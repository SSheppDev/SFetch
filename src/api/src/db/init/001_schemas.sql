-- 001_schemas.sql
-- Create top-level schemas for the sf-db pipeline.
-- Runs once on first Postgres container start via docker-entrypoint-initdb.d.

-- salesforce: all synced Salesforce object tables live here
CREATE SCHEMA IF NOT EXISTS salesforce;

-- sfdb: internal app metadata tables (config, sync state, logs, lock)
CREATE SCHEMA IF NOT EXISTS sfdb;
