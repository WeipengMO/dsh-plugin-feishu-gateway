/**
 * Read-only, explicitly whitelisted operations DTOs for authenticated DSH Web.
 * Never read or return inbox.jsonl, outbox.json or arbitrary system logs;
 * those records contain message text, Feishu IDs or tool parameters.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const KIND = new Set(['message', 'task', 'approval', 'transport', 'delivery', 'system'])
const safeNum = n => Number.isFinite(n) && n >= 0 && n <= 1e13 ? Math.floor(n) : undefined
const safeRef = s => typeof s === 'string' && /^[a-f0-9]{16}$/.test(s) ? s : undefined
const safeLabel = s => typeof s === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(s) ? s : undefined
const safeBot = s => typeof s === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(s) ? s : undefined
const safeModel = s => typeof s === 'string' && /^[a-zA-Z0-9_.:/-]{1,96}$/.test(s) ? s : undefined

async function readSafeFile(dir, file, maxBytes) {
  const root = await fs.lstat(dir).catch(e => { if (e.code === 'ENOENT') return null; throw e })
  if (!root) return null
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error('unsafe management state directory')
  const name = path.join(dir, file)
  const st = await fs.lstat(name).catch(e => { if (e.code === 'ENOENT') return null; throw e })
  if (!st) return null
  if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes)
    throw Error('unsafe or oversized operations snapshot')
  return await fs.readFile(name, 'utf8')
}
function toEvent(x) {
  if (!x || x.version !== 1 || !KIND.has(x.kind) ||
    safeNum(x.ts) === undefined || !safeLabel(x.state)) return null
  return {
    ts: safeNum(x.ts), kind: x.kind, state: x.state,
    ...(safeRef(x.ref) ? { ref: x.ref } : {}),
    ...(safeRef(x.session) ? { session: x.session } : {}),
    ...(safeBot(x.botId) ? { botId: x.botId } : {}),
    ...(safeModel(x.model) ? { model: x.model } : {}),
    ...(safeNum(x.tokens) !== undefined ? { tokens: safeNum(x.tokens) } : {}),
    ...(safeNum(x.elapsedMs) !== undefined ? { elapsedMs: safeNum(x.elapsedMs) } : {}),
  }
}
export async function readOpsEvents(dir, { kind, limit = 100 } = {}) {
  if (kind !== undefined && !KIND.has(kind)) throw Object.assign(Error('invalid event kind'), { status: 400 })
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw Object.assign(Error('invalid limit'), { status: 400 })
  const raw = await readSafeFile(dir, 'ops-events.jsonl', 3 * 1024 * 1024)
  if (raw === null) return []
  const lines = raw.split('\n').filter(Boolean)
  // Ignore a torn last JSONL line; never include arbitrary fields.
  const events = []
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
    let row
    try { row = JSON.parse(lines[i]) } catch { continue }
    const event = toEvent(row)
    if (event && (!kind || event.kind === kind)) events.push(event)
  }
  return events
}
export async function readOpsSnapshot(dir, now = Date.now()) {
  const raw = await readSafeFile(dir, 'ops-runtime.json', 1024 * 1024)
  if (raw === null) return null
  let doc
  try { doc = JSON.parse(raw) } catch { throw Error('operations snapshot is invalid') }
  if (!doc || doc.version !== 1 || safeNum(doc.ts) === undefined) return null
  const transports = {}
  for (const [id, value] of Object.entries(doc.transport ?? {})) {
    if (!safeBot(id) || !value || typeof value !== 'object') continue
    transports[id] = {
      state: safeLabel(value.state) ?? 'unknown',
      reconnects: safeNum(value.reconnects) ?? 0,
      failures: safeNum(value.failures) ?? 0,
      lastConnectedAt: safeNum(value.lastConnectedAt),
      lastDisconnectedAt: safeNum(value.lastDisconnectedAt),
    }
  }
  const tasks = (Array.isArray(doc.tasks) ? doc.tasks : []).slice(0, 100).flatMap(x =>
    x && safeRef(x.ref) && safeBot(x.botId) ?
      [{ ref: x.ref, ...(safeRef(x.session) ? { session: x.session } : {}),
        botId: x.botId,
        phase: x.phase === 'finalizing' ? 'finalizing' : 'running',
        elapsedMs: safeNum(x.elapsedMs) ?? 0 }] : [])
  const sessions = (Array.isArray(doc.sessions) ? doc.sessions : []).slice(0, 500).flatMap(x =>
    x && safeRef(x.ref) ?
      [{ ref: x.ref, createdAt: safeNum(x.createdAt), lastActiveAt: safeNum(x.lastActiveAt),
        persisted: x.persisted === true }] : [])
  const get = key => safeNum(doc.stats?.[key]) ?? 0
  return {
    ts: doc.ts, stale: Math.abs(now - doc.ts) > 15000,
    status: safeLabel(doc.status) ?? 'unknown',
    tasks, sessions, transport: transports,
    stats: {
      activeTurns: get('activeTurns'), boundSessions: get('boundSessions'),
      pendingApprovals: get('pendingApprovals'), processed: get('processed'),
      errors: get('errors'), outboxPending: get('outboxPending'), inboxPending: get('inboxPending'),
    },
  }
}
export function summarizeOps(events, snapshot) {
  const messages = new Map()
  const approvals = []
  const usage = new Map()
  const byBot = new Map()
  const days = new Map()
  for (const event of [...events].reverse()) {
    if (event.kind === 'message' || event.kind === 'task') {
      if (!event.ref) continue
      const previous = messages.get(event.ref) ?? { ref: event.ref, firstAt: event.ts }
      messages.set(event.ref, {
        ...previous, lastAt: event.ts, state: event.state,
        ...(event.botId ? { botId: event.botId } : {}),
        ...(event.session ? { session: event.session } : {}),
        ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
      })
    }
    if (event.kind === 'approval') approvals.push(event)
    if (event.kind === 'task' && event.state === 'done' && Number.isSafeInteger(event.tokens)) {
      const model = event.model || 'unknown'
      const before = usage.get(model) ?? { model, tokens: 0, turns: 0 }
      usage.set(model, { model, tokens: before.tokens + event.tokens, turns: before.turns + 1 })
      const botId = event.botId || 'unknown'
      const prior = byBot.get(botId) ?? { botId, tokens: 0, turns: 0 }
      byBot.set(botId, { botId, tokens: prior.tokens + event.tokens, turns: prior.turns + 1 })
      const day = new Date(event.ts).toISOString().slice(0, 10)
      const prev = days.get(day) ?? { day, tokens: 0, turns: 0 }
      days.set(day, { day, tokens: prev.tokens + event.tokens, turns: prev.turns + 1 })
    }
  }
  const alerts = []
  if (snapshot?.stale) alerts.push({ type: 'warning', code: 'stale-snapshot', message: '监控数据已过期，请检查 Gateway 服务' })
  if (snapshot && snapshot.status !== 'ok') alerts.push({ type: 'warning', code: 'degraded', message: 'Gateway 健康状态异常' })
  if (snapshot?.stats?.outboxPending > 0) alerts.push({ type: 'warning', code: 'outbox', message: '存在待投递消息，检查网络和 Outbox' })
  for (const [botId, value] of Object.entries(snapshot?.transport ?? {})) {
    if (value.state !== 'connected')
      alerts.push({ type: 'warning', code: 'transport', botId, message: '机器人连接未就绪' })
  }
  return {
    messages: [...messages.values()].reverse().slice(0, 100),
    approvals: approvals.reverse().slice(0, 100),
    usage: [...usage.values()].sort((a,b) => b.tokens - a.tokens),
    byBot: [...byBot.values()].sort((a,b) => b.tokens - a.tokens),
    daily: [...days.values()].sort((a,b) => a.day.localeCompare(b.day)),
    alerts: alerts.slice(0, 50),
  }
}

export async function readOpsResults(dir) {
  const control = path.join(dir, 'ops-control')
  const resultsDir = path.join(control, 'results')
  for (const part of [dir, control, resultsDir]) {
    const stat = await fs.lstat(part).catch(e => { if (e.code === 'ENOENT') return null; throw e })
    if (!stat) return []
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('unsafe command results directory')
  }
  const names = (await fs.readdir(resultsDir)).filter(name =>
    /^[a-f0-9-]{36}\.json$/.test(name)).sort().slice(-100)
  const results = []
  for (const name of names) {
    const st = await fs.lstat(path.join(resultsDir, name))
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024) continue
    let data
    try { data = JSON.parse(await fs.readFile(path.join(resultsDir, name), 'utf8')) }
    catch { continue }
    if (data?.version !== 1 || data.id !== name.slice(0, -5) ||
      (data.type !== 'cancel-task' && data.type !== 'retry-outbox') ||
      !['completed', 'not-found', 'rejected', 'error'].includes(data.state)) continue
    results.push({
      id: data.id, type: data.type, state: data.state, ts: safeNum(data.ts),
      ...(safeRef(data.ref) ? { ref: data.ref } : {}),
    })
  }
  return results.sort((a,b) => (b.ts ?? 0) - (a.ts ?? 0))
}
