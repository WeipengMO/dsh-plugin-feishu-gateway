/**
 * Read-only, explicitly whitelisted scheduled-tasks DTOs for authenticated
 * DSH Web. Everything here mirrors the strict style of ops-read.mjs:
 * verified lstat chain (no symlinks), <= 1 MiB, version===1, bounded ts,
 * bounded strings, no arbitrary keys and never any raw exception text.
 * It reads only stateDir/ops-schedule.json and ops-control/results/*.json.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SCHEDULE_ACTIONS, SCHEDULE_NOTIFY, SCHEDULE_TASK_ID_RE,
  validateSpecShape, validTimeZone } from './schedule-spec.mjs'

const MODEL_FILE = 'ops-schedule.json'
const MODEL_MAX = 1024 * 1024 // 1 MiB
const STALE_MS = 30000
const TASKS_MAX = 200
const DELIVERIES_MAX = 200
const DELIVERIES_PER_TASK = 20
const RUNS_MAX = 200
const AUDIT_MAX = 200
const RESULTS_MAX = 100
const RESULTS_FILE_MAX = 2048 // schedule results may carry a bounded detail

const safeNum = n => Number.isFinite(n) && n >= 0 && n <= 1e13 ? Math.floor(n) : undefined
const safeRef = s => typeof s === 'string' && /^[a-f0-9]{16}$/.test(s) ? s : undefined
const safeLabel = s => typeof s === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(s) ? s : undefined
const safeBot = s => typeof s === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(s) ? s : undefined
const safeChat = s => typeof s === 'string' && /^(?:oc_|ou_)[A-Za-z0-9_-]{2,128}$/.test(s) ? s : undefined
const safeSender = s => typeof s === 'string' && /^ou_[A-Za-z0-9_-]{2,128}$/.test(s) ? s : undefined
const safeTaskId = s => typeof s === 'string' && SCHEDULE_TASK_ID_RE.test(s) ? s : undefined
const safeText = (s, max) => typeof s === 'string' && s.length <= max && !s.includes('\0') ? s : undefined
const safeModel = s => typeof s === 'string' && /^[a-zA-Z0-9_.:/-]{1,96}$/.test(s) ? s : undefined
const safeIso = s => typeof s === 'string' && s.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(s) &&
  Number.isFinite(Date.parse(s)) ? s : undefined
const ACTOR_MAX = 64
const SUMMARY_MAX = 200
const MESSAGE_MAX = 128
// Native target Session ids are full ids (e.g. feishu-schedule-<uuid>-session-<uuid>),
// not the 16-hex display ref. restoreTaskSessions() reads the FULL raw id back
// from snapshot().tasks[].target.sessionId to bridge.resume() after a restart,
// so this field must never be hashed or truncated. Admin-only DTO, same trust
// level as the allowlist open_ids already returned by GET /state.
const SESSION_ID_MAX = 256
const ERROR_MAX = 200
const TITLE_MAX = 120
const PROMPT_MAX = 4000
const ZONE_MAX = 64
const STATUSES = new Set(['active', 'paused', 'ended', 'inactive', 'completed', 'expired', 'error', 'unknown'])
const RUN_STATES = new Set(['success', 'failed', 'skipped', 'timeout', 'empty', 'unknown'])
const OUTCOME_STATES = new Set(['completed', 'rejected', 'not-found', 'conflict', 'error'])

async function readSafeFile(dir, file, maxBytes) {
  const root = await fs.lstat(dir).catch(e => { if (e.code === 'ENOENT') return null; throw e })
  if (!root) return null
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error('unsafe management state directory')
  const name = path.join(dir, file)
  const st = await fs.lstat(name).catch(e => { if (e.code === 'ENOENT') return null; throw e })
  if (!st) return null
  if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes)
    throw Error('unsafe or oversized scheduled-tasks snapshot')
  return await fs.readFile(name, 'utf8')
}

function isoOr(value) { return safeIso(value) }
function whitelistDeliveryRecord(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  // Native receipts carry the full Session id; a hashed 16-hex sessionRef is
  // also accepted when the manager emits one. Support both.
  const session = safeRef(x.targetSessionId) || safeText(x.targetSessionId, SESSION_ID_MAX)
  return {
    ...(isoOr(x.scheduledAt) ? { scheduledAt: x.scheduledAt } : {}),
    ...(isoOr(x.deliveredAt) ? { deliveredAt: x.deliveredAt } : {}),
    ...(safeText(x.messageId, MESSAGE_MAX) ? { messageId: x.messageId } : {}),
    ...(session ? { targetSessionId: session } : {}),
  }
}
function whitelistTarget(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const kind = safeLabel(x.kind) ?? 'session'
  // FULL raw session id: restoreTaskSessions() resumes it after a restart.
  const sessionId = safeText(x.sessionId, SESSION_ID_MAX)
  if (!sessionId) return null
  return { kind, sessionId }
}
function whitelistDeliveryConfig(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const botId = safeBot(x.botId)
  const chatId = safeChat(x.chatId)
  if (!botId || !chatId) return null
  return {
    botId, chatId,
    chatType: x.chatType === 'group' ? 'group' : 'p2p',
    ...(SCHEDULE_NOTIFY.includes(x.notify) ? { notify: x.notify } : {}),
    ...(safeSender(x.senderId) ? { senderId: x.senderId } : {}),
  }
}
function whitelistSpec(x) {
  const result = validateSpecShape(x)
  if (!result.ok) return null
  return result.spec
}
function whitelistTask(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const id = safeTaskId(x.id)
  if (!id) return null
  const timingKind = safeLabel(x.timingKind) ?? 'unknown'
  const zone = safeText(x.timeZone, ZONE_MAX)
  const spec = whitelistSpec(x.spec)
  const task = {
    id,
    title: safeText(x.title, TITLE_MAX) ?? '',
    prompt: safeText(x.prompt, PROMPT_MAX) ?? '',
    ...(spec ? { spec } : {}),
    timingKind,
    ...(zone && validTimeZone(zone) ? { timeZone: zone } : { timeZone: 'UTC' }),
    ...(isoOr(x.scheduledAt) ? { scheduledAt: x.scheduledAt } : {}),
    status: STATUSES.has(x.status) ? x.status : 'unknown',
    ...(isoOr(x.createdAt) ? { createdAt: x.createdAt } : {}),
    ...(isoOr(x.updatedAt) ? { updatedAt: x.updatedAt } : {}),
    executionActive: x.executionActive === true,
  }
  const last = whitelistDeliveryRecord(x.lastDelivery)
  if (last) task.lastDelivery = last
  const target = whitelistTarget(x.target)
  if (target) task.target = target
  const delivery = whitelistDeliveryConfig(x.delivery)
  if (delivery) task.delivery = delivery
  return task
}
function whitelistRun(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const ts = safeNum(x.ts)
  if (ts === undefined) return null
  return {
    ts,
    ...(safeTaskId(x.taskId) ? { taskId: x.taskId } : {}),
    ...(safeText(x.messageId, MESSAGE_MAX) ? { messageId: x.messageId } : {}),
    ...(safeRef(x.sessionRef) || safeText(x.sessionRef, SESSION_ID_MAX)
      ? { sessionRef: x.sessionRef } : {}),
    status: RUN_STATES.has(x.status) ? x.status : 'unknown',
    ...(safeNum(x.elapsedMs) !== undefined ? { elapsedMs: safeNum(x.elapsedMs) } : {}),
    ...(safeNum(x.tokens) !== undefined ? { tokens: safeNum(x.tokens) } : {}),
    ...(safeModel(x.model) ? { model: x.model } : {}),
    delivered: x.delivered === true,
    ...(safeText(x.error, ERROR_MAX) ? { error: x.error } : {}),
  }
}
function whitelistAudit(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const ts = safeNum(x.ts)
  if (ts === undefined) return null
  return {
    ts,
    ...(safeText(x.actor, ACTOR_MAX) ? { actor: x.actor } : {}),
    ...(SCHEDULE_ACTIONS.includes(x.action) ? { action: x.action } : {}),
    ...(safeTaskId(x.taskId) ? { taskId: x.taskId } : {}),
    ...(OUTCOME_STATES.has(x.state) ? { state: x.state } : {}),
    ...(safeText(x.summary, SUMMARY_MAX) ? { summary: x.summary } : {}),
  }
}

/**
 * Sanitized read model from stateDir/ops-schedule.json. Returns null when the
 * file is absent or its version/ts are invalid (never throws for content).
 * Symlinks / oversized files fail closed via a thrown Error, exactly like
 * ops-read.mjs; the HTTP layer turns that into a generic 500 with no leaks.
 */
