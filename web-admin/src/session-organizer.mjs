/**
 * Web-host-only Feishu native Session organization.
 *
 * Uses SessionPersistence.list() (headers ONLY) and WorkspaceRegistry.
 * NEVER imports agents, calls resume, opens persistence for write or deletes logs.
 * The Gateway owns session titles and the chat->Session binding.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readOpsSnapshot } from './ops-read.mjs'
import { readScheduleModel } from './schedule-read.mjs'

const MAX_BYTES = 8 * 1024 * 1024
const CONFIG_FILE = 'session-organization-settings.json'
const CURSOR_FILE = 'ops-session-organization.json'
const SAFE_ID = /^feishu-[A-Za-z0-9_-]{1,235}$/
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const isObj = value => value && typeof value === 'object' && !Array.isArray(value)
const ms = value => {
  const n = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(n) && n >= 0 && n <= 1e13 ? Math.floor(n) : 0
}
const emptyConfig = Object.freeze({ enabled: false, revealNames: false, graceHours: 24 })
const emptyCursor = () => ({ version: 1, bindings: {}, schedule: {}, missing: {}, handled: [], pending: {}, retired: {} })

async function privateJson(dir, name) {
  const base = await fs.lstat(dir).catch(e => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (!base) return null
  if (!base.isDirectory() || base.isSymbolicLink()) throw Error('unsafe Feishu state directory')
  let fd
  try { fd = await fs.open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.size > MAX_BYTES) throw Error('unsafe or oversized Feishu state')
    return JSON.parse(await fd.readFile('utf8'))
  } finally { await fd.close() }
}
async function privateWrite(dir, name, value) {
  // Only Web host writes this bookkeeping. Never touch sessions.json.
  const stat = await fs.lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('unsafe Feishu state directory')
  const filename = path.join(dir, name)
  const old = await fs.lstat(filename).catch(e => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (old && (!old.isFile() || old.isSymbolicLink())) throw Error('unsafe organization record')
  const temp = path.join(dir, '.' + name + '.' + randomUUID() + '.tmp')
  const fd = await fs.open(temp, 'wx', 0o600)
  try {
    await fd.writeFile(JSON.stringify(value, null, 2) + '\n')
    await fd.sync()
  } finally { await fd.close() }
  try { await fs.rename(temp, filename) }
  catch (error) { await fs.rm(temp, { force: true }); throw error }
}
export async function organizationSettings(stateDir) {
  const doc = await privateJson(stateDir, CONFIG_FILE)
  if (!isObj(doc) || doc.version !== 1) return { ...emptyConfig }
  return { enabled: doc.enabled === true, revealNames: doc.revealNames === true,
    graceHours: Number.isInteger(doc.graceHours) && doc.graceHours >= 1 && doc.graceHours <= 168
      ? doc.graceHours : 24 }
}
export async function saveOrganizationSettings(stateDir, next) {
  if (!isObj(next) || Object.keys(next).some(key => !['enabled', 'revealNames', 'graceHours'].includes(key)) ||
    (next.enabled !== undefined && typeof next.enabled !== 'boolean') ||
    (next.revealNames !== undefined && typeof next.revealNames !== 'boolean') ||
    (next.graceHours !== undefined && (!Number.isInteger(next.graceHours) ||
      next.graceHours < 1 || next.graceHours > 168))) {
    throw Object.assign(new Error('invalid session organization settings'), { status: 400 })
  }
  const current = await organizationSettings(stateDir)
  const settings = { ...current, ...next }
  await privateWrite(stateDir, CONFIG_FILE, { version: 1, ...settings })
  return settings
}
async function sourceData(stateDir, persistence, registry) {
  const runtime = await readOpsSnapshot(stateDir)
  if (!runtime || runtime.isolatedAgent !== true ||
    typeof runtime.workspace !== 'string' || !path.isAbsolute(runtime.workspace)) {
    return { available: false, reason: 'Gateway runtime workspace unavailable' }
  }
  if (!persistence || typeof persistence.list !== 'function' ||
    !registry || typeof registry.list !== 'function' ||
    typeof registry.archiveSession !== 'function' || typeof registry.create !== 'function') {
    return { available: false, reason: 'Web native Session/Workspace services unavailable' }
  }
  const root = await fs.realpath(runtime.workspace)
  const [snapshots, bindingsDoc, scheduled, managedConfig] = await Promise.all([
    persistence.list(), privateJson(stateDir, 'sessions.json'),
    readScheduleModel(stateDir), privateJson(stateDir, 'admin-config.json'),
  ])
  if (!Array.isArray(snapshots) || snapshots.length > 100000) throw Error('invalid native Session header listing')
  if (bindingsDoc && (!isObj(bindingsDoc.bindings) ||
    Object.keys(bindingsDoc.bindings).length > 100000)) throw Error('invalid Feishu binding index')
  const bindings = new Map()
  const current = {}
  for (const [chatKey, binding] of Object.entries(bindingsDoc?.bindings || {})) {
    if (!isObj(binding) || typeof binding.sessionId !== 'string' || !SAFE_ID.test(binding.sessionId)) continue
    const index = chatKey.indexOf(':')
    if (index < 1) continue
    const botId = chatKey.slice(0, index)
    const chatId = chatKey.slice(index + 1).split(':group:')[0]
    current[hash(chatKey)] = binding.sessionId
    bindings.set(binding.sessionId, { botId, chatId, chatRef: hash(chatId),
      lastActiveAt: ms(binding.lastActiveAt), createdAt: ms(binding.createdAt),
      bindingArchived: binding.archived === true })
  }
  const tasks = new Map()
  const activeTasks = {}
  for (const task of scheduled?.tasks || []) {
    const id = task.target?.sessionId
    if (!SAFE_ID.test(id || '') || !id.startsWith('feishu-schedule-')) continue
    if (['ended', 'inactive', 'completed', 'expired'].includes(task.status)) continue
    tasks.set(id, task.title || '定时任务')
    activeTasks[id] = 1
  }
  const nameMap = new Map()
  for (const group of managedConfig?.config?.groups || []) {
    if (typeof group.chatId === 'string' && typeof group.name === 'string') {
      nameMap.set(group.chatId, group.name.slice(0, 100))
    }
  }
  const archived = new Set(registry.archivedSessionIds || [])
  // A stale snapshot is sufficient for offline history inventory but never
  // proof that a Session is currently executing.
  const active = new Set((runtime.stale ? [] : runtime.tasks || [])
    .map(task => task.session).filter(Boolean))
  const records = []
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    const id = header?.id
    if (typeof id !== 'string' || !SAFE_ID.test(id)) continue
    const cwd = header?.cwd
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue
    // Never traverse session directories: the native index is authoritative.
    const canonical = await fs.realpath(cwd).catch(() => path.resolve(cwd))
    const legacy = canonical !== root
    const binding = bindings.get(id)
    const scheduleTitle = tasks.get(id)
    const isScheduled = id.startsWith('feishu-schedule-')
    const status = archived.has(id) ? 'archived' :
      active.has(hash(id)) ? 'active' : binding || scheduleTitle ? 'idle' : 'unbound'
    const chatName = binding?.chatId ? nameMap.get(binding.chatId) : undefined
    records.push({
      id, idRef: hash(id), root: canonical, legacy,
      botId: binding?.botId || (isScheduled ? 'schedule' : ''),
      chatId: binding?.chatId || null, chatRef: binding?.chatRef || null,
      chatName: chatName || null, type: isScheduled ? 'schedule' :
        (binding?.chatId?.startsWith('oc_') ? 'group' : 'p2p'),
      scheduleTitle: scheduleTitle || null, bound: Boolean(binding),
      bindingArchived: binding?.bindingArchived === true,
      status, archived: archived.has(id), orphan: !binding && !scheduleTitle,
      createdAt: binding?.createdAt || ms(header?.createdAt),
      lastActiveAt: binding?.lastActiveAt || ms(header?.createdAt),
    })
  }
  return { available: true, root, runtime, records, current, activeTasks, archived, tasks,
    workspace: await registry.resolveByPath?.(root) }
}
export async function sessionOrganizationInventory(stateDir, services, query = {}) {
  const data = await sourceData(stateDir, services.persistence, services.registry)
  const settings = await organizationSettings(stateDir)
  if (!data.available) return { available: false, reason: data.reason, settings,
    total: 0, page: 1, pageSize: 25, items: [] }
  const reveal = query.reveal === true
  const search = String(query.search || '').slice(0, 128).toLowerCase()
  const from = query.from ? Date.parse(query.from + 'T00:00:00.000Z') : 0
  const to = query.to ? Date.parse(query.to + 'T23:59:59.999Z') : Infinity
  const status = ['all', 'active', 'idle', 'unbound', 'archived'].includes(query.status)
    ? query.status : 'all'
  const type = ['all', 'schedule', 'group', 'p2p'].includes(query.type) ? query.type : 'all'
  const page = Number.isInteger(query.page) && query.page > 0 && query.page < 100000 ? query.page : 1
  const pageSize = Number.isInteger(query.pageSize) && query.pageSize > 0 &&
    query.pageSize <= 100 ? query.pageSize : 25
  const filtered = data.records.filter(row =>
    (status === 'all' || row.status === status) &&
    (type === 'all' || row.type === type) &&
    (!query.orphanOnly || row.orphan) &&
    (!query.bot || row.botId === query.bot) &&
    row.lastActiveAt >= from && row.lastActiveAt <= to &&
    (!search || [row.idRef, row.botId, row.chatRef, row.scheduleTitle,
      settings.revealNames && reveal ? row.chatName : null,
      reveal ? row.id : null].some(v => String(v || '').toLowerCase().includes(search))))
    .sort((a,b) => b.lastActiveAt - a.lastActiveAt || a.id.localeCompare(b.id))
  const items = []
  for (const row of filtered.slice((page-1)*pageSize, page*pageSize)) {
    let sessionTitle = null
    try {
      if (typeof services.query?.readTitle === 'function') {
        const title = await services.query.readTitle(row.id)
        if (typeof title === 'string') sessionTitle = title.slice(0, 150)
        else if (typeof title?.title === 'string') sessionTitle = title.title.slice(0, 150)
      }
    } catch { /* title lookup does not hold the Agent writer lock */ }
    items.push({
      sessionRef: row.idRef,
      ...(reveal ? { sessionId: row.id } : {}),
      botId: row.botId, chatRef: row.chatRef,
      chatName: settings.revealNames && reveal ? row.chatName : null,
      type: row.type, scheduleTitle: row.scheduleTitle,
      sessionTitle, status: row.status, orphan: row.orphan,
      legacy: row.legacy, bindingArchived: row.bindingArchived,
      createdAt: row.createdAt, lastActiveAt: row.lastActiveAt,
    })
  }
  return { available: true, workspaceTitle: data.workspace?.title || null,
    workspaceId: data.workspace?.id || null, settings, total: filtered.length,
    page, pageSize, items, nativeCount: data.records.length,
    orphanCount: data.records.filter(row => row.orphan).length,
    note: 'Native DSH header inventory only. Archive hides Session history; no native data is deleted.' }
}
export async function reconcileSessionOrganization(stateDir, services, { dryRun = true, now = Date.now() } = {}) {
  const data = await sourceData(stateDir, services.persistence, services.registry)
  if (!data.available) return { available: false, reason: data.reason, dryRun }
  const settings = await organizationSettings(stateDir)
  // When the Gateway is offline, its bindings/schedule snapshot may no longer
  // be current. Keep the ledger readable, but prohibit automatic mutations.
  if (!dryRun && data.runtime.stale) return {
    available: false, reason: 'Gateway snapshot stale; native inventory remains read-only', dryRun,
  }
  const old = await privateJson(stateDir, CURSOR_FILE)
  const cursor = isObj(old) && old.version === 1 ? old : emptyCursor()
  const previousBindings = isObj(cursor.bindings) ? cursor.bindings : {}
  const previousSchedule = isObj(cursor.schedule) ? cursor.schedule : {}
  const pending = isObj(cursor.pending) ? { ...cursor.pending } : {}
  const retired = isObj(cursor.retired) ? { ...cursor.retired } : {}
  const missing = isObj(cursor.missing) ? { ...cursor.missing } : {}
  const handled = new Set(Array.isArray(cursor.handled) ? cursor.handled.filter(x => SAFE_ID.test(x)) : [])
  const currentIds = new Set(data.records.map(r => r.id))
  const boundIds = new Set(Object.values(data.current))
  const archiveCandidates = []
  for (const [chatRef, oldSession] of Object.entries(previousBindings)) {
    if (!SAFE_ID.test(oldSession) || !currentIds.has(oldSession) || handled.has(oldSession)) continue
    if (!data.current[chatRef]) {
      // /new temporarily removes the association before the first new prompt;
      // remember that key until it gets a replacement, not just for one tick.
      retired[chatRef] = oldSession
    } else if (data.current[chatRef] !== oldSession && !boundIds.has(oldSession)) {
      pending[oldSession] = 'binding-replaced'
    }
  }
  for (const [chatRef, oldSession] of Object.entries(retired)) {
    const replacement = data.current[chatRef]
    if (replacement) {
      if (replacement !== oldSession && currentIds.has(oldSession) && !boundIds.has(oldSession) &&
        !handled.has(oldSession)) pending[oldSession] = 'binding-replaced-after-new'
      delete retired[chatRef]
    } else if (!SAFE_ID.test(oldSession) || !currentIds.has(oldSession) || handled.has(oldSession)) {
      delete retired[chatRef]
    }
  }
  for (const [id, reason] of Object.entries(pending)) {
    if (!SAFE_ID.test(id) || !currentIds.has(id) || handled.has(id) || boundIds.has(id)) {
      delete pending[id]
      continue
    }
    archiveCandidates.push({ id, reason })
  }
  for (const id of new Set([...Object.keys(previousSchedule), ...Object.keys(missing)])) {
    if (data.activeTasks[id] || !currentIds.has(id) || handled.has(id)) {
      delete missing[id]
      continue
    }
    if (!Number.isFinite(missing[id])) missing[id] = now
    if (now - missing[id] >= settings.graceHours * 3600000)
      archiveCandidates.push({ id, reason: 'schedule-orphan-grace-elapsed' })
  }
  const newState = { version: 1, bindings: data.current,
    schedule: data.activeTasks, missing, pending, retired, handled: [...handled].slice(-10000) }
  // Do not auto-archive any historical sessions on the very first deployment.
  // An explicit migration preview/confirmation is required for those.
  // First-time migration requires human review. Automatic reconciliation
  // adopts only sessions still referenced by a chat binding or active task;
  // otherwise orphaned history would flood the new Web sidebar.
  const attach = data.records.filter(row => !row.legacy &&
    (boundIds.has(row.id) || data.activeTasks[row.id]) &&
    !data.workspace?.sessionIds?.includes(row.id) && !row.archived).map(row => row.id)
  const result = { available: true, enabled: settings.enabled, dryRun,
    workspace: data.workspace?.title || '飞书会话',
    attach, archive: archiveCandidates.filter(c => !data.archived.has(c.id)),
    legacy: data.records.filter(row => row.legacy).map(row => row.id),
    nativeCount: data.records.length, attached: 0, archived: 0, skipped: [] }
  if (dryRun || !settings.enabled) return result
  const workspace = data.workspace || await services.registry.create(data.root, '飞书会话')
  for (const id of attach) {
    try { await workspace.attachSession(id); result.attached += 1 }
    catch { result.skipped.push({ id, reason: 'attach-rejected' }) }
  }
  for (const candidate of result.archive) {
    try {
      // Default activity check (no stopActivity=true), no Agent resume.
      await services.registry.archiveSession(candidate.id)
      handled.add(candidate.id)
      delete pending[candidate.id]
      delete missing[candidate.id]
      result.archived += 1
      await auditOrganization(stateDir, candidate.id, 'native-session-auto-archived')
    } catch { result.skipped.push({ id: candidate.id, reason: 'active-or-unavailable' }) }
  }
  newState.handled = [...handled].slice(-10000)
  await privateWrite(stateDir, CURSOR_FILE, newState)
  return result
}
async function auditOrganization(stateDir, sessionId, state) {
  const filename = path.join(stateDir, 'ops-events.jsonl')
  const st = await fs.lstat(filename).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e))
  if (st && (!st.isFile() || st.isSymbolicLink())) throw Error('unsafe ops audit log')
  await fs.appendFile(filename, JSON.stringify({ version: 1, ts: Date.now(),
    kind: 'system', state, session: hash(sessionId) }) + '\n', { mode: 0o600 })
}
export async function archiveNativeSession(stateDir, services, sessionId) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId))
    throw Object.assign(new Error('invalid native Session'), { status: 400 })
  const data = await sourceData(stateDir, services.persistence, services.registry)
  if (!data.available) throw Object.assign(new Error(data.reason), { status: 503 })
  const row = data.records.find(value => value.id === sessionId)
  if (!row) throw Object.assign(new Error('native Session not found'), { status: 404 })
  if (row.status === 'active' || row.bound ||
    data.activeTasks[sessionId]) throw Object.assign(new Error('active/bound native Session cannot be archived here'), { status: 409 })
  // Even stale Web state cannot override native activity admission.
  await services.registry.archiveSession(sessionId)
  await auditOrganization(stateDir, sessionId, 'native-session-manual-archived')
  const prev = await privateJson(stateDir, CURSOR_FILE)
  const cursor = isObj(prev) && prev.version === 1 ? prev : emptyCursor()
  const handled = new Set(Array.isArray(cursor.handled) ? cursor.handled : [])
  handled.add(sessionId)
  await privateWrite(stateDir, CURSOR_FILE, { ...cursor, handled: [...handled].slice(-10000) })
  return { sessionRef: hash(sessionId), archived: true, nativeHistoryPreserved: true }
}
