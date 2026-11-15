/**
 * Issue #16 — read-only Feishu Session inventory.
 *
 * Sessions.json contains only Feishu->native DSH bindings. Never open native
 * DSH session files or return raw chat identifiers / session IDs to the UI.
 * This module deliberately implements NO filesystem mutations.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readOpsSnapshot } from './ops-read.mjs'

const MAX_STATE = 8 * 1024 * 1024
const MAX_ENTRIES = 100_000
const STORAGE_FILES = [
  ['inbox', 'inbox.jsonl'], ['outbox', 'outbox.json'],
  ['bindings', 'sessions.json'], ['events', 'ops-events.jsonl'],
  ['runtime', 'ops-runtime.json'], ['dedup', 'dedup.json'],
  ['usage', 'ops-usage'], ['commands', 'ops-control'],
]
const ref = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const invalid = msg => Object.assign(new Error(msg), { status: 400 })
const asDate = (s, end = false) => {
  if (s === null) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw invalid('invalid date (YYYY-MM-DD required)')
  const value = Date.parse(s + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z'))
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== s)
    throw invalid('invalid calendar date')
  return value
}
const number = (s, name, fallback, min, max) => {
  if (s === null) return fallback
  if (!/^\d+$/.test(s)) throw invalid('invalid ' + name)
  const v = Number(s)
  if (!Number.isSafeInteger(v) || v < min || v > max) throw invalid('invalid ' + name)
  return v
}
const safeDir = async dir => {
  const st = await fs.lstat(dir).catch(e => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (!st) return false
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('unsafe session state directory')
  return true
}
async function safeFile(dir, filename, maxBytes = MAX_STATE) {
  if (!(await safeDir(dir))) return null
  const filenameFull = path.join(dir, filename)
  let handle
  try {
    handle = await fs.open(filenameFull, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.size > maxBytes) throw Error('unsafe or oversized Feishu state')
    return { bytes: st.size, data: await handle.readFile('utf8') }
  } finally { await handle.close() }
}
async function countDir(dir, depth = 0) {
  if (!(await safeDir(dir))) return 0
  if (depth > 2) throw Error('unexpected nested state directory')
  let sum = 0
  const names = await fs.readdir(dir)
  if (names.length > 5000) throw Error('too many state entries to inventory safely')
  for (const name of names) {
    const file = path.join(dir, name)
    const st = await fs.lstat(file)
    if (st.isSymbolicLink()) throw Error('unsafe link in Feishu state')
    if (st.isFile()) sum += st.size
    else if (st.isDirectory()) sum += await countDir(file, depth + 1)
  }
  return sum
}
export async function sessionStorage(stateDir) {
  if (!(await safeDir(stateDir)))
    return { totalBytes: 0, categories: STORAGE_FILES.map(([key]) => ({ key, bytes: 0 })) }
  const categories = []
  for (const [key, filename] of STORAGE_FILES) {
    const full = path.join(stateDir, filename)
    const st = await fs.lstat(full).catch(e => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    if (!st) { categories.push({ key, bytes: 0 }); continue }
    if (st.isSymbolicLink()) throw Error('unsafe Feishu state file')
    if (st.isDirectory()) categories.push({ key, bytes: await countDir(full) })
    else if (st.isFile()) categories.push({ key, bytes: st.size })
    else throw Error('unexpected Feishu state node')
  }
  return { totalBytes: categories.reduce((sum, entry) => sum + entry.bytes, 0), categories }
}
export function parseSessionQuery(params) {
  const allowed = new Set(['from', 'to', 'bot', 'chat', 'session', 'status', 'sort', 'direction', 'page', 'pageSize'])
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw invalid('invalid session query key')
  }
  const from = asDate(params.get('from'))
  const to = asDate(params.get('to'), true)
  if (from !== undefined && to !== undefined && from > to) throw invalid('invalid date range')
  const bot = params.get('bot') ?? ''
  const chat = params.get('chat') ?? ''
  const session = params.get('session') ?? ''
  if (bot.length > 32 || (bot && !/^[a-z][a-z0-9_-]*$/.test(bot))) throw invalid('invalid bot filter')
  if (chat.length > 128 || /[\u0000-\u001f]/.test(chat)) throw invalid('invalid chat filter')
  if (session.length > 128 || /[\u0000-\u001f]/.test(session)) throw invalid('invalid session filter')
  const status = params.get('status') ?? 'all'
  if (!['all', 'active', 'idle', 'archived'].includes(status)) throw invalid('invalid status')
  const sort = params.get('sort') ?? 'lastActiveAt'
  if (!['lastActiveAt', 'createdAt'].includes(sort)) throw invalid('invalid sort')
  const direction = params.get('direction') ?? 'desc'
  if (!['asc', 'desc'].includes(direction)) throw invalid('invalid direction')
  return { from, to, bot, chat, session, status, sort, direction,
    page: number(params.get('page'), 'page', 1, 1, 100000),
    pageSize: number(params.get('pageSize'), 'pageSize', 25, 1, 100) }
}
export async function querySessions(stateDir, query, now = Date.now()) {
  const [file, snapshot, storage] = await Promise.all([
    safeFile(stateDir, 'sessions.json'), readOpsSnapshot(stateDir), sessionStorage(stateDir),
  ])
  if (!file) return { total: 0, page: query.page, pageSize: query.pageSize, items: [], storage }
  let parsed
  try { parsed = JSON.parse(file.data) } catch { throw Error('Feishu bindings are corrupt; original preserved') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !parsed.bindings || typeof parsed.bindings !== 'object' || Array.isArray(parsed.bindings))
    throw Error('invalid Feishu bindings schema')
  const pairs = Object.entries(parsed.bindings)
  if (pairs.length > MAX_ENTRIES) throw Error('too many Feishu bindings')
  // Never use a stale runtime snapshot to mark a session safe for management.
  const active = new Set(snapshot && !snapshot.stale ?
    snapshot.tasks.filter(task => task.session).map(task => task.session) : [])
  const items = []
  for (const [key, value] of pairs) {
    if (!value || typeof value.sessionId !== 'string' || !Number.isFinite(value.createdAt) ||
        !Number.isFinite(value.lastActiveAt)) continue
    const colon = key.indexOf(':')
    const botId = colon < 0 ? '' : key.slice(0, colon)
    const chatId = colon < 0 ? key : key.slice(colon + 1)
    const sessionRef = ref(value.sessionId)
    const status = value.archived === true ? 'archived' :
      active.has(sessionRef) ? 'active' : 'idle'
    if ((query.from !== undefined && value.lastActiveAt < query.from) ||
        (query.to !== undefined && value.lastActiveAt > query.to) ||
        (query.bot && botId !== query.bot) ||
        (query.chat && !chatId.includes(query.chat) && ref(chatId) !== query.chat) ||
        (query.session && !value.sessionId.includes(query.session) && sessionRef !== query.session) ||
        (query.status !== 'all' && query.status !== status)) continue
    items.push({ sessionRef, chatRef: ref(chatId), botId, status,
      createdAt: value.createdAt, lastActiveAt: value.lastActiveAt,
      persisted: value.persisted === true,
      // These bytes are a proportional estimate; sessions.json is one shared JSON object.
      estimatedBindingBytes: Buffer.byteLength(JSON.stringify({ [key]: value }), 'utf8'),
    })
  }
  items.sort((a, b) => {
    const diff = a[query.sort] - b[query.sort]
    return (query.direction === 'asc' ? diff : -diff) || a.sessionRef.localeCompare(b.sessionRef)
  })
  const offset = (query.page - 1) * query.pageSize
  return { total: items.length, page: query.page, pageSize: query.pageSize,
    items: items.slice(offset, offset + query.pageSize), storage,
    runtimeFresh: Boolean(snapshot && !snapshot.stale),
    note: 'Feishu bindings only; DSH native Session history belongs to DSH. Binding byte estimates are not guaranteed recoverable disk space.' }
}
