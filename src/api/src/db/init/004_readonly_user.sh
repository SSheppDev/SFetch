#!/bin/bash
# 004_readonly_user.sh
# Creates a read-only role scoped to the salesforce schema.
# Runs once on first Postgres container start via docker-entrypoint-initdb.d.
# Requires READONLY_PASSWORD env var to be set.

set -e

if [ -z "$READONLY_PASSWORD" ]; then
  echo "READONLY_PASSWORD not set — skipping read-only user creation"
  exit 0
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE sfdb_readonly WITH LOGIN PASSWORD '$READONLY_PASSWORD';

  GRANT CONNECT ON DATABASE $POSTGRES_DB TO sfdb_readonly;
  GRANT USAGE ON SCHEMA salesforce TO sfdb_readonly;
  GRANT SELECT ON ALL TABLES IN SCHEMA salesforce TO sfdb_readonly;

  -- auto-grant SELECT on tables created in the future
  ALTER DEFAULT PRIVILEGES IN SCHEMA salesforce
    GRANT SELECT ON TABLES TO sfdb_readonly;
EOSQL

echo "Read-only user 'sfdb_readonly' created."
