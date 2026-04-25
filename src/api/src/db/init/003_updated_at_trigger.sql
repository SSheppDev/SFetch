-- 003_updated_at_trigger.sql
-- Reusable trigger function that stamps updated_at = NOW() on row changes.
-- Applied to sfdb.sync_config (and any future table that needs it).

CREATE OR REPLACE FUNCTION sfdb.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Apply to sfdb.sync_config
DROP TRIGGER IF EXISTS trg_sync_config_updated_at ON sfdb.sync_config;

CREATE TRIGGER trg_sync_config_updated_at
    BEFORE UPDATE ON sfdb.sync_config
    FOR EACH ROW
    EXECUTE FUNCTION sfdb.set_updated_at();
