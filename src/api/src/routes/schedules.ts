import { Router, Request, Response, NextFunction } from 'express'
import { pool } from '../db/pool'
import { requireOrgId } from './_orgContext'

const router = Router()

const DEFAULT_DELTA_INTERVAL_MINUTES = 60
const DEFAULT_FULL_INTERVAL_HOURS = 24

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return

    const configResult = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM sfdb.app_config WHERE key = 'auto_sync_enabled'`
    )
    const autoSyncEnabled = (configResult.rows[0]?.value ?? 'true') === 'true'

    const intervalResult = await pool.query<{
      min_delta: number | null
      min_full: number | null
    }>(
      `SELECT
         MIN(delta_interval_minutes) AS min_delta,
         MIN(full_interval_hours) AS min_full
       FROM sfdb.sync_config
       WHERE org_id = $1 AND enabled = true`,
      [orgId]
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

router.patch('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return

    const body = req.body as {
      autoSyncEnabled?: unknown
      deltaIntervalMinutes?: unknown
      fullIntervalHours?: unknown
    }

    if (typeof body.autoSyncEnabled === 'boolean') {
      await pool.query(
        `INSERT INTO sfdb.app_config (key, value)
         VALUES ('auto_sync_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(body.autoSyncEnabled)]
      )
    }

    if (typeof body.deltaIntervalMinutes === 'number' && body.deltaIntervalMinutes > 0) {
      await pool.query(
        `UPDATE sfdb.sync_config
         SET delta_interval_minutes = $1
         WHERE org_id = $2 AND enabled = true`,
        [body.deltaIntervalMinutes, orgId]
      )
    }

    if (typeof body.fullIntervalHours === 'number' && body.fullIntervalHours > 0) {
      await pool.query(
        `UPDATE sfdb.sync_config
         SET full_interval_hours = $1
         WHERE org_id = $2 AND enabled = true`,
        [body.fullIntervalHours, orgId]
      )
    }

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
