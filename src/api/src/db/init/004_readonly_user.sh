#!/bin/bash
# 004_readonly_user.sh
# Creates a read-only role that the API will later grant per-org-schema
# privileges to as orgs are registered. Per-schema grants happen at runtime
# in the API (see ddlManager.createOrgSchema).
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
EOSQL

echo "Read-only user 'sfdb_readonly' created. Per-schema grants are issued by the API on org registration."
