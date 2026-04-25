-- 002_sfdb_tables.sql
-- Create all internal metadata tables in the sfdb schema.
-- Runs once on first Postgres container start via docker-entrypoint-initdb.d.

-- ---------------------------------------------------------------------------
-- sfdb.app_config — key/value store for runtime configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.app_config (
    key   text PRIMARY KEY,
    value text
);

INSERT INTO sfdb.app_config (key, value) VALUES
    ('active_org_alias',  NULL),
    ('auto_sync_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- sfdb.sync_config — per-object sync state and schedule settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.sync_config (
    object_api_name        text        PRIMARY KEY,
    enabled                boolean     NOT NULL DEFAULT false,
    last_delta_sync        timestamptz,
    last_full_sync         timestamptz,
    delta_interval_minutes integer     NOT NULL DEFAULT 60,
    full_interval_hours    integer     NOT NULL DEFAULT 24,
    sync_order             integer     NOT NULL DEFAULT 0,
    created_at             timestamptz NOT NULL DEFAULT NOW(),
    updated_at             timestamptz NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- sfdb.field_config — per-field enabled state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.field_config (
    object_api_name  text        NOT NULL,
    field_api_name   text        NOT NULL,
    pg_column_name   text        NOT NULL,
    enabled          boolean     NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (object_api_name, field_api_name)
);

-- ---------------------------------------------------------------------------
-- sfdb.field_metadata — cached Salesforce field metadata
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.field_metadata (
    object_api_name  text        NOT NULL,
    field_api_name   text        NOT NULL,
    label            text        NOT NULL,
    sf_type          text        NOT NULL,
    pg_type          text        NOT NULL,
    nullable         boolean     NOT NULL DEFAULT true,
    cached_at        timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (object_api_name, field_api_name)
);

-- ---------------------------------------------------------------------------
-- sfdb.sync_log — record of every sync run; purged on schedule
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.sync_log (
    id               serial      PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS sync_log_object_started_idx
    ON sfdb.sync_log (object_api_name, started_at DESC);

-- ---------------------------------------------------------------------------
-- sfdb.sync_lock — concurrency guard; enforced as a single row (id = 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdb.sync_lock (
    id        integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    locked    boolean     NOT NULL DEFAULT false,
    locked_at timestamptz,
    job_type  text
);

INSERT INTO sfdb.sync_lock (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
