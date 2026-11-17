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
const RETENTION_FILE = 'session-retention-settings.json'
const TRASH_FILE = 'session-trash.json'
const MAX_TRASH = 10000
const SAFE_ID = /^feishu-[A-Za-z0-9_-]{1,235}$/
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const isObj = value => value && typeof value === 'object' && !Array.isArray(value)
const ms = value => {
  const n = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(n) && n >= 0 && n <= 1e13 ? Math.floor(n) : 0
}
const emptyConfig = Object.freeze({ enabled: false, revealNames: false, graceHours: 24 })
const emptyCursor = () => ({ version: 1, bindings: {}, schedule: {}, missing: {}, handled: [], pending: {}, retired: {}, activity: {} })
const defaultRetention = Object.freeze({ autoArchiveEnabled: false, archiveAfterDays: 90, trashKeepDays: 30, autoDeleteEnabled: false })
const retentionDayChoices = [30, 60, 90, 180, 365]
const trashDayChoices = [7, 30, 90]
// Serialize all stateful workspace operations inside the Web process. A manual
// archive must never race the timer's cursor write or another manual run.
const operationQueue = new Map()
function serialized(stateDir, action) {
  const previous = operationQueue.get(stateDir) || Promise.resolve()
  const running = previous.catch(() => {}).then(action)
  operationQueue.set(stateDir, running)
  void running.finally(() => {
    if (operationQueue.get(stateDir) === running) operationQueue.delete(stateDir)
  }).catch(() => {})
  return running
}

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
    const running = active.has(hash(id))
    const status = archived.has(id) ? 'archived' :
      runtime.stale && (binding || scheduleTitle) ? 'unknown' :
      running ? 'active' : binding || scheduleTitle ? 'idle' : 'unbound'
    const chatName = binding?.chatId ? nameMap.get(binding.chatId) : undefined
    records.push({
      id, idRef: hash(id), root: canonical, legacy,
      botId: binding?.botId || (isScheduled ? 'schedule' : ''),
      chatId: binding?.chatId || null, chatRef: binding?.chatRef || null,
      chatName: chatName || null, type: isScheduled ? 'schedule' :
        (binding?.chatId?.startsWith('oc_') ? 'group' : 'p2p'),
      scheduleTitle: scheduleTitle || null, bound: Boolean(binding),
      bindingArchived: binding?.bindingArchived === true,
      status, running, archived: archived.has(id), orphan: !binding && !scheduleTitle,
      createdAt: binding?.createdAt || ms(header?.createdAt),
      lastActiveAt: binding?.lastActiveAt || ms(header?.createdAt),
      lastActiveKnown: Boolean(binding?.lastActiveAt),
    })
  }
  return { available: true, root, runtime, records, current, activeTasks, archived, tasks,
    workspace: await registry.resolveByPath?.(root) }
}
export async function sessionOrganizationInventory(stateDir, services, query = {}) {
  const data = await sourceData(stateDir, services.persistence, services.registry)
  const settings = await organizationSettings(stateDir)
  const trash = await readTrash(stateDir)
  if (!data.available) return { available: false, reason: data.reason, settings,
    total: 0, page: 1, pageSize: 25, items: [] }
  const reveal = query.reveal === true
  const search = String(query.search || '').slice(0, 128).toLowerCase()
  const from = query.from ? Date.parse(query.from + 'T00:00:00.000Z') : 0
  const to = query.to ? Date.parse(query.to + 'T23:59:59.999Z') : Infinity
  const status = ['all', 'current', 'active', 'idle', 'unknown', 'unbound', 'archived', 'trashed'].includes(query.status)
    ? query.status : 'all'
  const type = ['all', 'schedule', 'group', 'p2p'].includes(query.type) ? query.type : 'all'
  const page = Number.isInteger(query.page) && query.page > 0 && query.page < 100000 ? query.page : 1
  const pageSize = Number.isInteger(query.pageSize) && query.pageSize > 0 &&
    query.pageSize <= 100 ? query.pageSize : 25
  // A user searches visible conversation titles, not opaque Session hashes.
  // Bound cost to protect large persistence stores; no agent/session resume.
  const titleSearchLimited = Boolean(search && data.records.length > 1000)
  const searchedTitles = new Map()
  if (search && !titleSearchLimited && typeof services.query?.readTitle === 'function') {
    for (let offset = 0; offset < data.records.length; offset += 16) {
      await Promise.all(data.records.slice(offset, offset + 16).map(async row => {
        try {
          const value = await services.query.readTitle(row.id)
          const title = typeof value === 'string' ? value : value?.title
          if (typeof title === 'string') searchedTitles.set(row.id, title.slice(0,150))
        } catch { /* title lookup is optional, never resume a Session */ }
      }))
    }
  }
  const filtered = data.records.filter(row =>
    (status === 'all' ||
      (status === 'current' ? !row.archived && !trash.items[row.id] :
      (status === 'trashed' ? Boolean(trash.items[row.id]) :
       status === 'archived' ? row.archived :
       row.status === status && !trash.items[row.id]))) &&
    (type === 'all' || row.type === type) &&
    (!query.orphanOnly || row.orphan) &&
    (!query.bot || row.botId === query.bot) &&
    row.lastActiveAt >= from && row.lastActiveAt <= to &&
    (!search || [row.idRef, row.botId, row.chatRef, row.scheduleTitle, searchedTitles.get(row.id),
      settings.revealNames && reveal ? row.chatName : null,
      reveal ? row.id : null].some(v => String(v || '').toLowerCase().includes(search))))
    .sort((a,b) => b.lastActiveAt - a.lastActiveAt || a.id.localeCompare(b.id))
  const items = []
  for (const row of filtered.slice((page-1)*pageSize, page*pageSize)) {
    let sessionTitle = searchedTitles.get(row.id) || null
    try {
      if (!sessionTitle && typeof services.query?.readTitle === 'function') {
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
      sessionTitle, status: trash.items[row.id] ? 'trashed' : row.status, orphan: row.orphan, running: row.running,
      legacy: row.legacy, bindingArchived: row.bindingArchived,
      createdAt: row.createdAt, lastActiveAt: row.lastActiveAt, lastActiveKnown: row.lastActiveKnown,
      ...(trash.items[row.id] ? { trashedAt: trash.items[row.id].trashedAt, previousArchived: trash.items[row.id].previousArchived } : {}),
    })
  }
  return { available: true, workspaceTitle: data.workspace?.title || null,
    workspaceId: data.workspace?.id || null, settings, total: filtered.length,
    page, pageSize, items, titleSearchLimited, canRestore: typeof services.registry?.unarchiveSession === 'function', nativeCount: data.records.length,
    orphanCount: data.records.filter(row => row.orphan).length,
    archivedCount: data.records.filter(row => row.archived && !trash.items[row.id]).length,
    trashCount: data.records.filter(row => Boolean(trash.items[row.id])).length,
    canArchive: !data.runtime.stale && typeof services.registry?.archiveSession === 'function',
    canTrash: !data.runtime.stale && typeof services.registry?.archiveSession === 'function' &&
      typeof services.registry?.unarchiveSession === 'function',
    canDelete: !data.runtime.stale && typeof services.deleter?.inspect === 'function' &&
      typeof services.deleter?.delete === 'function',
    deleteUnavailableReason: data.runtime.stale ? '飞书通道状态未确认，暂时不能删除。' :
      typeof services.deleter?.delete === 'function' ? null :
      '未检测到 @michengai/dsh-archive-manager 的删除功能。可选安装至 DSH Web 的 web Profile；未安装不影响其他功能。',
    note: 'Native DSH header inventory only. Archive hides Session history; no native data is deleted.' }
}
export function reconcileSessionOrganization(stateDir, services, options = {}) {
  if (options.dryRun !== false) return reconcileOrganizationInternal(stateDir, services, options)
  return serialized(stateDir, () => reconcileOrganizationInternal(stateDir, services, options))
}
async function reconcileOrganizationInternal(stateDir, services, { dryRun = true, now = Date.now() } = {}) {
  const data = await sourceData(stateDir, services.persistence, services.registry)
  if (!data.available) return { available: false, reason: data.reason, dryRun }
  const settings = await organizationSettings(stateDir)
  const trash = await readTrash(stateDir)
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
  const activity = isObj(cursor.activity) ? { ...cursor.activity } : {}
  for (const row of data.records) {
    if (row.lastActiveKnown && row.lastActiveAt > 0) {
      activity[row.id] = Math.max(ms(activity[row.id]), row.lastActiveAt)
    }
  }
  // Retain only observed trustworthy timestamps for currently indexed Sessions.
  for (const id of Object.keys(activity)) {
    if (!SAFE_ID.test(id) || !data.records.some(r => r.id === id)) delete activity[id]
  }
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
    schedule: data.activeTasks, missing, pending, retired, handled: [...handled].slice(-10000), activity }
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
    attach, archive: archiveCandidates.filter(c => !data.archived.has(c.id) && !trash.items[c.id]),
    legacy: data.records.filter(row => row.legacy).map(row => row.id),
    nativeCount: data.records.length, attached: 0, archived: 0, skipped: [] }
  if (dryRun || !settings.enabled) {
    // Save reliable activity observations when reconciling enabled organizer.
    // Never write on a dry-run preview.
    if (!dryRun && !data.runtime.stale) await privateWrite(stateDir, CURSOR_FILE, newState)
    return result
  }
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
export function archiveNativeSession(stateDir, services, sessionId) {
  return serialized(stateDir, () => archiveNativeSessionInternal(stateDir, services, sessionId))
}
async function archiveNativeSessionInternal(stateDir, services, sessionId) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId))
    throw Object.assign(new Error('invalid native Session'), { status: 400 })
  const data = await sourceData(stateDir, services.persistence, services.registry)
  if (!data.available) throw Object.assign(new Error(data.reason), { status: 503 })
  const row = data.records.find(value => value.id === sessionId)
  if (!row) throw Object.assign(new Error('native Session not found'), { status: 404 })
  if (row.status === 'active' || row.running || data.runtime.stale || row.bound ||
    data.activeTasks[sessionId] || (await readTrash(stateDir)).items[sessionId]) throw Object.assign(new Error('active/bound native Session cannot be archived here'), { status: 409 })
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

