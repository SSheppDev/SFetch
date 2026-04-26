import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import { api, setApiOrgId } from './api'
import { type RegisteredOrg, type RegisteredOrgsResponse } from '@/types'

const ACTIVE_ORG_KEY = 'sfetch.activeOrgId'

interface OrgContextValue {
  orgs: RegisteredOrg[]
  activeOrgId: string | null
  activeOrg: RegisteredOrg | null
  loading: boolean
  refresh: () => Promise<void>
  setActiveOrgId: (orgId: string) => Promise<void>
}

const Ctx = createContext<OrgContextValue | null>(null)

function readStoredOrgId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_ORG_KEY)
  } catch {
    return null
  }
}

function writeStoredOrgId(orgId: string | null): void {
  try {
    if (orgId) localStorage.setItem(ACTIVE_ORG_KEY, orgId)
    else localStorage.removeItem(ACTIVE_ORG_KEY)
  } catch {
    /* ignore */
  }
}

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const [orgs, setOrgs] = useState<RegisteredOrg[]>([])
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Initialize the api client header from localStorage immediately so requests
  // made during the first render carry the right header.
  useEffect(() => {
    const stored = readStoredOrgId()
    if (stored) setApiOrgId(stored)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<RegisteredOrgsResponse>('/orgs')
      setOrgs(res.orgs)

      const stored = readStoredOrgId()
      const candidate =
        (stored && res.orgs.find((o) => o.orgId === stored)?.orgId) ||
        res.activeOrgId ||
        res.orgs[0]?.orgId ||
        null

      setActiveOrgIdState(candidate)
      setApiOrgId(candidate)
      writeStoredOrgId(candidate)
    } catch {
      setOrgs([])
      setActiveOrgIdState(null)
      setApiOrgId(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setActiveOrgId = useCallback(async (orgId: string) => {
    setApiOrgId(orgId)
    setActiveOrgIdState(orgId)
    writeStoredOrgId(orgId)
    try {
      await api.post(`/orgs/${orgId}/active`)
    } catch {
      /* server-side persistence is best-effort; UI state is the source of truth in-session */
    }
  }, [])

  const activeOrg = useMemo(
    () => orgs.find((o) => o.orgId === activeOrgId) ?? null,
    [orgs, activeOrgId]
  )

  const value = useMemo<OrgContextValue>(
    () => ({ orgs, activeOrgId, activeOrg, loading, refresh, setActiveOrgId }),
    [orgs, activeOrgId, activeOrg, loading, refresh, setActiveOrgId]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useOrg(): OrgContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useOrg must be used inside <OrgProvider>')
  return v
}
