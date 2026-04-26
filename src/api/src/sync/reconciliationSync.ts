import { getOrgToken } from '../auth/sfAuth'
import { createBulkClient } from '../salesforce/bulkClient'
import { pool } from '../db/pool'
import { writeSyncLog, updateSyncProgress } from './deltaSync'
import { schemaForOrg, tableRefForOrg } from './ddlManager'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SyncConfigRow {
  object_api_name: string
}

interface LocalIdRow {
  id: string
}

interface OrgRow {
  alias: string | null
  username: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DELETE_BATCH_SIZE = 1_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveOrgAuthKey(orgId: string): Promise<string> {
  const result = await pool.query<OrgRow>(
    `SELECT alias, username FROM sfdb.orgs WHERE org_id = $1`,
    [orgId]
  )
  const row = result.rows[0]
  if (!row) throw new Error(`runReconciliation: org "${orgId}" is not registered`)
  return row.alias ?? row.username
}

async function startSyncLog(orgId: string, objectApiName: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO sfdb.sync_log (org_id, object_api_name, sync_type, started_at, phase)
     VALUES ($1, $2, 'full', NOW(), 'polling')
     RETURNING id`,
    [orgId, objectApiName]
  )
  return result.rows[0].id
}

/**
 * Returns true if the per-org table for `objectApiName` exists.
 */
async function tableExists(orgId: string, objectApiName: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name   = $2
     ) AS exists`,
    [schemaForOrg(orgId), objectApiName.toLowerCase()]
  )
  return result.rows[0]?.exists ?? false
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runReconciliation(orgId: string, targetObject?: string): Promise<void> {
  const authKey = await resolveOrgAuthKey(orgId)
  const token = await getOrgToken(authKey)
  const bulkClient = createBulkClient({
    accessToken: token.accessToken,
    instanceUrl: token.instanceUrl,
  })

  const configResult = targetObject
    ? await pool.query<SyncConfigRow>(
        `SELECT object_api_name
         FROM sfdb.sync_config
         WHERE org_id = $1 AND enabled = true AND object_api_name = $2`,
        [orgId, targetObject]
      )
    : await pool.query<SyncConfigRow>(
        `SELECT object_api_name
         FROM sfdb.sync_config
         WHERE org_id = $1 AND enabled = true
         ORDER BY sync_order ASC, object_api_name ASC`,
        [orgId]
      )

  const objects = configResult.rows

  for (const { object_api_name: objectApiName } of objects) {
    let logId: number | undefined
    let recordsDeleted = 0

    try {
      if (!(await tableExists(orgId, objectApiName))) {
        console.warn(
          `[reconciliation] [${orgId}] Table ${tableRefForOrg(orgId, objectApiName)} does not exist — skipping`
        )
        continue
      }

      logId = await startSyncLog(orgId, objectApiName)

      const soql = `SELECT Id FROM ${objectApiName}`
      const queryResult = await bulkClient.query(soql)

      await updateSyncProgress(logId, 'polling', 0, queryResult.totalSize)

      const sfIds = new Set<string>()
      for await (const record of queryResult.records) {
        const id = record['Id']
        if (id !== null) {
          sfIds.add(id)
        }
      }

      await updateSyncProgress(logId, 'diffing', sfIds.size, queryResult.totalSize)
      const localResult = await pool.query<LocalIdRow>(
        `SELECT id FROM ${tableRefForOrg(orgId, objectApiName)} WHERE sf_deleted_at IS NULL`
      )
      const localIds = localResult.rows.map((r) => r.id)

      const deletedIds = localIds.filter((id) => !sfIds.has(id))

      for (let i = 0; i < deletedIds.length; i += DELETE_BATCH_SIZE) {
        const batch = deletedIds.slice(i, i + DELETE_BATCH_SIZE)
        const result = await pool.query(
          `UPDATE ${tableRefForOrg(orgId, objectApiName)}
           SET sf_deleted_at = NOW()
           WHERE id = ANY($1)`,
          [batch]
        )
        recordsDeleted += result.rowCount ?? 0
      }

      await pool.query(
        `UPDATE sfdb.sync_config SET last_full_sync = NOW()
         WHERE org_id = $1 AND object_api_name = $2`,
        [orgId, objectApiName]
      )

      await writeSyncLog(logId, 0, recordsDeleted)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[reconciliation] [${orgId}] Error reconciling ${objectApiName}: ${message}`)
      if (logId !== undefined) {
        await writeSyncLog(logId, 0, recordsDeleted, message)
      }
    }
  }
}
