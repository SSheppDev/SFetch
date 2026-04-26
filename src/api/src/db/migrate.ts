import { pool } from './pool'
import { listOrgs } from '../auth/sfAuth'

// ---------------------------------------------------------------------------
// Schema-name helpers (also used by ddlManager — kept here to avoid a cycle)
// ---------------------------------------------------------------------------

const ORG_ID_RE = /^[A-Za-z0-9]{15,18}$/

export function schemaNameForOrgId(orgId: string): string {
  if (!ORG_ID_RE.test(orgId)) {
    throw new Error(`migrate: invalid Salesforce org id "${orgId}"`)
  }
  return `org_${orgId.toLowerCase()}`
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

async function columnExists(
  schema: string,
  table: string,
  column: string
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
     ) AS exists`,
    [schema, table, column]
  )
  return result.rows[0]?.exists ?? false
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2
     ) AS exists`,
    [schema, table]
  )
  return result.rows[0]?.exists ?? false
}

async function schemaExists(schema: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
     ) AS exists`,
    [schema]
  )
  return result.rows[0]?.exists ?? false
}

async function readonlyRoleExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sfdb_readonly') AS exists`
  )
  return result.rows[0]?.exists ?? false
}

// ---------------------------------------------------------------------------
// Migration entry point — runs at API startup
// ---------------------------------------------------------------------------

/**
 * Bring an existing single-org sfdb database forward to the multi-org layout.
 *
 * Idempotent: if `sfdb.sync_config.org_id` already exists, returns immediately.
 *
 * If migration is needed but cannot complete (no active org alias on record,
 * or the alias can't be resolved to an org id via ~/.sfdx), the migration
 * is rolled back and a warning is logged. A subsequent call after the user
 * authenticates the missing org will retry.
 */
