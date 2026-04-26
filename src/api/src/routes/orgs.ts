import { Router, Request, Response, NextFunction } from 'express'
import { isSfCliMounted, listOrgs, getOrgToken } from '../auth/sfAuth'
import { pool } from '../db/pool'
import { schemaForOrg, createOrgSchema, dropOrgSchema } from '../sync/ddlManager'

const router = Router()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface OrgRow {
  org_id: string
  alias: string | null
  username: string
  instance_url: string
  schema_name: string
  added_at: Date
}

async function readActiveOrgId(): Promise<string | null> {
  const result = await pool.query<{ org_id: string | null }>(
    `SELECT org_id FROM sfdb.active_org WHERE id = 1`
  )
  return result.rows[0]?.org_id ?? null
}

async function readRegisteredOrg(orgId: string): Promise<OrgRow | null> {
  const result = await pool.query<OrgRow>(
    `SELECT org_id, alias, username, instance_url, schema_name, added_at
     FROM sfdb.orgs WHERE org_id = $1`,
    [orgId]
  )
  return result.rows[0] ?? null
}

// ---------------------------------------------------------------------------
// GET /api/orgs/available — sf CLI orgs detected on the host (not yet registered)
// ---------------------------------------------------------------------------

router.get('/available', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const mounted = await isSfCliMounted()
    if (!mounted) {
      res.json({ mounted: false, orgs: [] })
      return
    }
    const orgs = await listOrgs()

    const registered = await pool.query<{ org_id: string }>(`SELECT org_id FROM sfdb.orgs`)
    const registeredSet = new Set(registered.rows.map((r) => r.org_id))

    res.json({
      mounted: true,
      orgs: orgs.map((o) => ({ ...o, registered: registeredSet.has(o.orgId) })),
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/orgs — registered org list
// ---------------------------------------------------------------------------

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query<OrgRow>(
      `SELECT org_id, alias, username, instance_url, schema_name, added_at
       FROM sfdb.orgs ORDER BY added_at ASC`
    )
    const activeOrgId = await readActiveOrgId()
    res.json({
      orgs: result.rows.map((r) => ({
        orgId: r.org_id,
        alias: r.alias,
        username: r.username,
        instanceUrl: r.instance_url,
        schemaName: r.schema_name,
        addedAt: r.added_at,
        active: r.org_id === activeOrgId,
      })),
      activeOrgId,
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// POST /api/orgs — register an org and create its schema
// Body: { aliasOrUsername: string }
// ---------------------------------------------------------------------------

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { aliasOrUsername?: unknown }
    const aliasOrUsername = body.aliasOrUsername
    if (typeof aliasOrUsername !== 'string' || aliasOrUsername.trim().length === 0) {
      res.status(400).json({ error: 'aliasOrUsername is required' })
      return
    }

    const all = await listOrgs()
    const match = all.find(
      (o) => o.alias === aliasOrUsername || o.username === aliasOrUsername
    )
    if (!match) {
      res.status(404).json({ error: `Org "${aliasOrUsername}" not found in ~/.sfdx` })
      return
    }

    // Validate that we have a usable token for this org. The alias the picker
    // shows comes from ~/.sfdx/alias.json and may have been renamed since the
    // last `npm run export-tokens`, so fall back to username if alias lookup
    // fails — tokens.json is keyed by both.
    let lastErr: Error | null = null
    let resolved = false
    for (const key of [aliasOrUsername, match.alias, match.username].filter(
      (v): v is string => typeof v === 'string' && v.length > 0
    )) {
      try {
        await getOrgToken(key)
        resolved = true
        break
      } catch (err) {
        lastErr = err as Error
      }
    }
    if (!resolved) {
      res.status(400).json({
        error: 'Could not authenticate with the selected org',
        details:
          (lastErr?.message ?? 'no token entry found') +
          ' — refresh tokens by running `npm run export-tokens` on the host',
      })
      return
    }

    const schema = schemaForOrg(match.orgId)
    await pool.query(
      `INSERT INTO sfdb.orgs (org_id, alias, username, instance_url, schema_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id) DO UPDATE
         SET alias = EXCLUDED.alias,
             username = EXCLUDED.username,
             instance_url = EXCLUDED.instance_url`,
      [match.orgId, match.alias, match.username, match.instanceUrl, schema]
    )
    await pool.query(
      `INSERT INTO sfdb.sync_lock (org_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [match.orgId]
    )
    await createOrgSchema(match.orgId)

    // First registered org becomes active automatically
    const active = await readActiveOrgId()
    if (!active) {
      await pool.query(
        `UPDATE sfdb.active_org SET org_id = $1 WHERE id = 1`,
        [match.orgId]
      )
    }

    res.json({ ok: true, orgId: match.orgId, schemaName: schema })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// POST /api/orgs/:orgId/active — switch the UI's active org context
// ---------------------------------------------------------------------------

router.post('/:orgId/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const org = await readRegisteredOrg(orgId)
    if (!org) {
      res.status(404).json({ error: `Org "${orgId}" is not registered` })
      return
    }
    await pool.query(`UPDATE sfdb.active_org SET org_id = $1 WHERE id = 1`, [orgId])
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// DELETE /api/orgs/:orgId — drop the org's schema and unregister it
// Body (optional): { dropData?: boolean } default true
// ---------------------------------------------------------------------------

router.delete('/:orgId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const body = (req.body ?? {}) as { dropData?: unknown }
    const dropData = body.dropData !== false  // default true

    const org = await readRegisteredOrg(orgId)
    if (!org) {
      res.status(404).json({ error: `Org "${orgId}" is not registered` })
      return
    }

    if (dropData) {
      await dropOrgSchema(orgId)
    }
    // FKs from sfdb.orgs cascade to sync_config / field_config / field_metadata /
    // sync_log / sync_lock; sfdb.active_org.org_id is set to NULL.
    await pool.query(`DELETE FROM sfdb.orgs WHERE org_id = $1`, [orgId])

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/orgs/active — currently selected org context
// ---------------------------------------------------------------------------

router.get('/active', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await readActiveOrgId()
    if (!orgId) {
      res.json({ orgId: null })
      return
    }
    const org = await readRegisteredOrg(orgId)
    if (!org) {
      res.json({ orgId: null })
      return
    }
    res.json({
      orgId: org.org_id,
      alias: org.alias,
      username: org.username,
      instanceUrl: org.instance_url,
      schemaName: org.schema_name,
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/orgs/status — token validity for the active org
// ---------------------------------------------------------------------------

router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await readActiveOrgId()
    if (!orgId) {
      res.json({ configured: false })
      return
    }
    const org = await readRegisteredOrg(orgId)
    if (!org) {
      res.json({ configured: false })
      return
    }

    try {
      const authKey = org.alias ?? org.username
      const token = await getOrgToken(authKey)
      res.json({
        configured: true,
        orgId: org.org_id,
        alias: org.alias,
        instanceUrl: token.instanceUrl,
        username: token.username,
        tokenValid: true,
      })
    } catch (err) {
      res.json({
        configured: true,
        orgId: org.org_id,
        alias: org.alias,
        tokenValid: false,
        error: (err as Error).message,
      })
    }
  } catch (err) {
    next(err)
  }
})

export default router
