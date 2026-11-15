import { readFileSync } from 'node:fs'
import { link, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GatewayLogger } from '../types.js'
import { newId } from '../util/id.js'

export interface StateDirOwnerLock {
  /** Release the lock only if this instance still owns it. */
  release(): Promise<void>
}

interface LockPayload {
  readonly owner: string
  readonly pid: number
  readonly host: string
  readonly acquiredAt: number
  /** `/proc/<pid>/stat` starttime; distinguishes PID reuse from a live owner. */
  readonly procStart?: string
}

interface ProcIdentity {
  readonly state: string
  readonly start: string
}

/**
 * Read Linux `/proc/<pid>/stat` field 3 (state) and field 22 (starttime).
 * Returns undefined on other platforms or once the process is gone.
 */
function procIdentity(pid: number): ProcIdentity | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // `comm` is parenthesized and may contain spaces: skip to the last ')'.
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
    const state = fields[0]
    const start = fields[19]
    if (!state || !start) return undefined
    return { state, start }
  } catch {
    return undefined
  }
}

function ownerAlive(lock: LockPayload): boolean {
  if (lock.pid <= 0) return false
  // A lock written on another host cannot be inspected here; fail closed.
  if (lock.host !== os.hostname()) return true
  if (lock.procStart) {
    const current = procIdentity(lock.pid)
    if (!current) return false
    // A zombie has exited; PID reuse is caught by the starttime comparison.
    if (current.state === 'Z' || current.state === 'X') return false
    return current.start === lock.procStart
  }
  try {
    process.kill(lock.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Acquire an exclusive owner lock on a state directory.
 *
 * The Inbox admission authority is a per-instance in-memory Map, so two
 * gateways pointed at the same `stateDir` would each admit the same Feishu
 * `message_id` and execute the Agent turn twice. Failing closed is strictly
 * safer than duplicating potentially irreversible side effects.
 *
 * The lock is atomically published with a same-directory hardlink (no native dependency). A lock
 * owned by a dead process (crash / SIGKILL) is treated as stale and taken over,
 * so routine restarts can recover without manual intervention. A crash while holding the
 * reaper gate fails closed and requires manual inspection. PID reuse is detected via the
 * `/proc` starttime. This is an advisory single-owner guard, NOT a distributed
 * mutex: `stateDir` must be local to one host and one gateway instance.
 */
export async function acquireStateDirOwnerLock(
  stateDir: string,
  logger: GatewayLogger,
): Promise<StateDirOwnerLock> {
  await mkdir(stateDir, { recursive: true })
  const file = path.join(stateDir, '.owner.lock')
  const identity = procIdentity(process.pid)
  const payload: LockPayload = {
    owner: newId('owner'),
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: Date.now(),
    ...(identity ? { procStart: identity.start } : {}),
  }

  // Publish a fully-written lock atomically via hardlink. A plain O_EXCL open
  // briefly exposes an empty lock file, which another process could reap.
  const staging = `${file}.${payload.owner}.tmp`
  const reaper = `${file}.reaper`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await writeFile(staging, JSON.stringify(payload), { mode: 0o600 })
      await link(staging, file)
      return {
        release: async () => {
          try {
            const current = JSON.parse(await readFile(file, 'utf8')) as LockPayload
            if (current.owner !== payload.owner) return
          } catch {
            return
          }
          await rm(file, { force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await rm(staging, { force: true })
    }

    // Only one process may REAP a stale lock. Without this second exclusive
    // gate, two concurrent restarters can delete each other's fresh lock.
    try {
      await mkdir(reaper, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
      continue
    }
    try {
      let existing: LockPayload | undefined
      try {
        existing = JSON.parse(await readFile(file, 'utf8')) as LockPayload
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('unreadable stateDir owner lock; requiring recovery: %s', String(error))
          throw new Error('invalid owner lock; inspect and repair the stateDir manually', { cause: error })
        }
      }
      if (existing && ownerAlive(existing)) {
        throw new Error(
          `stateDir ${stateDir} is already owned by a running Feishu gateway (pid ${existing.pid}); ` +
          'sharing one stateDir across instances would duplicate Agent execution',
        )
      }
      if (existing) logger.warn('reaping stale stateDir lock (pid %s)', existing.pid)
      await rm(file, { force: true })
    } finally {
      await rmdir(reaper)
    }
  }
  throw new Error(`could not acquire exclusive owner lock for stateDir ${stateDir}; check ${reaper} for a crashed reaper`)
}
