import { Router, Request, Response, NextFunction } from 'express'
import { pool } from '../db/pool'
import {
  triggerDeltaSync,
  triggerFullSync,
  triggerDeltaSyncForObject,
  triggerFullSyncForObject,
  getSyncLockStatus,
} from '../sync/scheduler'
import { requireOrgId } from './_orgContext'

const router = Router()

function inProgressErrorResponse(err: unknown, res: Response): boolean {
  const msg = (err as Error).message ?? ''
  if (msg.toLowerCase().includes('lock') || msg.toLowerCase().includes('in progress')) {
    res.status(409).json({ error: 'Sync already in progress' })
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// POST /api/sync/delta
// ---------------------------------------------------------------------------

router.post('/delta', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return

    try {
      await triggerDeltaSync(orgId)
      res.json({ ok: true })
    } catch (err) {
      if (inProgressErrorResponse(err, res)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// POST /api/sync/full
// ---------------------------------------------------------------------------

router.post('/full', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return

    try {
      await triggerFullSync(orgId)
      res.json({ ok: true })
    } catch (err) {
      if (inProgressErrorResponse(err, res)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// POST /api/sync/delta/:objectApiName
// ---------------------------------------------------------------------------

router.post('/delta/:objectApiName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return
    const { objectApiName } = req.params

    try {
      await triggerDeltaSyncForObject(orgId, objectApiName)
      res.json({ ok: true })
    } catch (err) {
      if (inProgressErrorResponse(err, res)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// POST /api/sync/full/:objectApiName
// ---------------------------------------------------------------------------

router.post('/full/:objectApiName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return
    const { objectApiName } = req.params

    try {
      await triggerFullSyncForObject(orgId, objectApiName)
      res.json({ ok: true })
    } catch (err) {
      if (inProgressErrorResponse(err, res)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/sync/status
// ---------------------------------------------------------------------------

interface ObjectSyncStatus {
  objectApiName: string
  enabled: boolean
  lastDeltaSync: Date | null
  lastFullSync: Date | null
  deltaIntervalMinutes: number | null
  fullIntervalHours: number | null
}

router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return

    const lockStatus = await getSyncLockStatus(orgId)

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
       WHERE org_id = $1 AND enabled = true`,
      [orgId]
    )

    const objects: ObjectSyncStatus[] = syncConfigResult.rows.map((row) => ({
      objectApiName: row.object_api_name,
      enabled: row.enabled,
      lastDeltaSync: row.last_delta_sync,
      lastFullSync: row.last_full_sync,
      deltaIntervalMinutes: row.delta_interval_minutes,
      fullIntervalHours: row.full_interval_hours,
    }))

    const progressResult = await pool.query<{
      object_api_name: string
      records_upserted: number
      total_records: number | null
      phase: string
    }>(
      `SELECT object_api_name, records_upserted, total_records, phase
       FROM sfdb.sync_log
       WHERE org_id = $1 AND completed_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`,
      [orgId]
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
// ---------------------------------------------------------------------------

router.get('/progress', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return

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
       WHERE org_id = $1 AND completed_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`,
      [orgId]
    )

    const entry = result.rows[0] ?? null
    res.json({ inProgress: entry !== null, entry })
  } catch (err) {
    next(err)
  }
})

export default router
