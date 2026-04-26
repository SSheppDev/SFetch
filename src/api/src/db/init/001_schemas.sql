-- 001_schemas.sql
-- Create the sfdb metadata schema. Per-org data schemas (org_<orgid>) are
-- created at runtime by the API when an org is registered.
-- Runs once on first Postgres container start via docker-entrypoint-initdb.d.

CREATE SCHEMA IF NOT EXISTS sfdb;