/**
 * Restore a DSH sidebar archive only when the runtime exposes an official
 * unarchive capability. Never edit WorkspaceRegistry JSON by hand.
 * This is not recovery of a deleted transcript.
 */
export function restoreNativeSession(stateDir, services, sessionRef) {
  return serialized(stateDir, () => restoreNativeSessionInternal(stateDir, services, sessionRef))
}
async function restoreNativeSessionInternal(stateDir, services, sessionRef) {
  if (typeof sessionRef !== 'string' || !/^[0-9a-f]{16}$/.test(sessionRef))
    throw Object.assign(new Error('invalid session reference'), { status: 400 })
  if (typeof services.registry?.unarchiveSession !== 'function')
    throw Object.assign(new Error('DSH version does not support unarchive'), { status: 501 })
  const data = await sourceData(stateDir, services.persistence, services.registry)
  if (!data.available) throw Object.assign(new Error(data.reason), { status: 503 })
  const matches = data.records.filter(row => row.idRef === sessionRef)
  if (matches.length !== 1 || !matches[0].archived || (await readTrash(stateDir)).items[matches[0].id])
    throw Object.assign(new Error('session is no longer archived; refresh'), { status: 409 })
  // Reject ID collisions, stale catalog matches and any session whose owner
  // is currently performing work. The operation only removes an archive flag.
  const row = matches[0]
  if (row.status === 'active' || row.running || data.runtime.stale || data.activeTasks[row.id])
    throw Object.assign(new Error('active Session cannot be restored here'), { status: 409 })
  await services.registry.unarchiveSession(row.id)
  await auditOrganization(stateDir, row.id, 'native-session-manual-restored')
  const prev = await privateJson(stateDir, CURSOR_FILE)
  const cursor = isObj(prev) && prev.version === 1 ? prev : emptyCursor()
  const handled = new Set(Array.isArray(cursor.handled) ? cursor.handled.filter(x => SAFE_ID.test(x)) : [])
  handled.add(row.id) // never re-hide a manually restored Session on reconciliation
  await privateWrite(stateDir, CURSOR_FILE, { ...cursor, handled: [...handled].slice(-10000) })
  return { sessionRef, restored: true, nativeHistoryPreserved: true }
}

