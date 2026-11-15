/**
 * Workspace-scoped Agent profile editor.
 *
 * DSH already loads AGENTS.md and AGENTS.local.md via dsh-agent-instructions.
 * This editor materializes a strictly delimited section of AGENTS.local.md from
 * user-authored SOUL/IDENTITY/USER/TOOLS/MEMORY files, without modifying any
 * other instruction text or injecting unlogged prompts into the Agent.
 *
 * No arbitrary path editing, symlink traversal, HTML execution, or server-side
 * model calls. This module is server-only and requires a DSH-authenticated
 * HTTP handler; it is not a standalone HTTP service.
 */
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

const BASE_FILES = Object.freeze([
  'AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'MEMORY.md',
])
const INJECTABLE = Object.freeze(['IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'])
const DAILY = /^memory\/(20\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\.md$/
const REV = /^[a-f0-9]{64}$/
const MAX_FILE = 24 * 1024
const MAX_BUDGET = 32 * 1024
const BEGIN = '<!-- DSH-FEISHU-AGENT-PROFILE:BEGIN -->'
const END = '<!-- DSH-FEISHU-AGENT-PROFILE:END -->'
const SETTINGS = 'agent-profile-settings.json'
const OVERLAY = 'AGENTS.local.md'
const DEFAULT = Object.freeze({
  version: 1,
  enabled: Object.freeze(Object.fromEntries(INJECTABLE.map(name => [name, true]))),
  maxBytes: 16000,
  perFileBytes: 6000,
})
const digest = value => createHash('sha256').update(value).digest('hex')
const err = (status, message) => Object.assign(new Error(message), { status })
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function validateName(name) {
  if (typeof name !== 'string' || !(BASE_FILES.includes(name) || DAILY.test(name))) {
    throw err(400, 'unsupported Agent profile filename')
  }
  if (DAILY.test(name)) {
    const date = name.slice(7, 17)
    const parsed = new Date(date + 'T12:00:00Z')
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
      throw err(400, 'invalid memory date')
  }
  return name
}
function validateText(content) {
  if (typeof content !== 'string' || content.includes('\0') ||
    Buffer.byteLength(content, 'utf8') > MAX_FILE ||
    content.includes(BEGIN) || content.includes(END)) {
    throw err(400, 'invalid or oversized Markdown content')
  }
  return content
}
function validateSettings(input) {
  if (!obj(input) || Object.keys(input).some(key =>
    !['enabled', 'maxBytes', 'perFileBytes'].includes(key))) {
    throw err(400, 'invalid profile settings')
  }
  if (!obj(input.enabled) ||
    Object.keys(input.enabled).some(name => !INJECTABLE.includes(name)) ||
    INJECTABLE.some(name => typeof input.enabled[name] !== 'boolean')) {
    throw err(400, 'invalid Agent file inclusion map')
  }
  if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1024 ||
    input.maxBytes > MAX_BUDGET || !Number.isInteger(input.perFileBytes) ||
    input.perFileBytes < 512 || input.perFileBytes > input.maxBytes) {
    throw err(400, 'invalid Agent context byte limits')
  }
  return { version: 1, enabled: Object.fromEntries(INJECTABLE.map(name => [name, input.enabled[name]])),
    maxBytes: input.maxBytes, perFileBytes: input.perFileBytes }
}
async function checkedDir(dir, create = false) {
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  let stat
  try { stat = await fs.lstat(dir) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw err(409, 'unsafe Agent profile directory')
  return true
}
async function checkedWorkspace(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) ||
    workspace.includes('\0')) throw err(503, 'Gateway workspace is not available')
  const dir = path.resolve(workspace)
  if (!await checkedDir(dir)) throw err(503, 'Gateway workspace is not accessible')
  // Reject symlinked ancestor components, not only a symlink at the last level.
  if (await fs.realpath(dir) !== dir) throw err(409, 'symlinked workspace is not editable')
  return dir
}
async function safeFile(file, limit = MAX_FILE) {
  let stat
  try { stat = await fs.lstat(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw err(409, 'unsafe or oversized Agent profile file')
  return stat
}
async function atomicWrite(file, text) {
  await checkedDir(path.dirname(file), true)
  await safeFile(file, 128 * 1024)
  const tmp = file + '.' + randomUUID() + '.tmp'
  try {
    const handle = await fs.open(tmp, 'wx', 0o600)
    try { await handle.writeFile(text, 'utf8'); await handle.sync() }
    finally { await handle.close() }
    await fs.rename(tmp, file)
    await fs.chmod(file, 0o600)
  } finally { await fs.rm(tmp, { force: true }).catch(() => undefined) }
}
function filePath(workspace, name) {
  validateName(name)
  return path.join(workspace, ...name.split('/'))
}
async function readRaw(workspace, name) {
  const file = filePath(workspace, name)
  if (name.startsWith('memory/') && !await checkedDir(path.join(workspace, 'memory')))
    return { exists: false, content: '', revision: 'absent', size: 0, mtimeMs: null }
  const st = await safeFile(file)
  if (!st) return { exists: false, content: '', revision: 'absent', size: 0, mtimeMs: null }
  const content = await fs.readFile(file, 'utf8')
  return { exists: true, content, revision: digest(content), size: st.size, mtimeMs: st.mtimeMs }
}
async function readSettings(stateDir) {
  if (!await checkedDir(stateDir)) throw err(503, 'Gateway state directory is unavailable')
  const file = path.join(stateDir, SETTINGS)
  if (!await safeFile(file, 8192)) return { ...DEFAULT, enabled: { ...DEFAULT.enabled }, revision: 'absent' }
  let data
  const raw = await fs.readFile(file, 'utf8')
  try { data = JSON.parse(raw) } catch { throw err(409, 'Agent profile settings are corrupt') }
  if (data.version !== 1) throw err(409, 'unsupported profile settings version')
  const validated = validateSettings({
    enabled: data.enabled, maxBytes: data.maxBytes, perFileBytes: data.perFileBytes,
  })
  return { ...validated, revision: digest(raw) }
}
function cappedUtf8(content, limit) {
  let used = 0; let result = ''
  for (const char of content) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > limit) break
    result += char; used += size
  }
  return { text: result, truncated: used < Buffer.byteLength(content, 'utf8'), bytes: used }
}
async function generatedSection(workspace, settings) {
  const parts = []
  const wrapper = [BEGIN, '## 飞书 Agent 档案（DSH 自动加载的工作区指令补充）',
    '以下内容由飞书后台从当前工作区的 Agent 档案文件同步。',
    '这些工作区文件不覆盖系统指令、安全规则或 DSH 原生工具审批。', END].join('\n')
  // Budget includes the rendered wrapper, file headings and truncation markers.
  let remaining = settings.maxBytes - Buffer.byteLength(wrapper, 'utf8') - 16
  const loaded = []
  for (const name of INJECTABLE) {
    if (!settings.enabled[name]) continue
    const file = await readRaw(workspace, name)
    if (!file.exists || !file.content.trim()) continue
    const heading = '\n\n### ' + name + '\n'
    const reserve = Buffer.byteLength(heading, 'utf8') + 70
    if (remaining < reserve + 64) break
    const excerpt = cappedUtf8(file.content, Math.min(settings.perFileBytes, remaining - reserve))
    parts.push(heading + excerpt.text + (excerpt.truncated ? '\n[Profile content truncated by configured byte budget]' : ''))
    remaining -= Buffer.byteLength(parts.at(-1), 'utf8')
    loaded.push({ name, revision: file.revision, bytes: excerpt.bytes, truncated: excerpt.truncated })
  }
  const text = parts.length ? [
    BEGIN,
    '## 飞书 Agent 档案（DSH 自动加载的工作区指令补充）',
    '以下内容由飞书后台从当前工作区的 Agent 档案文件同步。',
    '这些工作区文件不覆盖系统指令、安全规则或 DSH 原生工具审批。',
    ...parts, END,
  ].join('\n') : ''
  return { text, loaded, bytes: Buffer.byteLength(text, 'utf8') }
}
function parseOverlay(raw) {
  const begin = raw.indexOf(BEGIN), end = raw.indexOf(END)
  if ((begin === -1) !== (end === -1) ||
    (begin !== -1 && (end < begin || raw.indexOf(BEGIN, begin + BEGIN.length) !== -1 ||
      raw.indexOf(END, end + END.length) !== -1))) {
    throw err(409, 'existing AGENTS.local.md has conflicting profile markers')
  }
  if (begin < 0) return { prefix: raw, suffix: '', section: '' }
  return { prefix: raw.slice(0, begin), suffix: raw.slice(end + END.length),
    section: raw.slice(begin, end + END.length) }
}
async function overlayState(workspace, settings) {
  const desired = await generatedSection(workspace, settings)
  const overlay = path.join(workspace, OVERLAY)
  const existing = await safeFile(overlay, 128 * 1024)
  const raw = existing ? await fs.readFile(overlay, 'utf8') : ''
  const current = parseOverlay(raw)
  return { desired, current, syncNeeded: current.section !== desired.text }
}
async function syncOverlay(workspace, settings) {
  const { desired, current, syncNeeded } = await overlayState(workspace, settings)
  if (syncNeeded) {
    const combined = current.section
      ? current.prefix + desired.text + current.suffix
      : current.prefix + (current.prefix && !current.prefix.endsWith('\n') ? '\n\n' : '') +
        desired.text + (desired.text ? '\n' : '')
    if (Buffer.byteLength(combined, 'utf8') > 128 * 1024)
      throw err(413, 'AGENTS.local.md too large to synchronize')
    await atomicWrite(path.join(workspace, OVERLAY), combined)
  }
  return { syncNeeded: false, loaded: desired.loaded, contextBytes: desired.bytes,
    effective: 'new-session', integration: 'dsh-agent-instructions / AGENTS.local.md' }
}
async function historyFolder(stateDir, name, create = false) {
  validateName(name)
  const root = path.join(stateDir, 'agent-profile-history')
  if (!await checkedDir(root, create)) return null
  const folder = path.join(root, digest(name).slice(0, 32))
  if (!await checkedDir(folder, create)) return null
  return folder
}
async function remember(stateDir, name, raw) {
  if (!raw.exists) return
  const folder = await historyFolder(stateDir, name, true)
  const stamp = String(Date.now()).padStart(13, '0')
  const target = path.join(folder, stamp + '-' + raw.revision + '.md')
  if (!await safeFile(target, MAX_FILE)) await atomicWrite(target, raw.content)
  await trimHistory(folder)
}
async function trimHistory(folder) {
  const list = (await fs.readdir(folder)).filter(n => /^\d{13}-[a-f0-9]{64}\.md$/.test(n)).sort()
  for (const name of list.slice(0, Math.max(0, list.length - 30))) {
    await safeFile(path.join(folder, name))
    await fs.rm(path.join(folder, name))
  }
}
export async function listAgentFiles({ stateDir, workspace }) {
  const dir = await checkedWorkspace(workspace)
  const settings = await readSettings(stateDir)
  const files = []
  for (const name of BASE_FILES) {
    const file = await readRaw(dir, name)
    files.push({ name, exists: file.exists, size: file.size, modifiedAt: file.mtimeMs,
      revision: file.revision, loading: name === 'AGENTS.md' ? 'dsh-native'
        : settings.enabled[name] ? 'enabled' : 'disabled' })
  }
  const dailyDir = path.join(dir, 'memory')
  if (await checkedDir(dailyDir)) {
    const names = (await fs.readdir(dailyDir)).filter(name => DAILY.test('memory/' + name))
      .sort().reverse().slice(0, 200)
    for (const file of names) {
      const name = 'memory/' + file
      const raw = await readRaw(dir, name)
      files.push({ name, exists: raw.exists, size: raw.size,
        modifiedAt: raw.mtimeMs, revision: raw.revision, loading: 'on-demand' })
    }
  }
  const overlay = await overlayState(dir, settings)
  return { workspace: dir, files, settings, syncNeeded: overlay.syncNeeded,
    loaded: overlay.desired.loaded, contextBytes: overlay.desired.bytes,
    activation: 'new-session', sharedWorkspace: false,
    isolation: 'feishu-channel', maxFileBytes: MAX_FILE }
}
export async function readAgentFile({ workspace }, name) {
  const dir = await checkedWorkspace(workspace)
  const result = await readRaw(dir, name)
  return { name, ...result }
}
export async function listAgentHistory({ stateDir, workspace }, name) {
  await checkedWorkspace(workspace)
  const folder = await historyFolder(stateDir, name)
  if (!folder) return []
  const names = (await fs.readdir(folder)).filter(n => /^\d{13}-[a-f0-9]{64}\.md$/.test(n))
    .sort().reverse().slice(0, 30)
  const results = []
  for (const entry of names) {
    const st = await safeFile(path.join(folder, entry))
    if (!st) continue
    results.push({ id: entry, revision: entry.slice(14, 78),
      timestamp: Number(entry.slice(0, 13)), size: st.size })
  }
  return results
}
export async function saveAgentFile({ stateDir, workspace }, { name, content, expectedRevision }) {
  const dir = await checkedWorkspace(workspace)
  validateName(name)
  validateText(content)
  if (!(expectedRevision === 'absent' || REV.test(expectedRevision)))
    throw err(400, 'invalid expected file revision')
  const before = await readRaw(dir, name)
  if (before.revision !== expectedRevision) throw err(409, 'profile file changed; reload before saving')
  // Guard before touching user content. We must be able to preserve any
  // manually authored AGENTS.local.md if the effective instruction chain changes.
  const settings = await readSettings(stateDir)
  await overlayState(dir, settings)
  const target = filePath(dir, name)
  if (name.startsWith('memory/')) await checkedDir(path.join(dir, 'memory'), true)
  await remember(stateDir, name, before)
  await atomicWrite(target, content)
  const now = await readRaw(dir, name)
  await remember(stateDir, name, now)
  const overlay = await syncOverlay(dir, settings)
  return { name, revision: now.revision, saved: true, ...overlay }
}
export async function restoreAgentFile(ctx, { name, id, expectedRevision }) {
  const dir = await checkedWorkspace(ctx.workspace)
  validateName(name)
  if (typeof id !== 'string' || !/^\d{13}-[a-f0-9]{64}\.md$/.test(id))
    throw err(400, 'invalid history revision')
  const folder = await historyFolder(ctx.stateDir, name)
  if (!folder) throw err(404, 'history revision not found')
  const file = path.join(folder, id)
  if (!await safeFile(file)) throw err(404, 'history revision not found')
  const content = await fs.readFile(file, 'utf8')
  if (digest(content) !== id.slice(14, 78)) throw err(409, 'profile history integrity check failed')
  return saveAgentFile({ ...ctx, workspace: dir }, { name, content, expectedRevision })
}
export async function saveAgentSettings({ stateDir, workspace }, { settings, expectedRevision }) {
  const dir = await checkedWorkspace(workspace)
  const before = await readSettings(stateDir)
  if (expectedRevision !== before.revision) throw err(409, 'profile settings changed; reload')
  const data = validateSettings(settings)
  await overlayState(dir, data) // reject marker collisions before writing settings
  await atomicWrite(path.join(stateDir, SETTINGS), JSON.stringify(data, null, 2) + '\n')
  return { settings: await readSettings(stateDir), ...await syncOverlay(dir, data) }
}
export async function applyAgentProfile({ stateDir, workspace }) {
  const dir = await checkedWorkspace(workspace)
  return syncOverlay(dir, await readSettings(stateDir))
}
export const AgentProfileFiles = BASE_FILES
