import { Router, Request, Response, NextFunction } from 'express'
import { Connection } from 'jsforce'
import { pool } from '../db/pool'
import { getOrgToken } from '../auth/sfAuth'
import * as ddlManager from '../sync/ddlManager'
import { requireOrgId, readOrg } from './_orgContext'

const router = Router()

// ---------------------------------------------------------------------------
// Helper — create a jsforce Connection for the given org
// ---------------------------------------------------------------------------

async function getConnectionForOrg(orgId: string): Promise<Connection> {
  const org = await readOrg(orgId)
  if (!org) {
    throw Object.assign(new Error(`Org "${orgId}" is not registered`), { status: 400 })
  }
  const authKey = org.alias ?? org.username
  const { accessToken, instanceUrl } = await getOrgToken(authKey)
  return new Connection({ accessToken, instanceUrl, version: '59.0' })
}

// ---------------------------------------------------------------------------
// SF fields that map to system columns — not user-configurable
// ---------------------------------------------------------------------------

const SF_SYSTEM_FIELDS = new Set(['Id', 'CreatedDate', 'SystemModstamp', 'IsDeleted'])

// Compound field types cannot be queried via Bulk API 2.0.
const SF_COMPOUND_TYPES = new Set(['address', 'location'])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncConfigRow {
  object_api_name: string
  enabled: boolean
  last_delta_sync: Date | null
  last_full_sync: Date | null
}

// ---------------------------------------------------------------------------
// GET /api/objects
// ---------------------------------------------------------------------------

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return

    const conn = await getConnectionForOrg(orgId)
    const globalDesc = await conn.describeGlobal()

    const filteredSObjects = globalDesc.sobjects.filter(
      (obj) => obj.queryable && obj.createable
    )

    const syncConfigResult = await pool.query<SyncConfigRow>(
      `SELECT object_api_name, enabled, last_delta_sync, last_full_sync
       FROM sfdb.sync_config WHERE org_id = $1`,
      [orgId]
    )
    const syncConfigMap = new Map<string, SyncConfigRow>()
    for (const row of syncConfigResult.rows) {
      syncConfigMap.set(row.object_api_name, row)
    }

    const objects = await Promise.all(
      filteredSObjects.map(async (obj) => {
        const syncConfig = syncConfigMap.get(obj.name) ?? null
        const rowCount = await ddlManager.getTableRowCount(orgId, obj.name)

        return {
          apiName: obj.name,
          label: obj.label,
          enabled: syncConfig?.enabled ?? false,
          lastDeltaSync: syncConfig?.last_delta_sync ?? null,
          lastFullSync: syncConfig?.last_full_sync ?? null,
          rowCount,
        }
      })
    )

    objects.sort((a, b) => a.label.localeCompare(b.label))

    res.json(objects)
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// PATCH /api/objects/:name
// ---------------------------------------------------------------------------

