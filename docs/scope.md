# sfetch — Project Scope

## Overview

A locally-run, Docker-based Salesforce data pipeline that syncs Salesforce objects and fields into a local PostgreSQL database. The database is the product — external apps, BI tools, and query clients connect to it directly with DB credentials. Everything is configured through a React web UI served by the Express backend. No custom CLI required.

---

## Goals

- Pull Salesforce data into a local Postgres database on a configurable schedule
- Let external applications connect directly to Postgres — no intermediate API layer for data access
- Give the user full control over which objects and fields are synced via a web UI
- Track record deletions in Salesforce so the local DB stays accurate
- Leverage the `sf` CLI for authentication — no Salesforce credentials stored in the project
- Handle enterprise record volumes via Salesforce Bulk API 2.0
- Be self-contained, shareable (without data), and runnable with `docker compose up`

---

## How External Apps Access Data

Postgres is exposed on a configurable port (set in `.env`). Any application connects with standard Postgres credentials:

```
Host:      localhost
Port:      $POSTGRES_PORT
Database:  sfdb
Schema:    salesforce
User:      $POSTGRES_USER
Password:  $POSTGRES_PASSWORD
```

The internal API is not exposed for external data access. It only serves the web UI and sync orchestration.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Database | PostgreSQL (Docker) |
| Backend API | Node.js + TypeScript + Express |
| Web UI | React + TypeScript + shadcn/ui + Tailwind (served as static files by Express) |
| Salesforce Auth | `sf` CLI auth files — read directly from `~/.sf/` via Node `fs` |
| Salesforce Data | `jsforce` (Bulk API 2.0 + REST fallback) |
| Scheduling | `node-cron` |
| Containerization | Docker + Docker Compose |

---

## Directory Structure

```
sf-db/
├── docs/                          # Project documentation
├── src/
│   ├── api/                       # Express backend + sync engine (TypeScript)
│   └── ui/                        # React frontend (TypeScript + shadcn/ui)
├── docker/                        # Dockerfiles only
│   ├── Dockerfile.api
│   └── Dockerfile.ui
├── data/                          # LOCAL ONLY — git-ignored
│   ├── docker/                    # Postgres data volume mount
│   └── downloads/                 # Future: file exports, attachments
├── docker-compose.yml             # At project root — run from here
├── .env.example                   # Committed — template, no secrets
├── .env                           # Git-ignored — bootstrap config only
├── package.json
└── .gitignore
```

---

## Running the App

```bash
# Start everything
docker compose up -d

# Stop
docker compose down

# View logs
docker compose logs -f api

# Open UI
http://localhost:7743
```

No custom binary. No global install. Just Docker Compose.

---

## Ports

All configurable in `.env`. Defaults chosen to avoid common conflicts.

| Service | Default Port | Purpose |
|---|---|---|
| API + Web UI | `7743` | Express serves both the API and React static files |
| PostgreSQL | `7745` | External app + BI tool connections |

No separate UI container — Express serves the built React app from `dist/`.

---

## Environment Variables

`.env` holds only bootstrap config — values needed before the database exists. All runtime/dynamic config (active org, sync settings, schedules) lives in the database.

```env
# Database
POSTGRES_USER=sfdb
POSTGRES_PASSWORD=changeme
POSTGRES_PORT=7745

# App
APP_PORT=7743

# Sync log retention
LOG_RETENTION_DAYS=14
```

`.env.example` is committed with empty values as a template.

---

## Authentication Strategy

Authentication is fully delegated to the Salesforce `sf` CLI. No Salesforce credentials are stored in this project.

### How it works

1. User authenticates once in their terminal: `sf org login web --alias my-org`
2. `sf` CLI stores OAuth tokens as JSON files in `~/.sf/` on the host
3. `~/.sf` is bind-mounted read-only into the API container
4. The API reads the access token and instance URL **directly from the JSON files** via Node `fs` — no `sf` binary required in the container
5. Tokens are passed to `jsforce` for all Salesforce API calls

```yaml
# docker-compose.yml (api service)
volumes:
  - ~/.sf:/root/.sf:ro
```

No `sf` binary in the Docker image. No version coupling. Lightweight container.

### Config storage

The active org alias is stored in `sfdb.app_config` in the database — not in `.env`. `.env` is for infrastructure bootstrap only (ports, DB creds). Org selection and all other runtime config is persisted in the DB and survives container restarts.

