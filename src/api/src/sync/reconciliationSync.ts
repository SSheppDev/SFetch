import { getOrgToken } from '../auth/sfAuth'
import { createBulkClient } from '../salesforce/bulkClient'
import { pool } from '../db/pool'
import { writeSyncLog, updateSyncProgress } from './deltaSync'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SyncConfigRow {
  object_api_name: string
}

interface LocalIdRow {
  id: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DELETE_BATCH_SIZE = 1_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startSyncLog(objectApiName: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO sfdb.sync_log (object_api_name, sync_type, started_at, phase)
     VALUES ($1, 'full', NOW(), 'polling')
     RETURNING id`,
    [objectApiName]
  )
  return result.rows[0].id
}

/**
 * Returns true if the salesforce.<objectApiName> table exists.
 */
async function tableExists(objectApiName: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'salesforce'
         AND table_name   = $1
     ) AS exists`,
    [objectApiName.toLowerCase()]
  )
  return result.rows[0]?.exists ?? false
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runReconciliation(orgAlias: string, targetObject?: string): Promise<void> {
  const token = await getOrgToken(orgAlias)
  const bulkClient = createBulkClient({
    accessToken: token.accessToken,
    instanceUrl: token.instanceUrl,
  })

  const configResult = targetObject
    ? await pool.query<SyncConfigRow>(
        `SELECT object_api_name
         FROM sfdb.sync_config
         WHERE enabled = true AND object_api_name = $1`,
        [targetObject]
      )
    : await pool.query<SyncConfigRow>(
        `SELECT object_api_name
         FROM sfdb.sync_config
         WHERE enabled = true
         ORDER BY sync_order ASC, object_api_name ASC`
      )

  const objects = configResult.rows

  for (const { object_api_name: objectApiName } of objects) {
    let logId: number | undefined
    let recordsDeleted = 0

    try {
      // Skip if the local table doesn't exist yet
      if (!(await tableExists(objectApiName))) {
        console.warn(
          `[reconciliation] Table salesforce.${objectApiName.toLowerCase()} does not exist — skipping`
        )
        continue
      }

      logId = await startSyncLog(objectApiName)

      // 1. Bulk query all live SF ids
      const soql = `SELECT Id FROM ${objectApiName}`
      const queryResult = await bulkClient.query(soql)

      // Phase: polling SF for IDs
      await updateSyncProgress(logId, 'polling', 0, queryResult.totalSize)

      const sfIds = new Set<string>()
      for await (const record of queryResult.records) {
        const id = record['Id']
        if (id !== null) {
          sfIds.add(id)
        }
      }

      // 2. Get local live ids (sf_deleted_at IS NULL)
      await updateSyncProgress(logId, 'diffing', sfIds.size, queryResult.totalSize)
      const localResult = await pool.query<LocalIdRow>(
        `SELECT id FROM salesforce.${objectApiName.toLowerCase()} WHERE sf_deleted_at IS NULL`
      )
      const localIds = localResult.rows.map((r) => r.id)

      // 3. Diff: local ids not in SF = deleted in Salesforce
      const deletedIds = localIds.filter((id) => !sfIds.has(id))

      // 4. Soft-delete in batches of 1000
      for (let i = 0; i < deletedIds.length; i += DELETE_BATCH_SIZE) {
        const batch = deletedIds.slice(i, i + DELETE_BATCH_SIZE)
        const result = await pool.query(
          `UPDATE salesforce.${objectApiName.toLowerCase()}
           SET sf_deleted_at = NOW()
           WHERE id = ANY($1)`,
          [batch]
        )
        recordsDeleted += result.rowCount ?? 0
      }

      // 5. Update last_full_sync
      await pool.query(
        `UPDATE sfdb.sync_config SET last_full_sync = NOW() WHERE object_api_name = $1`,
        [objectApiName]
      )

      await writeSyncLog(logId, 0, recordsDeleted)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[reconciliation] Error reconciling ${objectApiName}: ${message}`)
      if (logId !== undefined) {
        await writeSyncLog(logId, 0, recordsDeleted, message)
      }
    }
  }
}