/** Session recycle bin: metadata-only, never physical DSH transcript deletion. */
async function readTrash(stateDir) {
  const doc = await privateJson(stateDir, TRASH_FILE)
  if (!doc) return { version: 1, items: {} }
  if (!isObj(doc) || doc.version !== 1 || !isObj(doc.items) ||
      Object.keys(doc.items).length > MAX_TRASH) throw Error('invalid Session trash state')
  const items = {}
  for (const [id, item] of Object.entries(doc.items)) {
    if (!SAFE_ID.test(id) || !isObj(item) || !Number.isSafeInteger(item.trashedAt) ||
      item.trashedAt <= 0 || typeof item.previousArchived !== 'boolean')
      throw Error('invalid Session trash record')
    items[id] = { trashedAt: item.trashedAt, previousArchived: item.previousArchived }
  }
  return { version: 1, items }
}
export async function retentionSettings(stateDir) {
  const doc = await privateJson(stateDir, RETENTION_FILE)
  if (!doc) return { ...defaultRetention }
  if (!isObj(doc) || doc.version !== 1 ||
      typeof doc.autoArchiveEnabled !== 'boolean' ||
      !retentionDayChoices.includes(doc.archiveAfterDays) ||
      !trashDayChoices.includes(doc.trashKeepDays)) throw Error('invalid retention settings')
  return { autoArchiveEnabled: doc.autoArchiveEnabled, archiveAfterDays: doc.archiveAfterDays,
    trashKeepDays: doc.trashKeepDays, autoDeleteEnabled: false }
}
export function saveRetentionSettings(stateDir, patch) {
  return serialized(stateDir, async () => {
    if (!isObj(patch) || Object.keys(patch).some(key =>
      !['autoArchiveEnabled','archiveAfterDays','trashKeepDays'].includes(key)) ||
      (patch.autoArchiveEnabled !== undefined && typeof patch.autoArchiveEnabled !== 'boolean') ||
      (patch.archiveAfterDays !== undefined && !retentionDayChoices.includes(patch.archiveAfterDays)) ||
      (patch.trashKeepDays !== undefined && !trashDayChoices.includes(patch.trashKeepDays)))
      throw Object.assign(new Error('invalid retention settings'), { status: 400 })
    const current = await retentionSettings(stateDir)
    const next = { ...current, ...patch, autoDeleteEnabled: false }
    await privateWrite(stateDir, RETENTION_FILE, { version: 1, ...next })
    return next
  })
}
const validRef = ref => typeof ref === 'string' && /^[a-f0-9]{16}$/.test(ref)
function onlyRow(data, ref) {
  if (!validRef(ref)) throw Object.assign(new Error('invalid Session reference'), { status: 400 })
  const found = data.records.filter(row => row.idRef === ref)
  if (found.length !== 1) throw Object.assign(new Error('Session missing or changed'), { status: 409 })
  return found[0]
}
function eligibleToTrash(data, row) {
  // A possibly stale Gateway cannot prove absence of a new binding or writer.
  if (data.runtime.stale || row.bound || !row.orphan || row.type === 'schedule' || data.activeTasks[row.id] ||
    row.running || row.status === 'active' || row.status === 'unknown' ||
    data.runtime.stats?.pendingApprovals || data.runtime.stats?.outboxPending ||
    data.runtime.stats?.inboxPending) throw Object.assign(
    new Error('Session is active, referenced or runtime status not safe'), { status: 409 })
}
export async function previewTrashSession(stateDir, services, sessionRef) {
  const data = await sourceData(stateDir, services.persistence, services.registry)
  if (!data.available) throw Object.assign(new Error(data.reason), { status: 503 })
  const row = onlyRow(data, sessionRef)
  eligibleToTrash(data, row)
  const trash = await readTrash(stateDir)
  if (trash.items[row.id]) throw Object.assign(new Error('already in recycle bin'), { status: 409 })
  if (typeof services.registry?.unarchiveSession !== 'function')
    throw Object.assign(new Error('DSH unarchive capability is required for safe restore'), { status: 501 })
  return { sessionRef, previousArchived: row.archived, nativeHistoryPreserved: true,
    physicalDeleteAvailable: false }
}
export function moveNativeSessionToTrash(stateDir, services, sessionRef, now = Date.now()) {
  return serialized(stateDir, async () => {
    if (!Number.isSafeInteger(now) || now <= 0) throw Object.assign(new Error('invalid time'), { status: 400 })
    const data = await sourceData(stateDir, services.persistence, services.registry)
    if (!data.available) throw Object.assign(new Error(data.reason), { status: 503 })
    const row = onlyRow(data, sessionRef)
    eligibleToTrash(data, row)
    if (typeof services.registry?.unarchiveSession !== 'function')
      throw Object.assign(new Error('DSH cannot restore this Session safely'), { status: 501 })
    const trash = await readTrash(stateDir)
    if (trash.items[row.id]) throw Object.assign(new Error('already in recycle bin'), { status: 409 })
    if (Object.keys(trash.items).length >= MAX_TRASH)
      throw Object.assign(new Error('recycle bin capacity reached'), { status: 409 })
    if (!row.archived) await services.registry.archiveSession(row.id)
    // DSH's archive is the visibility operation. If persisting the metadata
    // fails, we never claim the session was moved or that bytes were freed.
    trash.items[row.id] = { trashedAt: now, previousArchived: row.archived }
    await privateWrite(stateDir, TRASH_FILE, trash)
    await auditOrganization(stateDir, row.id, 'native-session-moved-to-trash')
    return { sessionRef, trashed: true, nativeHistoryPreserved: true }
  })
}
export function restoreNativeSessionFromTrash(stateDir, services, sessionRef) {
  return serialized(stateDir, async () => {
    const data = await sourceData(stateDir, services.persistence, services.registry)
    if (!data.available) throw Object.assign(new Error(data.reason), { status: 503 })
    const row = onlyRow(data, sessionRef)
    if (data.runtime.stale) throw Object.assign(new Error('Gateway status is stale'), { status: 409 })
    const trash = await readTrash(stateDir)
    const old = trash.items[row.id]
    if (!old) throw Object.assign(new Error('Session not in recycle bin'), { status: 409 })
    if (!row.archived) throw Object.assign(new Error('DSH archive changed; refresh'), { status: 409 })
    if (!old.previousArchived) {
      if (typeof services.registry?.unarchiveSession !== 'function')
        throw Object.assign(new Error('DSH cannot restore this Session'), { status: 501 })
      await services.registry.unarchiveSession(row.id)
    }
    delete trash.items[row.id]
    await privateWrite(stateDir, TRASH_FILE, trash)
    await auditOrganization(stateDir, row.id, 'native-session-restored-from-trash')
    return { sessionRef, restored: true, target: old.previousArchived ? 'archived' : 'current',
      nativeHistoryPreserved: true }
  })
}
export async function previewRetention(stateDir, services, now = Date.now()) {
  const settings = await retentionSettings(stateDir)
  const data = await sourceData(stateDir, services.persistence, services.registry)
  if (!data.available) return { available: false, reason: data.reason, settings, candidates: 0,
    skippedUnknownActivity: 0, expiredTrash: 0 }
  const [cursorDoc, trash] = await Promise.all([
    privateJson(stateDir, CURSOR_FILE), readTrash(stateDir) ])
  const cursor = isObj(cursorDoc) && cursorDoc.version === 1 ? cursorDoc : emptyCursor()
  const activity = isObj(cursor.activity) ? cursor.activity : {}
  const handled = new Set(Array.isArray(cursor.handled) ? cursor.handled : [])
  const cutoff = now - settings.archiveAfterDays * 86400000
  const candidates = data.records.filter(row =>
    row.orphan && row.type !== 'schedule' && !row.archived && !trash.items[row.id] &&
    !handled.has(row.id) && ms(activity[row.id]) > 0 && ms(activity[row.id]) <= cutoff)
  const skippedUnknownActivity = data.records.filter(row =>
    row.orphan && row.type !== 'schedule' && !row.archived && !trash.items[row.id] &&
    !ms(activity[row.id])).length
  const candidatePreview = []
  for (const row of candidates.slice(0, 20)) {
    let title = row.scheduleTitle || null
    try {
      const value = await services.query?.readTitle?.(row.id)
      if (typeof value === 'string') title = value
      else if (typeof value?.title === 'string') title = value.title
    } catch { /* optional title, no Agent resume */ }
    candidatePreview.push({ sessionRef: row.idRef, title: (title || '未命名对话').slice(0, 100),
      lastActiveAt: ms(activity[row.id]) })
  }
  return { available: true, settings, candidates: candidates.length, candidatePreview,
    skippedUnknownActivity,
    expiredTrash: Object.values(trash.items).filter(item =>
      now - item.trashedAt >= settings.trashKeepDays * 86400000).length,
    physicalDeleteAvailable: false, runtimeFresh: !data.runtime.stale }
}
export function autoArchiveExpiredSessions(stateDir, services, now = Date.now()) {
  return serialized(stateDir, async () => {
    const settings = await retentionSettings(stateDir)
    if (!settings.autoArchiveEnabled) return { enabled: false, archived: 0 }
    const data = await sourceData(stateDir, services.persistence, services.registry)
    if (!data.available || data.runtime.stale ||
      data.runtime.stats?.pendingApprovals || data.runtime.stats?.outboxPending ||
      data.runtime.stats?.inboxPending) return { enabled: true, archived: 0, blocked: true }
    const [cursorDoc, trash] = await Promise.all([
      privateJson(stateDir, CURSOR_FILE), readTrash(stateDir) ])
    const cursor = isObj(cursorDoc) && cursorDoc.version === 1 ? cursorDoc : emptyCursor()
    const activity = isObj(cursor.activity) ? { ...cursor.activity } : {}
    // The trustworthy last active time is observed from a bound session,
    // never guessed from a header's creation date.
    for (const row of data.records) if (row.lastActiveKnown) {
      activity[row.id] = Math.max(ms(activity[row.id]), row.lastActiveAt)
    }
    const cutoff = now - settings.archiveAfterDays * 86400000
    let archived = 0
    const handled = new Set(Array.isArray(cursor.handled) ? cursor.handled.filter(id => SAFE_ID.test(id)) : [])
    for (const row of data.records) {
      if (!row.orphan || row.type === 'schedule' || row.archived || trash.items[row.id] ||
        !ms(activity[row.id]) || ms(activity[row.id]) > cutoff || handled.has(row.id)) continue
      try {
        // Registry rejects a still-live Agent writer even when telemetry misses it.
        await services.registry.archiveSession(row.id)
        handled.add(row.id)
        archived++
        await auditOrganization(stateDir, row.id, 'native-session-retention-auto-archived')
      } catch { /* retain history and retry only if still eligible */ }
    }
    await privateWrite(stateDir, CURSOR_FILE, { ...emptyCursor(), ...cursor,
      activity, handled: [...handled].slice(-10000) })
    return { enabled: true, archived, physicalDeletePerformed: false }
  })
}

