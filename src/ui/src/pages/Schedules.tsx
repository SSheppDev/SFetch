import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, Lock, Unlock } from 'lucide-react'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/format'
import { type ScheduleConfig, type SyncStatus, type SyncProgress } from '@/types'

function formatSyncProgress(p: SyncProgress): string {
  if (p.phase === 'queuing') return 'Queuing…'
  if (p.phase === 'polling') return 'Waiting on Salesforce…'
  if (p.phase === 'diffing') return `Diffing ${p.totalRecords?.toLocaleString() ?? '?'} IDs…`
  if (p.phase === 'streaming') {
    if (p.totalRecords && p.totalRecords > 0) {
      const pct = Math.round((p.recordsUpserted / p.totalRecords) * 100)
      return `${p.recordsUpserted.toLocaleString()} / ${p.totalRecords.toLocaleString()} records (${pct}%)`
    }
    return `${p.recordsUpserted.toLocaleString()} records…`
  }
  return p.phase
}
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/components/ui/use-toast'

const DELTA_OPTIONS = [
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '3 hours', value: 180 },
  { label: '6 hours', value: 360 },
  { label: '12 hours', value: 720 },
]

const FULL_OPTIONS = [
  { label: '12 hours', value: 12 },
  { label: '24 hours', value: 24 },
  { label: '48 hours', value: 48 },
  { label: '7 days', value: 168 },
]

