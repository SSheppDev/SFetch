# Contributing to sfetch

## Running locally for development

**Prerequisites:** Docker Desktop, Node.js 20+, Salesforce CLI with an authenticated org.

```bash
git clone https://github.com/SSheppDev/SFetch.git
cd SFetch
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD at minimum
```

Start Postgres only (so the API can run outside Docker during dev):

```bash
docker compose up postgres -d
```

Run the API and UI in watch mode:

```bash
npm install
npm run dev:api   # Express API on :7743
npm run dev:ui    # Vite dev server on :5173
```

The Vite dev server proxies `/api` requests to the Express backend, so the full app works at `http://localhost:5173`.

## Project structure

```
src/api/src/
  auth/         SF token reader
  db/           Postgres pool + init SQL
  routes/       Express route handlers
  salesforce/   Bulk API client
  sync/         Delta sync, reconciliation, DDL, scheduler

src/ui/src/
  components/   Shared UI components
  pages/        One file per page
  lib/          API client, utilities
```

## Submitting a pull request

1. Fork the repo and create a branch from `main`
2. Make your changes — keep commits focused and descriptive
3. Open a PR with a clear description of what changed and why
4. PRs that add features should include a note on how to test them manually

## Reporting bugs

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Relevant logs (`docker compose logs api`)
- Your OS and Docker version
