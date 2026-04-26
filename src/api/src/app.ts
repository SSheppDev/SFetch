import 'dotenv/config'
import express, { NextFunction, Request, Response } from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import path from 'path'
import { pool } from './db/pool'
import { migrateToMultiOrg, ensureSyncLockRows } from './db/migrate'
import { startScheduler } from './sync/scheduler'

// ---------------------------------------------------------------------------
// Route imports
// ---------------------------------------------------------------------------
import orgsRouter from './routes/orgs'
import objectsRouter from './routes/objects'
import syncRouter from './routes/sync'
import logsRouter from './routes/logs'
import schedulesRouter from './routes/schedules'
import settingsRouter from './routes/settings'
import syncOrderRouter from './routes/syncOrder'

// ---------------------------------------------------------------------------
// CORS helper — allow localhost origins only
// ---------------------------------------------------------------------------

function isLocalhostOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  try {
    const url = new URL(origin)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
})

const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
})

export function createApp() {
  const app = express()

  // HTTP security headers — CSP disabled to allow the bundled React SPA to load
  app.use(helmet({ contentSecurityPolicy: false }))

  // JSON body parser
  app.use(express.json({ limit: '100kb' }))

  // Rate limiting
  app.use('/api', globalLimiter)
  app.use('/api/sync', syncLimiter)

  // CORS — allow http://localhost:* origins only
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin
    if (isLocalhostOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin as string)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  // ---------------------------------------------------------------------------
  // API routes
  // ---------------------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.use('/api/orgs', orgsRouter)
  app.use('/api/objects', objectsRouter)
  app.use('/api/sync', syncRouter)
  app.use('/api/logs', logsRouter)
  app.use('/api/schedules', schedulesRouter)
  app.use('/api/settings', settingsRouter)
  app.use('/api/sync-order', syncOrderRouter)

  // ---------------------------------------------------------------------------
  // SPA static file serving — must come after all /api routes
  // ---------------------------------------------------------------------------

  const publicDir = path.join(__dirname, 'public')
  app.use(express.static(publicDir))

  // SPA fallback — all non-API GET requests return index.html
  app.get(/^(?!\/api).*$/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'))
  })

  // ---------------------------------------------------------------------------
  // Global error handler
  // ---------------------------------------------------------------------------

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[API error]', err)

    if (err instanceof Error) {
      const anyErr = err as Error & { status?: number; errorCode?: string }
      const isSfSessionExpired =
        anyErr.errorCode === 'INVALID_SESSION_ID' ||
        /INVALID_SESSION_ID|Session expired or invalid/i.test(err.message)
      if (isSfSessionExpired) {
        res.status(401).json({ error: 'Salesforce session expired', code: 'SF_SESSION_EXPIRED' })
        return
      }
      const status = anyErr.status ?? 500
      res.status(status).json({ error: err.message })
    } else {
      res.status(500).json({ error: 'Internal server error', details: err })
    }
  })

  return app
}

// ---------------------------------------------------------------------------
// Startup: wire scheduler if an active org is configured
// ---------------------------------------------------------------------------

export async function initApp(): Promise<void> {
  try {
    await migrateToMultiOrg()
    await ensureSyncLockRows()
  } catch (err) {
    console.error('[startup] Migration failed:', (err as Error).message)
  }

  try {
    // Release any stale locks left by a process killed mid-sync (works on
    // both legacy single-row and new per-org sync_lock shapes).
    await pool.query(
      `UPDATE sfdb.sync_lock
       SET locked = false, locked_at = NULL, job_type = NULL
       WHERE locked = true`
    )
    await pool.query(
      `UPDATE sfdb.sync_log
       SET completed_at = NOW(),
           error = 'Interrupted by process restart',
           phase = 'complete'
       WHERE completed_at IS NULL`
    )
    console.log('[startup] Cleared any stale sync lock / open log entries')
  } catch (err) {
    console.warn('[startup] Could not clear stale sync state:', (err as Error).message)
  }

  try {
    startScheduler()
  } catch (err) {
    console.warn('[startup] Could not start scheduler:', (err as Error).message)
  }
}