export default function Schedules() {
  const [config, setConfig] = useState<ScheduleConfig | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingAuto, setSavingAuto] = useState(false)
  const [savingDelta, setSavingDelta] = useState(false)
  const [savingFull, setSavingFull] = useState(false)
  const [runningDelta, setRunningDelta] = useState(false)
  const [runningFull, setRunningFull] = useState(false)

  // Local edit state
  const [deltaInterval, setDeltaInterval] = useState<number>(60)
  const [fullInterval, setFullInterval] = useState<number>(24)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.get<SyncStatus>('/sync/status')
      setSyncStatus(data)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    Promise.all([api.get<ScheduleConfig>('/schedules'), api.get<SyncStatus>('/sync/status')])
      .then(([cfg, status]) => {
        setConfig(cfg)
        setDeltaInterval(cfg.deltaIntervalMinutes)
        setFullInterval(cfg.fullIntervalHours)
        setSyncStatus(status)
      })
      .catch(() => {
        toast({ variant: 'destructive', title: 'Failed to load schedule config' })
      })
      .finally(() => setLoading(false))

    pollRef.current = setInterval(fetchStatus, 5000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchStatus])

  async function toggleAutoSync(enabled: boolean) {
    setSavingAuto(true)
    try {
      const updated = await api.patch<ScheduleConfig>('/schedules', { autoSyncEnabled: enabled })
      setConfig(updated)
      toast({ title: enabled ? 'Auto-sync enabled' : 'Auto-sync disabled' })
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to update auto-sync',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSavingAuto(false)
    }
  }

  async function saveDeltaInterval() {
    setSavingDelta(true)
    try {
      const updated = await api.patch<ScheduleConfig>('/schedules', {
        deltaIntervalMinutes: deltaInterval,
      })
      setConfig(updated)
      toast({ title: 'Delta sync interval saved' })
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to save interval',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSavingDelta(false)
    }
  }

  async function saveFullInterval() {
    setSavingFull(true)
    try {
      const updated = await api.patch<ScheduleConfig>('/schedules', {
        fullIntervalHours: fullInterval,
      })
      setConfig(updated)
      toast({ title: 'Full sync interval saved' })
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to save interval',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSavingFull(false)
    }
  }

  async function runDelta() {
    setRunningDelta(true)
    try {
      await api.post('/sync/delta')
      toast({ title: 'Delta sync started' })
      fetchStatus()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Delta sync failed',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setRunningDelta(false)
    }
  }

  async function runFull() {
    setRunningFull(true)
    try {
      await api.post('/sync/full')
      toast({ title: 'Full reconciliation started' })
      fetchStatus()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Full sync failed',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setRunningFull(false)
    }
  }

  const isSyncInProgress = syncStatus?.locked === true

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
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Schedules</h1>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-0.5">
          Configure automatic sync intervals and trigger manual syncs.
        </p>
      </div>

      {/* Sync Status Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            {isSyncInProgress ? (
              <Lock className="h-4 w-4 text-amber-500" />
            ) : (
              <Unlock className="h-4 w-4 text-green-500" />
            )}
            Sync Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <Badge variant={isSyncInProgress ? 'default' : 'secondary'}>
              {isSyncInProgress ? 'In Progress' : 'Idle'}
            </Badge>
            {isSyncInProgress && syncStatus?.jobType && (
              <span className="text-[var(--color-muted-foreground)] capitalize">
                {syncStatus.jobType}
              </span>
            )}
          </div>
          {isSyncInProgress && syncStatus?.lockedAt && (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Running since {formatRelative(syncStatus.lockedAt)}
            </p>
          )}
          {isSyncInProgress && syncStatus?.currentObject && (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Current:{' '}
              <span className="font-mono text-[var(--color-foreground)]">
                {syncStatus.currentObject}
              </span>
            </p>
          )}
          {isSyncInProgress && syncStatus?.currentProgress && (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              {formatSyncProgress(syncStatus.currentProgress)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Auto-sync toggle */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">Auto-sync</p>
              <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5">
                Automatically run syncs on the configured schedule
              </p>
            </div>
            {savingAuto ? (
              <Loader2 className="h-4 w-4 animate-spin text-[var(--color-muted-foreground)]" />
            ) : (
              <Switch
                checked={config?.autoSyncEnabled ?? false}
                onCheckedChange={toggleAutoSync}
                disabled={savingAuto}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Delta Sync Interval */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Delta Sync Interval</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Select
            value={String(deltaInterval)}
            onValueChange={(v) => setDeltaInterval(Number(v))}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DELTA_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={saveDeltaInterval}
            disabled={savingDelta || deltaInterval === config?.deltaIntervalMinutes}
          >
            {savingDelta ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </CardContent>
      </Card>

      {/* Full Reconciliation Interval */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Full Reconciliation Interval</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Select
            value={String(fullInterval)}
            onValueChange={(v) => setFullInterval(Number(v))}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FULL_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={saveFullInterval}
            disabled={savingFull || fullInterval === config?.fullIntervalHours}
          >
            {savingFull ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </CardContent>
      </Card>

      {/* Manual Triggers */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Manual Sync</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-3 flex-wrap">
          <Button
            variant="outline"
            onClick={runDelta}
            disabled={runningDelta || isSyncInProgress}
          >
            {runningDelta || (isSyncInProgress && syncStatus?.jobType === 'delta') ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Run Delta Sync Now
          </Button>
          <Button
            variant="outline"
            onClick={runFull}
            disabled={runningFull || isSyncInProgress}
          >
            {runningFull || (isSyncInProgress && syncStatus?.jobType === 'full') ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Run Full Reconciliation Now
          </Button>
        </CardContent>
      </Card>

      {/* Per-object last sync */}
      {syncStatus && syncStatus.objects.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Per-Object Last Sync</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                    Object
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                    Last Delta
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                    Last Full
                  </th>
                </tr>
              </thead>
              <tbody>
                {syncStatus.objects.map((obj) => (
                  <tr
                    key={obj.objectApiName}
                    className="border-b border-[var(--color-border)] last:border-0"
                  >
                    <td className="px-4 py-2.5 font-mono text-xs">{obj.objectApiName}</td>
                    <td className="px-4 py-2.5 text-[var(--color-muted-foreground)]">
                      {formatRelative(obj.lastDeltaSync)}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--color-muted-foreground)]">
                      {formatRelative(obj.lastFullSync)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
