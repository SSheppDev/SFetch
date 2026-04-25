#!/usr/bin/env node
/**
 * export-tokens.js
 *
 * Runs on the HOST (not in Docker) where the macOS Keychain is accessible.
 * Calls `sf org display` for each connected org to get decrypted tokens,
 * then writes them to data/tokens.json for the Docker container to consume.
 *
 * Run before starting Docker, and whenever tokens expire:
 *   npm run export-tokens
 */

import { execFileSync } from 'child_process'
import { writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'data', 'tokens.json')

// Optional --target ALIAS flag — refresh only one org (used by on-demand
// token refresh from the container; dramatically faster than full export)
const targetArgIdx = process.argv.indexOf('--target')
const targetAlias = targetArgIdx > -1 ? process.argv[targetArgIdx + 1] : null

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8' })
  } catch (err) {
    return err.stdout ?? ''
  }
}

let orgs = []

if (targetAlias) {
  orgs = [{ alias: targetAlias, username: null }]
} else {
  const listRaw = run('sf', ['org', 'list', '--json'])
  try {
    const parsed = JSON.parse(listRaw)
    const all = [
      ...(parsed.result?.nonScratchOrgs ?? []),
      ...(parsed.result?.devHubs ?? []),
      ...(parsed.result?.sandboxes ?? []),
      ...(parsed.result?.scratchOrgs ?? []),
    ]
    orgs = all.filter(o => o.connectedStatus === 'Connected' || o.alias)
  } catch {
    console.error('Failed to parse sf org list output')
    process.exit(1)
  }
}

if (orgs.length === 0) {
  console.error('No orgs found. Run: sf org login web --alias my-org')
  process.exit(1)
}

// 2. Extract token for each org
// When refreshing a single org, start from existing tokens so we don't wipe the others.
let tokens = {}
if (targetAlias) {
  try {
    tokens = JSON.parse(readFileSync(OUT, 'utf-8'))
  } catch {
    tokens = {}
  }
}
let success = 0
let fail = 0

for (const org of orgs) {
  const target = org.alias || org.username
  process.stdout.write(`  ${target}... `)

  const raw = run('sf', ['org', 'display', '--target-org', target, '--json'])
  let result
  try {
    result = JSON.parse(raw)?.result
  } catch {
    console.log('parse error')
    fail++
    continue
  }

  if (!result?.accessToken || !result?.instanceUrl) {
    console.log('no token')
    fail++
    continue
  }

  // Store by both alias and username for flexible lookup
  const entry = {
    alias: org.alias ?? null,
    username: result.username ?? org.username,
    accessToken: result.accessToken,
    instanceUrl: result.instanceUrl,
    exportedAt: new Date().toISOString(),
  }
  if (org.alias) tokens[org.alias] = entry
  if (result.username) tokens[result.username] = entry

  console.log('ok')
  success++
}

// 3. Write output
mkdirSync(join(ROOT, 'data'), { recursive: true })
writeFileSync(OUT, JSON.stringify(tokens, null, 2))

console.log(`\nExported ${success} orgs to data/tokens.json`)
if (fail > 0) console.log(`Skipped ${fail} orgs (expired or no token)`)
console.log('\nNow start or restart the app:')
console.log('  docker compose restart api')