/**
 * Optional integration with @michengai/dsh-archive-manager.
 *
 * The plugin augments the existing DSH workspaceRegistry rather than
 * providing a separate "sessionAdmin" service. Its real interface is:
 *   archivedSessionMetadata(): { items: [{ sessionId, createdAt }] }
 *   deleteArchivedSessions(target)
 *   deleteSession(sessionId): { deleted: true }
 *
 * We require the full signature to avoid accidentally enabling the dangerous
 * action because an unrelated extension exposes a same-named method.
 * These functions are not called during capability detection.
 */
export function archiveManagerDeleteAvailable(registry) {
  return typeof registry?.archivedSessionMetadata === 'function' &&
    typeof registry?.deleteArchivedSessions === 'function' &&
    typeof registry?.deleteSession === 'function'
}

export function createArchiveManagerDeleter(registry, persistence, sessions) {
  if (!archiveManagerDeleteAvailable(registry)) return null
  return {
    isLive: sessionId => {
      // dsh-archive-manager itself can detach a live session before removing
      // it. The Feishu Admin never intentionally permits that behaviour.
      if (typeof sessions?.get !== 'function') return false
      return sessions.get(sessionId) !== undefined
    },
    async inspect(sessionId) {
      if (typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined)
        throw Object.assign(new Error('会话正在执行，不能删除'), { status: 409 })
      const metadata = await registry.archivedSessionMetadata()
      if (!Array.isArray(metadata?.items) ||
        !metadata.items.some(row => row?.sessionId === sessionId))
        throw Object.assign(new Error('此会话已不在归档中，请刷新重试'), { status: 409 })
      // This plugin does not report bytes; do not invent an estimate.
      return { live: false }
    },
    async delete(sessionId, options) {
      if (options?.force !== false || options?.backup !== false)
        throw Object.assign(new Error('unsafe delete options'), { status: 400 })
      if (typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined)
        throw Object.assign(new Error('会话正在执行，不能删除'), { status: 409 })
      const result = await registry.deleteSession(sessionId)
      if (result?.deleted !== true)
        throw Object.assign(new Error('归档管理插件未确认删除成功'), { status: 503 })
      return { deleted: true }
    },
    async presentSessionIds() {
      // Physical deletion in the archive-manager already verifies persistence
      // using stat/location. A second indexed list read is only a guard.
      if (typeof persistence?.list !== 'function') return null
      const result = await persistence.list()
      const entries = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
      return new Set(entries.map(item => item?.header?.id ?? item?.id).filter(id => typeof id === 'string'))
    },
  }
}