export async function migrateToMultiOrg(): Promise<void> {
  // Ensure the sfdb schema exists at all (fresh install without init may skip this)
  if (!(await schemaExists('sfdb'))) {
    console.log('[migrate] sfdb schema missing — fresh DB, nothing to migrate')
    return
  }

  // If sync_config already has org_id, the new shape is in place.
  const alreadyMigrated = await columnExists('sfdb', 'sync_config', 'org_id')
  if (alreadyMigrated) return

  console.log('[migrate] Detected pre-multi-org schema — beginning forward migration')

  // 1) Resolve the legacy active_org_alias before opening a transaction
  const aliasRow = await pool.query<{ value: string | null }>(
    `SELECT value FROM sfdb.app_config WHERE key = 'active_org_alias'`
  ).catch(() => ({ rows: [] as Array<{ value: string | null }> }))
  const legacyAlias = aliasRow.rows[0]?.value ?? null

  if (!legacyAlias) {
    console.warn(
      '[migrate] No active_org_alias found in sfdb.app_config — applying schema changes only ' +
        'and registering no org. Existing salesforce.* data (if any) will not be claimed by any org until ' +
        'the user manually adopts it.'
    )
  }

  // Resolve alias → SfOrg via ~/.sfdx
  let resolvedOrgId: string | null = null
  let resolvedUsername: string | null = null
  let resolvedInstanceUrl: string | null = null

  if (legacyAlias) {
    const orgs = await listOrgs()
    const match = orgs.find(
      (o) => o.alias === legacyAlias || o.username === legacyAlias
    )
    if (!match) {
      console.warn(
        `[migrate] Could not resolve alias "${legacyAlias}" to an org id from ~/.sfdx. ` +
          'Skipping migration — re-authenticate the org with `sf org login web --alias ' +
          legacyAlias +
          '` and restart.'
      )
      return
    }
    resolvedOrgId = match.orgId
    resolvedUsername = match.username
    resolvedInstanceUrl = match.instanceUrl
  }

  const targetSchema = resolvedOrgId ? schemaNameForOrgId(resolvedOrgId) : null

  // 2) Apply schema changes inside a single transaction
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Create sfdb.orgs (no FKs yet — we add them after backfill)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sfdb.orgs (
        org_id        text        PRIMARY KEY,
        alias         text,
        username      text        NOT NULL,
        instance_url  text        NOT NULL,
        schema_name   text        NOT NULL UNIQUE,
        added_at      timestamptz NOT NULL DEFAULT NOW()
      )
    `)

    // Create sfdb.active_org
    await client.query(`
      CREATE TABLE IF NOT EXISTS sfdb.active_org (
        id     integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        org_id text
      )
    `)
    await client.query(
      `INSERT INTO sfdb.active_org (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
    )

    if (resolvedOrgId && resolvedUsername && resolvedInstanceUrl && targetSchema) {
      await client.query(
        `INSERT INTO sfdb.orgs (org_id, alias, username, instance_url, schema_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id) DO NOTHING`,
        [resolvedOrgId, legacyAlias, resolvedUsername, resolvedInstanceUrl, targetSchema]
      )
    }

    // Add org_id columns to per-object tables (nullable for now; backfill next)
    for (const t of ['sync_config', 'field_config', 'field_metadata', 'sync_log']) {
      await client.query(`ALTER TABLE sfdb.${t} ADD COLUMN IF NOT EXISTS org_id text`)
    }

    // Add audit-detection columns on sync_config if a very old install lacks them
    await client.query(`
      ALTER TABLE sfdb.sync_config
        ADD COLUMN IF NOT EXISTS has_system_modstamp boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS has_created_date    boolean NOT NULL DEFAULT true
    `)

    // Backfill org_id on existing rows (only meaningful when we resolved an org)
    if (resolvedOrgId) {
      for (const t of ['sync_config', 'field_config', 'field_metadata', 'sync_log']) {
        await client.query(
          `UPDATE sfdb.${t} SET org_id = $1 WHERE org_id IS NULL`,
          [resolvedOrgId]
        )
      }
    }

    // Tables with no rows are fine to set NOT NULL even without backfill;
    // tables WITH rows but no resolved org will fail here, which is correct —
    // the migration must roll back rather than leave dangling state.
    for (const t of ['sync_config', 'field_config', 'field_metadata', 'sync_log']) {
      await client.query(`ALTER TABLE sfdb.${t} ALTER COLUMN org_id SET NOT NULL`)
    }

    // Swap PKs to composite, add FKs to sfdb.orgs
    await client.query(`
      ALTER TABLE sfdb.sync_config
        DROP CONSTRAINT IF EXISTS sync_config_pkey,
        ADD PRIMARY KEY (org_id, object_api_name),
        ADD CONSTRAINT sync_config_org_fk
          FOREIGN KEY (org_id) REFERENCES sfdb.orgs(org_id) ON DELETE CASCADE
    `)
    await client.query(`
      ALTER TABLE sfdb.field_config
        DROP CONSTRAINT IF EXISTS field_config_pkey,
        ADD PRIMARY KEY (org_id, object_api_name, field_api_name),
        ADD CONSTRAINT field_config_org_fk
          FOREIGN KEY (org_id) REFERENCES sfdb.orgs(org_id) ON DELETE CASCADE
    `)
    await client.query(`
      ALTER TABLE sfdb.field_metadata
        DROP CONSTRAINT IF EXISTS field_metadata_pkey,
        ADD PRIMARY KEY (org_id, object_api_name, field_api_name),
        ADD CONSTRAINT field_metadata_org_fk
          FOREIGN KEY (org_id) REFERENCES sfdb.orgs(org_id) ON DELETE CASCADE
    `)
    await client.query(`
      ALTER TABLE sfdb.sync_log
        ADD CONSTRAINT sync_log_org_fk
          FOREIGN KEY (org_id) REFERENCES sfdb.orgs(org_id) ON DELETE CASCADE
    `)

    // sync_log: add new index, drop legacy index
    await client.query(`
      CREATE INDEX IF NOT EXISTS sync_log_org_object_started_idx
        ON sfdb.sync_log (org_id, object_api_name, started_at DESC)
    `)
    await client.query(
      `DROP INDEX IF EXISTS sfdb.sync_log_object_started_idx`
    )

    // Replace legacy single-row sync_lock with per-org table
    await client.query(`DROP TABLE IF EXISTS sfdb.sync_lock`)
    await client.query(`
      CREATE TABLE sfdb.sync_lock (
        org_id    text        PRIMARY KEY REFERENCES sfdb.orgs(org_id) ON DELETE CASCADE,
        locked    boolean     NOT NULL DEFAULT false,
        locked_at timestamptz,
        job_type  text
      )
    `)
    if (resolvedOrgId) {
      await client.query(
        `INSERT INTO sfdb.sync_lock (org_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [resolvedOrgId]
      )
    }

    // Rename the legacy `salesforce` schema to org_<id> if it exists
    if (resolvedOrgId && targetSchema) {
      const legacySchema = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'salesforce') AS exists`
      )
      if (legacySchema.rows[0]?.exists) {
        // If somehow the new schema already exists, leave the legacy schema alone
        // and log — the operator can resolve manually.
        const targetExists = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists`,
          [targetSchema]
        )
        if (targetExists.rows[0]?.exists) {
          throw new Error(
            `migrate: cannot rename legacy "salesforce" schema — target schema "${targetSchema}" already exists`
          )
        }
        await client.query(`ALTER SCHEMA salesforce RENAME TO ${targetSchema}`)
        console.log(`[migrate] Renamed schema salesforce -> ${targetSchema}`)
      }
    }

    // Point sfdb.active_org at the resolved org
    if (resolvedOrgId) {
      await client.query(
        `UPDATE sfdb.active_org SET org_id = $1 WHERE id = 1`,
        [resolvedOrgId]
      )
    }

    // Now we can add the FK on sfdb.active_org.org_id (deferred until orgs row exists)
    await client.query(`
      ALTER TABLE sfdb.active_org
        DROP CONSTRAINT IF EXISTS active_org_org_id_fkey,
        ADD CONSTRAINT active_org_org_id_fkey
          FOREIGN KEY (org_id) REFERENCES sfdb.orgs(org_id) ON DELETE SET NULL
    `)

    // Drop the legacy active_org_alias entry from app_config
    await client.query(
      `DELETE FROM sfdb.app_config WHERE key = 'active_org_alias'`
    )

    await client.query('COMMIT')
    console.log('[migrate] Forward migration committed')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // 3) Outside the transaction: grant readonly role on the new schema
  if (targetSchema && (await readonlyRoleExists())) {
    try {
      await pool.query(`GRANT USAGE ON SCHEMA ${targetSchema} TO sfdb_readonly`)
      await pool.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${targetSchema} TO sfdb_readonly`
      )
      await pool.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${targetSchema} GRANT SELECT ON TABLES TO sfdb_readonly`
      )
      console.log(`[migrate] Granted sfdb_readonly SELECT on ${targetSchema}`)
    } catch (err) {
      console.warn(
        `[migrate] Could not grant readonly role on ${targetSchema}: ${(err as Error).message}`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: ensure a sync_lock row exists for every registered org.
// Called on every startup so a row is present even if registration predates this code.
// ---------------------------------------------------------------------------

export async function ensureSyncLockRows(): Promise<void> {
  if (!(await tableExists('sfdb', 'sync_lock'))) return
  await pool.query(`
    INSERT INTO sfdb.sync_lock (org_id)
    SELECT org_id FROM sfdb.orgs
    ON CONFLICT (org_id) DO NOTHING
  `)
}
