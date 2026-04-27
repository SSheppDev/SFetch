-- 002_sfdb_tables.sql
-- Internal metadata tables for the sfdb pipeline.
-- All per-object/per-field state is keyed by (org_id, ...) so multiple
-- Salesforce orgs can coexist in the same database with isolated schemas.
-- Runs once on first Postgres container start via docker-entrypoint-initdb.d.

-- ---------------------------------------------------------------------------
-- sfdb.orgs — registry of every Salesforce org configured in this database
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.orgs (
    org_id        text        PRIMARY KEY,
    alias         text,
    username      text        NOT NULL,
    instance_url  text        NOT NULL,
    schema_name   text        NOT NULL UNIQUE,
    added_at      timestamptz NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- sfdb.active_org — single-row pointer to the org currently selected in the UI
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.active_org (
    id     integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    org_id text    REFERENCES sfdb.orgs(org_id) ON DELETE SET NULL
);

INSERT INTO sfdb.active_org (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- sfdb.app_config — global key/value runtime config (not per-org)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.app_config (
    key   text PRIMARY KEY,
    value text
);

INSERT INTO sfdb.app_config (key, value) VALUES
    ('auto_sync_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- sfdb.sync_config — per-org, per-object sync state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.sync_config (
    org_id                 text        NOT NULL REFERENCES sfdb.orgs(org_id) ON DELETE CASCADE,
    object_api_name        text        NOT NULL,
    enabled                boolean     NOT NULL DEFAULT false,
    last_delta_sync        timestamptz,
    last_full_sync         timestamptz,
    delta_interval_minutes integer     NOT NULL DEFAULT 60,
    full_interval_hours    integer     NOT NULL DEFAULT 24,
    sync_order             integer     NOT NULL DEFAULT 0,
    has_system_modstamp    boolean     NOT NULL DEFAULT true,
    has_created_date       boolean     NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT NOW(),
    updated_at             timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, object_api_name)
);

-- ---------------------------------------------------------------------------
-- sfdb.field_config — per-org, per-field enabled state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.field_config (
    org_id           text        NOT NULL REFERENCES sfdb.orgs(org_id) ON DELETE CASCADE,
    object_api_name  text        NOT NULL,
    field_api_name   text        NOT NULL,
    pg_column_name   text        NOT NULL,
    enabled          boolean     NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, object_api_name, field_api_name)
);

-- ---------------------------------------------------------------------------
-- sfdb.field_metadata — per-org cached Salesforce field metadata
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.field_metadata (
    org_id           text        NOT NULL REFERENCES sfdb.orgs(org_id) ON DELETE CASCADE,
    object_api_name  text        NOT NULL,
    field_api_name   text        NOT NULL,
    label            text        NOT NULL,
    sf_type          text        NOT NULL,
    pg_type          text        NOT NULL,
    nullable         boolean     NOT NULL DEFAULT true,
    cached_at        timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, object_api_name, field_api_name)
);

-- ---------------------------------------------------------------------------
-- sfdb.sync_log — record of every sync run; purged on schedule
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.sync_log (
    id               serial      PRIMARY KEY,
    org_id           text        NOT NULL REFERENCES sfdb.orgs(org_id) ON DELETE CASCADE,
    object_api_name  text        NOT NULL,
    sync_type        text        NOT NULL CHECK (sync_type IN ('delta', 'full')),
    started_at       timestamptz NOT NULL DEFAULT NOW(),
    completed_at     timestamptz,
    records_upserted integer     NOT NULL DEFAULT 0,
    records_deleted  integer     NOT NULL DEFAULT 0,
    total_records    integer,
    phase            text        NOT NULL DEFAULT 'initializing',
    error            text
);

CREATE INDEX IF NOT EXISTS sync_log_org_object_started_idx
    ON sfdb.sync_log (org_id, object_api_name, started_at DESC);

CREATE INDEX IF NOT EXISTS sync_log_started_idx
    ON sfdb.sync_log (started_at DESC);

-- ---------------------------------------------------------------------------
-- sfdb.sync_lock — concurrency guard, one row per registered org
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.sync_lock (
    org_id    text        PRIMARY KEY REFERENCES sfdb.orgs(org_id) ON DELETE CASCADE,
    locked    boolean     NOT NULL DEFAULT false,
    locked_at timestamptz,
    job_type  text
);
