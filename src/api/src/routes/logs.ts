import { Router, Request, Response, NextFunction } from 'express'
import { pool } from '../db/pool'

const router = Router()

// ---------------------------------------------------------------------------
// GET /api/logs
// Query sync logs with optional filters
// ---------------------------------------------------------------------------

interface LogEntry {
  id: number
  objectApiName: string | null
  syncType: string
  startedAt: Date
  completedAt: Date | null
  recordsUpserted: number | null
  recordsDeleted: number | null
  error: string | null
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      object: objectFilter,
      syncType: syncTypeFilter,
      status: statusFilter,
      limit: limitParam,
      offset: offsetParam,
    } = req.query as Record<string, string | undefined>

    const limit = Math.min(parseInt(limitParam ?? '100', 10) || 100, 500)
    const offset = parseInt(offsetParam ?? '0', 10) || 0

    // Build dynamic WHERE clauses
    const conditions: string[] = []
    const params: unknown[] = []

    if (objectFilter) {
      params.push(objectFilter)
      conditions.push(`object_api_name = $${params.length}`)
    }

    if (syncTypeFilter) {
      params.push(syncTypeFilter)
      conditions.push(`sync_type = $${params.length}`)
    }

    if (statusFilter === 'error') {
      conditions.push(`error IS NOT NULL`)
    } else if (statusFilter === 'success') {
      conditions.push(`error IS NULL AND completed_at IS NOT NULL`)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Get total count
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sfdb.sync_log ${whereClause}`,
      params
    )
    const total = parseInt(countResult.rows[0]?.count ?? '0', 10)

    // Get paginated rows
    const dataParams = [...params, limit, offset]
    const dataResult = await pool.query<{
      id: number
      object_api_name: string | null
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
       ${whereClause}
       ORDER BY started_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      dataParams
    )

    const logs: LogEntry[] = dataResult.rows.map((row) => ({
      id: row.id,
      objectApiName: row.object_api_name,
      syncType: row.sync_type,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      recordsUpserted: row.records_upserted,
      recordsDeleted: row.records_deleted,
      error: row.error,
    }))

    res.json({ logs, total })
  } catch (err) {
    next(err)
  }
})

export default router
