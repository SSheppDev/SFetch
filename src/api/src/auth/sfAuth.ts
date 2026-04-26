import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SfOrg {
  alias: string | null
  username: string
  instanceUrl: string
  orgId: string
  loginUrl: string
}

export interface SfToken {
  accessToken: string
  instanceUrl: string
  username: string
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface RawOrgFile {
  accessToken?: unknown
  instanceUrl?: unknown
  username?: unknown
  orgId?: unknown
  loginUrl?: unknown
}

interface RawAliasJson {
  orgs?: Record<string, unknown>
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * sf CLI v2 stores auth in ~/.sfdx/ (legacy sfdx directory).
 * ~/.sf/ is config/logs only — no auth tokens.
 */
function sfdxDir(): string {
  return path.join(os.homedir(), '.sfdx')
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `sfAuth: could not read "${filePath}": ${(err as NodeJS.ErrnoException).message}`
    )
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`sfAuth: invalid JSON in "${filePath}"`)
  }
}

async function tryReadJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    await fs.access(filePath)
    return await readJsonFile<T>(filePath)
  } catch {
    return undefined
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Read ~/.sfdx/alias.json and return a username → alias map.
 * Format: { orgs: { alias: username } }
 */
async function buildAliasMap(dir: string): Promise<Map<string, string>> {
  const usernameToAlias = new Map<string, string>()
  const aliasJson = await tryReadJsonFile<RawAliasJson>(path.join(dir, 'alias.json'))
  if (aliasJson?.orgs) {
    for (const [alias, username] of Object.entries(aliasJson.orgs)) {
      if (isNonEmptyString(username) && !usernameToAlias.has(username)) {
        usernameToAlias.set(username, alias)
      }
    }
  }
  return usernameToAlias
}

/**
 * Build an alias → username map for resolving aliases in getOrgToken.
 */
async function buildAliasToUsername(dir: string): Promise<Map<string, string>> {
  const aliasToUsername = new Map<string, string>()
  const aliasJson = await tryReadJsonFile<RawAliasJson>(path.join(dir, 'alias.json'))
  if (aliasJson?.orgs) {
    for (const [alias, username] of Object.entries(aliasJson.orgs)) {
      if (isNonEmptyString(username)) {
        aliasToUsername.set(alias, username)
      }
    }
  }
  return aliasToUsername
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if ~/.sfdx/ is accessible and readable.
 * Never throws.
 */
export async function isSfCliMounted(): Promise<boolean> {
  try {
    await fs.access(sfdxDir(), fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Lists all Salesforce orgs found in ~/.sfdx/.
 * Auth files are named {username}.json at the root of ~/.sfdx/.
 * Returns empty array if directory is inaccessible or empty.
 */
export async function listOrgs(): Promise<SfOrg[]> {
  const dir = sfdxDir()
  try {
    await fs.access(dir, fs.constants.R_OK)
  } catch {
    return []
  }

  const usernameToAlias = await buildAliasMap(dir)

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  // Org auth files are named {username}.json or {orgId}.sandbox.json
  // Skip known non-org files
  const SKIP = new Set(['alias.json', 'config.json'])
  const orgFiles = entries.filter(
    (f) => f.endsWith('.json') && !SKIP.has(f) && !f.startsWith('sf-')
  )

  const orgMap = new Map<string, SfOrg>()

  for (const file of orgFiles) {
    const filePath = path.join(dir, file)
    let entry: RawOrgFile
    try {
      entry = await readJsonFile<RawOrgFile>(filePath)
    } catch {
      continue
    }

    const username = isNonEmptyString(entry.username) ? entry.username : undefined
    const instanceUrl = isNonEmptyString(entry.instanceUrl) ? entry.instanceUrl : undefined
    const orgId = isNonEmptyString(entry.orgId) ? entry.orgId : undefined
    const loginUrl = isNonEmptyString(entry.loginUrl) ? entry.loginUrl : undefined

    if (!username || !instanceUrl || !orgId || !loginUrl) continue

    // Deduplicate by username — keep the first entry encountered
    if (!orgMap.has(username)) {
      orgMap.set(username, {
        alias: usernameToAlias.get(username) ?? null,
        username,
        instanceUrl,
        orgId,
        loginUrl,
      })
    }
  }

  return Array.from(orgMap.values())
}

/**
 * Returns a decrypted access token for the given org alias or username.
 *
 * Reads from data/tokens.json which is populated by running on the HOST:
 *   npm run export-tokens
 *
 * This is required because sf CLI encrypts tokens using the macOS Keychain,
 * which is inaccessible inside Docker. The export script runs on the host
 * where the Keychain is available and writes plaintext tokens to data/tokens.json.
 */
export async function getOrgToken(aliasOrUsername: string): Promise<SfToken> {
  const tokensPath = path.join(process.cwd(), '..', '..', 'data', 'tokens.json')

  interface TokenEntry {
    alias: string | null
    username: string
    accessToken: string
    instanceUrl: string
    exportedAt: string
  }

  function tokenError(message: string): Error {
    // Tagged so the global error handler can return a 401 + SF_SESSION_EXPIRED
    // code, which makes the UI's SessionExpiredBanner appear with the
    // copy-the-command + reload affordance.
    return Object.assign(new Error(message), { sfAuthMissing: true })
  }

  let tokenMap: Record<string, TokenEntry>
  try {
    const raw = await fs.readFile(tokensPath, 'utf-8')
    tokenMap = JSON.parse(raw) as Record<string, TokenEntry>
  } catch (err) {
    const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT'
    if (isNotFound) {
      throw tokenError(
        `sfAuth: data/tokens.json not found. ` +
          `Run on the host: npm run export-tokens`
      )
    }
    throw tokenError(`sfAuth: could not read data/tokens.json: ${(err as Error).message}`)
  }

  const entry = tokenMap[aliasOrUsername]
  if (!entry) {
    throw tokenError(
      `sfAuth: org "${aliasOrUsername}" not found in data/tokens.json. ` +
          `Run: npm run export-tokens`
    )
  }

  if (!isNonEmptyString(entry.accessToken)) {
    throw tokenError(
      `sfAuth: empty access token for "${aliasOrUsername}". ` +
          `Re-run: npm run export-tokens`
    )
  }
  if (!isNonEmptyString(entry.instanceUrl)) {
    throw new Error(`sfAuth: instanceUrl missing for "${aliasOrUsername}".`)
  }

  return {
    accessToken: entry.accessToken,
    instanceUrl: entry.instanceUrl,
    username: entry.username,
  }
}
