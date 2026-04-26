import * as cron from 'node-cron'
import { pool } from '../db/pool'
import { runDeltaSync } from './deltaSync'
import { runReconciliation } from './reconciliationSync'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SyncLockRow {
  locked: boolean
  locked_at: Date | null
  job_type: string | null
}

interface SyncConfigMinRow {
  delta_interval_minutes: number
}

interface AppConfigRow {
  value: string | null
}

// ---------------------------------------------------------------------------
// Per-org sync lock helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire the per-org sync lock.
 *
 * Returns true if acquired, false if currently held by a fresh job.
 * A stale lock (held for > 30 minutes) is forcibly taken.
 */
async function acquireLock(orgId: string, jobType: string): Promise<boolean> {
  const result = await pool.query<SyncLockRow>(
    `SELECT locked, locked_at, job_type FROM sfdb.sync_lock WHERE org_id = $1`,
    [orgId]
  )
  const row = result.rows[0]
  if (!row) {
    // No row yet — insert one in the locked state
    const insert = await pool.query(
      `INSERT INTO sfdb.sync_lock (org_id, locked, locked_at, job_type)
       VALUES ($1, true, NOW(), $2)
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId, jobType]
    )
    return (insert.rowCount ?? 0) > 0
  }

  if (!row.locked) {
    await pool.query(
      `UPDATE sfdb.sync_lock SET locked = true, locked_at = NOW(), job_type = $2
       WHERE org_id = $1`,
      [orgId, jobType]
    )
    return true
  }

  if (row.locked_at !== null) {
    const ageMs = Date.now() - row.locked_at.getTime()
    const thirtyMinMs = 30 * 60 * 1_000
    if (ageMs > thirtyMinMs) {
      console.warn(
        `[scheduler] [${orgId}] Stale sync lock detected (held by "${row.job_type}" for ${Math.round(ageMs / 60_000)} min). Taking it.`
      )
      await pool.query(
        `UPDATE sfdb.sync_lock SET locked = true, locked_at = NOW(), job_type = $2
         WHERE org_id = $1`,
        [orgId, jobType]
      )
      return true
    }
  }

  return false
}

async function releaseLock(orgId: string): Promise<void> {
  await pool.query(
    `UPDATE sfdb.sync_lock SET locked = false, locked_at = NULL, job_type = NULL
     WHERE org_id = $1`,
    [orgId]
  )
}

// ---------------------------------------------------------------------------
// Log purge
// ---------------------------------------------------------------------------

export async function purgeOldLogs(): Promise<void> {
  const days = process.env.LOG_RETENTION_DAYS ?? '14'
  await pool.query(
    `DELETE FROM sfdb.sync_log WHERE started_at < NOW() - ($1 || ' days')::interval`,
    [days]
  )
}

// ---------------------------------------------------------------------------
// Auto-sync enabled check (global)
// ---------------------------------------------------------------------------

async function isAutoSyncEnabled(): Promise<boolean> {
  try {
    const result = await pool.query<AppConfigRow>(
      `SELECT value FROM sfdb.app_config WHERE key = 'auto_sync_enabled'`
    )
    const value = result.rows[0]?.value
    return value === 'true'
  } catch {
    return false
  }
}

async function getMinDeltaIntervalMinutes(orgId: string, defaultMinutes = 60): Promise<number> {
  try {
    const result = await pool.query<SyncConfigMinRow>(
      `SELECT MIN(delta_interval_minutes) AS delta_interval_minutes
       FROM sfdb.sync_config
       WHERE org_id = $1 AND enabled = true`,
      [orgId]
    )
    const min = result.rows[0]?.delta_interval_minutes
    return typeof min === 'number' && min > 0 ? min : defaultMinutes
  } catch {
    return defaultMinutes
  }
}

// ---------------------------------------------------------------------------
// Lock status (per-org)
// ---------------------------------------------------------------------------

export interface SyncLockStatus {
  locked: boolean
  lockedAt: Date | null
  jobType: string | null
}

export async function getSyncLockStatus(orgId: string): Promise<SyncLockStatus> {
  const result = await pool.query<SyncLockRow>(
    `SELECT locked, locked_at, job_type FROM sfdb.sync_lock WHERE org_id = $1`,
    [orgId]
  )
  const row = result.rows[0]
  return {
    locked: row?.locked ?? false,
    lockedAt: row?.locked_at ?? null,
    jobType: row?.job_type ?? null,
  }
}

// ---------------------------------------------------------------------------
// Manual triggers (per-org)
// ---------------------------------------------------------------------------

export async function triggerDeltaSync(orgId: string): Promise<void> {
  const acquired = await acquireLock(orgId, 'delta')
  if (!acquired) {
    throw new Error('Sync already in progress — could not acquire lock')
  }
  try {
    await purgeOldLogs()
    await runDeltaSync(orgId)
  } finally {
    await releaseLock(orgId)
  }
}

export async function triggerFullSync(orgId: string): Promise<void> {
  const acquired = await acquireLock(orgId, 'full')
  if (!acquired) {
    throw new Error('Sync already in progress — could not acquire lock')
  }
  try {
    await runReconciliation(orgId)
  } finally {
    await releaseLock(orgId)
  }
}

export async function triggerDeltaSyncForObject(orgId: string, objectApiName: string): Promise<void> {
  const acquired = await acquireLock(orgId, 'delta')
  if (!acquired) {
    throw new Error('Sync already in progress — could not acquire lock')
  }
  try {
    await purgeOldLogs()
    await runDeltaSync(orgId, objectApiName)
  } finally {
    await releaseLock(orgId)
  }
}

export async function triggerFullSyncForObject(orgId: string, objectApiName: string): Promise<void> {
  const acquired = await acquireLock(orgId, 'full')
  if (!acquired) {
    throw new Error('Sync already in progress — could not acquire lock')
  }
  try {
    await runReconciliation(orgId, objectApiName)
  } finally {
    await releaseLock(orgId)
  }
}

// ---------------------------------------------------------------------------
// Scheduler — one job stream per registered org. Each org's delta and full
// jobs use that org's per-org lock so two orgs can sync concurrently.
// ---------------------------------------------------------------------------

interface SchedulerEntry {
  orgId: string
  lastDeltaRun: Date | null
}

const schedulerState = new Map<string, SchedulerEntry>()

let started = false
let deltaTask: cron.ScheduledTask | null = null
let fullTask: cron.ScheduledTask | null = null

async function listRegisteredOrgIds(): Promise<string[]> {
  const result = await pool.query<{ org_id: string }>(`SELECT org_id FROM sfdb.orgs`)
  return result.rows.map((r) => r.org_id)
}

function syncSchedulerEntries(orgIds: string[]): void {
  const seen = new Set(orgIds)
  for (const orgId of orgIds) {
    if (!schedulerState.has(orgId)) {
      schedulerState.set(orgId, { orgId, lastDeltaRun: null })
    }
  }
  for (const orgId of [...schedulerState.keys()]) {
    if (!seen.has(orgId)) schedulerState.delete(orgId)
  }
}

async function runDeltaTick(entry: SchedulerEntry): Promise<void> {
  if (!(await isAutoSyncEnabled())) return

  const intervalMinutes = await getMinDeltaIntervalMinutes(entry.orgId)
  const now = new Date()
  if (
    entry.lastDeltaRun !== null &&
    now.getTime() - entry.lastDeltaRun.getTime() < intervalMinutes * 60_000
  ) {
    return
  }

  const acquired = await acquireLock(entry.orgId, 'delta')
  if (!acquired) {
    console.log(`[scheduler] [${entry.orgId}] Delta sync skipped — lock held`)
    return
  }

  entry.lastDeltaRun = now

  try {
    await purgeOldLogs()
    await runDeltaSync(entry.orgId)
  } finally {
    await releaseLock(entry.orgId)
  }
}

async function runFullTick(entry: SchedulerEntry): Promise<void> {
  if (!(await isAutoSyncEnabled())) return
  const acquired = await acquireLock(entry.orgId, 'full')
  if (!acquired) {
    console.log(`[scheduler] [${entry.orgId}] Full reconciliation skipped — lock held`)
    return
  }
  try {
    await runReconciliation(entry.orgId)
  } finally {
    await releaseLock(entry.orgId)
  }
}

/**
 * Start cron jobs that run delta + full reconciliation across all registered orgs.
 *
 * - Delta tick fires every minute; each org runs its own delta if its configured
 *   interval has elapsed and its per-org lock is free.
 * - Full reconciliation tick fires daily at 02:00; each org reconciles independently.
 *
 * Idempotent — calling startScheduler() again is a no-op.
 */
export function startScheduler(): void {
  if (started) return
  started = true

  deltaTask = cron.schedule('* * * * *', () => {
    void (async () => {
      try {
        const orgIds = await listRegisteredOrgIds()
        syncSchedulerEntries(orgIds)
        for (const entry of schedulerState.values()) {
          try {
            await runDeltaTick(entry)
          } catch (err) {
            console.error(`[scheduler] [${entry.orgId}] Delta sync error:`, (err as Error).message)
            try { await releaseLock(entry.orgId) } catch { /* ignore */ }
          }
        }
      } catch (err) {
        console.error('[scheduler] Delta tick error:', (err as Error).message)
      }
    })()
  })

  fullTask = cron.schedule('0 2 * * *', () => {
    void (async () => {
      try {
        const orgIds = await listRegisteredOrgIds()
        syncSchedulerEntries(orgIds)
        for (const entry of schedulerState.values()) {
          try {
            await runFullTick(entry)
          } catch (err) {
            console.error(`[scheduler] [${entry.orgId}] Full reconciliation error:`, (err as Error).message)
            try { await releaseLock(entry.orgId) } catch { /* ignore */ }
          }
        }
      } catch (err) {
        console.error('[scheduler] Full tick error:', (err as Error).message)
      }
    })()
  })

  console.log('[scheduler] Started (delta: per-minute check, full: daily 02:00) — operates on all registered orgs')
}

/**
 * For tests / shutdown.
 */
export function stopScheduler(): void {
  deltaTask?.stop()
  fullTask?.stop()
  deltaTask = null
  fullTask = null
  started = false
  schedulerState.clear()
}
