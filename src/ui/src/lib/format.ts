/**
 * Format a date/ISO string as a human-readable relative time (e.g. "2 hours ago").
 * Returns "Never" when the value is null/undefined.
 */
export function formatRelative(date: string | null | undefined): string {
  if (!date) return 'Never'
  const diff = Date.now() - new Date(date).getTime()
  if (diff < 0) return 'Just now'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Format a byte count as a human-readable size string (e.g. "48.3 MB").
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

/**
 * Format a duration in milliseconds as a seconds string (e.g. "3.2s").
 */
export function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return '—'
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 0) return '—'
  return `${(ms / 1000).toFixed(1)}s`
}
