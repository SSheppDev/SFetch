import { Router, Request, Response, NextFunction } from 'express'
import { isSfCliMounted, listOrgs, getOrgToken } from '../auth/sfAuth'
import { pool } from '../db/pool'

const router = Router()

// ---------------------------------------------------------------------------
// GET /api/orgs
// List all orgs detected from ~/.sf — used by the onboarding picker
// ---------------------------------------------------------------------------

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const mounted = await isSfCliMounted()
    if (!mounted) {
      res.json({ mounted: false, orgs: [] })
      return
    }
    const orgs = await listOrgs()
    res.json({ mounted: true, orgs })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/orgs/active
// Return the currently configured active org alias
// ---------------------------------------------------------------------------

router.get('/active', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query<{ value: string }>(
      `SELECT value FROM sfdb.app_config WHERE key = 'active_org_alias'`
    )
    const alias = result.rows[0]?.value ?? null
    res.json({ alias })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// POST /api/orgs/active
// Set the active org alias (validates the token works first)
// ---------------------------------------------------------------------------

router.post('/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { alias?: unknown }
    const alias = body.alias

    if (typeof alias !== 'string' || alias.trim().length === 0) {
      res.status(400).json({ error: 'alias is required' })
      return
    }

    // Validate the org token works before saving
    try {
      await getOrgToken(alias)
    } catch (err) {
      res.status(400).json({
        error: 'Could not authenticate with the selected org',
        details: (err as Error).message,
      })
      return
    }

    // Upsert active_org_alias into app_config
    await pool.query(
      `INSERT INTO sfdb.app_config (key, value)
       VALUES ('active_org_alias', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [alias]
    )

    // Also set auto_sync_enabled = 'true' if not already set
    await pool.query(
      `INSERT INTO sfdb.app_config (key, value)
       VALUES ('auto_sync_enabled', 'true')
       ON CONFLICT (key) DO NOTHING`
    )

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/orgs/status
// Check if an active org is configured and its token is still valid
// ---------------------------------------------------------------------------

router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query<{ value: string }>(
      `SELECT value FROM sfdb.app_config WHERE key = 'active_org_alias'`
    )
    const alias = result.rows[0]?.value ?? null

    if (!alias) {
      res.json({ configured: false })
      return
    }

    try {
      const token = await getOrgToken(alias)
      res.json({
        configured: true,
        alias,
        instanceUrl: token.instanceUrl,
        username: token.username,
        tokenValid: true,
      })
    } catch (err) {
      res.json({
        configured: true,
        alias,
        tokenValid: false,
        error: (err as Error).message,
      })
    }
  } catch (err) {
    next(err)
  }
})

export default router