### Error handling

| Scenario | Behavior |
|---|---|
| `~/.sf` not mounted or empty | Onboarding screen shown; instructions to run `sf org login web` |
| No org JSON files found | Same as above |
| Selected org file missing/corrupt | Error banner; prompt to re-authenticate the org |
| Token expired | Detected on first API call; banner shown in UI |

---

## Web UI — Pages & Flows

### Onboarding (first launch)

Shown automatically when no org is configured in `sfdb.app_config`.

1. API reads `~/.sf/` directory for org JSON files
2. If none found — error state with `sf org login web` instructions
3. If orgs found — display interactive org picker (alias, username, org type)
4. User selects org → alias saved to `sfdb.app_config` → proceed to Objects page

### Objects Page (`/objects`)

- Lists all Salesforce sObjects in the connected org
- Shows: API name, label, sync toggle, last sync time, local row count
- Enabling an object creates its Postgres table on next sync (or immediately on toggle)
- Disabling stops syncing; prompts to optionally drop the table

### Fields Page (`/objects/:apiName/fields`)

- Lists all fields on the selected object
- All fields **checked by default** when object is first enabled
- Unchecking a field:
  1. Drops the column from Postgres immediately (with confirmation)
  2. Updates `sfdb.field_config` to mark field disabled
  3. Removed from future SOQL queries
- Re-checking re-adds the column and backfills on next full sync

### Schedules Page (`/schedules`)

- Set delta sync interval (e.g. every 15 min, 1 hr, 6 hr)
- Set full reconciliation interval (e.g. nightly, weekly)
- Enable/disable auto-sync globally
- Trigger a manual sync (delta or full) via button
- Show next scheduled run times and last run results

### Logs Page (`/logs`)

- Live log stream (polling)
- Per-object: records upserted, deleted, errors, duration
- Filter by object, date range, status
- Logs auto-purged after `LOG_RETENTION_DAYS` (default: 14)

### Settings Page (`/settings`)

- Switch active org (re-runs onboarding picker)
- View Postgres connection details (host, port, user, password, DB name)
- Copy connection string for use in external tools

---

## Sync Engine

### Concurrency Lock

Only one sync can run at a time. Before starting any sync job:

1. Check `sfdb.sync_lock` — a single-row table with `locked_at` timestamp
2. If locked and `locked_at` is within the last 30 minutes — skip, log warning
3. If locked and stale (> 30 min) — assume previous job crashed, take the lock
4. On completion or error — always release the lock

### Delta Sync (frequent — default every 1 hr)

Catches creates and updates. Does not catch hard deletes.

```
Acquire sync lock
For each enabled object:
  1. Read last_delta_sync from sfdb.sync_config
  2. If NULL → initial full load: no WHERE clause (pulls all records)
     If set  → WHERE SystemModstamp >= :last_delta_sync
  3. SELECT <enabled fields> FROM <Object> [WHERE ...] ORDER BY SystemModstamp ASC
  4. Execute via Bulk API 2.0 query job
  5. Poll until complete, stream result CSV
  6. Batch upsert into Postgres (INSERT ... ON CONFLICT (id) DO UPDATE)
  7. Update last_delta_sync in sfdb.sync_config
Release sync lock
```

### Full ID Reconciliation (less frequent — default nightly)

Catches hard deletes, merges, and cascade deletes.

```
Acquire sync lock
For each enabled object:
  1. Bulk query: SELECT Id FROM <Object>
  2. SELECT id FROM salesforce.<object> WHERE sf_deleted_at IS NULL
  3. Diff: local_live - sf_live = deleted in Salesforce
  4. SET sf_deleted_at = NOW() on deleted rows
  5. Update last_full_sync in sfdb.sync_config
Release sync lock
```

### Bulk API 2.0

Default for all objects. Falls back to REST query for objects under 2,000 records.

```
POST   /services/data/vXX.0/jobs/query    → create job
GET    .../jobs/query/:jobId              → poll for Complete
GET    .../jobs/query/:jobId/results      → paginated CSV download
Stream CSV → parse → batch upsert into Postgres
```

### Schema Changes (DDL)

The sync engine manages schema changes directly with raw SQL — no migration framework.

