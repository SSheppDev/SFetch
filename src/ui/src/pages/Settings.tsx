import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Copy, Check, Loader2, RefreshCw, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useOrg } from '@/lib/orgContext'
import { formatBytes } from '@/lib/format'
import { type ConnectionDetails, type DbStats } from '@/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'

export default function SettingsPage() {
  const navigate = useNavigate()
  const { orgs, activeOrg, refresh: refreshOrgs, setActiveOrgId } = useOrg()

  const [connection, setConnection] = useState<ConnectionDetails | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [copied, setCopied] = useState(false)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<ConnectionDetails>('/settings/connection')
      .then(setConnection)
      .catch(() => toast({ variant: 'destructive', title: 'Failed to load connection details' }))
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

  async function handleRemoveOrg(orgId: string) {
    try {
      await api.delete(`/orgs/${orgId}`, { dropData: true })
      toast({ title: 'Org removed', description: 'Schema dropped and metadata cleared.' })
      await refreshOrgs()
      await fetchStats()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to remove org',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setPendingDelete(null)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Settings</h1>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-0.5">
          Manage registered orgs, view database stats, and copy connection details.
        </p>
      </div>

      {/* Registered Orgs */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Registered Orgs</CardTitle>
            <Button size="sm" variant="outline" onClick={() => navigate('/onboarding')}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add org
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {orgs.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No orgs registered.</p>
          ) : (
            <div className="space-y-2">
              {orgs.map((org) => {
                const isActive = org.orgId === activeOrg?.orgId
                return (
                  <div
                    key={org.orgId}
                    className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-[var(--color-foreground)] truncate">
                          {org.alias ?? org.username}
                        </p>
                        {isActive && <Badge variant="secondary" className="text-[10px]">Active</Badge>}
                      </div>
                      <p className="text-xs text-[var(--color-muted-foreground)] truncate">
                        {org.username}
                      </p>
                      <p className="text-[10px] font-mono text-[var(--color-muted-foreground)] truncate">
                        {org.orgId} → schema <span className="text-[var(--color-foreground)]">{org.schemaName}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {!isActive && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void setActiveOrgId(org.orgId)}
                        >
                          Switch
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPendingDelete(org.orgId)}
                        className="text-[var(--color-destructive)] hover:text-[var(--color-destructive)]"
                        aria-label="Remove org"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )
              })}
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
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'DB size', value: formatBytes(stats.dbSizeBytes) },
                  { label: 'Synced data', value: formatBytes(stats.salesforceSizeBytes) },
                  { label: 'Total rows', value: stats.totalRows.toLocaleString() },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-md bg-[var(--color-muted)] px-3 py-2.5">
                    <p className="text-xs text-[var(--color-muted-foreground)] mb-0.5">{label}</p>
                    <p className="text-sm font-semibold tabular-nums">{value}</p>
                  </div>
                ))}
              </div>

              {stats.tables.length > 0 && (
                <div className="rounded-md border border-[var(--color-border)] overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                        <th className="text-left px-3 py-2 font-medium text-[var(--color-muted-foreground)]">Schema</th>
                        <th className="text-left px-3 py-2 font-medium text-[var(--color-muted-foreground)]">Table</th>
                        <th className="text-right px-3 py-2 font-medium text-[var(--color-muted-foreground)]">Rows</th>
                        <th className="text-right px-3 py-2 font-medium text-[var(--color-muted-foreground)]">Size</th>
                        <th className="text-right px-3 py-2 font-medium text-[var(--color-muted-foreground)]">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.tables.map((t) => (
                        <tr
                          key={`${t.schemaName}.${t.tableName}`}
                          className="border-b border-[var(--color-border)] last:border-0"
                        >
                          <td className="px-3 py-2 font-mono text-[var(--color-muted-foreground)]">{t.schemaName}</td>
                          <td className="px-3 py-2 font-mono text-[var(--color-foreground)]">{t.tableName}</td>
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
                      {showPassword
                        ? connection.password
                        : '•'.repeat(Math.min(connection.password.length, 12))}
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
                    : connection.connectionString.replace(/:([^@]+)@/, ':' + '•'.repeat(8) + '@')}
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
                Connect your BI tool or SQL client using these details. Each registered org has its
                own schema named <code className="font-mono">org_&lt;orgid&gt;</code>; pick the schema for
                the org you want to query.
              </p>
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Connection details unavailable.
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this org?</DialogTitle>
            <DialogDescription>
              This drops the org's Postgres schema and every synced table inside it, and clears
              all sfdb metadata for the org. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => pendingDelete && handleRemoveOrg(pendingDelete)}
              className="bg-[var(--color-destructive)] text-white hover:bg-[var(--color-destructive)]/90"
            >
              Remove org
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
