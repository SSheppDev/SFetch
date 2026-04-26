const BASE = '/api'

export const SF_SESSION_EXPIRED_EVENT = 'sfdb:sf-session-expired'

let currentOrgId: string | null = null

/**
 * Set the org id sent with every subsequent API request as `X-Org-Id`.
 * The OrgProvider calls this whenever the active org changes; routes that
 * are scoped per-org read it server-side via requireOrgId().
 */
export function setApiOrgId(orgId: string | null): void {
  currentOrgId = orgId
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options?.headers as Record<string, string>) ?? {}),
  }
  if (currentOrgId) headers['X-Org-Id'] = currentOrgId

  const res = await fetch(`${BASE}${path}`, { ...options, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    if (body?.code === 'SF_SESSION_EXPIRED') {
      window.dispatchEvent(new CustomEvent(SF_SESSION_EXPIRED_EVENT))
    }
    const detail = typeof body?.details === 'string' ? body.details : null
    const message = body?.error
      ? detail
        ? `${body.error}: ${detail}`
        : body.error
      : res.statusText
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body: JSON.stringify(body ?? {}) }),
}
