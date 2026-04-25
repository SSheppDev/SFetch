import { Router, Request, Response, NextFunction } from 'express'
import { pool } from '../db/pool'

const router = Router()

// ---------------------------------------------------------------------------
// GET /api/sync-order
// Returns all enabled objects sorted by sync_order ASC, then name ASC
// ---------------------------------------------------------------------------

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query<{
      object_api_name: string
      sync_order: number
    }>(
      `SELECT object_api_name, sync_order
       FROM sfdb.sync_config
       WHERE enabled = true
       ORDER BY sync_order ASC, object_api_name ASC`
    )

    res.json(
      result.rows.map((r) => ({
        objectApiName: r.object_api_name,
        syncOrder: r.sync_order,
      }))
    )
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// PUT /api/sync-order
// Body: [{ objectApiName: string, syncOrder: number }]
// Saves the full ordered list atomically
// ---------------------------------------------------------------------------

interface SyncOrderItem {
  objectApiName: string
  syncOrder: number
}

router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = req.body as SyncOrderItem[]

    if (!Array.isArray(items)) {
      res.status(400).json({ error: 'Body must be an array' })
      return
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const { objectApiName, syncOrder } of items) {
        await client.query(
          `UPDATE sfdb.sync_config SET sync_order = $1 WHERE object_api_name = $2`,
          [syncOrder, objectApiName]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