export async function readScheduleModel(dir, now = Date.now()) {
  const raw = await readSafeFile(dir, MODEL_FILE, MODEL_MAX)
  if (raw === null) return null
  let doc
  try { doc = JSON.parse(raw) } catch { return null }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== 1) return null
  const ts = safeNum(doc.ts)
  if (ts === undefined) return null
  const available = doc.available === true
  const reason = available ? null : (safeText(doc.reason, SUMMARY_MAX) ?? null)
  const limits = {
    newSessionIntervalSeconds: safeNum(doc.limits?.newSessionIntervalSeconds) ?? 60,
  }
  const tasks = (Array.isArray(doc.tasks) ? doc.tasks : []).slice(0, TASKS_MAX)
    .map(whitelistTask).filter(Boolean)
  const deliveries = {}
  if (doc.deliveries && typeof doc.deliveries === 'object' && !Array.isArray(doc.deliveries)) {
    let keys = 0
    for (const [id, list] of Object.entries(doc.deliveries)) {
      if (keys >= DELIVERIES_MAX || !safeTaskId(id)) continue
      keys += 1
      deliveries[id] = (Array.isArray(list) ? list : []).slice(0, DELIVERIES_PER_TASK)
        .map(whitelistDeliveryRecord).filter(Boolean)
    }
  }
  const runs = (Array.isArray(doc.runs) ? doc.runs : []).slice(0, RUNS_MAX)
    .map(whitelistRun).filter(Boolean)
  const audit = (Array.isArray(doc.audit) ? doc.audit : []).slice(0, AUDIT_MAX)
    .map(whitelistAudit).filter(Boolean)
  return {
    ts,
    stale: Math.abs(now - ts) > STALE_MS,
    available,
    reason,
    limits,
    tasks,
    deliveries,
    runs,
    audit,
  }
}

