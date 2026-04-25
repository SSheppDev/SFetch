import { Router, Request, Response, NextFunction } from 'express'
import { Connection } from 'jsforce'
import { pool } from '../db/pool'
import { getOrgToken } from '../auth/sfAuth'
import * as ddlManager from '../sync/ddlManager'

const router = Router()

// ---------------------------------------------------------------------------
// Helper — create a jsforce Connection for the active org
// ---------------------------------------------------------------------------

async function getConnection(): Promise<Connection> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM sfdb.app_config WHERE key = 'active_org_alias'`
  )
  const alias = result.rows[0]?.value
  if (!alias) {
    throw Object.assign(new Error('No active org configured'), { status: 400 })
  }
  const { accessToken, instanceUrl } = await getOrgToken(alias)
  return new Connection({ accessToken, instanceUrl, version: '59.0' })
}

// ---------------------------------------------------------------------------
// SF fields that map to system columns — not user-configurable
// ---------------------------------------------------------------------------

const SF_SYSTEM_FIELDS = new Set(['Id', 'CreatedDate', 'SystemModstamp', 'IsDeleted'])

// Compound field types cannot be queried via Bulk API 2.0.
// Their component fields (BillingStreet, BillingCity, etc.) are included individually.
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
// List all queryable+createable sObjects with sync status and row counts
// ---------------------------------------------------------------------------

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const conn = await getConnection()
    const globalDesc = await conn.describeGlobal()

    // Filter to queryable + createable sObjects
    const filteredSObjects = globalDesc.sobjects.filter(
      (obj) => obj.queryable && obj.createable
    )

    // Load sync_config rows for all objects
    const syncConfigResult = await pool.query<SyncConfigRow>(
      `SELECT object_api_name, enabled, last_delta_sync, last_full_sync
       FROM sfdb.sync_config`
    )
    const syncConfigMap = new Map<string, SyncConfigRow>()
    for (const row of syncConfigResult.rows) {
      syncConfigMap.set(row.object_api_name, row)
    }

    // Build result array
    const objects = await Promise.all(
      filteredSObjects.map(async (obj) => {
        const syncConfig = syncConfigMap.get(obj.name) ?? null
        const rowCount = await ddlManager.getTableRowCount(obj.name)

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

    // Sort by label
    objects.sort((a, b) => a.label.localeCompare(b.label))

    res.json(objects)
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// PATCH /api/objects/:name
// Enable or disable sync for an object; optionally drop its table
// ---------------------------------------------------------------------------

router.patch('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params
    const body = req.body as { enabled?: unknown; dropTable?: unknown }

    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' })
      return
    }

    const enabled: boolean = body.enabled
    const dropTableFlag = body.dropTable === true

    if (enabled) {
      // Describe the object fields via jsforce first so we can detect capabilities
      const conn = await getConnection()
      const desc = await conn.sobject(name).describe()

      const fieldNames = new Set(desc.fields.map((f) => f.name))
      const hasSystemModstamp = fieldNames.has('SystemModstamp')
      const hasCreatedDate    = fieldNames.has('CreatedDate')

      // Upsert sync_config with enabled = true and detected audit capabilities
      await pool.query(
        `INSERT INTO sfdb.sync_config (object_api_name, enabled, has_system_modstamp, has_created_date)
         VALUES ($1, true, $2, $3)
         ON CONFLICT (object_api_name) DO UPDATE
           SET enabled = true, has_system_modstamp = $2, has_created_date = $3`,
        [name, hasSystemModstamp, hasCreatedDate]
      )

      // Upsert all fields into field_config and field_metadata (skip system and compound fields)
      for (const field of desc.fields) {
        if (SF_SYSTEM_FIELDS.has(field.name)) continue
        if (SF_COMPOUND_TYPES.has((field.type as string).toLowerCase())) continue
        const pgType = ddlManager.sfTypeToPg(field.type as string)

        await pool.query(
          `INSERT INTO sfdb.field_config (object_api_name, field_api_name, pg_column_name, enabled)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (object_api_name, field_api_name) DO NOTHING`,
          [name, field.name, field.name.toLowerCase()]
        )

        await pool.query(
          `INSERT INTO sfdb.field_metadata (object_api_name, field_api_name, label, sf_type, pg_type, nullable, cached_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (object_api_name, field_api_name) DO UPDATE
             SET label = $3, sf_type = $4, pg_type = $5, nullable = $6, cached_at = NOW()`,
          [name, field.name, field.label, field.type, pgType, field.nillable]
        )
      }

      // Create PG table via DDL manager (skip system and compound fields)
      const enabledFields = desc.fields
        .filter((f) => !SF_SYSTEM_FIELDS.has(f.name) && !SF_COMPOUND_TYPES.has((f.type as string).toLowerCase()))
        .map((f) => ({ apiName: f.name, sfType: f.type as string }))

      await ddlManager.createObjectTable(name, enabledFields)
    } else {
      // Disable sync
      await pool.query(
        `UPDATE sfdb.sync_config SET enabled = false WHERE object_api_name = $1`,
        [name]
      )

      if (dropTableFlag) {
        await ddlManager.dropTable(name)
      }
    }

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/objects/:name/fields
// List fields for an object with enabled state and type info
// ---------------------------------------------------------------------------

router.get('/:name/fields', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params

    const conn = await getConnection()
    const desc = await conn.sobject(name).describe()

    // Load field_config rows for this object
    const fieldConfigResult = await pool.query<{
      field_api_name: string
      enabled: boolean
    }>(
      `SELECT field_api_name, enabled FROM sfdb.field_config WHERE object_api_name = $1`,
      [name]
    )
    const fieldConfigMap = new Map<string, boolean>()
    for (const row of fieldConfigResult.rows) {
      fieldConfigMap.set(row.field_api_name, row.enabled)
    }

    // Load cached pg_type from field_metadata
    const metaResult = await pool.query<{
      field_api_name: string
      pg_type: string
    }>(
      `SELECT field_api_name, pg_type FROM sfdb.field_metadata WHERE object_api_name = $1`,
      [name]
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
// Enable or disable a specific field
// ---------------------------------------------------------------------------

router.patch('/:name/fields/:field', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, field } = req.params
    const body = req.body as { enabled?: unknown }

    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' })
      return
    }

    const enabled: boolean = body.enabled

    // Update field_config
    await pool.query(
      `UPDATE sfdb.field_config SET enabled = $1
       WHERE object_api_name = $2 AND field_api_name = $3`,
      [enabled, name, field]
    )

    if (!enabled) {
      // Drop column from PG table
      await ddlManager.dropColumn(name, field)
    } else {
      // Re-enable: look up sfType from field_metadata and add column
      const metaResult = await pool.query<{ sf_type: string }>(
        `SELECT sf_type FROM sfdb.field_metadata
         WHERE object_api_name = $1 AND field_api_name = $2`,
        [name, field]
      )
      const sfType = metaResult.rows[0]?.sf_type ?? 'string'
      await ddlManager.addColumn(name, field, sfType)
    }

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
