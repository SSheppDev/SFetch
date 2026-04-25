# First-Run Setup

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) installed
- At least one Salesforce org authenticated locally

## 1. Authenticate a Salesforce org (if not already done)

```bash
sf org login web --alias my-org
```

Verify it worked:
```bash
sf org list
```

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` if you need to change ports or the DB password. Defaults:
- UI + API: `http://localhost:7743`
- PostgreSQL: `localhost:7745`

## 3. Start the app

```bash
docker compose up -d
```

First start takes ~30 seconds — Postgres initialises the database and the API container builds.

Check everything is up:
```bash
docker compose ps
docker compose logs -f api
```

## 4. Open the UI

```
http://localhost:7743
```

The onboarding screen will detect your authenticated orgs and ask you to pick one.

## 5. Connect your BI tool / SQL client

Once data is syncing, connect directly to Postgres:

| Setting | Value |
|---|---|
| Host | `localhost` |
| Port | `7745` (or `$POSTGRES_PORT` from `.env`) |
| Database | `sfdb` |
| Schema | `salesforce` |
| User | `sfdb` (or `$POSTGRES_USER`) |
| Password | `changeme` (or `$POSTGRES_PASSWORD`) |

The Settings page in the UI shows a copyable connection string.

## Stopping

```bash
docker compose down
```

Data persists in `data/docker/postgres/` — it survives stop/start cycles.

## Rebuilding after code changes

```bash
docker compose down
docker compose build
docker compose up -d
```
