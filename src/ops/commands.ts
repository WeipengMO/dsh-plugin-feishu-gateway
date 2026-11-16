/**
 * Cross-profile operator command mailbox.
 * Web Admin writes a one-time request after DSH auth; the owning Gateway
 * atomically claims it before acting. Processing files are NEVER retried after
 * crashes: an unacknowledged cancellation is uncertain, not automatic replay.
 *
 * Capability-limited commands: cancel a running task, re-drain Outbox,
 * archive/unlink one unchanged Feishu binding, or manage native DSH scheduled
 * tasks. No command deletes DSH data. Schedule payloads are revalidated
 * authoritatively by ScheduleManager before any native API call.
 */
import { mkdir, readdir, lstat, readFile, rename, open, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export type ScheduleCommandAction =
  | 'create' | 'update' | 'pause' | 'resume' | 'run' | 'delete' | 'delete-inactive' | 'refresh'

/**
 * Mailbox-validated schedule payload. Field shapes are bounded here; semantic
 * validation (spec, allowlist, native ids) belongs to ScheduleManager so the
 * Web Admin is never a trust boundary.
 */
export interface ScheduleOperatorPayload {
  readonly action: ScheduleCommandAction
  readonly clientRef?: string
  readonly taskId?: string
  readonly title?: string
  readonly prompt?: string
  readonly spec?: Record<string, unknown>
  readonly notify?: 'result' | 'failure' | 'both' | 'none'
  readonly delivery?: Record<string, unknown> | null
  readonly expectedUpdatedAt?: string | null
}

export interface OperatorCommand {
  readonly version: 1
  readonly id: string
  readonly ts: number
  readonly type: 'cancel-task' | 'retry-outbox' | 'archive-session' | 'unbind-session' | 'batch-sessions' | 'schedule'
  readonly ref?: string
  readonly expectedLastActiveAt?: number
  /** Bounded, server-derived label of the authenticated DSH Web operator. */
  readonly actor?: string
  readonly schedule?: ScheduleOperatorPayload
  /** At most 20 versioned, hashed Feishu binding operations. No raw chat/session ID. */
  readonly batch?: SessionBatchPayload
}

export interface SessionBatchItem {
  readonly ref: string
  readonly chatRef: string
  readonly botId: string
  readonly expectedLastActiveAt: number
}
export interface SessionBatchPayload {
  readonly action: 'archive' | 'unlink'
  readonly items: readonly SessionBatchItem[]
}
export interface OperatorResult {
  readonly version: 1
  readonly id: string
  readonly ts: number
  readonly type: OperatorCommand['type']
  readonly state: 'completed' | 'not-found' | 'rejected' | 'error' | 'conflict'
  readonly ref?: string
  /** Bounded, stable outcome detail. Never a secret or a raw exception body. */
  readonly detail?: string
}
/** Execute callback may return a plain state or a state plus a bounded detail. */
export type OperatorExecutionResult = OperatorResult['state'] |
  { readonly state: OperatorResult['state']; readonly detail?: string }

const UUID = /^[a-f0-9-]{36}\.json$/
const REF = /^[a-f0-9]{16}$/
const TASK_ID = /^schedule-[a-f0-9-]{36}$/
const CLIENT_REF = /^[a-f0-9-]{36}$/
const ACTOR = /^[A-Za-z0-9_.:@-]{1,64}$/
const BOT_ID = /^[a-z][a-z0-9_-]{0,31}$/
const CHAT_ID = /^(?:oc_|ou_)[A-Za-z0-9_-]{2,128}$/
const OPEN_ID = /^ou_[A-Za-z0-9_-]{2,128}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T[\d:.Z+-]{1,40}$/
/** Schedule commands carry a prompt/spec; legacy commands stay tiny. */
const LEGACY_MAX_BYTES = 1024
const SCHEDULE_MAX_BYTES = 8192
const BATCH_MAX_BYTES = 4096
const RESULT_STATES = new Set<OperatorResult['state']>(['completed', 'not-found', 'rejected', 'error', 'conflict'])
const SCHEDULE_ACTIONS = new Set<ScheduleCommandAction>([
  'create', 'update', 'pause', 'resume', 'run', 'delete', 'delete-inactive', 'refresh',
])
const SCHEDULE_KEYS = ['action', 'clientRef', 'taskId', 'title', 'prompt', 'spec', 'notify', 'delivery', 'expectedUpdatedAt']
const DELIVERY_KEYS = ['botId', 'chatId', 'chatType', 'senderId']
const NOTIFY_VALUES = new Set(['result', 'failure', 'both', 'none'])

/** Validate every field again in the owner process; the browser is not an authority. */
function parseSessionBatch(value: unknown): SessionBatchPayload | null {
  if (!isPlainObject(value) || Object.keys(value).some(key => key !== 'action' && key !== 'items') ||
    (value.action !== 'archive' && value.action !== 'unlink') || !Array.isArray(value.items) ||
    value.items.length < 1 || value.items.length > 20) return null
  const items: SessionBatchItem[] = []
  const seen = new Set<string>()
  for (const item of value.items) {
    if (!isPlainObject(item) ||
      Object.keys(item).some(key => !['ref', 'chatRef', 'botId', 'expectedLastActiveAt'].includes(key)) ||
      typeof item.ref !== 'string' || !REF.test(item.ref) ||
      typeof item.chatRef !== 'string' || !REF.test(item.chatRef) ||
      typeof item.botId !== 'string' || !BOT_ID.test(item.botId) ||
      typeof item.expectedLastActiveAt !== 'number' ||
      !Number.isSafeInteger(item.expectedLastActiveAt) ||
      item.expectedLastActiveAt < 0 || item.expectedLastActiveAt > 1e13) return null
    const key = item.botId + ':' + item.chatRef
    if (seen.has(key)) return null
    seen.add(key)
    items.push({ ref: item.ref, chatRef: item.chatRef, botId: item.botId,
      expectedLastActiveAt: item.expectedLastActiveAt })
  }
  return { action: value.action, items }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function boundedString(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length >= min && trimmed.length <= max ? trimmed : undefined
}
/** Return null for any malformed schedule payload; the command is rejected. */
function parseSchedulePayload(value: unknown): ScheduleOperatorPayload | null {
  if (!isPlainObject(value)) return null
  for (const key of Object.keys(value)) if (!SCHEDULE_KEYS.includes(key)) return null
  const action = value.action
  if (typeof action !== 'string' || !SCHEDULE_ACTIONS.has(action as ScheduleCommandAction)) return null
  const payload: Record<string, unknown> = { action }

  if (value.clientRef !== undefined) {
    if (typeof value.clientRef !== 'string' || !CLIENT_REF.test(value.clientRef)) return null
    payload.clientRef = value.clientRef
  }
  if (value.taskId !== undefined) {
    if (typeof value.taskId !== 'string' || !TASK_ID.test(value.taskId)) return null
    payload.taskId = value.taskId
  }
  if (value.title !== undefined) {
    const title = boundedString(value.title, 1, 120)
    if (!title) return null
    payload.title = title
  }
  if (value.prompt !== undefined) {
    const prompt = boundedString(value.prompt, 1, 4000)
    if (!prompt) return null
    payload.prompt = prompt
  }
  if (value.spec !== undefined) {
    if (!isPlainObject(value.spec)) return null
    payload.spec = value.spec
  }
  if (value.notify !== undefined) {
    if (typeof value.notify !== 'string' || !NOTIFY_VALUES.has(value.notify)) return null
    payload.notify = value.notify
  }
  if (value.delivery !== undefined) {
    if (value.delivery === null) {
      payload.delivery = null
    } else {
      if (!isPlainObject(value.delivery)) return null
      for (const key of Object.keys(value.delivery)) if (!DELIVERY_KEYS.includes(key)) return null
      const d = value.delivery
      const botId = typeof d.botId === 'string' && BOT_ID.test(d.botId) ? d.botId : undefined
      const chatId = typeof d.chatId === 'string' && CHAT_ID.test(d.chatId) ? d.chatId : undefined
      if (!botId || !chatId || (d.chatType !== 'p2p' && d.chatType !== 'group')) return null
      if (d.senderId !== undefined &&
        (typeof d.senderId !== 'string' || !OPEN_ID.test(d.senderId))) return null
      payload.delivery = {
        botId, chatId, chatType: d.chatType,
        ...(typeof d.senderId === 'string' ? { senderId: d.senderId } : {}),
      } as Record<string, unknown>
    }
  }
  if (value.expectedUpdatedAt !== undefined) {
    if (value.expectedUpdatedAt === null) payload.expectedUpdatedAt = null
    else {
      if (typeof value.expectedUpdatedAt !== 'string' ||
        !INSTANT.test(value.expectedUpdatedAt)) return null
      payload.expectedUpdatedAt = value.expectedUpdatedAt
    }
  }
  return payload as unknown as ScheduleOperatorPayload
}

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

/** Keep result details a compact, allowlisted alphabet (no IDs or stack traces). */
function boundedDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[^A-Za-z0-9 _.:/+@=-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  return clean || undefined
}

export async function processOperatorCommands(
  stateDir: string,
  execute: (command: OperatorCommand) => Promise<OperatorExecutionResult>,
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
    let fileSize = 0
    try {
      const stat = await lstat(source)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SCHEDULE_MAX_BYTES) continue
      fileSize = stat.size
      await rename(source, claimed)
    } catch { continue } // already claimed, deleted, or invalid
    let cmd: OperatorCommand | null = null
    let state: OperatorResult['state'] = 'rejected'
    let detail: string | undefined
    let resultType: OperatorCommand['type'] = 'cancel-task'
    try {
      const data = JSON.parse(await readFile(claimed, 'utf8')) as Record<string, unknown>
      const isSession = data.type === 'archive-session' || data.type === 'unbind-session'
      const isSchedule = data.type === 'schedule'
      const isBatch = data.type === 'batch-sessions'
      if (isSchedule) resultType = 'schedule'
      if (isBatch) resultType = 'batch-sessions'
      const legacy = data.type === 'cancel-task' || data.type === 'retry-outbox' || isSession
      const fresh = typeof data.ts === 'number' && Date.now() - data.ts >= 0 &&
        Date.now() - data.ts < 30_000
      if (data?.version === 1 && data.id === name.slice(0, -5) && fresh &&
        (legacy || isSchedule || isBatch) &&
        fileSize <= (isSchedule ? SCHEDULE_MAX_BYTES : isBatch ? BATCH_MAX_BYTES : LEGACY_MAX_BYTES)) {
        if (isSchedule) {
          const schedule = parseSchedulePayload(data.schedule)
          const actor = typeof data.actor === 'string' && ACTOR.test(data.actor)
            ? data.actor : 'dsh-web-admin'
          if (schedule) {
            const command: OperatorCommand = {
              version: 1, id: data.id as string, ts: data.ts as number,
              type: 'schedule', actor, schedule,
            }
            cmd = command
            const outcome = await execute(command)
            state = typeof outcome === 'string' ? outcome : outcome.state
            detail = boundedDetail(typeof outcome === 'string' ? undefined : outcome.detail)
          }
        } else if (isBatch && Object.keys(data).every(key =>
          ['version', 'id', 'ts', 'type', 'batch'].includes(key))) {
          const batch = parseSessionBatch(data.batch)
          if (batch) {
            const command: OperatorCommand = {
              version: 1, id: data.id as string, ts: data.ts as number,
              type: 'batch-sessions', batch,
            }
            cmd = command
            const outcome = await execute(command)
            state = typeof outcome === 'string' ? outcome : outcome.state
            detail = boundedDetail(typeof outcome === 'string' ? undefined : outcome.detail)
          }
        } else if ((data.type === 'cancel-task' || data.type === 'retry-outbox' || isSession) &&
          (data.type === 'retry-outbox' ? data.ref === undefined && data.expectedLastActiveAt === undefined :
            REF.test(data.ref as string)) &&
          (!isSession || (Number.isSafeInteger(data.expectedLastActiveAt) &&
            (data.expectedLastActiveAt as number) >= 0 && (data.expectedLastActiveAt as number) <= 1e13)) &&
          (isSession || data.expectedLastActiveAt === undefined)) {
          cmd = { version: 1, id: data.id as string, ts: data.ts as number, type: data.type as OperatorCommand['type'],
            ...(typeof data.ref === 'string' ? { ref: data.ref } : {}),
            ...(isSession ? { expectedLastActiveAt: data.expectedLastActiveAt as number } : {}) }
          const outcome = await execute(cmd)
          state = typeof outcome === 'string' ? outcome : outcome.state
          detail = boundedDetail(typeof outcome === 'string' ? undefined : outcome.detail)
        }
      }
      if (!RESULT_STATES.has(state)) state = 'error'
    } catch { state = 'error' }
    try {
      await writeResult(results, { version: 1, id: name.slice(0, -5),
        ts: Date.now(), type: cmd?.type ?? resultType, state,
        ...(cmd?.ref ? { ref: cmd.ref } : {}),
        ...(detail ? { detail } : {}) })
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
