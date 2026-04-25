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
- Synced Salesforce data → `salesforce` schema
- Internal app tables → `sfdb` schema
- Every synced table must have: `id`, `sf_created_at`, `sf_updated_at`, `sf_deleted_at`, `synced_at`
- Field names are lowercase snake_case versions of SF API names
- DDL is always idempotent (`IF NOT EXISTS` / `IF EXISTS`)

### Sync engine
- Always acquire `sfdb.sync_lock` before running any sync
- Always release the lock in a `finally` block — never leave it held on error
- If `last_delta_sync` is NULL → initial full load (no SystemModstamp WHERE clause)
- Stale lock threshold: 30 minutes
- Log purge runs at the start of every sync (delete rows older than `LOG_RETENTION_DAYS`)

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

- **sf CLI binary is NOT in the Docker image.** Auth tokens are read directly from the `~/.sf/` JSON files mounted into the container. No `sf org display` command.
- **The API is not a data API.** It serves the UI and orchestrates syncs only. External tools connect directly to Postgres.
- **Deletions are soft.** `sf_deleted_at` is set — records are never hard-deleted from the local DB.
- **Bulk API 2.0 by default.** REST query fallback only for objects under 2,000 records.
- **Config in DB, not `.env`.** `.env` is infrastructure only. Org alias, object selection, field selection, and schedule config all live in `sfdb.app_config` / `sfdb.sync_config` / `sfdb.field_config`.
- **One active org at a time.** Multi-org simultaneous sync is out of scope for v1.
