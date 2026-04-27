import { Router, Request, Response, NextFunction } from 'express'
import { pool } from '../db/pool'

const router = Router()

// ---------------------------------------------------------------------------
// GET /api/settings — high-level app settings
// ---------------------------------------------------------------------------

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const configResult = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM sfdb.app_config WHERE key = 'auto_sync_enabled'`
    )
    const autoSyncEnabled = (configResult.rows[0]?.value ?? 'true') === 'true'

    const activeResult = await pool.query<{ org_id: string | null }>(
      `SELECT org_id FROM sfdb.active_org WHERE id = 1`
    )
    const activeOrgId = activeResult.rows[0]?.org_id ?? null

    res.json({
      activeOrgId,
      autoSyncEnabled,
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/settings/connection — DB connection details for the UI
// ---------------------------------------------------------------------------

router.get('/connection', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const host = 'localhost'
    const port = process.env.POSTGRES_PORT ?? '7745'
    const database = process.env.POSTGRES_DB ?? 'sfdb'
    const user = process.env.POSTGRES_USER ?? 'sfdb'
    const connectionString = `postgresql://${user}@${host}:${port}/${database}`

    res.json({
      host,
      port,
      database,
      user,
      connectionString,
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/settings/stats — DB stats aggregated across all org schemas
// ---------------------------------------------------------------------------

router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const dbSizeResult = await pool.query<{ bytes: string }>(
      `SELECT pg_database_size(current_database()) AS bytes`
    )
    const dbSizeBytes = parseInt(dbSizeResult.rows[0]?.bytes ?? '0', 10)

    // All registered org schemas
    const orgs = await pool.query<{ org_id: string; alias: string | null; schema_name: string }>(
      `SELECT org_id, alias, schema_name FROM sfdb.orgs`
    )

    const tableResult = await pool.query<{
      schema_name: string
      table_name: string
      row_count: string
      table_size_bytes: string
      total_size_bytes: string
    }>(
      `SELECT
         t.table_schema AS schema_name,
         t.table_name,
         COALESCE(s.n_live_tup, 0)::text AS row_count,
         pg_relation_size(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::text AS table_size_bytes,
         pg_total_relation_size(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::text AS total_size_bytes
       FROM information_schema.tables t
       LEFT JOIN pg_stat_user_tables s
         ON s.schemaname = t.table_schema AND s.relname = t.table_name
       WHERE t.table_schema = ANY($1::text[])
         AND t.table_type = 'BASE TABLE'
       ORDER BY pg_total_relation_size(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name)) DESC`,
      [orgs.rows.map((o) => o.schema_name)]
    )

    const tables = tableResult.rows.map((r) => ({
      schemaName: r.schema_name,
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
      orgs: orgs.rows.map((o) => ({
        orgId: o.org_id,
        alias: o.alias,
        schemaName: o.schema_name,
      })),
      tables,
    })
  } catch (err) {
    next(err)
  }
})

export default router