/**
 * Permanent Session deletion is only supported through a runtime service
 * which owns the DSH persistence, workspace, projection and live-agent cleanup.
 * Never guess storage paths, rm logs, or represent archive/unlink as delete.
 */
function deletionService(services) {
  const deleter = services.deleter
  if (!deleter || typeof deleter.inspect !== 'function' ||
    typeof deleter.delete !== 'function') {
    throw Object.assign(new Error('未检测到 @michengai/dsh-archive-manager 删除功能，请确认已安装在 web Profile 并启用'), { status: 501 })
  }
  return deleter
}
async function deletionCandidate(stateDir, services, sessionRef) {
  const data = await sourceData(stateDir, services.persistence, services.registry)
  if (!data.available) throw Object.assign(new Error(data.reason), { status: 503 })
  const row = onlyRow(data, sessionRef)
  if (!row.archived || row.bound || !row.orphan || row.status === 'active' || row.running ||
    row.type === 'schedule' || data.activeTasks[row.id] || data.runtime.stale ||
    data.runtime.stats?.pendingApprovals || data.runtime.stats?.inboxPending ||
    data.runtime.stats?.outboxPending) {
    throw Object.assign(new Error('会话仍在使用、处于定时任务中或运行状态不确定，不能删除'), { status: 409 })
  }
  const deleter = deletionService(services)
  if (typeof deleter.isLive === 'function' && deleter.isLive(row.id))
    throw Object.assign(new Error('会话仍由 Agent 占用'), { status: 409 })
  return { row, deleter }
}
export async function previewNativePermanentDelete(stateDir, services, sessionRef) {
  const { row, deleter } = await deletionCandidate(stateDir, services, sessionRef)
  const detail = await deleter.inspect(row.id)
  if (detail?.live === true || detail?.status === 'live')
    throw Object.assign(new Error('会话正在运行，不能删除'), { status: 409 })
  // Inspection can contain absolute paths and other sensitive backend fields:
  // expose a minimal, backend-agnostic sanitized preview only.
  const bytes = Number(detail?.bytes ?? detail?.bytesTotal ?? detail?.totalBytes)
  return { sessionRef, permanent: true, reversible: false,
    estimatedBytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null }
}
export function permanentlyDeleteNativeSession(stateDir, services, sessionRef) {
  return serialized(stateDir, async () => {
    const { row, deleter } = await deletionCandidate(stateDir, services, sessionRef)
    const detail = await deleter.inspect(row.id)
    if (detail?.live === true || detail?.status === 'live')
      throw Object.assign(new Error('会话正在运行，不能删除'), { status: 409 })
    // The storage owner must refuse live writers and clean all DSH indices.
    // Explicitly disallow forced live deletion and retained full-log backups.
    const report = await deleter.delete(row.id, { force: false, backup: false })
    if (!report || typeof report !== 'object' ||
      report.deleted === false || report.ok === false || report.success === false)
      throw Object.assign(new Error('删除服务没有确认删除成功'), { status: 503 })
    if (typeof deleter.presentSessionIds === 'function') {
      const present = await deleter.presentSessionIds()
      if (present instanceof Set && present.has(row.id))
        throw Object.assign(new Error('原生日志仍然存在，删除结果需要检查'), { status: 503 })
    }
    const bytes = Number(report.bytesRemoved)
    let indexCleanupPending = false
    try {
      const trash = await readTrash(stateDir)
      if (trash.items[row.id]) {
        delete trash.items[row.id]
        await privateWrite(stateDir, TRASH_FILE, trash)
      }
    } catch { indexCleanupPending = true }
    await auditOrganization(stateDir, row.id, 'native-session-permanently-deleted')
      .catch(() => { indexCleanupPending = true })
    return { sessionRef, deleted: true,
      bytesRemoved: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
      indexCleanupPending }
  })
}

