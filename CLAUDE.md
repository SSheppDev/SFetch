# sfetch — Agent Rules & Project Conventions

## What this project is

A locally-run Docker-based Salesforce-to-PostgreSQL data pipeline. The database is the product. External apps connect directly to Postgres. A React web UI handles configuration. Everything runs via `docker compose up`.

Full scope: `docs/scope.md`

---

## Commit Rules for Agents

**Agents must commit their work after completing each task.** Do not batch multiple tasks into one commit. One task = one commit (minimum).

### Commit format

```
<type>(<scope>): <short description>

<optional body — what changed and why>

Co-Authored-By: Claude <noreply@anthropic.com>
```

**Types:**
- `feat` — new functionality
- `fix` — bug fix
- `chore` — config, tooling, setup
- `refactor` — restructure without behavior change
- `docs` — documentation only

**Scopes:** `scaffold`, `docker`, `db`, `auth`, `bulk-api`, `ddl`, `delta-sync`, `reconciliation`, `scheduler`, `api`, `ui`, `build`

**Examples:**
```
feat(auth): add SF org token reader from ~/.sf JSON files
feat(delta-sync): implement initial full load when last_delta_sync is NULL
chore(scaffold): initialize project structure and package.json files
feat(ui): add objects page with sync toggle and row count display
```

### When to commit

- After completing a full task from the task list
- After a meaningful sub-step within a large task (e.g. after each route module, after each UI page)
- Always before starting a new task
- Never commit broken or partially-wired code — a commit should represent a working unit

### What to stage

Stage specific files by name — never `git add .` or `git add -A` blindly. Check `git status` first. Never stage:
- `data/` (git-ignored, but double-check)
- `.env` (git-ignored, but double-check)
- Unrelated files touched incidentally

---

## Branch Strategy

All work goes to `main` for this project. It is a local-only tool with a single developer. No feature branches required unless explicitly requested.

---

## Tech Stack (quick reference)

| Layer | Technology |
|---|---|
| Database | PostgreSQL (Docker) |
| Backend | Node.js + TypeScript + Express |
| Frontend | React + TypeScript + shadcn/ui + Tailwind |
| SF Auth | Read `~/.sf/` JSON directly (no sf binary in container) |
| SF Data | jsforce + Bulk API 2.0 |
| Scheduler | node-cron |
| Containers | Docker + Docker Compose |

---

## Directory Structure

```
sf-db/
├── src/
│   ├── api/          # Express backend + sync engine
│   └── ui/           # React frontend
├── docker/           # Dockerfiles only
├── data/             # LOCAL ONLY — git-ignored
│   ├── docker/       # Postgres volume mount
│   └── downloads/    # Future file exports
├── docs/             # Project documentation
├── docker-compose.yml
├── .env              # Git-ignored — ports, DB creds, LOG_RETENTION_DAYS
├── .env.example      # Committed — template with empty values
└── CLAUDE.md
```

---

## Code Conventions

### TypeScript
- Strict mode on (`"strict": true` in tsconfig)
- No `any` — use `unknown` and narrow properly
- Prefer `interface` over `type` for object shapes
- Async/await over raw promises
- All database queries go through the pg pool — never create ad-hoc connections

### Postgres
- Internal app tables → `sfdb` schema
- Synced Salesforce data → one schema per registered org named `org_<lowercased orgid>` (e.g. `org_00d5g000001abcdeaa`)
- All `sfdb.*` per-object/per-field tables (`sync_config`, `field_config`, `field_metadata`, `sync_log`, `sync_lock`) are keyed by `(org_id, ...)` with `ON DELETE CASCADE` from `sfdb.orgs`
- The active UI/sync context is stored in `sfdb.active_org` (single row); the API resolves it from `X-Org-Id` request header first, falling back to that pointer
- Every synced table must have: `id`, `sf_created_at`, `sf_updated_at`, `sf_deleted_at`, `synced_at`
- Field names are lowercase snake_case versions of SF API names
- DDL is always idempotent (`IF NOT EXISTS` / `IF EXISTS`); identifiers are always quoted (objects like `Order` / `User` collide with PG reserved words)

### Sync engine
- Every sync entry point takes `orgId` as its primary key; alias is only used to look up an `~/.sfdx` token via `sfdb.orgs`
- `sfdb.sync_lock` is per-org (one row per registered org). Acquire before any sync; always release in a `finally` block
- Different orgs sync in parallel; one sync per org is serialized via that org's lock
- If `last_delta_sync` is NULL → initial full load (no SystemModstamp WHERE clause)
- Stale lock threshold: 30 minutes
- Log purge runs at the start of every sync (delete rows older than `LOG_RETENTION_DAYS`)
- The cron scheduler runs as one process with two ticks (delta per minute, full daily 02:00) that iterate every registered org

### API
- All routes under `/api/` prefix
- Non-API routes serve the React SPA (`dist/index.html`)
- Return consistent error shape: `{ error: string, details?: unknown }`
- No authentication on API — local-only tool, localhost only

### React / UI
- Components in `src/ui/src/components/`
- Pages in `src/ui/src/pages/`
- API calls through a single typed client (`src/ui/src/lib/api.ts`)
- Use shadcn/ui components — do not build primitives from scratch
- Confirmation modals required before any destructive action (drop column, drop table)

---

## Environment Variables

Only bootstrap values live in `.env` — values needed before the DB exists.

```env
POSTGRES_USER=sfdb
POSTGRES_PASSWORD=changeme
POSTGRES_PORT=7745
APP_PORT=7743
LOG_RETENTION_DAYS=14
```

All runtime config (active org alias, sync intervals, enabled objects/fields) lives in the `sfdb` schema in the database.

---

## Key Design Decisions (do not revisit without good reason)

- **sf CLI binary is NOT in the Docker image.** Auth tokens are read directly from the `~/.sfdx/` JSON files mounted into the container. No `sf org display` command.
- **The API is not a data API.** It serves the UI and orchestrates syncs only. External tools connect directly to Postgres.
- **Deletions are soft.** `sf_deleted_at` is set — records are never hard-deleted from the local DB.
- **Bulk API 2.0 by default.** REST query fallback only for objects under 2,000 records.
- **Config in DB, not `.env`.** `.env` is infrastructure only. Org registry, object selection, field selection, and schedule config all live in `sfdb.orgs` / `sfdb.sync_config` / `sfdb.field_config` / `sfdb.app_config`.
- **Multi-org by schema.** Every registered org gets its own `org_<orgid>` schema. Removing an org drops the schema and cascades through `sfdb.*` via the FKs on `sfdb.orgs(org_id)`.
- **Schema name is derived from the immutable Salesforce org id**, not the user-editable alias — aliases can be renamed without affecting where the data lives.
