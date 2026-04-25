import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, ChevronRight, Loader2, Search, RotateCcw } from 'lucide-react'
import { api } from '@/lib/api'
import { formatRelative, formatBytes } from '@/lib/format'
import { type SObject, type SyncStatus, type SyncProgress, type DbStats } from '@/types'

function formatSyncProgress(p: SyncProgress): string {
  if (p.phase === 'queuing') return 'queuing…'
  if (p.phase === 'polling') return 'waiting on Salesforce…'
  if (p.phase === 'diffing') return `diffing ${p.totalRecords?.toLocaleString() ?? '?'} IDs…`
  if (p.phase === 'streaming') {
    if (p.totalRecords && p.totalRecords > 0) {
      const pct = Math.round((p.recordsUpserted / p.totalRecords) * 100)
      return `${p.recordsUpserted.toLocaleString()} / ${p.totalRecords.toLocaleString()} records (${pct}%)`
    }
    return `${p.recordsUpserted.toLocaleString()} records…`
  }
  return p.phase
}
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export default function Objects() {
  const navigate = useNavigate()
  const [objects, setObjects] = useState<SObject[]>([])
  const [loading, setLoading] = useState(true)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(false)
  const [disableDialog, setDisableDialog] = useState<SObject | null>(null)
  const [droppingId, setDroppingId] = useState<string | null>(null)
  const [objectSyncing, setObjectSyncing] = useState<Map<string, 'delta' | 'full'>>(new Map())
  const [search, setSearch] = useState('')
  const [letterFilter, setLetterFilter] = useState<string | null>(null)
  const [syncedOnly, setSyncedOnly] = useState(false)
  const [dbSizeBytes, setDbSizeBytes] = useState<number | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchObjects = useCallback(async () => {
    try {
      const data = await api.get<SObject[]>('/objects')
      setObjects(data)
    } catch {
      toast({ variant: 'destructive', title: 'Failed to load objects' })
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchSyncStatus = useCallback(async () => {
    try {
      const data = await api.get<SyncStatus>('/sync/status')
      setSyncStatus(data)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchObjects()
    fetchSyncStatus()
    api.get<DbStats>('/settings/stats')
      .then((s) => setDbSizeBytes(s.dbSizeBytes))
      .catch(() => {})
    pollRef.current = setInterval(fetchSyncStatus, 5000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchObjects, fetchSyncStatus])

  // Step 1: synced-only gate
  const baseObjects = useMemo(
    () => (syncedOnly ? objects.filter((o) => o.enabled) : objects),
    [objects, syncedOnly]
  )

  // Step 2: search filter
  const searchFiltered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return baseObjects
    return baseObjects.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.apiName.toLowerCase().includes(q)
    )
  }, [baseObjects, search])

  // Which letters have at least one match in the current search results
  const availableLetters = useMemo(
    () => new Set(searchFiltered.map((o) => o.label[0]?.toUpperCase()).filter(Boolean)),
    [searchFiltered]
  )

  // Final filtered list — search + letter
  const filtered = useMemo(() => {
    if (!letterFilter) return searchFiltered
    return searchFiltered.filter((o) => o.label[0]?.toUpperCase() === letterFilter)
  }, [searchFiltered, letterFilter])

  async function handleToggle(obj: SObject, enabled: boolean) {
    if (!enabled) {
      setDisableDialog(obj)
      return
    }
    setTogglingIds((s) => new Set(s).add(obj.apiName))
    try {
      await api.patch(`/objects/${obj.apiName}`, { enabled: true })
      setObjects((prev) =>
        prev.map((o) => (o.apiName === obj.apiName ? { ...o, enabled: true } : o))
      )
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to enable object',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setTogglingIds((s) => {
        const next = new Set(s)
        next.delete(obj.apiName)
        return next
      })
    }
  }

  async function handleDisable(obj: SObject, dropTable: boolean) {
    setDroppingId(obj.apiName)
    try {
      await api.patch(`/objects/${obj.apiName}`, { enabled: false, dropTable })
      setObjects((prev) =>
        prev.map((o) => (o.apiName === obj.apiName ? { ...o, enabled: false } : o))
      )
      toast({
        title: `${obj.label} disabled`,
        description: dropTable ? 'Table dropped.' : 'Data preserved.',
      })
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to disable object',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setDroppingId(null)
      setDisableDialog(null)
    }
  }

  async function handleObjectDelta(apiName: string) {
    setObjectSyncing((m) => new Map(m).set(apiName, 'delta'))
    try {
      await api.post(`/sync/delta/${apiName}`)
      toast({ title: `Delta sync started for ${apiName}` })
      fetchSyncStatus()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Delta sync failed',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setObjectSyncing((m) => {
        const next = new Map(m)
        next.delete(apiName)
        return next
      })
    }
  }

  async function handleObjectFull(apiName: string) {
    setObjectSyncing((m) => new Map(m).set(apiName, 'full'))
    try {
      await api.post(`/sync/full/${apiName}`)
      toast({ title: `Full reconciliation started for ${apiName}` })
      fetchSyncStatus()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Full reconciliation failed',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setObjectSyncing((m) => {
        const next = new Map(m)
        next.delete(apiName)
        return next
      })
    }
  }

  async function handleSyncNow() {
    setSyncing(true)
    try {
      await api.post('/sync/delta')
      toast({ title: 'Delta sync started' })
      fetchSyncStatus()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Sync failed',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSyncing(false)
    }
  }

  const isSyncInProgress = syncStatus?.locked === true

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Objects</h1>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-0.5">
            Enable Salesforce objects to sync into your local database.
            {dbSizeBytes !== null && (
              <span className="ml-1.5 font-medium text-[var(--color-foreground)]">
                · {formatBytes(dbSizeBytes)}
              </span>
            )}
          </p>
        </div>
        <Button onClick={handleSyncNow} disabled={syncing || isSyncInProgress} size="sm">
          {syncing || isSyncInProgress ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {isSyncInProgress ? 'Sync in progress…' : 'Sync Now'}
        </Button>
      </div>

      {/* Sync indicator */}
      {isSyncInProgress && (
        <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)] bg-[var(--color-muted)] rounded-md px-3 py-2">
          <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
          <span>
            {syncStatus?.jobType ?? 'delta'} sync in progress — started{' '}
            {formatRelative(syncStatus?.lockedAt)}
            {syncStatus?.currentObject && (
              <span className="ml-1.5 font-mono text-[var(--color-foreground)]">
                · {syncStatus.currentObject}
              </span>
            )}
            {syncStatus?.currentProgress && (
              <span className="ml-1.5">
                · {formatSyncProgress(syncStatus.currentProgress)}
              </span>
            )}
          </span>
        </div>
      )}

      {/* Search + alpha index */}
      {!loading && objects.length > 0 && (
        <div className="space-y-2">
          {/* Search bar + synced-only toggle */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--color-muted-foreground)]" />
              <Input
                placeholder="Search by label or API name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <Switch
                checked={syncedOnly}
                onCheckedChange={setSyncedOnly}
                aria-label="Show synced objects only"
              />
              <span className="text-xs text-[var(--color-muted-foreground)] whitespace-nowrap select-none">
                Synced only
              </span>
            </label>
          </div>

          {/* Alpha index */}
          <div className="flex items-center gap-px flex-wrap">
            <button
              onClick={() => setLetterFilter(null)}
              className={`px-1.5 py-0.5 text-xs rounded font-medium transition-colors mr-1 ${
                letterFilter === null
                  ? 'bg-[var(--color-foreground)] text-[var(--color-background)]'
                  : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-accent)]'
              }`}
            >
              All
            </button>
            {LETTERS.map((letter) => {
              const available = availableLetters.has(letter)
              const active = letterFilter === letter
              return (
                <button
                  key={letter}
                  onClick={() => available && setLetterFilter(active ? null : letter)}
                  className={`w-6 py-0.5 text-xs rounded font-medium transition-colors ${
                    active
                      ? 'bg-[var(--color-foreground)] text-[var(--color-background)]'
                      : available
                      ? 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-accent)]'
                      : 'text-[var(--color-border)] cursor-default'
                  }`}
                >
                  {letter}
                </button>
              )
            })}
          </div>

          {/* Result count */}
          {(search.trim() || letterFilter) && (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              {filtered.length} of {objects.length} objects
            </p>
          )}
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Label
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                API Name
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Status
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Last Sync
              </th>
              <th className="text-right px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Rows
              </th>
              <th className="text-center px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Enabled
              </th>
              <th className="px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Sync
              </th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="py-12 text-center">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto text-[var(--color-muted-foreground)]" />
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="py-12 text-center text-sm text-[var(--color-muted-foreground)]"
                >
                  {objects.length === 0 ? 'No objects found' : 'No objects match your search'}
                </td>
              </tr>
            )}
            {filtered.map((obj) => (
              <tr
                key={obj.apiName}
                onClick={() => navigate(`/objects/${obj.apiName}/fields`)}
                className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-accent)] cursor-pointer transition-colors"
              >
                <td className="px-4 py-3 font-medium text-[var(--color-foreground)]">
                  {obj.label}
                </td>
                <td className="px-4 py-3 text-[var(--color-muted-foreground)] font-mono text-xs">
                  {obj.apiName}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={obj.enabled ? 'default' : 'secondary'}>
                    {obj.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-[var(--color-muted-foreground)]">
                  {formatRelative(obj.lastDeltaSync)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-[var(--color-muted-foreground)]">
                  {obj.rowCount !== null ? obj.rowCount.toLocaleString() : '—'}
                </td>
                <td
                  className="px-4 py-3 text-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Switch
                    checked={obj.enabled}
                    disabled={togglingIds.has(obj.apiName)}
                    onCheckedChange={(checked) => handleToggle(obj, checked)}
                    aria-label={`${obj.enabled ? 'Disable' : 'Enable'} ${obj.label}`}
                  />
                </td>
                <td
                  className="px-4 py-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  {obj.enabled && (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => handleObjectDelta(obj.apiName)}
                        disabled={objectSyncing.has(obj.apiName) || isSyncInProgress}
                        title="Run delta sync"
                      >
                        {objectSyncing.get(obj.apiName) === 'delta' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        <span className="ml-1">Delta</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => handleObjectFull(obj.apiName)}
                        disabled={objectSyncing.has(obj.apiName) || isSyncInProgress}
                        title="Run full reconciliation"
                      >
                        {objectSyncing.get(obj.apiName) === 'full' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        <span className="ml-1">Full</span>
                      </Button>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-[var(--color-muted-foreground)]">
                  <ChevronRight className="h-4 w-4" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Disable confirmation dialog */}
      <Dialog open={disableDialog !== null} onOpenChange={(open) => !open && setDisableDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop syncing {disableDialog?.label}?</DialogTitle>
            <DialogDescription>
              Choose whether to keep or drop the local table when disabling this object.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setDisableDialog(null)}
              disabled={droppingId !== null}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => disableDialog && handleDisable(disableDialog, false)}
              disabled={droppingId !== null}
            >
              {droppingId && !droppingId.endsWith('_drop') ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Disable only
            </Button>
            <Button
              variant="destructive"
              onClick={() => disableDialog && handleDisable(disableDialog, true)}
              disabled={droppingId !== null}
            >
              {droppingId ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Disable + drop table
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