/** Batch operations never share raw Session IDs with the browser. A small
 * selection is previewed first, then each action revalidates at execution. */
const NATIVE_BATCH_LIMIT = 20
const NATIVE_BATCH_ACTIONS = new Set(['archive', 'restore', 'delete'])
export function validateNativeSessionBatch(input) {
  if (!isObj(input) || Object.keys(input).some(key => !['action','sessionRefs'].includes(key)) ||
    !NATIVE_BATCH_ACTIONS.has(input.action) || !Array.isArray(input.sessionRefs) ||
    input.sessionRefs.length < 1 || input.sessionRefs.length > NATIVE_BATCH_LIMIT ||
    input.sessionRefs.some(ref => !validRef(ref)) ||
    new Set(input.sessionRefs).size !== input.sessionRefs.length)
    throw Object.assign(new Error('请选择 1–20 条不重复的对话记录'), { status: 400 })
  return { action: input.action, sessionRefs: [...input.sessionRefs] }
}
function batchRowReason(action, row, data, trash, services) {
  if (!row) return '会话不存在或已发生变化'
  if (data.runtime.stale) return '飞书运行状态待确认，请稍后刷新'
  if (data.runtime.stats?.pendingApprovals || data.runtime.stats?.inboxPending ||
      data.runtime.stats?.outboxPending) return '仍有审批或消息正在处理'
  if (action === 'archive') {
    if (row.archived || trash.items[row.id]) return '已经归档'
    if (row.bound) return '仍与飞书聊天关联，请先解除关联'
    if (row.type === 'schedule' || data.activeTasks[row.id]) return '定时任务会话暂不支持手动归档'
    if (!row.orphan || row.running || row.status !== 'unbound') return '会话仍在运行或状态未知'
    return null
  }
  if (!row.archived) return '不是已归档的对话'
  if (row.status === 'active' || row.running || data.activeTasks[row.id]) return '会话正在使用'
  if (action === 'restore') {
    if (typeof services.registry?.unarchiveSession !== 'function')
      return '当前 DSH 无法恢复归档'
    return null
  }
  if (row.bound || !row.orphan) return '仍与飞书聊天关联，请先解除关联'
  if (row.type === 'schedule') return '定时任务会话暂不支持删除'
  if (typeof services.deleter?.inspect !== 'function' || typeof services.deleter?.delete !== 'function')
    return '未检测到 @michengai/dsh-archive-manager 删除接口'
  return null
}
export async function previewNativeSessionBatch(stateDir, services, input) {
  const { action, sessionRefs } = validateNativeSessionBatch(input)
  const data = await sourceData(stateDir, services.persistence, services.registry)
  if (!data.available) throw Object.assign(new Error(data.reason), { status: 503 })
  const trash = await readTrash(stateDir)
  const eligibleRefs = []
  const skipped = []
  for (const ref of sessionRefs) {
    const matches = data.records.filter(row => row.idRef === ref)
    if (matches.length !== 1) {
      skipped.push({ sessionRef: ref, reason: '会话不存在或引用不唯一' })
      continue
    }
    const row = matches[0]
    const reason = batchRowReason(action, row, data, trash, services)
    if (reason) { skipped.push({ sessionRef: ref, reason }); continue }
    if (action === 'delete') {
      try {
        await previewNativePermanentDelete(stateDir, services, ref)
      } catch (error) {
        skipped.push({ sessionRef: ref, reason: error.message || '不符合删除条件' })
        continue
      }
    }
    eligibleRefs.push(ref)
  }
  return { action, requested: sessionRefs.length, eligible: eligibleRefs.length,
    skipped: skipped.length, eligibleRefs, skippedItems: skipped, limit: NATIVE_BATCH_LIMIT,
    nativeHistoryPreserved: action !== 'delete' }
}
export async function executeNativeSessionBatch(stateDir, services, input) {
  const { action, sessionRefs } = validateNativeSessionBatch(input)
  const succeededRefs = []
  const failedItems = []
  for (const ref of sessionRefs) {
    try {
      // Resolve refs against the latest native catalog for every action.
      const data = await sourceData(stateDir, services.persistence, services.registry)
      if (!data.available) throw Object.assign(new Error(data.reason), { status: 503 })
      const row = onlyRow(data, ref)
      const trash = await readTrash(stateDir)
      const reason = batchRowReason(action, row, data, trash, services)
      if (reason) throw Object.assign(new Error(reason), { status: 409 })
      if (action === 'archive') {
        await archiveNativeSession(stateDir, services, row.id)
      } else if (action === 'restore') {
        if (trash.items[row.id]) {
          const result = await restoreNativeSessionFromTrash(stateDir, services, ref)
          if (result.target === 'archived')
            await restoreNativeSession(stateDir, services, ref)
        } else {
          await restoreNativeSession(stateDir, services, ref)
        }
      } else {
        await permanentlyDeleteNativeSession(stateDir, services, ref)
      }
      succeededRefs.push(ref)
    } catch (error) {
      failedItems.push({ sessionRef: ref, reason: String(error.message || '操作未完成').slice(0, 160) })
    }
  }
  return { action, requested: sessionRefs.length, succeeded: succeededRefs.length,
    failed: failedItems.length, succeededRefs, failedItems,
    nativeHistoryPreserved: action !== 'delete' }
}
