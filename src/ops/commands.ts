/**
 * Cross-profile operator command mailbox.
 * Web Admin writes a one-time request after DSH auth; the owning Gateway
 * atomically claims it before acting. Processing files are NEVER retried after
 * crashes: an unacknowledged cancellation is uncertain, not automatic replay.
 *
 * Capability-limited commands: cancel a running task, re-drain Outbox, or
 * archive/unlink one unchanged Feishu binding. No command deletes DSH data.
 */
import { mkdir, readdir, lstat, readFile, rename, open, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export interface OperatorCommand {
  readonly version: 1
  readonly id: string
  readonly ts: number
  readonly type: 'cancel-task' | 'retry-outbox' | 'archive-session' | 'unbind-session'
  readonly ref?: string
  readonly expectedLastActiveAt?: number
}
export interface OperatorResult {
  readonly version: 1
  readonly id: string
  readonly ts: number
  readonly type: OperatorCommand['type']
  readonly state: 'completed' | 'not-found' | 'rejected' | 'error'
  readonly ref?: string
}
const UUID = /^[a-f0-9-]{36}\.json$/
const REF = /^[a-f0-9]{16}$/
async function realDir(dir: string): Promise<void> {
  const stat = await lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('unsafe mailbox directory')
}
async function writeResult(dir: string, result: OperatorResult): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await realDir(dir)
  const target = path.join(dir, result.id + '.json')
  const temp = path.join(dir, result.id + '.tmp.' + randomUUID())
  try {
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(result) + '\n'); await handle.sync() }
    finally { await handle.close() }
    await rename(temp, target)
  } finally { await rm(temp, { force: true }).catch(() => undefined) }
}

export async function processOperatorCommands(
  stateDir: string,
  execute: (command: OperatorCommand) => Promise<OperatorResult['state']>,
): Promise<number> {
  const root = path.join(stateDir, 'ops-control')
  const inbox = path.join(root, 'requests')
  const processing = path.join(root, 'processing')
  const results = path.join(root, 'results')
  try {
    await realDir(stateDir)
    await realDir(root)
    await realDir(inbox)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw e
  }
  await mkdir(processing, { recursive: true, mode: 0o700 })
  await realDir(processing)
  let count = 0
  const names = (await readdir(inbox)).filter(x => UUID.test(x)).sort().slice(0, 30)
  for (const name of names) {
    const source = path.join(inbox, name)
    const claimed = path.join(processing, name)
    try {
      const stat = await lstat(source)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) continue
      await rename(source, claimed)
    } catch { continue } // already claimed, deleted, or invalid
    let cmd: OperatorCommand | null = null
    let state: OperatorResult['state'] = 'rejected'
    try {
      const data = JSON.parse(await readFile(claimed, 'utf8'))
      const isSession = data.type === 'archive-session' || data.type === 'unbind-session'
      if (data?.version === 1 && data.id === name.slice(0, -5) &&
        typeof data.ts === 'number' && Date.now() - data.ts >= 0 &&
        Date.now() - data.ts < 30_000 &&
        (data.type === 'cancel-task' || data.type === 'retry-outbox' || isSession) &&
        (data.type === 'retry-outbox' ? data.ref === undefined && data.expectedLastActiveAt === undefined :
          REF.test(data.ref)) &&
        (!isSession || (Number.isSafeInteger(data.expectedLastActiveAt) &&
          data.expectedLastActiveAt >= 0 && data.expectedLastActiveAt <= 1e13)) &&
        (isSession || data.expectedLastActiveAt === undefined)) {
        cmd = { version: 1, id: data.id, ts: data.ts, type: data.type,
          ...(data.ref ? { ref: data.ref } : {}),
          ...(isSession ? { expectedLastActiveAt: data.expectedLastActiveAt } : {}) }
        state = await execute(cmd)
      }
    } catch { state = 'error' }
    try {
      await writeResult(results, { version: 1, id: name.slice(0, -5),
        ts: Date.now(), type: cmd?.type ?? 'cancel-task', state,
        ...(cmd?.ref ? { ref: cmd.ref } : {}) })
      await rm(claimed, { force: true })
    } catch {
      // Claimed files are never re-executed. The operator can inspect an
      // uncertain timeout rather than silently repeating an action.
    }
    count += 1
  }
  // Keep a bounded on-disk outcome history. No operator action is retried
  // when a result ages out; cleanup is strictly housekeeping.
  try {
    const resultNames = (await readdir(results)).filter(name => UUID.test(name))
    if (resultNames.length > 500) {
      const dates = await Promise.all(resultNames.map(async name => {
        const st = await lstat(path.join(results, name))
        return { name, mtimeMs: st.isFile() && !st.isSymbolicLink() ? st.mtimeMs : Infinity }
      }))
      dates.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const old of dates.slice(0, Math.max(0, dates.length - 500))) {
        if (Number.isFinite(old.mtimeMs)) await rm(path.join(results, old.name), { force: true })
      }
    }
  } catch { /* Retention cleanup must never interrupt the Gateway */ }
  return count
}
