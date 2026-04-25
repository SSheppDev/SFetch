import { Router, Request, Response, NextFunction } from 'express'
import { pool } from '../db/pool'

const router = Router()

const DEFAULT_DELTA_INTERVAL_MINUTES = 60
const DEFAULT_FULL_INTERVAL_HOURS = 24

// ---------------------------------------------------------------------------
// GET /api/schedules
// Return current schedule settings
// ---------------------------------------------------------------------------

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Read app_config values
    const configResult = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM sfdb.app_config WHERE key IN ('auto_sync_enabled')`
    )
    const configMap = new Map<string, string>()
    for (const row of configResult.rows) {
      configMap.set(row.key, row.value)
    }

    const autoSyncEnabled = (configMap.get('auto_sync_enabled') ?? 'true') === 'true'

    // Read minimum delta interval from enabled objects (or use default)
    const intervalResult = await pool.query<{
      min_delta: number | null
      min_full: number | null
    }>(
      `SELECT
         MIN(delta_interval_minutes) AS min_delta,
         MIN(full_interval_hours) AS min_full
       FROM sfdb.sync_config
       WHERE enabled = true`
    )

    const deltaIntervalMinutes =
      intervalResult.rows[0]?.min_delta ?? DEFAULT_DELTA_INTERVAL_MINUTES
    const fullIntervalHours =
      intervalResult.rows[0]?.min_full ?? DEFAULT_FULL_INTERVAL_HOURS

    res.json({
      autoSyncEnabled,
      deltaIntervalMinutes,
      fullIntervalHours,
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// PATCH /api/schedules
// Update global sync settings and per-object intervals
// ---------------------------------------------------------------------------

router.patch('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as {
      autoSyncEnabled?: unknown
      deltaIntervalMinutes?: unknown
      fullIntervalHours?: unknown
    }

    // Update auto_sync_enabled in app_config
    if (typeof body.autoSyncEnabled === 'boolean') {
      await pool.query(
        `INSERT INTO sfdb.app_config (key, value)
         VALUES ('auto_sync_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(body.autoSyncEnabled)]
      )
    }

    // Update delta interval for all enabled objects
    if (typeof body.deltaIntervalMinutes === 'number' && body.deltaIntervalMinutes > 0) {
      await pool.query(
        `UPDATE sfdb.sync_config
         SET delta_interval_minutes = $1
         WHERE enabled = true`,
        [body.deltaIntervalMinutes]
      )
    }

    // Update full interval for all enabled objects
    if (typeof body.fullIntervalHours === 'number' && body.fullIntervalHours > 0) {
      await pool.query(
        `UPDATE sfdb.sync_config
         SET full_interval_hours = $1
         WHERE enabled = true`,
        [body.fullIntervalHours]
      )
    }

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
