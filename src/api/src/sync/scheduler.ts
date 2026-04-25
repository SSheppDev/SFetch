import cron from 'node-cron'
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
// Sync lock helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire the sync lock.
 *
 * Returns true if acquired, false if currently held by a fresh job.
 * A stale lock (held for > 30 minutes) is forcibly taken.
 */
async function acquireLock(jobType: string): Promise<boolean> {
  const result = await pool.query<SyncLockRow>(
    `SELECT locked, locked_at, job_type FROM sfdb.sync_lock WHERE id = 1`
  )
  const row = result.rows[0]
  if (!row) {
    // Defensive: row should always exist (seeded in init SQL)
    return false
  }

  if (!row.locked) {
    // Lock is free — take it
    await pool.query(
      `UPDATE sfdb.sync_lock SET locked = true, locked_at = NOW(), job_type = $1 WHERE id = 1`,
      [jobType]
    )
    return true
  }

  // Lock is held — check if stale (> 30 minutes)
  if (row.locked_at !== null) {
    const ageMs = Date.now() - row.locked_at.getTime()
    const thirtyMinMs = 30 * 60 * 1_000
    if (ageMs > thirtyMinMs) {
      // Stale lock — take it
      console.warn(
        `[scheduler] Stale sync lock detected (held by "${row.job_type}" for ${Math.round(ageMs / 60_000)} min). Taking it.`
      )
      await pool.query(
        `UPDATE sfdb.sync_lock SET locked = true, locked_at = NOW(), job_type = $1 WHERE id = 1`,
        [jobType]
      )
      return true
    }
  }

  // Fresh lock held by another job — skip
  return false
}

/**
 * Release the sync lock unconditionally.
 */
async function releaseLock(): Promise<void> {
  await pool.query(
    `UPDATE sfdb.sync_lock SET locked = false, locked_at = NULL, job_type = NULL WHERE id = 1`
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
// Auto-sync enabled check
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

// ---------------------------------------------------------------------------
// Delta interval helper — reads min delta_interval_minutes across enabled objects
// ---------------------------------------------------------------------------

async function getMinDeltaIntervalMinutes(defaultMinutes = 60): Promise<number> {
  try {
    const result = await pool.query<SyncConfigMinRow>(
      `SELECT MIN(delta_interval_minutes) AS delta_interval_minutes
       FROM sfdb.sync_config
       WHERE enabled = true`
    )
    const min = result.rows[0]?.delta_interval_minutes
    return typeof min === 'number' && min > 0 ? min : defaultMinutes
  } catch {
    return defaultMinutes
  }
}

// ---------------------------------------------------------------------------
// Exports: lock status
// ---------------------------------------------------------------------------

export interface SyncLockStatus {
  locked: boolean
  lockedAt: Date | null
  jobType: string | null
}

export async function getSyncLockStatus(): Promise<SyncLockStatus> {
  const result = await pool.query<SyncLockRow>(
    `SELECT locked, locked_at, job_type FROM sfdb.sync_lock WHERE id = 1`
  )
  const row = result.rows[0]
  return {
    locked: row?.locked ?? false,
    lockedAt: row?.locked_at ?? null,
    jobType: row?.job_type ?? null,
  }
}

// ---------------------------------------------------------------------------
// Exports: manual triggers
// ---------------------------------------------------------------------------

/**
 * Trigger a delta sync immediately for the given org.
 * Acquires the sync lock; throws if already held by a fresh job.
 */
export async function triggerDeltaSync(orgAlias: string): Promise<void> {
  const acquired = await acquireLock('delta')
  if (!acquired) {
    throw new Error('Sync already in progress — could not acquire lock')
  }
  try {
    await purgeOldLogs()
    await runDeltaSync(orgAlias)
  } finally {
    await releaseLock()
  }
}

/**
 * Trigger a full ID reconciliation immediately for the given org.
 * Acquires the sync lock; throws if already held by a fresh job.
 */
export async function triggerFullSync(orgAlias: string): Promise<void> {
  const acquired = await acquireLock('full')
  if (!acquired) {
    throw new Error('Sync already in progress — could not acquire lock')
  }
  try {
    await runReconciliation(orgAlias)
  } finally {
    await releaseLock()
  }
}

/**
 * Trigger a delta sync for a single object immediately.
 * Acquires the sync lock; throws if already held by a fresh job.
 */
export async function triggerDeltaSyncForObject(orgAlias: string, objectApiName: string): Promise<void> {
  const acquired = await acquireLock('delta')
  if (!acquired) {
    throw new Error('Sync already in progress — could not acquire lock')
  }
  try {
    await purgeOldLogs()
    await runDeltaSync(orgAlias, objectApiName)
  } finally {
    await releaseLock()
  }
}

/**
 * Trigger a full reconciliation for a single object immediately.
 * Acquires the sync lock; throws if already held by a fresh job.
 */
export async function triggerFullSyncForObject(orgAlias: string, objectApiName: string): Promise<void> {
  const acquired = await acquireLock('full')
  if (!acquired) {
    throw new Error('Sync already in progress — could not acquire lock')
  }
  try {
    await runReconciliation(orgAlias, objectApiName)
  } finally {
    await releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Scheduler startup
// ---------------------------------------------------------------------------

/**
 * Start cron jobs for delta sync and full reconciliation.
 *
 * Delta sync: fires every minute, checks the configured interval on each tick
 * so UI changes to delta_interval_minutes are picked up without a restart.
 *
 * Full reconciliation: fires daily at 2am.
 */
export function startScheduler(orgAlias: string): void {
  // Delta sync — check every minute, respect configured interval
  let lastDeltaRun: Date | null = null

  cron.schedule('* * * * *', () => {
    void (async () => {
      try {
        if (!(await isAutoSyncEnabled())) return

        const intervalMinutes = await getMinDeltaIntervalMinutes()
        const now = new Date()

        if (
          lastDeltaRun !== null &&
          now.getTime() - lastDeltaRun.getTime() < intervalMinutes * 60_000
        ) {
          return // Not enough time has elapsed since last run
        }

        const acquired = await acquireLock('delta')
        if (!acquired) {
          console.log('[scheduler] Delta sync skipped — lock held by another job')
          return
        }

        lastDeltaRun = now

        try {
          await purgeOldLogs()
          await runDeltaSync(orgAlias)
        } finally {
          await releaseLock()
        }
      } catch (err) {
        console.error('[scheduler] Delta sync error:', (err as Error).message)
        // Best-effort lock release on unexpected error
        try {
          await releaseLock()
        } catch {
          // ignore
        }
      }
    })()
  })

  // Full reconciliation — daily at 2am
  cron.schedule('0 2 * * *', () => {
    void (async () => {
      try {
        if (!(await isAutoSyncEnabled())) return

        const acquired = await acquireLock('full')
        if (!acquired) {
          console.log('[scheduler] Full reconciliation skipped — lock held by another job')
          return
        }

        try {
          await runReconciliation(orgAlias)
        } finally {
          await releaseLock()
        }
      } catch (err) {
        console.error('[scheduler] Full reconciliation error:', (err as Error).message)
        // Best-effort lock release on unexpected error
        try {
          await releaseLock()
        } catch {
          // ignore
        }
      }
    })()
  })

  console.log(
    `[scheduler] Started for org "${orgAlias}" (delta: dynamic interval, full: daily at 2am)`
  )
}
