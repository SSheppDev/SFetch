import { getOrgToken } from '../auth/sfAuth'
import { createBulkClient } from '../salesforce/bulkClient'
import { pool } from '../db/pool'
import { getTableRowCount, tableRefForOrg } from './ddlManager'

// ---------------------------------------------------------------------------
// SF fields handled as system columns — never selected from field_config
// ---------------------------------------------------------------------------

const SF_SYSTEM_FIELDS  = new Set(['Id', 'CreatedDate', 'SystemModstamp', 'IsDeleted'])
const SF_COMPOUND_TYPES = new Set(['address', 'location'])

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SyncConfigRow {
  object_api_name: string
  last_delta_sync: Date | null
  has_system_modstamp: boolean
  has_created_date: boolean
}

interface FieldConfigRow {
  field_api_name: string
  sf_type: string
  pg_type: string
}

interface FieldInfo {
  sfName: string  // original SF API name  e.g. 'BillingCity'
  pgName: string  // postgres column name  e.g. 'billingcity'
  pgType: string  // postgres type         e.g. 'text'
}

interface OrgRow {
  alias: string | null
  username: string
}

/**
 * Which audit fields a specific object actually exposes in Salesforce.
 * Most objects have CreatedDate + SystemModstamp; some metadata/junction
 * objects (Territory2, UserRole, etc.) only have LastModifiedDate.
 */
interface ObjectAuditFields {
  hasCreatedDate: boolean
  /** SF field name to use for sf_updated_at and delta WHERE clause */
  updatedAtField: 'SystemModstamp' | 'LastModifiedDate' | null
}

// ---------------------------------------------------------------------------
// Org lookup
// ---------------------------------------------------------------------------

async function resolveOrgAuthKey(orgId: string): Promise<string> {
  const result = await pool.query<OrgRow>(
    `SELECT alias, username FROM sfdb.orgs WHERE org_id = $1`,
    [orgId]
  )
  const row = result.rows[0]
  if (!row) throw new Error(`runDeltaSync: org "${orgId}" is not registered`)
  // Prefer alias; fall back to username for orgs without an alias mapping
  return row.alias ?? row.username
}

// ---------------------------------------------------------------------------
// Sync log helpers
// ---------------------------------------------------------------------------