| Event | DDL executed |
|---|---|
| Object enabled | `CREATE TABLE IF NOT EXISTS salesforce.<object> (id text PRIMARY KEY, ...)` |
| Object disabled + drop | `DROP TABLE salesforce.<object>` |
| Field re-enabled | `ALTER TABLE salesforce.<object> ADD COLUMN <field> <type>` |
| Field disabled | `ALTER TABLE salesforce.<object> DROP COLUMN <field>` |

DDL is idempotent where possible (`IF NOT EXISTS`, `IF EXISTS`).

---

## Postgres Schema

Synced data in `salesforce` schema. Internal metadata in `sfdb` schema.

### Per-object table (e.g. `salesforce.account`)

| Column | Type | Notes |
|---|---|---|
| `id` | `text PRIMARY KEY` | Salesforce 18-char ID |
| *(enabled fields)* | *(mapped type)* | Lowercased snake_case API names |
| `sf_created_at` | `timestamptz` | CreatedDate |
| `sf_updated_at` | `timestamptz` | SystemModstamp |
| `sf_deleted_at` | `timestamptz NULL` | NULL = live; set on deletion detected |
| `synced_at` | `timestamptz` | When this row was last written |

### Salesforce → Postgres type mapping

| Salesforce Type | Postgres Type |
|---|---|
| id, string, textarea, url, phone, email, picklist, reference | `text` |
| boolean | `boolean` |
| int | `integer` |
| double, currency, percent | `numeric` |
| date | `date` |
| datetime | `timestamptz` |
| multipicklist | `text[]` |
| base64 / attachments | deferred to v2 |

### Internal tables (`sfdb` schema)

**`sfdb.app_config`** — key/value store for runtime config
- `key` text PRIMARY KEY
- `value` text
- Stores: active org alias, global sync enabled/disabled

**`sfdb.sync_config`** — per-object sync state
- `object_api_name` text PRIMARY KEY
- `enabled` boolean
- `last_delta_sync` timestamptz
- `last_full_sync` timestamptz
- `delta_interval_minutes` integer
- `full_interval_hours` integer

**`sfdb.field_config`** — per-field enabled state
- `object_api_name` text
- `field_api_name` text
- `pg_column_name` text
- `enabled` boolean
- PRIMARY KEY (`object_api_name`, `field_api_name`)

**`sfdb.field_metadata`** — cached Salesforce field metadata
- `object_api_name` text
- `field_api_name` text
- `label` text
- `sf_type` text
- `pg_type` text
- `nullable` boolean
- `cached_at` timestamptz

**`sfdb.sync_log`** — record of every sync run
- `id` serial PRIMARY KEY
- `object_api_name` text
- `sync_type` text (`delta` | `full`)
- `started_at` timestamptz
- `completed_at` timestamptz
- `records_upserted` integer
- `records_deleted` integer
- `error` text
- Auto-purged: rows older than `LOG_RETENTION_DAYS` days deleted at start of each sync run

**`sfdb.sync_lock`** — concurrency guard
- Single row: `locked` boolean, `locked_at` timestamptz, `job_type` text

---

## Deletion Tracking

Deleted records are never removed from Postgres. Soft-deleted via `sf_deleted_at`.

| Scenario | Delta catches it? | Reconciliation catches it? |
|---|---|---|
| Record updated | Yes | Yes |
| Record hard deleted | No | Yes |
| Record merged (loser) | No | Yes |
| Cascade delete | No | Yes |
| Record undeleted | Yes (SystemModstamp changes) | Yes |

---

## Data Persistence & Git Strategy

| Path | Purpose | Git-tracked |
|---|---|---|
| `data/docker/` | Postgres data directory (Docker volume) | No |
| `data/downloads/` | Future file exports / attachments | No |
| `.env` | Ports, DB credentials, log retention | No |
| `.env.example` | Template for above | Yes |
| `src/` | All application source | Yes |
| `docker/` | Dockerfiles | Yes |
| `docker-compose.yml` | Compose config | Yes |
| `docs/` | Documentation | Yes |

`.gitignore`:
```
data/
.env
node_modules/
dist/
```

---

## Out of Scope — v1

- Custom CLI binary (use `docker compose` directly)
- File attachments / ContentVersion (planned for v2)
- Multi-org simultaneous sync (single active org; switch via Settings page)
- Cloud hosting or remote access
- Real-time Change Data Capture (CDC) streaming
- Auth/access control on the web UI (local-only tool)
- Automated Postgres backups
- Salesforce reports or list views as data sources
