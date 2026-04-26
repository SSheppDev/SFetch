import { pool } from '../db/pool'
import { schemaNameForOrgId } from '../db/migrate'

// ---------------------------------------------------------------------------
// System columns — always present, never managed via field_config
// ---------------------------------------------------------------------------

const SF_API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/

function assertValidApiName(name: string, label: string): void {
  if (!SF_API_NAME_RE.test(name)) {
    throw new Error(`ddlManager: invalid ${label} "${name}"`)
  }
}

const SYSTEM_COLUMNS = new Set([
  'id',
  'sf_created_at',
  'sf_updated_at',
  'sf_deleted_at',
  'synced_at',
])

// ---------------------------------------------------------------------------
// SF → PG type mapping
// ---------------------------------------------------------------------------

export function sfTypeToPg(sfType: string): string {
  switch (sfType.toLowerCase()) {
    case 'id':
    case 'string':
    case 'textarea':
    case 'url':
    case 'phone':
    case 'email':
    case 'picklist':
    case 'reference':
    case 'encryptedstring':
      return 'text'

    case 'boolean':
      return 'boolean'

    case 'int':
      return 'integer'

    case 'double':
    case 'currency':
    case 'percent':
      return 'numeric'

    case 'date':
      return 'date'

    case 'datetime':
      return 'timestamptz'

    case 'multipicklist':
      return 'text[]'

    default:
      return 'text'
  }
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

export { schemaNameForOrgId as schemaForOrg }

export function tableRefForOrg(orgId: string, objectApiName: string): string {
  assertValidApiName(objectApiName, 'objectApiName')
  return `${schemaNameForOrgId(orgId)}.${quoteIdent(objectApiName.toLowerCase())}`
}

/**
 * Some Salesforce object names collide with Postgres reserved words
 * (e.g. `Order`, `User`). We always quote the identifier so the resulting
 * SQL is valid regardless of name.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Create the per-org schema. Idempotent. Also re-issues the read-only
 * grants if the role exists, so newly added orgs are visible to BI users.
 */
export async function createOrgSchema(orgId: string): Promise<void> {
  const schema = schemaNameForOrgId(orgId)
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)

  const roleResult = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sfdb_readonly') AS exists`
  )
  if (roleResult.rows[0]?.exists) {
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO sfdb_readonly`)
    await pool.query(
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO sfdb_readonly`
    )
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO sfdb_readonly`
    )
  }
}

/**
 * Drop the per-org schema and every table inside it. Caller must confirm
 * with the user before invoking — this is destructive.
 */
export async function dropOrgSchema(orgId: string): Promise<void> {
  const schema = schemaNameForOrgId(orgId)
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
}

// ---------------------------------------------------------------------------
// Per-table DDL
// ---------------------------------------------------------------------------

/**
 * Create a table for a Salesforce object in the org's schema.
 * Idempotent — uses CREATE TABLE IF NOT EXISTS.
 */
export async function createObjectTable(
  orgId: string,
  objectApiName: string,
  fields: Array<{ apiName: string; sfType: string }>
): Promise<void> {
  assertValidApiName(objectApiName, 'objectApiName')
  const fieldColumns = fields
    .filter(({ apiName }) => !SYSTEM_COLUMNS.has(apiName.toLowerCase()))
    .map(({ apiName, sfType }) => {
      assertValidApiName(apiName, 'fieldApiName')
      const col = apiName.toLowerCase()
      const pgType = sfTypeToPg(sfType)
      return `  ${quoteIdent(col)} ${pgType}`
    })
    .join(',\n')

  const extraCols = fieldColumns.length > 0 ? `,\n${fieldColumns}` : ''

  const sql = `
CREATE TABLE IF NOT EXISTS ${tableRefForOrg(orgId, objectApiName)} (
  id             text        PRIMARY KEY,
  sf_created_at  timestamptz,
  sf_updated_at  timestamptz,
  sf_deleted_at  timestamptz,
  synced_at      timestamptz NOT NULL DEFAULT NOW()${extraCols}
)
`
  await pool.query(sql)
}

/**
 * Add a single column to an existing object table. Idempotent.
 */
export async function addColumn(
  orgId: string,
  objectApiName: string,
  fieldApiName: string,
  sfType: string
): Promise<void> {
  assertValidApiName(objectApiName, 'objectApiName')
  assertValidApiName(fieldApiName, 'fieldApiName')
  const col = fieldApiName.toLowerCase()
  const pgType = sfTypeToPg(sfType)
  const sql = `ALTER TABLE ${tableRefForOrg(orgId, objectApiName)} ADD COLUMN IF NOT EXISTS ${quoteIdent(col)} ${pgType}`
  await pool.query(sql)
}

/**
 * Drop a single column from an existing object table. Idempotent.
 * Throws if a system column is targeted.
 */
export async function dropColumn(
  orgId: string,
  objectApiName: string,
  fieldApiName: string
): Promise<void> {
  assertValidApiName(objectApiName, 'objectApiName')
  assertValidApiName(fieldApiName, 'fieldApiName')
  const col = fieldApiName.toLowerCase()
  if (SYSTEM_COLUMNS.has(col)) {
    throw new Error(
      `dropColumn: "${col}" is a system column and cannot be dropped from ${tableRefForOrg(orgId, objectApiName)}`
    )
  }
  const sql = `ALTER TABLE ${tableRefForOrg(orgId, objectApiName)} DROP COLUMN IF EXISTS ${quoteIdent(col)}`
  await pool.query(sql)
}

/**
 * Drop the table for a Salesforce object. Idempotent.
 */
export async function dropTable(
  orgId: string,
  objectApiName: string
): Promise<void> {
  assertValidApiName(objectApiName, 'objectApiName')
  const sql = `DROP TABLE IF EXISTS ${tableRefForOrg(orgId, objectApiName)}`
  await pool.query(sql)
}

/**
 * Returns the row count for an object table, or null if the table does not exist.
 */
export async function getTableRowCount(
  orgId: string,
  objectApiName: string
): Promise<number | null> {
  assertValidApiName(objectApiName, 'objectApiName')
  const schema = schemaNameForOrgId(orgId)
  const existsResult = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name   = $2
     ) AS exists`,
    [schema, objectApiName.toLowerCase()]
  )

  if (!existsResult.rows[0]?.exists) {
    return null
  }

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${tableRefForOrg(orgId, objectApiName)}`
  )

  return parseInt(countResult.rows[0]?.count ?? '0', 10)
}