router.patch('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return

    const { name } = req.params
    const body = req.body as { enabled?: unknown; dropTable?: unknown }

    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' })
      return
    }

    const enabled: boolean = body.enabled
    const dropTableFlag = body.dropTable === true

    if (enabled) {
      const conn = await getConnectionForOrg(orgId)
      const desc = await conn.sobject(name).describe()

      const fieldNames = new Set(desc.fields.map((f) => f.name))
      const hasSystemModstamp = fieldNames.has('SystemModstamp')
      const hasCreatedDate    = fieldNames.has('CreatedDate')

      await pool.query(
        `INSERT INTO sfdb.sync_config (org_id, object_api_name, enabled, has_system_modstamp, has_created_date)
         VALUES ($1, $2, true, $3, $4)
         ON CONFLICT (org_id, object_api_name) DO UPDATE
           SET enabled = true, has_system_modstamp = $3, has_created_date = $4`,
        [orgId, name, hasSystemModstamp, hasCreatedDate]
      )

      for (const field of desc.fields) {
        if (SF_SYSTEM_FIELDS.has(field.name)) continue
        if (SF_COMPOUND_TYPES.has((field.type as string).toLowerCase())) continue
        const pgType = ddlManager.sfTypeToPg(field.type as string)

        await pool.query(
          `INSERT INTO sfdb.field_config (org_id, object_api_name, field_api_name, pg_column_name, enabled)
           VALUES ($1, $2, $3, $4, true)
           ON CONFLICT (org_id, object_api_name, field_api_name) DO NOTHING`,
          [orgId, name, field.name, field.name.toLowerCase()]
        )

        await pool.query(
          `INSERT INTO sfdb.field_metadata (org_id, object_api_name, field_api_name, label, sf_type, pg_type, nullable, cached_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (org_id, object_api_name, field_api_name) DO UPDATE
             SET label = $4, sf_type = $5, pg_type = $6, nullable = $7, cached_at = NOW()`,
          [orgId, name, field.name, field.label, field.type, pgType, field.nillable]
        )
      }

      const enabledFields = desc.fields
        .filter((f) => !SF_SYSTEM_FIELDS.has(f.name) && !SF_COMPOUND_TYPES.has((f.type as string).toLowerCase()))
        .map((f) => ({ apiName: f.name, sfType: f.type as string }))

      await ddlManager.createObjectTable(orgId, name, enabledFields)
    } else {
      await pool.query(
        `UPDATE sfdb.sync_config SET enabled = false
         WHERE org_id = $1 AND object_api_name = $2`,
        [orgId, name]
      )

      if (dropTableFlag) {
        await ddlManager.dropTable(orgId, name)
      }
    }

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/objects/:name/fields
// ---------------------------------------------------------------------------

router.get('/:name/fields', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return

    const { name } = req.params

    const conn = await getConnectionForOrg(orgId)
    const desc = await conn.sobject(name).describe()

    const fieldConfigResult = await pool.query<{
      field_api_name: string
      enabled: boolean
    }>(
      `SELECT field_api_name, enabled FROM sfdb.field_config
       WHERE org_id = $1 AND object_api_name = $2`,
      [orgId, name]
    )
    const fieldConfigMap = new Map<string, boolean>()
    for (const row of fieldConfigResult.rows) {
      fieldConfigMap.set(row.field_api_name, row.enabled)
    }

    const metaResult = await pool.query<{
      field_api_name: string
      pg_type: string
    }>(
      `SELECT field_api_name, pg_type FROM sfdb.field_metadata
       WHERE org_id = $1 AND object_api_name = $2`,
      [orgId, name]
    )
    const pgTypeMap = new Map<string, string>()
    for (const row of metaResult.rows) {
      pgTypeMap.set(row.field_api_name, row.pg_type)
    }

    const fields = desc.fields.map((field) => ({
      apiName: field.name,
      label: field.label,
      sfType: field.type,
      pgType: pgTypeMap.get(field.name) ?? ddlManager.sfTypeToPg(field.type as string),
      enabled: fieldConfigMap.get(field.name) ?? true,
      nullable: field.nillable,
    }))

    res.json(fields)
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// PATCH /api/objects/:name/fields/:field
// ---------------------------------------------------------------------------

router.patch('/:name/fields/:field', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = await requireOrgId(req, res)
    if (!orgId) return

    const { name, field } = req.params
    const body = req.body as { enabled?: unknown }

    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' })
      return
    }

    const enabled: boolean = body.enabled

    await pool.query(
      `UPDATE sfdb.field_config SET enabled = $1
       WHERE org_id = $2 AND object_api_name = $3 AND field_api_name = $4`,
      [enabled, orgId, name, field]
    )

    if (!enabled) {
      await ddlManager.dropColumn(orgId, name, field)
    } else {
      const metaResult = await pool.query<{ sf_type: string }>(
        `SELECT sf_type FROM sfdb.field_metadata
         WHERE org_id = $1 AND object_api_name = $2 AND field_api_name = $3`,
        [orgId, name, field]
      )
      const sfType = metaResult.rows[0]?.sf_type ?? 'string'
      await ddlManager.addColumn(orgId, name, field, sfType)
    }

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
