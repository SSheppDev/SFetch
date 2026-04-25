import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Copy, Check, Loader2, ExternalLink, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { type ConnectionDetails, type DbStats } from '@/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/use-toast'

interface OrgStatus {
  configured: boolean
  alias: string | null
  username: string | null
  instanceUrl: string | null
  tokenValid: boolean
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const [orgStatus, setOrgStatus] = useState<OrgStatus | null>(null)
  const [connection, setConnection] = useState<ConnectionDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [copied, setCopied] = useState(false)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get<OrgStatus>('/orgs/status'),
      api.get<ConnectionDetails>('/settings/connection'),
    ])
      .then(([org, conn]) => {
        setOrgStatus(org)
        setConnection(conn)
      })
      .catch(() => {
        toast({ variant: 'destructive', title: 'Failed to load settings' })
      })
      .finally(() => setLoading(false))
  }, [])

  const fetchStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const data = await api.get<DbStats>('/settings/stats')
      setStats(data)
    } catch {
      toast({ variant: 'destructive', title: 'Failed to load database stats' })
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  async function handleCopyConnectionString() {
    if (!connection?.connectionString) return
    try {
      await navigator.clipboard.writeText(connection.connectionString)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({ variant: 'destructive', title: 'Failed to copy to clipboard' })
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--color-muted-foreground)]" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Settings</h1>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-0.5">
          Manage your active org and database connection.
        </p>
      </div>

      {/* Active Org */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Active Org</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {orgStatus?.configured ? (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">Alias</p>
                  <p className="font-semibold">{orgStatus.alias ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">Username</p>
                  <p className="font-mono text-xs">{orgStatus.username ?? '—'}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">
                    Instance URL
                  </p>
                  <div className="flex items-center gap-1.5">
                    <p className="font-mono text-xs text-[var(--color-muted-foreground)]">
                      {orgStatus.instanceUrl ?? '—'}
                    </p>
                    {orgStatus.instanceUrl && (
                      <a
                        href={orgStatus.instanceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--color-primary)]"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">
                    Token validity
                  </p>
                  <Badge variant={orgStatus.tokenValid ? 'secondary' : 'destructive'}>
                    {orgStatus.tokenValid ? 'Valid' : 'Expired'}
                  </Badge>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate('/onboarding')}
              >
                Switch Org
              </Button>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-[var(--color-muted-foreground)]">
                No org is currently configured.
              </p>
              <Button size="sm" onClick={() => navigate('/onboarding')}>
                Connect an Org
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Database Stats */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Database Stats</CardTitle>
            <button
              onClick={fetchStats}
              disabled={statsLoading}
              className="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors disabled:opacity-50"
              aria-label="Refresh stats"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${statsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </CardHeader>
        <CardContent>
          {statsLoading && !stats ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--color-muted-foreground)]" />
            </div>
          ) : stats ? (
            <div className="space-y-4">
              {/* Summary row */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'DB size', value: formatBytes(stats.dbSizeBytes) },
                  { label: 'Salesforce data', value: formatBytes(stats.salesforceSizeBytes) },
                  { label: 'Total rows', value: stats.totalRows.toLocaleString() },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-md bg-[var(--color-muted)] px-3 py-2.5">
                    <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">{label}</p>
                    <p className="text-sm font-semibold tabular-nums">{value}</p>
                  </div>
                ))}
              </div>

              {/* Per-table breakdown */}
              {stats.tables.length > 0 && (
                <div className="rounded-md border border-[var(--color-border)] overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                        <th className="text-left px-3 py-2 font-medium text-[var(--color-muted-foreground)]">
                          Table
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-[var(--color-muted-foreground)]">
                          Rows
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-[var(--color-muted-foreground)]">
                          Size
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-[var(--color-muted-foreground)]">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.tables.map((t) => (
                        <tr
                          key={t.tableName}
                          className="border-b border-[var(--color-border)] last:border-0"
                        >
                          <td className="px-3 py-2 font-mono text-[var(--color-foreground)]">
                            {t.tableName}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-[var(--color-muted-foreground)]">
                            {t.rowCount.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-[var(--color-muted-foreground)]">
                            {formatBytes(t.tableSizeBytes)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-[var(--color-muted-foreground)]">
                            {formatBytes(t.totalSizeBytes)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {stats.tables.length === 0 && (
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  No tables synced yet. Enable objects on the Objects page to start syncing.
                </p>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Database Connection */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Database Connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {connection ? (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">Host</p>
                  <p className="font-mono text-xs">{connection.host}</p>
                </div>
                <div>
                  <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">Port</p>
                  <p className="font-mono text-xs">{connection.port}</p>
                </div>
                <div>
                  <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">Database</p>
                  <p className="font-mono text-xs">{connection.database}</p>
                </div>
                <div>
                  <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">User</p>
                  <p className="font-mono text-xs">{connection.user}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">Password</p>
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-xs tracking-wider">
                      {showPassword ? connection.password : '•'.repeat(Math.min(connection.password.length, 12))}
                    </p>
                    <button
                      onClick={() => setShowPassword((v) => !v)}
                      className="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="rounded-md bg-[var(--color-muted)] px-3 py-2 flex items-center justify-between gap-3">
                <p className="font-mono text-xs text-[var(--color-foreground)] truncate">
                  {showPassword
                    ? connection.connectionString
                    : connection.connectionString.replace(
                        /:([^@]+)@/,
                        ':' + '•'.repeat(8) + '@'
                      )}
                </p>
                <button
                  onClick={handleCopyConnectionString}
                  className="flex-shrink-0 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors"
                  aria-label="Copy connection string"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>

              <p className="text-xs text-[var(--color-muted-foreground)]">
                Connect your BI tool or SQL client using these details. The{' '}
                <code className="font-mono">salesforce</code> schema contains all synced data.
              </p>
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Connection details unavailable.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