async function resultFiles(dir) {
  const control = path.join(dir, 'ops-control')
  const resultsDir = path.join(control, 'results')
  for (const part of [dir, control, resultsDir]) {
    const stat = await fs.lstat(part).catch(e => { if (e.code === 'ENOENT') return null; throw e })
    if (!stat) return []
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('unsafe command results directory')
  }
  const names = (await fs.readdir(resultsDir)).filter(name =>
    /^[a-f0-9-]{36}\.json$/.test(name)).sort().slice(-RESULTS_MAX)
  const rows = []
  for (const name of names) {
    const file = path.join(resultsDir, name)
    const st = await fs.lstat(file)
    if (!st.isFile() || st.isSymbolicLink() || st.size > RESULTS_FILE_MAX) continue
    let data
    try { data = JSON.parse(await fs.readFile(file, 'utf8')) } catch { continue }
    if (data?.version !== 1 || data.id !== name.slice(0, -5) || data.type !== 'schedule' ||
      !OUTCOME_STATES.has(data.state)) continue
    rows.push({
      id: data.id, type: data.type, state: data.state, ts: safeNum(data.ts),
      ...(safeRef(data.ref) ? { ref: data.ref } : {}),
      ...(safeTaskId(data.taskId) ? { taskId: data.taskId } : {}),
      ...(safeText(data.detail, SUMMARY_MAX) ? { detail: data.detail } : {}),
    })
  }
  return rows.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
}

/** Recent `type:'schedule'` command outcomes only, with bounded detail. */
export async function readScheduleResults(dir) {
  return await resultFiles(dir)
}
