import { Router, Request, Response, NextFunction } from 'express'
import { pool } from '../db/pool'

const router = Router()

// ---------------------------------------------------------------------------
// GET /api/settings
// Return high-level app settings
// ---------------------------------------------------------------------------

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM sfdb.app_config WHERE key IN ('active_org_alias', 'auto_sync_enabled')`
    )

    const configMap = new Map<string, string>()
    for (const row of result.rows) {
      configMap.set(row.key, row.value)
    }

    res.json({
      activeOrgAlias: configMap.get('active_org_alias') ?? null,
      autoSyncEnabled: (configMap.get('auto_sync_enabled') ?? 'true') === 'true',
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/settings/connection
// Return DB connection details for display in the UI
// ---------------------------------------------------------------------------

router.get('/connection', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const host = process.env.POSTGRES_HOST ?? 'localhost'
    const port = process.env.POSTGRES_PORT ?? '7745'
    const database = process.env.POSTGRES_DB ?? 'sfdb'
    const user = process.env.POSTGRES_USER ?? 'sfdb'
    const password = process.env.POSTGRES_PASSWORD ?? 'changeme'

    const connectionString = `postgresql://${user}:${password}@${host}:${port}/${database}`

    res.json({
      host,
      port,
      database,
      user,
      password,
      connectionString,
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/settings/stats
// Return database size stats for the UI
// ---------------------------------------------------------------------------

router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Total database size
    const dbSizeResult = await pool.query<{ bytes: string }>(
      `SELECT pg_database_size(current_database()) AS bytes`
    )
    const dbSizeBytes = parseInt(dbSizeResult.rows[0]?.bytes ?? '0', 10)

    // Per-table stats for the salesforce schema
    const tableResult = await pool.query<{
      table_name: string
      row_count: string
      table_size_bytes: string
      total_size_bytes: string
    }>(
      `SELECT
         t.table_name,
         COALESCE(s.n_live_tup, 0)::text AS row_count,
         pg_relation_size('salesforce.' || quote_ident(t.table_name))::text AS table_size_bytes,
         pg_total_relation_size('salesforce.' || quote_ident(t.table_name))::text AS total_size_bytes
       FROM information_schema.tables t
       LEFT JOIN pg_stat_user_tables s
         ON s.schemaname = t.table_schema AND s.relname = t.table_name
       WHERE t.table_schema = 'salesforce'
       ORDER BY pg_total_relation_size('salesforce.' || quote_ident(t.table_name)) DESC`
    )

    const tables = tableResult.rows.map((r) => ({
      tableName: r.table_name,
      rowCount: parseInt(r.row_count, 10),
      tableSizeBytes: parseInt(r.table_size_bytes, 10),
      totalSizeBytes: parseInt(r.total_size_bytes, 10),
    }))

    const salesforceSizeBytes = tables.reduce((sum, t) => sum + t.totalSizeBytes, 0)
    const totalRows = tables.reduce((sum, t) => sum + t.rowCount, 0)

    res.json({
      dbSizeBytes,
      salesforceSizeBytes,
      tableCount: tables.length,
      totalRows,
      tables,
    })
  } catch (err) {
    next(err)
  }
})

export default router
