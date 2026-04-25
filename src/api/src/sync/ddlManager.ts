import { pool } from '../db/pool'

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
// Helpers
// ---------------------------------------------------------------------------

function tableRef(objectApiName: string): string {
  return `salesforce.${objectApiName.toLowerCase()}`
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Create a table for a Salesforce object in the salesforce schema.
 * Idempotent — uses CREATE TABLE IF NOT EXISTS.
 *
 * System columns (id, sf_created_at, sf_updated_at, sf_deleted_at, synced_at)
 * are always added. The `fields` array lists additional columns to include.
 */
export async function createObjectTable(
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
      return `  ${col} ${pgType}`
    })
    .join(',\n')

  const extraCols = fieldColumns.length > 0 ? `,\n${fieldColumns}` : ''

  const sql = `
CREATE TABLE IF NOT EXISTS ${tableRef(objectApiName)} (
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
 * Add a single column to an existing object table.
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */
export async function addColumn(
  objectApiName: string,
  fieldApiName: string,
  sfType: string
): Promise<void> {
  assertValidApiName(objectApiName, 'objectApiName')
  assertValidApiName(fieldApiName, 'fieldApiName')
  const col = fieldApiName.toLowerCase()
  const pgType = sfTypeToPg(sfType)
  const sql = `ALTER TABLE ${tableRef(objectApiName)} ADD COLUMN IF NOT EXISTS ${col} ${pgType}`
  await pool.query(sql)
}

/**
 * Drop a single column from an existing object table.
 * Idempotent — uses DROP COLUMN IF EXISTS.
 * Throws if a system column (id, sf_created_at, etc.) is targeted.
 */
export async function dropColumn(
  objectApiName: string,
  fieldApiName: string
): Promise<void> {
  assertValidApiName(objectApiName, 'objectApiName')
  assertValidApiName(fieldApiName, 'fieldApiName')
  const col = fieldApiName.toLowerCase()
  if (SYSTEM_COLUMNS.has(col)) {
    throw new Error(
      `dropColumn: "${col}" is a system column and cannot be dropped from ${tableRef(objectApiName)}`
    )
  }
  const sql = `ALTER TABLE ${tableRef(objectApiName)} DROP COLUMN IF EXISTS ${col}`
  await pool.query(sql)
}

/**
 * Drop the table for a Salesforce object.
 * Idempotent — uses DROP TABLE IF EXISTS.
 */
export async function dropTable(objectApiName: string): Promise<void> {
  assertValidApiName(objectApiName, 'objectApiName')
  const sql = `DROP TABLE IF EXISTS ${tableRef(objectApiName)}`
  await pool.query(sql)
}

/**
 * Returns the row count for an object table, or null if the table does not exist.
 */
export async function getTableRowCount(objectApiName: string): Promise<number | null> {
  assertValidApiName(objectApiName, 'objectApiName')
  const existsResult = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'salesforce'
         AND table_name   = $1
     ) AS exists`,
    [objectApiName.toLowerCase()]
  )

  if (!existsResult.rows[0]?.exists) {
    return null
  }

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${tableRef(objectApiName)}`
  )

  return parseInt(countResult.rows[0]?.count ?? '0', 10)
}
