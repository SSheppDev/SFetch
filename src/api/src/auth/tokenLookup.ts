import { getOrgToken, type SfToken } from './sfAuth'

/**
 * Resolve an SF token for the given org by trying alias first, then username.
 * data/tokens.json is keyed by both, but the alias in `~/.sfdx/alias.json`
 * (and therefore `sfdb.orgs.alias`) may differ in case from the tokens.json
 * key, or may have been renamed since the last `npm run export-tokens`.
 *
 * Throws the last error from getOrgToken if no key works.
 */
export async function tokenForOrg(
  alias: string | null,
  username: string
): Promise<SfToken> {
  const candidates = [alias, username].filter(
    (v): v is string => typeof v === 'string' && v.length > 0
  )
  let lastErr: Error | null = null
  for (const key of candidates) {
    try {
      return await getOrgToken(key)
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('tokenForOrg: no candidate keys for org')
}
