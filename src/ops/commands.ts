/**
 * Cross-profile operator command mailbox.
 * Web Admin writes a one-time request after DSH auth; the owning Gateway
 * atomically claims it before acting. Processing files are NEVER retried after
 * crashes: an unacknowledged cancellation is uncertain, not automatic replay.
 *
 * Only two capability-limited commands exist: cancel an already running task,
 * or ask the durable Outbox to re-drain existing pending UUIDs.
 */
import { mkdir, readdir, lstat, readFile, rename, open, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export interface OperatorCommand {
  readonly version: 1
  readonly id: string
  readonly ts: number
  readonly type: 'cancel-task' | 'retry-outbox'
  readonly ref?: string
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
      if (data?.version === 1 && data.id === name.slice(0, -5) &&
        typeof data.ts === 'number' && Date.now() - data.ts >= 0 &&
        Date.now() - data.ts < 30_000 &&
        (data.type === 'cancel-task' || data.type === 'retry-outbox') &&
        (data.type !== 'cancel-task' || REF.test(data.ref)) &&
        (data.type !== 'retry-outbox' || data.ref === undefined)) {
        cmd = { version: 1, id: data.id, ts: data.ts, type: data.type,
          ...(data.ref ? { ref: data.ref } : {}) }
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
  return count
}
