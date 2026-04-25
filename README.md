# sfetch

A self-hosted Salesforce-to-PostgreSQL sync pipeline. Run it with `docker compose up`, point a BI tool or SQL client at the local Postgres instance, and query your Salesforce data like a normal database.

**The database is the product.** The web UI configures which objects and fields to sync. External tools connect directly to Postgres — no intermediate API.

---

> **Security note:** The web UI and API have no authentication. This is intentional — it is a localhost-only tool. Both services bind to `127.0.0.1` and must not be exposed to a network. Do not run this on a shared or internet-accessible host without adding an auth layer.

---

## Features

- Configure sync from a web UI — no config files to edit
- Select individual objects and fields to sync
- Delta sync (frequent, catches creates/updates) + full ID reconciliation (nightly, catches hard deletes)
- Soft deletes: records deleted in Salesforce get `sf_deleted_at` set, never hard-deleted locally
- Salesforce Bulk API 2.0 for large volumes; REST fallback for small objects
- Auth via `~/.sfdx` files — no Salesforce credentials stored in the project
- Sync logs with per-object record counts, errors, and duration

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) with at least one org authenticated

## Quick start

```bash
# 1. Authenticate a Salesforce org (skip if already done)
sf org login web --alias my-org

# 2. Configure environment
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD at minimum

# 3. Start
docker compose up -d

# 4. Open the UI
open http://localhost:7743
```

First start takes ~30 seconds while Postgres initializes and the API container builds.

The onboarding screen will detect your authenticated orgs and ask you to pick one. After that, go to the Objects page and enable the Salesforce objects you want to sync.

## Connect a BI tool or SQL client

Once data is syncing, connect any Postgres-compatible tool directly:

| Setting  | Default value         |
|----------|-----------------------|
| Host     | `localhost`           |
| Port     | `7745`                |
| Database | `sfdb`               |
| Schema   | `salesforce`          |
| User     | `sfdb`               |
| Password | *(your `.env` value)* |

The Settings page in the UI shows a copyable connection string.

A read-only role is also available — set `READONLY_PASSWORD` in `.env` and connect as user `sfdb_readonly`.

## Ports

| Service       | Default | Set via       |
|---------------|---------|---------------|
| UI + API      | `7743`  | `APP_PORT`    |
| PostgreSQL    | `7745`  | `POSTGRES_PORT` |

Both default ports are chosen to avoid conflicts with common local services.

## Environment variables

`.env` holds only bootstrap config — values needed before the database exists. All runtime config (active org, sync intervals, enabled objects) lives in the database.

```env
POSTGRES_USER=sfdb
POSTGRES_PASSWORD=            # required
POSTGRES_DB=sfdb
POSTGRES_PORT=7745
READONLY_PASSWORD=            # optional read-only role password

APP_PORT=7743
NODE_ENV=production

LOG_RETENTION_DAYS=14
```

Copy `.env.example` to `.env` and fill in at minimum `POSTGRES_PASSWORD`.

## How sync works

### Delta sync (default: every hour)

Queries `WHERE SystemModstamp >= last_delta_sync` via Bulk API 2.0, streams the CSV result, and batch-upserts into Postgres. On first sync, no WHERE clause — pulls all records.

### Full ID reconciliation (default: nightly)

Queries `SELECT Id FROM <Object>` for the full live ID set, diffs against local rows, and sets `sf_deleted_at` on any that are gone. This is the only way to catch hard deletes, merges, and cascade deletes.

### Concurrency

Only one sync runs at a time. A single-row lock table (`sfdb.sync_lock`) prevents overlap. Stale locks (> 30 min) are automatically reclaimed on startup.

## Database schema

**`salesforce` schema** — one table per enabled Salesforce object, e.g. `salesforce.account`

| Column | Type | Notes |
|---|---|---|
| `id` | `text PRIMARY KEY` | 18-char Salesforce ID |
| *(enabled fields)* | *(mapped type)* | Lowercased snake_case API names |
| `sf_created_at` | `timestamptz` | CreatedDate |
| `sf_updated_at` | `timestamptz` | SystemModstamp |
| `sf_deleted_at` | `timestamptz NULL` | NULL = live; set when deletion detected |
| `synced_at` | `timestamptz` | Last written by this tool |

**`sfdb` schema** — internal app tables (sync config, logs, lock, field metadata)

## Tech stack

| Layer | Technology |
|---|---|
| Database | PostgreSQL 16 |
| Backend | Node.js + TypeScript + Express |
| Frontend | React + TypeScript + shadcn/ui + Tailwind |
| Salesforce auth | `~/.sfdx` files read directly via Node `fs` (no `sf` binary in container) |
| Salesforce data | jsforce + Bulk API 2.0 |
| Scheduling | node-cron |
| Containers | Docker + Docker Compose |

## Stopping and data persistence

```bash
docker compose down       # stop containers — data persists
docker compose down -v    # stop and delete all data
```

Postgres data lives in `data/docker/postgres/` (git-ignored). It survives stop/start cycles.

## Rebuilding after code changes

```bash
docker compose down
docker compose build
docker compose up -d
```

## License

MIT — see [LICENSE](LICENSE).
