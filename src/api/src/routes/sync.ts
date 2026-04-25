import { Router, Request, Response, NextFunction } from 'express'
import { pool } from '../db/pool'
import {
  triggerDeltaSync,
  triggerFullSync,
  triggerDeltaSyncForObject,
  triggerFullSyncForObject,
  getSyncLockStatus,
} from '../sync/scheduler'

const router = Router()

// ---------------------------------------------------------------------------
// Helper — read active org alias from app_config
// ---------------------------------------------------------------------------

async function getActiveAlias(): Promise<string | null> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM sfdb.app_config WHERE key = 'active_org_alias'`
  )
  return result.rows[0]?.value ?? null
}

// ---------------------------------------------------------------------------
// POST /api/sync/delta
// Trigger a delta sync for the active org
// ---------------------------------------------------------------------------

router.post('/delta', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const alias = await getActiveAlias()
    if (!alias) {
      res.status(400).json({ error: 'No active org configured' })
      return
    }

    try {
      await triggerDeltaSync(alias)
      res.json({ ok: true })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.toLowerCase().includes('lock') || msg.toLowerCase().includes('in progress')) {
        res.status(409).json({ error: 'Sync already in progress' })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// POST /api/sync/full
// Trigger a full ID reconciliation sync for the active org
// ---------------------------------------------------------------------------

router.post('/full', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const alias = await getActiveAlias()
    if (!alias) {
      res.status(400).json({ error: 'No active org configured' })
      return
    }

    try {
      await triggerFullSync(alias)
      res.json({ ok: true })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.toLowerCase().includes('lock') || msg.toLowerCase().includes('in progress')) {
        res.status(409).json({ error: 'Sync already in progress' })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// POST /api/sync/delta/:objectApiName
// Trigger a delta sync for a specific object
// ---------------------------------------------------------------------------

router.post('/delta/:objectApiName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const alias = await getActiveAlias()
    if (!alias) {
      res.status(400).json({ error: 'No active org configured' })
      return
    }
    const { objectApiName } = req.params

    try {
      await triggerDeltaSyncForObject(alias, objectApiName)
      res.json({ ok: true })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.toLowerCase().includes('lock') || msg.toLowerCase().includes('in progress')) {
        res.status(409).json({ error: 'Sync already in progress' })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// POST /api/sync/full/:objectApiName
// Trigger a full reconciliation for a specific object
// ---------------------------------------------------------------------------

router.post('/full/:objectApiName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const alias = await getActiveAlias()
    if (!alias) {
      res.status(400).json({ error: 'No active org configured' })
      return
    }
    const { objectApiName } = req.params

    try {
      await triggerFullSyncForObject(alias, objectApiName)
      res.json({ ok: true })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.toLowerCase().includes('lock') || msg.toLowerCase().includes('in progress')) {
        res.status(409).json({ error: 'Sync already in progress' })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/sync/status
// Return lock status + per-object sync state for all enabled objects
// ---------------------------------------------------------------------------

interface ObjectSyncStatus {
  objectApiName: string
  enabled: boolean
  lastDeltaSync: Date | null
  lastFullSync: Date | null
  deltaIntervalMinutes: number | null
  fullIntervalHours: number | null
}

router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const lockStatus = await getSyncLockStatus()

    const syncConfigResult = await pool.query<{
      object_api_name: string
      enabled: boolean
      last_delta_sync: Date | null
      last_full_sync: Date | null
      delta_interval_minutes: number | null
      full_interval_hours: number | null
    }>(
      `SELECT object_api_name, enabled, last_delta_sync, last_full_sync,
              delta_interval_minutes, full_interval_hours
       FROM sfdb.sync_config
       WHERE enabled = true`
    )

    const objects: ObjectSyncStatus[] = syncConfigResult.rows.map((row) => ({
      objectApiName: row.object_api_name,
      enabled: row.enabled,
      lastDeltaSync: row.last_delta_sync,
      lastFullSync: row.last_full_sync,
      deltaIntervalMinutes: row.delta_interval_minutes,
      fullIntervalHours: row.full_interval_hours,
    }))

    // Current in-progress object + live progress from open sync_log row
    const progressResult = await pool.query<{
      object_api_name: string
      records_upserted: number
      total_records: number | null
      phase: string
    }>(
      `SELECT object_api_name, records_upserted, total_records, phase
       FROM sfdb.sync_log
       WHERE completed_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`
    )
    const openRow = progressResult.rows[0] ?? null
    const currentObject = openRow?.object_api_name ?? null
    const currentProgress = openRow
      ? {
          recordsUpserted: openRow.records_upserted,
          totalRecords: openRow.total_records,
          phase: openRow.phase,
        }
      : null

    res.json({
      locked: lockStatus.locked,
      lockedAt: lockStatus.lockedAt,
      jobType: lockStatus.jobType,
      currentObject,
      currentProgress,
      objects,
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/sync/progress
// Return the latest in-progress sync_log entry (poll-friendly)
// ---------------------------------------------------------------------------

router.get('/progress', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query<{
      id: number
      object_api_name: string
      sync_type: string
      started_at: Date
      completed_at: Date | null
      records_upserted: number | null
      records_deleted: number | null
      error: string | null
    }>(
      `SELECT id, object_api_name, sync_type, started_at, completed_at,
              records_upserted, records_deleted, error
       FROM sfdb.sync_log
       WHERE completed_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`
    )

    const entry = result.rows[0] ?? null
    res.json({ inProgress: entry !== null, entry })
  } catch (err) {
    next(err)
  }
})

export default router