async function startSyncLog(
  orgId: string,
  objectApiName: string,
  syncType: 'delta' | 'full'
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO sfdb.sync_log (org_id, object_api_name, sync_type, started_at, phase)
     VALUES ($1, $2, $3, NOW(), 'queuing')
     RETURNING id`,
    [orgId, objectApiName, syncType]
  )
  return result.rows[0].id
}

export async function writeSyncLog(
  logId: number,
  recordsUpserted: number,
  recordsDeleted: number,
  error?: string
): Promise<void> {
  if (error !== undefined) {
    await pool.query(
      `UPDATE sfdb.sync_log
       SET completed_at = NOW(), records_upserted = $2, records_deleted = $3,
           error = $4, phase = 'complete'
       WHERE id = $1`,
      [logId, recordsUpserted, recordsDeleted, error]
    )
  } else {
    await pool.query(
      `UPDATE sfdb.sync_log
       SET completed_at = NOW(), records_upserted = $2, records_deleted = $3,
           phase = 'complete'
       WHERE id = $1`,
      [logId, recordsUpserted, recordsDeleted]
    )
  }
}

/**
 * Update in-progress sync log with live counters and phase label.
 * Fire-and-forget — errors are logged but not surfaced to the caller.
 */
export async function updateSyncProgress(
  logId: number,
  phase: string,
  recordsUpserted?: number,
  totalRecords?: number
): Promise<void> {
  try {
    await pool.query(
      `UPDATE sfdb.sync_log
       SET phase = $2,
           records_upserted = COALESCE($3, records_upserted),
           total_records     = COALESCE($4, total_records)
       WHERE id = $1`,
      [logId, phase, recordsUpserted ?? null, totalRecords ?? null]
    )
  } catch (err) {
    console.warn('[sync-log] Failed to update progress:', (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Batch upsert — UNNEST approach: O(columns) params regardless of row count
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500

/**
 * Returns the SELECT expression to cast a UNNEST text column to its target type.
 * Multi-picklist fields stored as text[] in PG are split on ';'.
 */
function selectExpr(pgName: string, pgType: string): string {
  if (pgType === 'text') return `t.${pgName}`
  if (pgType === 'text[]') {
    return `CASE WHEN t.${pgName} IS NULL THEN NULL ELSE string_to_array(t.${pgName}, ';') END`
  }
  return `t.${pgName}::${pgType}`
}

/**
 * Upsert a batch of SF records using UNNEST (one text[] per column).
 */
async function upsertBatch(
  orgId: string,
  objectApiName: string,
  auditFields: ObjectAuditFields,
  fields: FieldInfo[],
  batch: Array<Record<string, string | null>>
): Promise<number> {
  if (batch.length === 0) return 0

  const table = tableRefForOrg(orgId, objectApiName)

  // One value array per column
  const ids: (string | null)[] = []
  const createdAts: (string | null)[] = []
  const updatedAts: (string | null)[] = []
  const userArrays: (string | null)[][] = fields.map(() => [])

  for (const record of batch) {
    ids.push(record['Id'] ?? null)
    createdAts.push(auditFields.hasCreatedDate ? (record['CreatedDate'] ?? null) : null)
    updatedAts.push(auditFields.updatedAtField ? (record[auditFields.updatedAtField] ?? null) : null)
    for (let i = 0; i < fields.length; i++) {
      userArrays[i].push(record[fields[i].sfName] ?? null)
    }
  }

  // Column metadata in insertion order
  const colDefs = [
    { pgName: 'id',           pgType: 'text',        values: ids },
    { pgName: 'sf_created_at', pgType: 'timestamptz', values: createdAts },
    { pgName: 'sf_updated_at', pgType: 'timestamptz', values: updatedAts },
    ...fields.map((f, i) => ({ pgName: f.pgName, pgType: f.pgType, values: userArrays[i] })),
  ]

  // params = one text[] per column (O(cols) total params, not O(rows×cols))
  const params: (string | null)[][] = colDefs.map((c) => c.values)

  const unnestArgs  = colDefs.map((_c, i) => `$${i + 1}::text[]`).join(', ')
  const colAliases  = colDefs.map((c) => c.pgName).join(', ')
  const selectExprs = colDefs.map((c) => selectExpr(c.pgName, c.pgType)).join(', ')

  const userPgNames = fields.map((f) => f.pgName)
  const updateSet   = ['sf_created_at', 'sf_updated_at', ...userPgNames]
    .map((col) => `${col} = EXCLUDED.${col}`)
    .join(',\n        ')

  const insertColList = [...colDefs.map((c) => c.pgName), 'synced_at'].join(', ')

  const sql = `
INSERT INTO ${table} (${insertColList})
SELECT ${selectExprs}, NOW()
FROM UNNEST(${unnestArgs}) AS t(${colAliases})
ON CONFLICT (id) DO UPDATE SET
  ${updateSet},
  synced_at = NOW()
`

  const result = await pool.query(sql, params as unknown[])
  return result.rowCount ?? 0
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runDeltaSync(orgId: string, targetObject?: string): Promise<void> {
  const authKey = await resolveOrgAuthKey(orgId)
  const token = await getOrgToken(authKey)
  const bulkClient = createBulkClient({
    accessToken: token.accessToken,
    instanceUrl: token.instanceUrl,
  })

  const configResult = targetObject
    ? await pool.query<SyncConfigRow>(
        `SELECT object_api_name, last_delta_sync, has_system_modstamp, has_created_date
         FROM sfdb.sync_config
         WHERE org_id = $1 AND enabled = true AND object_api_name = $2`,
        [orgId, targetObject]
      )
    : await pool.query<SyncConfigRow>(
        `SELECT object_api_name, last_delta_sync, has_system_modstamp, has_created_date
         FROM sfdb.sync_config
         WHERE org_id = $1 AND enabled = true
         ORDER BY sync_order ASC, object_api_name ASC`,
        [orgId]
      )

  for (const obj of configResult.rows) {
    const {
      object_api_name: objectApiName,
      last_delta_sync: lastDeltaSync,
      has_system_modstamp: hasSystemModstamp,
      has_created_date: hasCreatedDate,
    } = obj

    let logId: number | undefined
    let recordsUpserted = 0

    try {
      logId = await startSyncLog(orgId, objectApiName, 'delta')
      const syncMode = lastDeltaSync === null ? 'initial full load' : 'delta'
      console.log(`[delta-sync] [${orgId}] ${objectApiName}: starting ${syncMode}`)

      const trackingField = hasSystemModstamp ? 'SystemModstamp' : 'LastModifiedDate'
      let auditFields: ObjectAuditFields = {
        hasCreatedDate,
        updatedAtField: hasSystemModstamp ? 'SystemModstamp' : 'LastModifiedDate',
      }

      const fieldResult = await pool.query<FieldConfigRow>(
        `SELECT fc.field_api_name,
                COALESCE(fm.sf_type, 'string') AS sf_type,
                COALESCE(fm.pg_type, 'text')   AS pg_type
         FROM sfdb.field_config fc
         LEFT JOIN sfdb.field_metadata fm
           ON  fm.org_id          = fc.org_id
           AND fm.object_api_name = fc.object_api_name
           AND fm.field_api_name  = fc.field_api_name
         WHERE fc.org_id = $1
           AND fc.object_api_name = $2
           AND fc.enabled = true`,
        [orgId, objectApiName]
      )

      const fields: FieldInfo[] = fieldResult.rows
        .filter((r) =>
          !SF_SYSTEM_FIELDS.has(r.field_api_name) &&
          !SF_COMPOUND_TYPES.has(r.sf_type.toLowerCase()) &&
          !(r.field_api_name === 'LastModifiedDate' && !hasSystemModstamp)
        )
        .map((r) => ({
          sfName: r.field_api_name,
          pgName: r.field_api_name.toLowerCase(),
          pgType: r.pg_type,
        }))

      const systemSelect = ['Id']
      if (hasCreatedDate) systemSelect.push('CreatedDate')
      systemSelect.push(trackingField)

      const selectFields = [...systemSelect, ...fields.map((f) => f.sfName)].join(', ')

      let soql = `SELECT ${selectFields} FROM ${objectApiName}`
      if (lastDeltaSync !== null) {
        soql += ` WHERE ${trackingField} >= ${lastDeltaSync.toISOString()}`
      }
      soql += ` ORDER BY ${trackingField} ASC`

      await updateSyncProgress(logId, 'polling')

      const localRowCount = await getTableRowCount(orgId, objectApiName)
      const estimatedRows = localRowCount !== null && localRowCount > 0 ? localRowCount : undefined

      let queryResult = await bulkClient.query(soql, estimatedRows).catch(async (err: Error) => {
        const msg = err.message ?? ''
        const missingModstamp = msg.includes("No such column 'SystemModstamp'") || msg.includes("No such column 'CreatedDate'")
        if (!missingModstamp) throw err

        console.warn(`[delta-sync] [${orgId}] ${objectApiName}: object lacks standard audit fields — switching to LastModifiedDate`)
        await pool.query(
          `UPDATE sfdb.sync_config SET has_system_modstamp = false, has_created_date = false
           WHERE org_id = $1 AND object_api_name = $2`,
          [orgId, objectApiName]
        )

        const fallbackFields = fields.filter((f) => f.sfName !== 'LastModifiedDate')
        const fallbackSelect = ['Id', 'LastModifiedDate', ...fallbackFields.map((f) => f.sfName)].join(', ')
        let fallbackSoql = `SELECT ${fallbackSelect} FROM ${objectApiName}`
        if (lastDeltaSync !== null) fallbackSoql += ` WHERE LastModifiedDate >= ${lastDeltaSync.toISOString()}`
        fallbackSoql += ` ORDER BY LastModifiedDate ASC`

        auditFields.hasCreatedDate = false
        auditFields.updatedAtField = 'LastModifiedDate'

        return bulkClient.query(fallbackSoql, estimatedRows)
      })

      await updateSyncProgress(logId, 'streaming', 0, queryResult.totalSize)
      console.log(`[delta-sync] [${orgId}] ${objectApiName}: streaming ${queryResult.totalSize} records`)

      let batch: Array<Record<string, string | null>> = []

      for await (const record of queryResult.records) {
        batch.push(record)
        if (batch.length >= BATCH_SIZE) {
          recordsUpserted += await upsertBatch(orgId, objectApiName, auditFields, fields, batch)
          batch = []
          void updateSyncProgress(logId, 'streaming', recordsUpserted)
        }
      }
      if (batch.length > 0) {
        recordsUpserted += await upsertBatch(orgId, objectApiName, auditFields, fields, batch)
      }

      await pool.query(
        `UPDATE sfdb.sync_config SET last_delta_sync = NOW()
         WHERE org_id = $1 AND object_api_name = $2`,
        [orgId, objectApiName]
      )

      console.log(`[delta-sync] [${orgId}] ${objectApiName}: complete — ${recordsUpserted} rows upserted`)
      await writeSyncLog(logId, recordsUpserted, 0)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[delta-sync] [${orgId}] Error syncing ${objectApiName}: ${message}`)
      if (logId !== undefined) {
        await writeSyncLog(logId, recordsUpserted, 0, message)
      }
    }
  }
}
