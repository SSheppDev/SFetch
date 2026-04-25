import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { formatRelative, formatDuration } from '@/lib/format'
import { type LogEntry, type SyncStatus } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/components/ui/use-toast'

const PAGE_SIZE = 25

interface LogsResponse {
  logs: LogEntry[]
  total: number
}

export default function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [page, setPage] = useState(0)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)

  // Filters
  const [objectFilter, setObjectFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  // All unique object names from loaded entries (for filter dropdown)
  const [objectNames, setObjectNames] = useState<string[]>([])

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const buildParams = useCallback(
    (pageNum: number) => {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(pageNum * PAGE_SIZE))
      if (objectFilter !== 'all') params.set('object', objectFilter)
      if (typeFilter !== 'all') params.set('type', typeFilter)
      if (statusFilter !== 'all') params.set('status', statusFilter)
      return params.toString()
    },
    [objectFilter, typeFilter, statusFilter]
  )

  const fetchLogs = useCallback(
    async (reset = false) => {
      const pageNum = reset ? 0 : page
      if (reset) {
        setLoading(true)
        setPage(0)
      } else {
        setLoadingMore(true)
      }
      try {
        const data = await api.get<LogsResponse>(`/logs?${buildParams(pageNum)}`)
        if (reset) {
          setEntries(data.logs)
        } else {
          setEntries((prev) => [...prev, ...data.logs])
        }
        setTotal(data.total)
        // Collect unique object names for filter dropdown
        setObjectNames((prev) => {
          const combined = new Set([...prev, ...data.logs.map((e) => e.objectApiName)])
          return Array.from(combined).sort()
        })
      } catch {
        toast({ variant: 'destructive', title: 'Failed to load logs' })
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buildParams, page]
  )

  // Fetch when filters change (reset)
  useEffect(() => {
    fetchLogs(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectFilter, typeFilter, statusFilter])

  // Poll sync status; auto-refresh logs if in progress
  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.get<SyncStatus>('/sync/status')
      setSyncStatus(data)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    pollRef.current = setInterval(async () => {
      await fetchStatus()
      setSyncStatus((prev) => {
        if (prev?.locked) {
          fetchLogs(true)
        }
        return prev
      })
    }, 10000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchStatus, fetchLogs])

  function toggleExpanded(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  async function loadMore() {
    const nextPage = page + 1
    setPage(nextPage)
    setLoadingMore(true)
    try {
      const data = await api.get<LogsResponse>(`/logs?${buildParams(nextPage)}`)
      setEntries((prev) => [...prev, ...data.logs])
      setTotal(data.total)
    } catch {
      toast({ variant: 'destructive', title: 'Failed to load more logs' })
    } finally {
      setLoadingMore(false)
    }
  }

  const hasMore = entries.length < total
  const isSyncInProgress = syncStatus?.locked === true

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Logs</h1>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-0.5">
            Sync run history — {total} total entries
          </p>
        </div>
        {isSyncInProgress && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            Sync in progress — auto-refreshing
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {/* Object filter */}
        <Select value={objectFilter} onValueChange={setObjectFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Object" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All objects</SelectItem>
            {objectNames.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Type filter */}
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="delta">Delta</SelectItem>
            <SelectItem value="full">Full</SelectItem>
          </SelectContent>
        </Select>

        {/* Status filter */}
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
              <th className="w-8 px-2 py-2.5" />
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Started
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Object
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Type
              </th>
              <th className="text-right px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Duration
              </th>
              <th className="text-right px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Upserted
              </th>
              <th className="text-right px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Deleted
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Status
              </th>
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
            {!loading && entries.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="py-12 text-center text-sm text-[var(--color-muted-foreground)]"
                >
                  No log entries found
                </td>
              </tr>
            )}
            {entries.map((entry) => {
              const isError = entry.error !== null
              const isExpanded = expandedIds.has(entry.id)
              return (
                <Fragment key={entry.id}>
                  <tr
                    onClick={() => isError && toggleExpanded(entry.id)}
                    className={`border-b border-[var(--color-border)] last:border-0 transition-colors ${
                      isError ? 'cursor-pointer hover:bg-[var(--color-accent)]' : ''
                    }`}
                  >
                    <td className="px-2 py-3 text-center text-[var(--color-muted-foreground)]">
                      {isError ? (
                        isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-muted-foreground)] whitespace-nowrap">
                      {formatRelative(entry.startedAt)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{entry.objectApiName}</td>
                    <td className="px-4 py-3">
                      <Badge variant={entry.syncType === 'delta' ? 'default' : 'secondary'}>
                        {entry.syncType}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--color-muted-foreground)]">
                      {formatDuration(entry.startedAt, entry.completedAt)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--color-muted-foreground)]">
                      {entry.recordsUpserted.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--color-muted-foreground)]">
                      {entry.recordsDeleted.toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={isError ? 'destructive' : 'secondary'}>
                        {isError ? 'Error' : 'Success'}
                      </Badge>
                    </td>
                  </tr>
                  {isError && isExpanded && (
                    <tr className="bg-red-50 border-b border-[var(--color-border)]">
                      <td colSpan={8} className="px-6 py-3">
                        <p className="text-xs font-mono text-[var(--color-destructive)] whitespace-pre-wrap">
                          {entry.error}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Load more */}
      {hasMore && !loading && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Load more ({total - entries.length} remaining)
          </Button>
        </div>
      )}
    </div>
  )
}
