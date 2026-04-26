import { Request, Response } from 'express'
import { pool } from '../db/pool'

/**
 * Resolve the org id for a request. Prefer the `X-Org-Id` header (UI-supplied
 * context); fall back to the persisted `sfdb.active_org` pointer.
 *
 * Sends a 400 response and returns null if no org context can be resolved.
 * Verifies the org id is registered in `sfdb.orgs`.
 */
export async function requireOrgId(req: Request, res: Response): Promise<string | null> {
  const headerVal = req.header('x-org-id')
  let orgId = typeof headerVal === 'string' && headerVal.trim().length > 0 ? headerVal.trim() : null

  if (!orgId) {
    const result = await pool.query<{ org_id: string | null }>(
      `SELECT org_id FROM sfdb.active_org WHERE id = 1`
    )
    orgId = result.rows[0]?.org_id ?? null
  }

  if (!orgId) {
    res.status(400).json({ error: 'No active org configured' })
    return null
  }

  const verify = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM sfdb.orgs WHERE org_id = $1) AS exists`,
    [orgId]
  )
  if (!verify.rows[0]?.exists) {
    res.status(400).json({ error: `Org "${orgId}" is not registered` })
    return null
  }

  return orgId
}

export interface OrgRow {
  org_id: string
  alias: string | null
  username: string
  instance_url: string
  schema_name: string
}

export async function readOrg(orgId: string): Promise<OrgRow | null> {
  const result = await pool.query<OrgRow>(
    `SELECT org_id, alias, username, instance_url, schema_name
     FROM sfdb.orgs WHERE org_id = $1`,
    [orgId]
  )
  return result.rows[0] ?? null
}
