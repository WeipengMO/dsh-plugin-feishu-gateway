/**
 * Management-only DSH Web Cordis plugin.
 *
 * No Feishu WebSocket, no Agent factory, no credential echo, no second Host.
 * The existing authenticated DSH webServer provides the only HTTP listener.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFile as rawExecFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { readOpsEvents, readOpsSnapshot, readOpsResults, summarizeOps } from './ops-read.mjs'
import { readScheduleModel, readScheduleResults } from './schedule-read.mjs'
import { readApprovalsModel } from './approvals-read.mjs'
import { validateSpec, previewOccurrences, specSummary, SCHEDULE_ACTIONS,
  SCHEDULE_NOTIFY, SCHEDULE_ACTOR, SCHEDULE_TASK_ID_RE, SCHEDULE_UUID_RE,
  TITLE_MAX, PROMPT_MAX, PREVIEW_MAX } from './schedule-spec.mjs'
import { parseSessionQuery, querySessions } from './session-read.mjs'
import { sessionOrganizationInventory, reconcileSessionOrganization, archiveNativeSession, restoreNativeSession,
  organizationSettings, saveOrganizationSettings, retentionSettings, saveRetentionSettings,
  previewRetention, previewTrashSession, moveNativeSessionToTrash, restoreNativeSessionFromTrash,
  previewNativePermanentDelete, permanentlyDeleteNativeSession,
  autoArchiveExpiredSessions } from './session-organizer.mjs'
import { parseUsageQuery, queryUsage, usageCsv } from './usage-read.mjs'
import { listAgentFiles, readAgentFile, saveAgentFile, listAgentHistory,
  restoreAgentFile, saveAgentSettings, applyAgentProfile, detachLegacyOverlay } from './agent-profile.mjs'
import { readExecPolicy, writeExecPolicy, normalizeExecPolicy, defaultProfilePath,
  EXEC_MODES, APPROVAL_POLICIES, EXEC_OVERLAY_FILE } from './exec-policy.mjs'

export const name = 'feishu-channel-admin'
export const inject = ['webServer', 'connection']
const execFile = promisify(rawExecFile)
const PREFIX = '/api/feishu-admin'
const VERSION = 1
const SERVICE = 'dsh-feishu-channel.service'
const CFG_KEYS = ['bots', 'allowlist', 'groupPolicy', 'groupSenderAllowlist', 'groups', 'workspace', 'agentWorkspace', 'agent', 'replyTimeoutMs', 'networkProxy',
  'replyFormat', 'sendRetries', 'outboxRetryIntervalMs', 'autoConnect',
  'approvalCards', 'streamCards', 'approvalTimeoutMs', 'streamIntervalMs']
// The proxy URL is a write-only secret: stored in its own 0600 file, never in
// admin-config.json, never echoed back by any management API.
const DEFAULT_PROXY_ENV = 'FEISHU_CHANNEL_PROXY_URL'
const PROXY_FILE = 'network-proxy.json'
const PROXY_URL_MAX = 2048
const PROXY_TEST_TIMEOUT_MS = 6000
const PROXY_TEST_TARGETS = { feishu: 'open.feishu.cn:443', lark: 'open.larksuite.com:443' }
const PROBE_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'ECONNABORTED', 'EPROTO'])

function httpError(status, message) { return Object.assign(new Error(message), { status }) }
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function exactKeys(value, allowed) {
  for (const name of Object.keys(value)) if (!allowed.includes(name)) throw httpError(400, 'unsupported field: ' + name)
}
function integer(v, key, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw httpError(400, key + ' must be ' + min + '..' + max)
  return v
}
function envNames(id) {
  return { appId: 'FEISHU_GATEWAY_' + id.toUpperCase().replace(/-/g, '_') + '_APP_ID',
    appSecret: 'FEISHU_GATEWAY_' + id.toUpperCase().replace(/-/g, '_') + '_APP_SECRET' }
}
export function validateConfig(input) {
  if (!object(input)) throw httpError(400, 'config must be an object')
  exactKeys(input, CFG_KEYS)
  const result = {}
  if (input.bots !== undefined) {
    if (!Array.isArray(input.bots) || input.bots.length > 8) throw httpError(400, 'bots must be an array (max 8)')
    const seen = new Set()
    result.bots = input.bots.map(bot => {
      if (!object(bot)) throw httpError(400, 'bot must be an object')
      exactKeys(bot, ['id', 'enabled', 'domain'])
      if (typeof bot.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(bot.id)) throw httpError(400, 'invalid bot id')
      if (bot.enabled !== undefined && typeof bot.enabled !== 'boolean') throw httpError(400, 'invalid bot enabled')
      if (bot.domain !== 'feishu' && bot.domain !== 'lark') throw httpError(400, 'invalid bot domain')
      const names = envNames(bot.id)
      if (seen.has(names.appId)) throw httpError(400, 'colliding bot environment names')
      seen.add(names.appId)
      return { id: bot.id, enabled: bot.enabled !== false, domain: bot.domain }
    })
  }
  if (input.allowlist !== undefined) {
    if (!Array.isArray(input.allowlist) || input.allowlist.length > 200 ||
      input.allowlist.some(id => typeof id !== 'string' || !/^ou_[A-Za-z0-9_-]{2,128}$/.test(id)) ||
      new Set(input.allowlist).size !== input.allowlist.length) throw httpError(400, 'invalid allowlist')
    result.allowlist = [...input.allowlist]
  }
  if (input.groupPolicy !== undefined) {
    if (!['disabled', 'allowlist', 'open'].includes(input.groupPolicy)) throw httpError(400, 'invalid groupPolicy')
    result.groupPolicy = input.groupPolicy
  }
  if (input.groupSenderAllowlist !== undefined) {
    if (!Array.isArray(input.groupSenderAllowlist) || input.groupSenderAllowlist.length > 200 ||
      input.groupSenderAllowlist.some(id => typeof id !== 'string' || !/^ou_[A-Za-z0-9_-]{2,128}$/.test(id)) ||
      new Set(input.groupSenderAllowlist).size !== input.groupSenderAllowlist.length)
      throw httpError(400, 'invalid groupSenderAllowlist')
    result.groupSenderAllowlist = [...input.groupSenderAllowlist]
  }
  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups) || input.groups.length > 200) throw httpError(400, 'invalid groups')
    const seen = new Set()
    result.groups = input.groups.map(rule => {
      if (!object(rule)) throw httpError(400, 'invalid group')
      exactKeys(rule, ['chatId', 'name', 'enabled', 'requireMention', 'senderAllowlist', 'sessionScope'])
      if (typeof rule.chatId !== 'string' || !/^oc_[A-Za-z0-9_-]{2,128}$/.test(rule.chatId) || seen.has(rule.chatId))
        throw httpError(400, 'invalid or duplicate group chatId')
      seen.add(rule.chatId)
      if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') throw httpError(400, 'invalid group enabled')
      if (rule.name !== undefined && (typeof rule.name !== 'string' || rule.name.length > 100))
        throw httpError(400, 'invalid group name')
      if (rule.requireMention !== undefined && typeof rule.requireMention !== 'boolean')
        throw httpError(400, 'invalid requireMention')
      if (rule.senderAllowlist !== undefined &&
        (!Array.isArray(rule.senderAllowlist) || rule.senderAllowlist.length > 200 ||
          rule.senderAllowlist.some(id => typeof id !== 'string' || !/^ou_[A-Za-z0-9_-]{2,128}$/.test(id)) ||
          new Set(rule.senderAllowlist).size !== rule.senderAllowlist.length))
        throw httpError(400, 'invalid group senderAllowlist')
      const scope = rule.sessionScope ?? 'group_sender'
      if (!['group', 'group_sender', 'group_topic', 'group_topic_sender'].includes(scope))
        throw httpError(400, 'invalid group sessionScope')
      return { chatId: rule.chatId, enabled: rule.enabled !== false,
        ...(rule.name !== undefined ? { name: rule.name } : {}),
        requireMention: rule.requireMention !== false,
        ...(rule.senderAllowlist ? { senderAllowlist: [...rule.senderAllowlist] } : {}),
        sessionScope: scope }
    })
  }
  if (input.workspace !== undefined) {
    if (typeof input.workspace !== 'string' || input.workspace.length > 4096 ||
      !path.isAbsolute(input.workspace) || input.workspace.includes('\0')) throw httpError(400, 'workspace must be an absolute path')
    result.workspace = path.normalize(input.workspace)
  }
  if (input.agentWorkspace !== undefined) {
    if (typeof input.agentWorkspace !== 'string' || input.agentWorkspace.length > 4096 ||
        !path.isAbsolute(input.agentWorkspace) || input.agentWorkspace.includes('\0'))
      throw httpError(400, 'agentWorkspace must be an absolute path')
    result.agentWorkspace = path.normalize(input.agentWorkspace)
  }
  if (input.agent !== undefined) {
    if (!object(input.agent)) throw httpError(400, 'agent must be an object')
    exactKeys(input.agent, ['provider', 'model', 'fallback', 'fallbacks'])
    const agent = {}
    for (const key of ['provider', 'model']) if (input.agent[key] !== undefined) {
      if (typeof input.agent[key] !== 'string' || !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(input.agent[key])) {
        throw httpError(400, 'invalid model route ' + key)
      }
      agent[key] = input.agent[key]
    }
    if (input.agent.fallback !== undefined && input.agent.fallbacks !== undefined) {
      throw httpError(400, 'use either fallback or fallbacks')
    }
    if (input.agent.fallbacks !== undefined) {
      const candidates = input.agent.fallbacks
      if (!Array.isArray(candidates) || candidates.length > 8) {
        throw httpError(400, 'fallbacks must be an array (max 8)')
      }
      const seen = new Set()
      agent.fallbacks = candidates.map(choice => {
        if (!object(choice)) throw httpError(400, 'fallback route must be an object')
        exactKeys(choice, ['provider', 'model'])
        for (const key of ['provider', 'model']) {
          if (typeof choice[key] !== 'string' || !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(choice[key])) {
            throw httpError(400, 'invalid fallback model route ' + key)
          }
        }
        const id = choice.provider + '\0' + choice.model
        if (seen.has(id)) throw httpError(400, 'duplicate fallback route')
        if (agent.provider === choice.provider && agent.model === choice.model) {
          throw httpError(400, 'fallback route must differ from the primary route')
        }
        seen.add(id)
        return { provider: choice.provider, model: choice.model }
      })
    }
    const fallback = input.agent.fallback
    if (fallback === null) {
      // Explicit clear: the overlay must never silently inherit an old route.
      agent.fallback = null
    } else if (fallback !== undefined) {
      if (!object(fallback)) throw httpError(400, 'agent fallback must be an object or null')
      exactKeys(fallback, ['provider', 'model'])
      for (const key of ['provider', 'model']) {
        if (typeof fallback[key] !== 'string' || !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(fallback[key])) {
          throw httpError(400, 'invalid fallback model route ' + key)
        }
      }
      if (agent.provider === fallback.provider && agent.model === fallback.model) {
        throw httpError(400, 'fallback route must differ from the primary route')
      }
      agent.fallback = { provider: fallback.provider, model: fallback.model }
    }
    result.agent = agent
  }
  if (input.replyTimeoutMs !== undefined) result.replyTimeoutMs = integer(input.replyTimeoutMs, 'replyTimeoutMs', 5000, 1800000)
  if (input.networkProxy !== undefined) {
    const p = input.networkProxy
    if (!object(p)) throw httpError(400, 'networkProxy must be an object')
    exactKeys(p, ['enabled', 'urlEnv', 'fallbackDirect'])
    // urlEnv only exists for compatibility with old deployments; a saved
    // managed URL always wins at runtime. Default keeps rc.9 configs valid.
    const urlEnv = p.urlEnv === undefined ? DEFAULT_PROXY_ENV : p.urlEnv
    if (typeof p.enabled !== 'boolean' || typeof p.fallbackDirect !== 'boolean' ||
        typeof urlEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(urlEnv))
      throw httpError(400, 'invalid networkProxy')
    result.networkProxy = { enabled: p.enabled, urlEnv, fallbackDirect: p.fallbackDirect }
  }
  if (input.replyFormat !== undefined) {
    if (input.replyFormat !== 'text' && input.replyFormat !== 'markdown') throw httpError(400, 'invalid replyFormat')
    result.replyFormat = input.replyFormat
  }
  if (input.sendRetries !== undefined) result.sendRetries = integer(input.sendRetries, 'sendRetries', 1, 10)
  if (input.outboxRetryIntervalMs !== undefined) result.outboxRetryIntervalMs = integer(input.outboxRetryIntervalMs, 'outboxRetryIntervalMs', 1000, 300000)
  for (const key of ['approvalCards', 'streamCards']) if (input[key] !== undefined) {
    if (typeof input[key] !== 'boolean') throw httpError(400, 'invalid ' + key)
    result[key] = input[key]
  }
  if (input.approvalTimeoutMs !== undefined)
    result.approvalTimeoutMs = integer(input.approvalTimeoutMs, 'approvalTimeoutMs', 5000, 1800000)
  if (input.streamIntervalMs !== undefined)
    result.streamIntervalMs = integer(input.streamIntervalMs, 'streamIntervalMs', 500, 5000)
  if (input.autoConnect !== undefined) {
    if (typeof input.autoConnect !== 'boolean') throw httpError(400, 'autoConnect must be boolean')
    result.autoConnect = input.autoConnect
  }
  return result
}

function sha(raw) { return createHash('sha256').update(raw).digest('hex') }
async function existingRegular(filename) {
  try {
    const st = await fs.lstat(filename)
    if (!st.isFile() || st.isSymbolicLink()) throw httpError(409, 'refusing non-regular file: ' + path.basename(filename))
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
async function configFile(filename) {
  if (!(await existingRegular(filename))) return { config: {}, revision: sha('absent'), mtimeMs: 0 }
  const raw = await fs.readFile(filename, 'utf8')
  let doc
  try { doc = JSON.parse(raw) } catch { throw httpError(409, 'managed config is corrupt; repair manually') }
  if (!object(doc) || doc.version !== 1) throw httpError(409, 'managed config version unsupported')
  exactKeys(doc, ['version', 'config'])
  return { config: validateConfig(doc.config), revision: sha(raw), mtimeMs: (await fs.stat(filename)).mtimeMs }
}
async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const st = await fs.lstat(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw httpError(409, 'stateDir must be a real directory')
}
async function atomicPrivateWrite(filename, content) {
  await ensurePrivateDir(path.dirname(filename))
  await existingRegular(filename)
  const temp = filename + '.' + randomUUID() + '.tmp'
  try {
    const handle = await fs.open(temp, 'wx', 0o600)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await fs.rename(temp, filename)
    await fs.chmod(filename, 0o600)
  } finally { await fs.rm(temp, { force: true }).catch(() => undefined) }
}

// Strict proxy URL validation, shared by every write path. Rejections always
// use the same generic message so no URL, userinfo or raw parser text leaks.
export function validateProxyUrl(raw) {
  const invalid = () => httpError(400, 'invalid proxy url')
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PROXY_URL_MAX) throw invalid()
  if (/[\u0000-\u0020\u007f]/.test(raw)) throw invalid()
  let parsed
  try { parsed = new URL(raw) } catch { throw invalid() }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalid()
  if (!parsed.hostname) throw invalid()
  if (parsed.port !== '') {
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid()
  }
  // Only the authority may carry data: no path (except the implicit '/'),
  // no query, no fragment.
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') throw invalid()
  return parsed.href
}

// Display form: scheme + host + port, with userinfo/path/query/fragment removed.
export function redactProxyUrl(raw) {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.protocol + '//' + parsed.host
  } catch { return null }
}

function safeProxyUrl(raw) {
  try { return validateProxyUrl(raw) } catch { return null }
}

function envFileValue(raw, name) {
  let value = null
  for (const line of raw.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match || match[1] !== name) continue
    let candidate = match[2].trim()
    if (candidate.length > 1 &&
      ((candidate.startsWith('"') && candidate.endsWith('"')) ||
       (candidate.startsWith("'") && candidate.endsWith("'")))) candidate = candidate.slice(1, -1)
    value = candidate
  }
  return value ? value : null
}

async function readEnvProxyUrl(envFile, envName) {
  if (!(await existingRegular(envFile))) return null
  return envFileValue(await fs.readFile(envFile, 'utf8'), envName)
}

// The stored proxy URL is sensitive: regular file only (no symlinks), small,
// versioned JSON with exactly one URL field, and the URL itself revalidated.
//
// Symlinks / non-regular files still fail closed with 409 (a security refusal).
// A merely unreadable *content* (corrupt JSON, wrong version, invalid URL) is
// reported as `{ url: null, error: true }` instead of failing the whole admin
// panel: the proxy file is auxiliary, and a broken one must stay fixable from
// the UI (save a new URL or clear it) rather than requiring a Linux shell.
async function readStoredProxyUrl(filename) {
  if (!(await existingRegular(filename))) return { url: null, error: false }
  try {
    const st = await fs.stat(filename)
    if (st.size > 8192) return { url: null, error: true }
    const raw = await fs.readFile(filename, 'utf8')
    let doc
    try { doc = JSON.parse(raw) } catch { return { url: null, error: true } }
    if (!object(doc) || doc.version !== 1) return { url: null, error: true }
    for (const key of Object.keys(doc)) {
      if (key !== 'version' && key !== 'url') return { url: null, error: true }
    }
    const url = safeProxyUrl(doc.url)
    if (!url) return { url: null, error: true }
    return { url, error: false }
  } catch {
    // Unreadable/racing file: degrade to "no managed URL" instead of failing.
    return { url: null, error: true }
  }
}

async function writeStoredProxyUrl(filename, url) {
  await atomicPrivateWrite(filename, JSON.stringify({ version: 1, url }, null, 2) + '\n')
}

async function deleteStoredProxyUrl(filename) {
  if (!(await existingRegular(filename))) return false
  await fs.rm(filename)
  return true
}

async function networkProxyStatus(envFile, proxyFile, config) {
  const cfg = config.networkProxy ?? {}
  const envName = typeof cfg.urlEnv === 'string' ? cfg.urlEnv : DEFAULT_PROXY_ENV
  const storedResult = await readStoredProxyUrl(proxyFile)
  const stored = storedResult.url
  const envValue = await readEnvProxyUrl(envFile, envName)
  const envUrl = envValue === null ? null : safeProxyUrl(envValue)
  // source reports which stored configuration is available (managed wins over
  // env); `enabled` separately reports whether the start script activates it.
  const selected = stored ?? envUrl
  return { enabled: cfg.enabled === true, fallbackDirect: cfg.fallbackDirect !== false,
    source: stored ? 'managed' : envUrl ? 'env' : 'none',
    configured: Boolean(selected), display: selected ? redactProxyUrl(selected) : null,
    envName, envConfigured: envValue !== null,
    // True when network-proxy.json exists but is unreadable/invalid. The UI can
    // still recover by saving a new URL or clearing it; never expose content.
    ...(storedResult.error ? { storedError: true } : {}) }
}

function proxyTestTarget(config) {
  const bots = config.bots ?? [{ id: 'default', domain: 'feishu', enabled: true }]
  const active = bots.find(bot => bot.enabled !== false) ?? bots[0]
  return PROXY_TEST_TARGETS[active?.domain === 'lark' ? 'lark' : 'feishu']
}

function probeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'ETIMEDOUT' || code === 'ERR_TLS_HANDSHAKE_TIMEOUT') return 'ETIMEDOUT'
  if (PROBE_ERROR_CODES.has(code)) return code
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'TLS_ERROR'
  return 'CONNECT_FAILED'
}

// CONNECT probe through the proxy. Only stable error codes are reported: the
// proxy URL, its userinfo and the underlying error message never leave here.
function probeProxy(proxyUrl, target, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now()
    let settled = false
    let request
    let socket
    const finish = outcome => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket) socket.destroy()
      if (request) request.destroy()
      resolve({ reachable: outcome.reachable, latencyMs: Math.max(0, Date.now() - started), target,
        ...(outcome.error ? { error: outcome.error } : {}) })
    }
    const timer = setTimeout(() => finish({ reachable: false, error: 'ETIMEDOUT' }), timeoutMs)
    try {
      const parsed = new URL(proxyUrl)
      const secure = parsed.protocol === 'https:'
      const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80
      const headers = { host: target, connection: 'keep-alive', 'proxy-connection': 'keep-alive' }
      if (parsed.username || parsed.password) {
        const user = decodeURIComponent(parsed.username)
        const pass = decodeURIComponent(parsed.password)
        headers['proxy-authorization'] = 'Basic ' + Buffer.from(user + ':' + pass, 'utf8').toString('base64')
      }
      const transport = secure ? https : http
      request = transport.request({ host: parsed.hostname.replace(/^\[|\]$/g, ''), port,
        method: 'CONNECT', path: target, headers, agent: false, timeout: timeoutMs })
      request.on('socket', value => { socket = value })
      const httpFailure = status => ({ reachable: false,
        error: Number.isInteger(status) ? 'HTTP_' + status : 'CONNECT_FAILED' })
      request.on('connect', (response, socket) => {
        socket?.destroy()
        const status = Number(response?.statusCode)
        if (status >= 200 && status < 300) return finish({ reachable: true })
        finish(httpFailure(status))
      })
      request.on('response', response => {
        response.resume()
        finish(httpFailure(Number(response?.statusCode)))
      })
      request.on('timeout', () => finish({ reachable: false, error: 'ETIMEDOUT' }))
      request.on('error', error => finish({ reachable: false, error: probeErrorCode(error) }))
      request.end()
    } catch { finish({ reachable: false, error: 'INVALID_PROXY' }) }
  })
}

// networkProxy.url is a write-only side channel: it is split off before
// validateConfig so admin-config.json can never contain it.
function splitProxyUrl(config) {
  if (!object(config) || !object(config.networkProxy) ||
    !Object.prototype.hasOwnProperty.call(config.networkProxy, 'url')) {
    return { config, provided: false, url: undefined }
  }
  const { url, ...rest } = config.networkProxy
  return { config: { ...config, networkProxy: rest }, provided: true, url }
}
function json(res, status, data) {
  const payload = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}
async function readBody(req) {
  const chunks = []; let size = 0
  for await (const part of req) {
    const buf = Buffer.from(part); size += buf.length
    if (size > 32 * 1024) throw httpError(413, 'request body too large')
    chunks.push(buf)
  }
  let result
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw httpError(400, 'invalid JSON') }
  if (!object(result)) throw httpError(400, 'request body must be an object')
  return result
}
function security(req, reject) {
  const rejection = reject(req)
  if (rejection !== undefined) throw httpError(rejection, 'DSH browser authorization required')
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw httpError(403, 'cross-site request denied')
  const origin = req.headers.origin
  if (origin) {
    let expected
    try { expected = new URL(origin).host.toLowerCase() } catch { throw httpError(403, 'invalid origin') }
    if (!req.headers.host || expected !== req.headers.host.toLowerCase()) throw httpError(403, 'origin mismatch')
  }
  if (req.method !== 'GET') {
    if (req.headers['x-dsh-feishu-admin'] !== '1') throw httpError(403, 'missing management request header')
    if (!req.headers['content-type']?.startsWith('application/json')) throw httpError(415, 'JSON required')
  }
}
// DSH HTTP admission returns a trusted Peer, unlike request headers/body.
// Browser connections currently all share the Host owner's principal. Until
// DSH exposes independently authenticated roles, unknown principals have no
// schedule permissions; never infer a role from an email, header, or UI.
const SCHEDULE_PERMISSION_BY_ACTION = Object.freeze({
  create: 'create', update: 'edit', pause: 'edit', resume: 'edit',
  run: 'run', delete: 'delete', 'delete-inactive': 'delete', refresh: 'view',
})
function authorizeSchedule(req, admit, permission) {
  if (typeof admit !== 'function') throw httpError(503, 'schedule authorization unavailable')
  let admission
  try { admission = admit(req) } catch { throw httpError(503, 'schedule authorization unavailable') }
  if (admission?.rejection === 401 || admission?.rejection === 403)
    throw httpError(admission.rejection, 'DSH browser authorization required')
  const kind = admission?.peer?.principal?.kind
  if (kind !== 'owner') throw httpError(403, 'schedule permission denied')
  if (!['view', 'create', 'edit', 'run', 'delete'].includes(permission))
    throw httpError(403, 'schedule permission denied')
}

async function loopback(port, route) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw httpError(500, 'invalid health port')
  return await new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port, path: route, timeout: 1500,
      headers: { accept: 'application/json' } }, response => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { raw += chunk; if (raw.length > 100000) request.destroy() })
      response.on('end', () => {
        try { resolve(response.statusCode === 200 ? JSON.parse(raw) : { ok: false, error: 'HTTP ' + response.statusCode }) }
        catch { resolve({ ok: false, error: 'invalid health response' }) }
      })
    })
    request.on('error', () => resolve({ ok: false, error: 'channel not reachable' }))
    request.on('timeout', () => request.destroy())
  })
}
async function unitState(unit) {
  try {
    const { stdout } = await execFile('systemctl', ['--user', 'is-active', unit], { timeout: 2000 })
    return stdout.trim()
  } catch { return 'unavailable' }
}
async function credentialStatus(filename, bots) {
  if (!(await existingRegular(filename))) return bots.map(bot => ({ id: bot.id, configured: false }))
  const raw = await fs.readFile(filename, 'utf8')
  return bots.map(bot => {
    const keys = envNames(bot.id)
    // Only existence/length of assignments; values are NEVER included in JSON.
    const present = key => raw.split(/\r?\n/).some(line => line.startsWith(key + '=') && line.length > key.length + 1)
    return { id: bot.id, configured: present(keys.appId) && present(keys.appSecret) }
  })
}
// --- Issue #19: cross-profile schedule operator commands ------------------
// The Gateway always revalidates the mailbox payload; Web Admin is not a trust
// boundary. `actor` is a bounded, server-derived label: it is NEVER accepted
// from the request body. Schedule commands may be up to 8192 bytes; the legacy
// command types keep their original 1024-byte cap.
const SCHEDULE_FIELDS = ['action', 'clientRef', 'taskId', 'title', 'prompt', 'spec', 'notify', 'delivery', 'expectedUpdatedAt']
const SCHEDULE_COMMAND_MAX_BYTES = 8192
const LEGACY_COMMAND_MAX_BYTES = 1024
const APPROVAL_REVOKE_MAX_BYTES = 1024
const APPROVAL_REF_RE = /^[a-f0-9]{16}$/
const SESSION_BATCH_MAX_BYTES = 4096
const SESSION_REF = /^[a-f0-9]{16}$/
const SESSION_BOT_ID = /^[a-z][a-z0-9_-]{0,31}$/
const SCHEDULE_BOT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const SCHEDULE_OU_RE = /^ou_[A-Za-z0-9_-]{2,128}$/
const SCHEDULE_OC_RE = /^oc_[A-Za-z0-9_-]{2,128}$/
const SCHEDULE_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/

function boundedScheduleText(value, key, max) {
  if (typeof value !== 'string' || value.length > max || value.length === 0 ||
    value.trim().length < 1 || value.includes('\0')) throw httpError(400, 'invalid ' + key)
  return value
}
/** Pure validation of the `schedule` sub-object shared by the command mailbox. */
export function validateScheduleCommand(input) {
  if (!object(input)) throw httpError(400, 'schedule must be an object')
  exactKeys(input, SCHEDULE_FIELDS)
  if (!SCHEDULE_ACTIONS.includes(input.action)) throw httpError(400, 'invalid schedule action')
  const result = { action: input.action }
  if (input.clientRef !== undefined) {
    if (typeof input.clientRef !== 'string' || !SCHEDULE_UUID_RE.test(input.clientRef))
      throw httpError(400, 'invalid clientRef')
    result.clientRef = input.clientRef
  }
  // create reserves one Gateway-owned native Session id before the task exists.
  if (input.action === 'create' && input.clientRef === undefined)
    throw httpError(400, 'clientRef is required for create')
  if (['update', 'pause', 'resume', 'run', 'delete'].includes(input.action) && input.taskId === undefined)
    throw httpError(400, 'taskId is required for this action')
  if (input.taskId !== undefined) {
    if (typeof input.taskId !== 'string' || !SCHEDULE_TASK_ID_RE.test(input.taskId))
      throw httpError(400, 'invalid taskId')
    result.taskId = input.taskId
  }
  if (input.title !== undefined) result.title = boundedScheduleText(input.title, 'title', TITLE_MAX)
  if (input.prompt !== undefined) result.prompt = boundedScheduleText(input.prompt, 'prompt', PROMPT_MAX)
  if (input.spec !== undefined) {
    const check = validateSpec(input.spec)
    if (!check.ok) throw httpError(400, 'invalid schedule spec: ' + check.error)
    result.spec = check.spec
  }
  if (input.notify !== undefined) {
    if (!SCHEDULE_NOTIFY.includes(input.notify)) throw httpError(400, 'invalid notify')
    result.notify = input.notify
  }
  if (input.delivery !== undefined) {
    if (input.delivery === null) result.delivery = null
    else {
      const d = input.delivery
      if (!object(d)) throw httpError(400, 'invalid delivery')
      exactKeys(d, ['botId', 'chatId', 'chatType', 'senderId'])
      if (typeof d.botId !== 'string' || !SCHEDULE_BOT_ID_RE.test(d.botId))
        throw httpError(400, 'invalid delivery botId')
      if (typeof d.chatId !== 'string' || !(SCHEDULE_OC_RE.test(d.chatId) || SCHEDULE_OU_RE.test(d.chatId)))
        throw httpError(400, 'invalid delivery chatId')
      if (d.chatType !== 'p2p' && d.chatType !== 'group') throw httpError(400, 'invalid delivery chatType')
      const delivery = { botId: d.botId, chatId: d.chatId, chatType: d.chatType }
      if (d.senderId !== undefined) {
        if (typeof d.senderId !== 'string' || !SCHEDULE_OU_RE.test(d.senderId))
          throw httpError(400, 'invalid delivery senderId')
        delivery.senderId = d.senderId
      }
      result.delivery = delivery
    }
  }
  if (input.expectedUpdatedAt !== undefined) {
    if (input.expectedUpdatedAt === null) result.expectedUpdatedAt = null
    else if (typeof input.expectedUpdatedAt === 'string' && input.expectedUpdatedAt.length <= 40 &&
      SCHEDULE_ISO_RE.test(input.expectedUpdatedAt) &&
      Number.isFinite(Date.parse(input.expectedUpdatedAt)))
      result.expectedUpdatedAt = input.expectedUpdatedAt
    else throw httpError(400, 'invalid expectedUpdatedAt')
  }
  return result
}

export function validateSessionBatch(value) {
  if (!object(value)) throw httpError(400, 'batch must be an object')
  exactKeys(value, ['action', 'items'])
  if (value.action !== 'archive' && value.action !== 'unlink')
    throw httpError(400, 'invalid batch action')
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 20)
    throw httpError(400, 'batch size must be 1..20')
  const seen = new Set()
  const items = value.items.map(item => {
    if (!object(item)) throw httpError(400, 'invalid batch item')
    exactKeys(item, ['ref', 'chatRef', 'botId', 'expectedLastActiveAt'])
    if (typeof item.ref !== 'string' || !SESSION_REF.test(item.ref) ||
      typeof item.chatRef !== 'string' || !SESSION_REF.test(item.chatRef) ||
      typeof item.botId !== 'string' || !SESSION_BOT_ID.test(item.botId) ||
      !Number.isSafeInteger(item.expectedLastActiveAt) ||
      item.expectedLastActiveAt < 0 || item.expectedLastActiveAt > 1e13)
      throw httpError(400, 'invalid batch item reference or activity version')
    const key = item.botId + ':' + item.chatRef
    if (seen.has(key)) throw httpError(400, 'duplicate batch binding')
    seen.add(key)
    return { ref: item.ref, chatRef: item.chatRef, botId: item.botId,
      expectedLastActiveAt: item.expectedLastActiveAt }
  })
  return { action: value.action, items }
}

/** Browser preflight is advisory. Owner Gateway verifies again before every mutation. */
async function previewSessionBatch(stateDir, batch) {
  const snapshot = await readOpsSnapshot(stateDir)
  if (!snapshot || snapshot.stale || snapshot.stats.pendingApprovals ||
    snapshot.stats.outboxPending || snapshot.stats.inboxPending)
    throw httpError(409, 'pending tasks, approvals or delivery; retry when idle')
  let totalBytes = 0
  for (const item of batch.items) {
    const report = await querySessions(stateDir, parseSessionQuery(
      new URLSearchParams({ session: item.ref, pageSize: '100' })))
    const matches = report.items.filter(row =>
      row.sessionRef === item.ref && row.chatRef === item.chatRef &&
      row.botId === item.botId && row.lastActiveAt === item.expectedLastActiveAt)
    if (!report.runtimeFresh || matches.length !== 1 || matches[0].status === 'active' ||
      (batch.action === 'archive' && matches[0].status === 'archived'))
      throw httpError(409, 'Session is active, stale, missing or changed; refresh')
    totalBytes += matches[0].estimatedBindingBytes
  }
  return { count: batch.items.length, estimatedBindingBytes: totalBytes }
}

export async function queueOperatorCommand(stateDir, body, maxBytes) {
  const isSchedule = object(body) && body.type === 'schedule'
  const isBatch = object(body) && body.type === 'batch-sessions'
  const cap = Number.isInteger(maxBytes) && maxBytes > 0
    ? maxBytes : (isSchedule ? SCHEDULE_COMMAND_MAX_BYTES :
      isBatch ? SESSION_BATCH_MAX_BYTES : LEGACY_COMMAND_MAX_BYTES)
  let command
  if (isSchedule) {
    exactKeys(body, ['type', 'schedule'])
    command = { version: 1, id: randomUUID(), ts: Date.now(), type: 'schedule',
      actor: SCHEDULE_ACTOR, schedule: validateScheduleCommand(body.schedule) }
  } else if (isBatch) {
    exactKeys(body, ['type', 'batch'])
    command = { version: 1, id: randomUUID(), ts: Date.now(), type: 'batch-sessions',
      batch: validateSessionBatch(body.batch) }
  } else {
  exactKeys(body, ['type', 'ref', 'expectedLastActiveAt'])
  const sessionAction = body.type === 'archive-session' || body.type === 'unbind-session'
  if (body.type !== 'cancel-task' && body.type !== 'retry-outbox' && !sessionAction)
    throw httpError(400, 'unsupported operator action')
  if ((sessionAction || body.type === 'cancel-task') &&
    (typeof body.ref !== 'string' || !/^[a-f0-9]{16}$/.test(body.ref)))
    throw httpError(400, 'invalid correlation reference')
  if (body.type === 'retry-outbox' && body.ref !== undefined)
    throw httpError(400, 'retry-outbox takes no task reference')
  if (sessionAction && (!Number.isSafeInteger(body.expectedLastActiveAt) ||
    body.expectedLastActiveAt < 0 || body.expectedLastActiveAt > 1e13))
    throw httpError(400, 'invalid Session activity version')
  if (!sessionAction && body.expectedLastActiveAt !== undefined)
    throw httpError(400, 'activity version is only allowed for Session commands')
    command = { version: 1, id: randomUUID(), ts: Date.now(), type: body.type,
      ...(body.ref ? { ref: body.ref } : {}),
      ...(sessionAction ? { expectedLastActiveAt: body.expectedLastActiveAt } : {}) }
  }
  // Verified directory chain: refuse to write through a symlinked parent.
  await ensurePrivateDir(stateDir)
  const root = path.join(stateDir, 'ops-control')
  await ensurePrivateDir(root)
  const dir = path.join(root, 'requests')
  await ensurePrivateDir(dir)
  const raw = JSON.stringify(command) + '\n'
  if (Buffer.byteLength(raw, 'utf8') > cap) throw httpError(413, 'operator command too large')
  await atomicPrivateWrite(path.join(dir, command.id + '.json'), raw)
  return { id: command.id, type: command.type }
}

// Permanent tool authorizations are owned by the Gateway. Web Admin only asks
// it to revoke one rule through the existing operator mailbox; the Gateway
// revalidates the request and owns approvals.json. A narrow writer keeps this
// payload fixed ({version,id,ts,type,ref}), 0600, atomic and <= 1024 bytes.
async function queueApprovalRevoke(stateDir, ref) {
  if (typeof ref !== 'string' || !APPROVAL_REF_RE.test(ref))
    throw httpError(400, 'invalid approval reference')
  const command = { version: 1, id: randomUUID(), ts: Date.now(),
    type: 'approval-revoke', ref }
  await ensurePrivateDir(stateDir)
  const root = path.join(stateDir, 'ops-control')
  await ensurePrivateDir(root)
  const dir = path.join(root, 'requests')
  await ensurePrivateDir(dir)
  const raw = JSON.stringify(command) + '\n'
  if (Buffer.byteLength(raw, 'utf8') > APPROVAL_REVOKE_MAX_BYTES)
    throw httpError(413, 'approval revoke command too large')
  await atomicPrivateWrite(path.join(dir, command.id + '.json'), raw)
  return command
}

async function agentProfileContext(stateDir) {
  const snapshot = await readOpsSnapshot(stateDir)
  // The workspace comes only from the actual Gateway runtime. Never let a
  // browser-supplied path or unsaved Web Admin config select filesystem scope.
  if (!snapshot || snapshot.stale || !snapshot.workspace || snapshot.isolatedAgent !== true)
    throw httpError(503, 'running Gateway workspace unavailable; start Gateway and refresh')
  return { stateDir, workspace: snapshot.workspace, sharedProjectWorkspace: snapshot.sharedProjectWorkspace }
}

async function setCredential(filename, body, knownBots) {
  exactKeys(body, ['botId', 'appId', 'appSecret'])
  const id = body.botId
  if (typeof id !== 'string' || !knownBots.includes(id)) throw httpError(400, 'unknown bot id')
  if (body.appId === undefined && body.appSecret === undefined) throw httpError(400, 'provide appId and/or appSecret')
  if (body.appId !== undefined && (typeof body.appId !== 'string' || !/^cli_[A-Za-z0-9]{16}$/.test(body.appId))) {
    throw httpError(400, 'invalid Feishu App ID')
  }
  if (body.appSecret !== undefined &&
    (typeof body.appSecret !== 'string' || !/^[A-Za-z0-9._-]{8,512}$/.test(body.appSecret))) {
    throw httpError(400, 'invalid App Secret')
  }
  let lines = []
  if (await existingRegular(filename)) lines = (await fs.readFile(filename, 'utf8')).split(/\r?\n/)
  if (lines.some(line => line.trim() && !line.trimStart().startsWith('#') &&
      !/^[A-Za-z_][A-Za-z0-9_]*=[^\r\n]*$/.test(line))) {
    throw httpError(409, 'credential file contains nonstandard shell syntax; edit it manually')
  }
  const names = envNames(id)
  const changes = new Map()
  if (body.appId !== undefined) changes.set(names.appId, body.appId)
  if (body.appSecret !== undefined) changes.set(names.appSecret, body.appSecret)
  const out = lines.filter(line => ![...changes.keys()].some(key => line.startsWith(key + '=')))
  for (const [key, value] of changes) out.push(key + '=' + value)
  await atomicPrivateWrite(filename, out.filter(Boolean).join('\n') + '\n')
}

export function createAdminHandler(options = {}) {
  const home = options.home ?? os.homedir()
  const stateDir = options.stateDir ?? path.join(home, '.dsh', 'feishu-channel-state')
  const envFile = options.envFile ?? path.join(home, '.dsh', 'feishu-channel.env')
  const healthPort = options.healthPort ?? 18095
  const unit = options.serviceUnit ?? SERVICE
  if (!/^[A-Za-z0-9@_.-]+\.service$/.test(unit)) throw new Error('invalid service unit')
  // Test-only override; production probes always use the documented 6s budget.
  const proxyTestTimeoutMs = options.proxyTestTimeoutMs ?? PROXY_TEST_TIMEOUT_MS
  if (!Number.isInteger(proxyTestTimeoutMs) || proxyTestTimeoutMs < 100 || proxyTestTimeoutMs > PROXY_TEST_TIMEOUT_MS) {
    throw new Error('invalid proxy test timeout')
  }
  const reject = options.requestRejection
  const admit = options.requestAdmission
  if (typeof reject !== 'function') throw new Error('DSH connection.requestRejection required')
  const managed = path.join(stateDir, 'admin-config.json')
  const proxyFile = path.join(stateDir, PROXY_FILE)
  const profilePath = options.profilePath ?? defaultProfilePath(home)
  const execOverlay = path.join(stateDir, EXEC_OVERLAY_FILE)
  // Short-lived, one-time confirmation tokens live only in authenticated Web.
  const sessionPreviews = new Map()
  const nativePreviews = new Map()
  // Raw native ids may embed Feishu chat identifiers. Organizer previews only
  // need counts and stable references; reveal full ids via the explicit ledger
  // toggle rather than a second unredacted endpoint.
  const nativeRef = id => createHash('sha256').update(id).digest('hex').slice(0, 16)
  const publicPlan = report => !report?.available ? report : ({
    ...report,
    attach: report.attach.map(nativeRef),
    archive: report.archive.map(row => ({ sessionRef: nativeRef(row.id), reason: row.reason })),
    legacy: report.legacy.map(nativeRef),
    skipped: report.skipped.map(row => ({ sessionRef: nativeRef(row.id), reason: row.reason })),
  })
  const sessionServices = () => typeof options.sessionServices === 'function' ? options.sessionServices() : (options.sessionServices || {})
  // Save/credential/restart commands are serialized within this Web Host.
  // A stale ETag check must not race another accepted config write.
  let mutationQueue = Promise.resolve()
  const serializeMutation = work => {
    const next = mutationQueue.then(work, work)
    mutationQueue = next.catch(() => undefined)
    return next
  }
  return async (req, res) => {
    try {
      security(req, reject)
      const route = (req.url ?? '').split('?')[0]
      if (req.method === 'GET' && route === PREFIX + '/state') {
        const current = await configFile(managed)
        const bots = current.config.bots ?? [{ id: 'default', domain: 'feishu', enabled: true }]
        const [health, service, credentials, networkProxy, snapshot] = await Promise.all([
          loopback(healthPort, '/health'), unitState(unit), credentialStatus(envFile, bots),
          networkProxyStatus(envFile, proxyFile, current.config),
          // The model directory belongs to the Gateway Host, not this Web
          // Profile: read only the Gateway's whitelisted telemetry snapshot.
          readOpsSnapshot(stateDir).catch(() => null),
        ])
        const startedAt = health?.health?.uptimeMs == null ? 0 : Date.now() - health.health.uptimeMs
        return json(res, 200, { ok: true, apiVersion: VERSION, config: current.config,
          revision: current.revision, source: current.mtimeMs ? 'managed' : 'profile',
          pendingRestart: Boolean(current.mtimeMs && startedAt && current.mtimeMs > startedAt),
          health, service, credentials, bots, networkProxy,
          // Explicit selections for the admin form; null means "unknown", never
          // a fabricated default route.
          modelCatalog: snapshot?.modelCatalog ?? null,
          agentRoute: snapshot?.agentRoute ?? null,
          profileDefaultRoute: snapshot?.profileDefaultRoute ?? null,
          modelDirectoryStale: snapshot ? snapshot.stale === true : null })
      }
      if (req.method === 'GET' && route === PREFIX + '/health') {
        return json(res, 200, { ok: true, health: await loopback(healthPort, '/health') })
      }
      if (req.method === 'GET' && route === PREFIX + '/diagnostics') {
        return json(res, 200, { ok: true, diagnostics: await loopback(healthPort, '/diagnostics') })
      }
      if (req.method === 'GET' && route === PREFIX + '/ops') {
        // Only the explicit, redacted telemetry DTO is readable here.
        // Never return raw Inbox/Outbox/Sessions storage or journalctl output.
        const [snapshot, events] = await Promise.all([
          readOpsSnapshot(stateDir), readOpsEvents(stateDir, { limit: 200 }),
        ])
        const allCommands = await readOpsResults(stateDir)
        // The legacy operations dashboard shares the results directory. Do
        // not leak schedule command outcomes around schedule authorization.
        let canViewSchedule = false
        try { authorizeSchedule(req, admit, 'view'); canViewSchedule = true } catch { /* fail closed */ }
        const commands = canViewSchedule ? allCommands : allCommands.filter(c => c.type !== 'schedule')
        return json(res, 200, { ok: true, snapshot, events, commands,
          summary: summarizeOps(events, snapshot), telemetryAvailable: snapshot !== null })
      }
      if (req.method === 'GET' && route === PREFIX + '/sessions/ledger') {
        const params = new URL(req.url ?? '', 'http://localhost').searchParams
        const allowed = new Set(['status', 'type', 'orphan', 'bot', 'search', 'page', 'pageSize', 'reveal', 'from', 'to'])
        for (const key of params.keys()) {
          if (!allowed.has(key) || params.getAll(key).length !== 1)
            throw httpError(400, 'invalid native Session query')
        }
        const validDay = value => {
          if (!value) return true
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
          const ts = Date.parse(value + 'T00:00:00.000Z')
          return Number.isFinite(ts) && new Date(ts).toISOString().slice(0, 10) === value
        }
        const from = params.get('from') || ''
        const to = params.get('to') || ''
        const bot = params.get('bot') || ''
        const page = Number(params.get('page') || 1)
        const pageSize = Number(params.get('pageSize') || 25)
        if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
          !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
          (params.get('search') || '').length > 128 ||
          (bot !== '' && !/^[a-z][a-z0-9_-]{0,31}$/.test(bot)) ||
          !validDay(from) || !validDay(to) || (from && to && from > to) ||
          !['all', 'current', 'active', 'idle', 'unknown', 'unbound', 'archived', 'trashed'].includes(params.get('status') || 'all') ||
          !['all', 'p2p', 'group', 'schedule'].includes(params.get('type') || 'all') ||
          !['0', '1'].includes(params.get('reveal') || '0') ||
          !['0', '1'].includes(params.get('orphan') || '0')) throw httpError(400, 'invalid native Session query')
        const report = await sessionOrganizationInventory(stateDir, sessionServices(), {
          page, pageSize, status: params.get('status') || 'all',
          type: params.get('type') || 'all', search: params.get('search') || '',
          bot, from, to, orphanOnly: params.get('orphan') === '1',
          reveal: params.get('reveal') === '1',
        })
        return json(res, 200, { ok: true, report })
      }
      if (req.method === 'GET' && route === PREFIX + '/sessions/organizer') {
        const report = await reconcileSessionOrganization(stateDir, sessionServices(), { dryRun: true })
        const settings = await organizationSettings(stateDir)
        // Session ids already appear in authenticated DSH Web. This is a
        // header-only preview, not a filesystem walk or a write operation.
        return json(res, 200, { ok: true, report: publicPlan(report), settings })
      }
      if (req.method === 'PUT' && route === PREFIX + '/sessions/organizer/settings') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          const settings = await saveOrganizationSettings(stateDir, body)
          return json(res, 200, { ok: true, settings })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/organizer/run') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, [])
          const report = await reconcileSessionOrganization(stateDir, sessionServices(), { dryRun: false })
          return json(res, 200, { ok: true, report: publicPlan(report) })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/native/preview') {
        const body = await readBody(req)
        exactKeys(body, ['sessionId'])
        if (typeof body.sessionId !== 'string' || body.sessionId.length > 256)
          throw httpError(400, 'invalid native Session id')
        const report = await sessionOrganizationInventory(stateDir, sessionServices(),
          { status: 'unbound', reveal: true, search: body.sessionId, pageSize: 100 })
        const row = report.items.find(item => item.sessionId === body.sessionId && item.orphan)
        if (!row || row.status !== 'unbound') throw httpError(409, 'native Session is no longer an orphan; refresh')
        const token = randomUUID()
        for (const [key, value] of nativePreviews) {
          if (value.expiresAt <= Date.now()) nativePreviews.delete(key)
        }
        if (nativePreviews.size > 100) nativePreviews.clear()
        nativePreviews.set(token, { action: 'archive', sessionId: row.sessionId, expiresAt: Date.now() + 30_000 })
        return json(res, 200, { ok: true, preview: { token, expiresAt: Date.now() + 30_000,
          sessionRef: row.sessionRef, sessionTitle: row.sessionTitle,
          legacy: row.legacy, nativeHistoryPreserved: true } })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/native/archive') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['token'])
          if (typeof body.token !== 'string' || !/^[0-9a-f-]{36}$/.test(body.token))
            throw httpError(400, 'invalid confirmation token')
          const pending = nativePreviews.get(body.token)
          nativePreviews.delete(body.token)
          if (!pending || pending.action !== 'archive' || pending.expiresAt <= Date.now()) throw httpError(409, 'confirmation expired')
          const result = await archiveNativeSession(stateDir, sessionServices(), pending.sessionId)
          return json(res, 200, { ok: true, result })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/native/restore') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['sessionRef'])
          const result = await restoreNativeSession(stateDir, sessionServices(), body.sessionRef)
          return json(res, 200, { ok: true, result })
        })
      }
      // DSH has no portable persistence.delete(). Recycle bin only tracks
      // reversible native archives; permanent deletion is intentionally absent.
      if (req.method === 'POST' && route === PREFIX + '/sessions/native/delete/preview') {
        const body = await readBody(req)
        exactKeys(body, ['sessionRef'])
        const preview = await previewNativePermanentDelete(stateDir, sessionServices(), body.sessionRef)
        const token = randomUUID()
        const expiresAt = Date.now() + 30_000
        for (const [key, value] of nativePreviews)
          if (value.expiresAt <= Date.now()) nativePreviews.delete(key)
        if (nativePreviews.size >= 100) nativePreviews.clear()
        nativePreviews.set(token, { action: 'hard-delete', sessionRef: preview.sessionRef, expiresAt })
        return json(res, 200, { ok: true, preview: { ...preview, token, expiresAt } })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/native/delete') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['token'])
          if (typeof body.token !== 'string' || !/^[0-9a-f-]{36}$/.test(body.token))
            throw httpError(400, 'invalid confirmation token')
          const pending = nativePreviews.get(body.token)
          nativePreviews.delete(body.token)
          if (!pending || pending.action !== 'hard-delete' || pending.expiresAt <= Date.now())
            throw httpError(409, 'delete confirmation expired')
          const result = await permanentlyDeleteNativeSession(stateDir, sessionServices(), pending.sessionRef)
          return json(res, 200, { ok: true, result })
        })
      }
      if (req.method === 'GET' && route === PREFIX + '/sessions/retention') {
        const report = await previewRetention(stateDir, sessionServices())
        return json(res, 200, { ok: true, report })
      }
      if (req.method === 'PUT' && route === PREFIX + '/sessions/retention/settings') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          const settings = await saveRetentionSettings(stateDir, body)
          return json(res, 200, { ok: true, settings })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/trash/preview') {
        const body = await readBody(req)
        exactKeys(body, ['sessionRef'])
        const report = await previewTrashSession(stateDir, sessionServices(), body.sessionRef)
        const token = randomUUID()
        const expiresAt = Date.now() + 30_000
        for (const [key,value] of nativePreviews) if (value.expiresAt <= Date.now())
          nativePreviews.delete(key)
        if (nativePreviews.size >= 100) nativePreviews.clear()
        nativePreviews.set(token, { action: 'trash', sessionRef: report.sessionRef, expiresAt })
        return json(res, 200, { ok: true, preview: { ...report, token, expiresAt } })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/trash/move') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['token'])
          if (typeof body.token !== 'string' || !/^[0-9a-f-]{36}$/.test(body.token))
            throw httpError(400, 'invalid confirmation token')
          const pending = nativePreviews.get(body.token)
          nativePreviews.delete(body.token)
          if (!pending || pending.action !== 'trash' || pending.expiresAt <= Date.now())
            throw httpError(409, 'confirmation expired')
          const result = await moveNativeSessionToTrash(stateDir, sessionServices(), pending.sessionRef)
          return json(res, 200, { ok: true, result })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/trash/restore') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['sessionRef'])
          const result = await restoreNativeSessionFromTrash(stateDir, sessionServices(), body.sessionRef)
          return json(res, 200, { ok: true, result })
        })
      }
      if (req.method === 'GET' && route === PREFIX + '/sessions') {
        const params = new URL(req.url ?? '', 'http://localhost').searchParams
        const report = await querySessions(stateDir, parseSessionQuery(params))
        return json(res, 200, { ok: true, report })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/batch/preview') {
        const body = await readBody(req)
        const batch = validateSessionBatch(body)
        const summary = await previewSessionBatch(stateDir, batch)
        const token = randomUUID()
        const expiresAt = Date.now() + 30_000
        for (const [k, v] of sessionPreviews) {
          if (v.expiresAt <= Date.now()) sessionPreviews.delete(k)
        }
        if (sessionPreviews.size >= 100) sessionPreviews.clear()
        sessionPreviews.set(token, { type: 'batch-sessions', batch, expiresAt })
        return json(res, 200, { ok: true, preview: {
          token, expiresAt, action: batch.action, ...summary, nativeSessionPreserved: true,
        } })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/preview') {
        const body = await readBody(req)
        exactKeys(body, ['type', 'ref', 'expectedLastActiveAt'])
        if (body.type !== 'archive-session' && body.type !== 'unbind-session')
          throw httpError(400, 'invalid Session action')
        if (typeof body.ref !== 'string' || !/^[a-f0-9]{16}$/.test(body.ref) ||
          !Number.isSafeInteger(body.expectedLastActiveAt))
          throw httpError(400, 'invalid Session reference')
        const query = parseSessionQuery(new URLSearchParams({ session: body.ref }))
        const report = await querySessions(stateDir, query)
        const matches = report.items.filter(item => item.sessionRef === body.ref &&
          item.lastActiveAt === body.expectedLastActiveAt)
        if (!report.runtimeFresh || matches.length !== 1 || matches[0].status === 'active')
          throw httpError(409, 'Session is active, stale, missing or changed; refresh')
        const snapshot = await readOpsSnapshot(stateDir)
        if (!snapshot || snapshot.stale || snapshot.stats.pendingApprovals ||
          snapshot.stats.outboxPending || snapshot.stats.inboxPending)
          throw httpError(409, 'pending tasks, approvals or delivery; retry when idle')
        const selected = matches[0]
        const token = randomUUID()
        const expiresAt = Date.now() + 30_000
        for (const [k, v] of sessionPreviews) {
          if (v.expiresAt <= Date.now()) sessionPreviews.delete(k)
        }
        if (sessionPreviews.size >= 100) sessionPreviews.clear()
        sessionPreviews.set(token, { type: body.type, ref: body.ref,
          expectedLastActiveAt: body.expectedLastActiveAt, expiresAt })
        return json(res, 200, { ok: true, preview: {
          token, expiresAt, action: body.type, sessionRef: selected.sessionRef,
          chatRef: selected.chatRef, botId: selected.botId, status: selected.status,
          estimatedBindingBytes: selected.estimatedBindingBytes,
          nativeSessionPreserved: true,
        } })
      }
      if (req.method === 'POST' && route === PREFIX + '/sessions/commands') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['token'])
          if (typeof body.token !== 'string' || !/^[a-f0-9-]{36}$/.test(body.token))
            throw httpError(400, 'invalid Session confirmation token')
          const request = sessionPreviews.get(body.token)
          sessionPreviews.delete(body.token)
          if (!request || request.expiresAt <= Date.now())
            throw httpError(409, 'Session confirmation expired; preview again')
          // Recheck the activity version before enqueue; owner Gateway checks
          // once more under its per-chat queue and exclusive stateDir lock.
          if (request.type === 'batch-sessions') {
            await previewSessionBatch(stateDir, request.batch)
            const command = await queueOperatorCommand(stateDir,
              { type: 'batch-sessions', batch: request.batch })
            return json(res, 202, { ok: true, queued: true, command })
          }
          const report = await querySessions(stateDir,
            parseSessionQuery(new URLSearchParams({ session: request.ref })))
          if (!report.runtimeFresh ||
            !report.items.some(x => x.sessionRef === request.ref &&
              x.lastActiveAt === request.expectedLastActiveAt && x.status !== 'active'))
            throw httpError(409, 'Session changed; preview again')
          const command = await queueOperatorCommand(stateDir, { type: request.type,
            ref: request.ref, expectedLastActiveAt: request.expectedLastActiveAt })
          return json(res, 202, { ok: true, queued: true, command })
        })
      }
      if (req.method === 'GET' && route === PREFIX + '/ops/events') {
        const params = new URL(req.url ?? '', 'http://localhost').searchParams
        const limit = params.has('limit') ? Number(params.get('limit')) : 100
        const kind = params.get('kind') || undefined
        return json(res, 200, { ok: true, events: await readOpsEvents(stateDir, { kind, limit }) })
      }
      if (req.method === 'GET' && (route === PREFIX + '/ops/usage' ||
          route === PREFIX + '/ops/usage/export')) {
        const params = new URL(req.url ?? '', 'http://localhost').searchParams
        const report = await queryUsage(stateDir, parseUsageQuery(params))
        // Catalog is Gateway's live Host, not the Web Profile. A missing or
        // stale snapshot means unknown availability, never zero usage.
        const snapshot = await readOpsSnapshot(stateDir).catch(() => null)
        report.modelCatalog = snapshot?.modelCatalog ?? null
        if (route.endsWith('/export')) {
          const csv = usageCsv(report)
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="feishu-token-usage.csv"',
            'content-length': Buffer.byteLength(csv),
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
          })
          res.end(csv)
          return
        }
        return json(res, 200, { ok: true, report })
      }
      if (req.method === 'GET' && route === PREFIX + '/agent-profile') {
        return json(res, 200, { ok: true, profile: await listAgentFiles(await agentProfileContext(stateDir)) })
      }
      if (req.method === 'GET' && route === PREFIX + '/agent-profile/file') {
        const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name')
        return json(res, 200, { ok: true, file: await readAgentFile(await agentProfileContext(stateDir), name) })
      }
      if (req.method === 'GET' && route === PREFIX + '/agent-profile/history') {
        const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name')
        return json(res, 200, { ok: true, history: await listAgentHistory(await agentProfileContext(stateDir), name) })
      }
      if (req.method === 'PUT' && route === PREFIX + '/agent-profile/file') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['name', 'content', 'expectedRevision'])
          const result = await saveAgentFile(await agentProfileContext(stateDir), body)
          return json(res, 200, { ok: true, result })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/agent-profile/restore') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['name', 'id', 'expectedRevision'])
          const result = await restoreAgentFile(await agentProfileContext(stateDir), body)
          return json(res, 200, { ok: true, result })
        })
      }
      if (req.method === 'PUT' && route === PREFIX + '/agent-profile/settings') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['settings', 'expectedRevision'])
          const result = await saveAgentSettings(await agentProfileContext(stateDir), body)
          return json(res, 200, { ok: true, result })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/agent-profile/detach-legacy') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['expectedRevision'])
          const result = await detachLegacyOverlay(await agentProfileContext(stateDir), body)
          return json(res, 200, { ok: true, result })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/agent-profile/sync') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, [])
          const result = await applyAgentProfile(await agentProfileContext(stateDir))
          return json(res, 200, { ok: true, result })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/ops/commands') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          if (body.type === 'schedule') {
            const parsed = validateScheduleCommand(body.schedule)
            authorizeSchedule(req, admit, SCHEDULE_PERMISSION_BY_ACTION[parsed.action])
          }
          const command = await queueOperatorCommand(stateDir, body)
          return json(res, 202, { ok: true, command, queued: true })
        })
      }
      // --- Permanent tool authorizations: read model + revoke mailbox ---
      // There is exactly one authority for approvals: the Gateway. GET only
      // exposes its sanitized read model; POST only enqueues a bounded revoke
      // request (never a local decision, never an execution in Web Admin).
      if (req.method === 'GET' && route === PREFIX + '/approvals') {
        return json(res, 200, { ok: true, model: await readApprovalsModel(stateDir) })
      }
      if (req.method === 'POST' && route === PREFIX + '/approvals/revoke') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['ref'])
          if (typeof body.ref !== 'string' || !APPROVAL_REF_RE.test(body.ref))
            throw httpError(400, 'invalid approval reference')
          const command = await queueApprovalRevoke(stateDir, body.ref)
          return json(res, 202, { ok: true, id: command.id })
        })
      }
      // Schedule reads and previews require a trusted owner Peer.
      if ((route === PREFIX + '/schedule' || route === PREFIX + '/schedule/results' ||
           route === PREFIX + '/schedule/preview') && (req.method === 'GET' || req.method === 'POST'))
        authorizeSchedule(req, admit, 'view')
      // --- Issue #19: scheduled tasks (all behind security(req, reject)) ---
      if (req.method === 'GET' && route === PREFIX + '/schedule') {
        // Only the sanitized, redacted read model is readable here.
        return json(res, 200, { ok: true, model: await readScheduleModel(stateDir) })
      }
      if (req.method === 'POST' && route === PREFIX + '/schedule/preview') {
        // Pure computation: no filesystem writes and no command enqueue.
        const body = await readBody(req)
        exactKeys(body, ['spec', 'count'])
        const count = integer(body.count, 'count', 1, PREVIEW_MAX)
        const now = Date.now()
        const check = validateSpec(body.spec, now)
        if (!check.ok) throw httpError(400, 'invalid schedule spec: ' + check.error)
        const occurrences = previewOccurrences(check.spec, count, now)
        return json(res, 200, { ok: true, occurrences, summary: specSummary(check.spec) })
      }
      if (req.method === 'POST' && route === PREFIX + '/schedule/commands') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['type', 'schedule'])
          if (body.type !== 'schedule') throw httpError(400, 'unsupported schedule command')
          // validateScheduleCommand is the pure helper shared with the mailbox
          // writer; the writer validates once more under serializeMutation.
          const parsed = validateScheduleCommand(body.schedule)
          authorizeSchedule(req, admit, SCHEDULE_PERMISSION_BY_ACTION[parsed.action])
          const command = await queueOperatorCommand(stateDir, body, SCHEDULE_COMMAND_MAX_BYTES)
          return json(res, 202, { ok: true, command, queued: true })
        })
      }
      if (req.method === 'GET' && route === PREFIX + '/schedule/results') {
        return json(res, 200, { ok: true, commands: await readScheduleResults(stateDir) })
      }
      if (req.method === 'PUT' && route === PREFIX + '/config') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['expectedRevision', 'config', 'confirmOpenGroups'])
          const before = await configFile(managed)
          if (body.expectedRevision !== before.revision) throw httpError(409, 'config changed; reload before saving')
          // The proxy URL is never part of admin-config.json: validate it on
          // its own, then strip it before the strict config validation.
          const split = splitProxyUrl(body.config)
          const config = validateConfig(split.config)
          if (config.groupPolicy === 'open' && before.config.groupPolicy !== 'open' &&
            body.confirmOpenGroups !== true) {
            throw httpError(400, 'opening group access requires explicit confirmation')
          }
          const storedUrl = split.provided
            ? (split.url === null ? null : validateProxyUrl(split.url))
            : undefined
          if (storedUrl === null) await deleteStoredProxyUrl(proxyFile)
          else if (storedUrl !== undefined) await writeStoredProxyUrl(proxyFile, storedUrl)
          await atomicPrivateWrite(managed, JSON.stringify({ version: VERSION, config }, null, 2) + '\n')
          const result = await configFile(managed)
          const networkProxy = await networkProxyStatus(envFile, proxyFile, result.config)
          return json(res, 200, { ok: true, revision: result.revision, restartRequired: true, networkProxy })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/network-proxy/test') {
        const body = await readBody(req)
        exactKeys(body, ['url'])
        const current = await configFile(managed)
        let proxyUrl
        if (body.url !== undefined && body.url !== null && body.url !== '') {
          proxyUrl = validateProxyUrl(body.url)
        } else {
          // Fall back to the effective stored configuration: managed → env.
          const envName = current.config.networkProxy?.urlEnv ?? DEFAULT_PROXY_ENV
          const stored = (await readStoredProxyUrl(proxyFile)).url
          const envUrl = safeProxyUrl(await readEnvProxyUrl(envFile, envName) ?? '')
          proxyUrl = stored ?? envUrl
          if (!proxyUrl) throw httpError(400, 'no proxy configured')
        }
        const result = await probeProxy(proxyUrl, proxyTestTarget(current.config), proxyTestTimeoutMs)
        return json(res, 200, { ok: true, result })
      }
      if (req.method === 'POST' && route === PREFIX + '/network-proxy/import-env') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, [])
          const current = await configFile(managed)
          const envName = current.config.networkProxy?.urlEnv ?? DEFAULT_PROXY_ENV
          const value = await readEnvProxyUrl(envFile, envName)
          if (value === null) throw httpError(404, 'proxy url not found in env file')
          const url = validateProxyUrl(value)
          await writeStoredProxyUrl(proxyFile, url)
          const result = await configFile(managed)
          const networkProxy = await networkProxyStatus(envFile, proxyFile, result.config)
          return json(res, 200, { ok: true, networkProxy, restartRequired: true })
        })
      }
      if (req.method === 'PUT' && route === PREFIX + '/credentials') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          const current = await configFile(managed)
          await setCredential(envFile, body, (current.config.bots ?? [{ id: 'default' }]).map(bot => bot.id))
          return json(res, 200, { ok: true, restartRequired: true })
        })
      }
      if (req.method === 'POST' && route === PREFIX + '/restart') {
        return await serializeMutation(async () => {
          await readBody(req)
          try { await execFile('systemctl', ['--user', 'restart', unit], { timeout: 12000 }) }
          catch { throw httpError(503, 'systemd user service unavailable; configure ' + unit + ' and retry') }
          return json(res, 200, { ok: true, requested: true })
        })
      }
      if (req.method === 'GET' && route === PREFIX + '/exec-policy') {
        const current = await readExecPolicy({ stateDir, profilePath })
        const health = await loopback(healthPort, '/health')
        const startedAt = health?.health?.uptimeMs == null ? 0 : Date.now() - health.health.uptimeMs
        let overlayMtimeMs = 0
        try {
          const st = await fs.lstat(execOverlay)
          if (st.isFile() && !st.isSymbolicLink()) overlayMtimeMs = st.mtimeMs
        } catch { /* no overlay yet */ }
        return json(res, 200, { ok: true, policy: current.policy, source: current.source,
          modes: EXEC_MODES, approvalPolicies: APPROVAL_POLICIES,
          restartRequired: Boolean(overlayMtimeMs && startedAt && overlayMtimeMs > startedAt) })
      }
      if (req.method === 'POST' && route === PREFIX + '/exec-policy') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['mode', 'approvalPolicy', 'additionalWritableRoots'])
          const policy = normalizeExecPolicy(body)
          await writeExecPolicy({ stateDir, profilePath }, policy)
          return json(res, 200, { ok: true, policy, restartRequired: true })
        })
      }
      return json(res, 404, { ok: false, error: 'unknown management endpoint' })
    } catch (error) {
      // Never expose request body, App Secret, or underlying command stdout.
      return json(res, error.status ?? 500, { ok: false, error: error.status ? error.message : 'management operation failed' })
    }
  }
}
export function apply(ctx, config = {}) {
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (typeof webServer?.register !== 'function' || typeof connection?.requestRejection !== 'function') {
    throw new Error('DSH webServer and authenticated connection services required')
  }
  ctx.effect(() => {
    const unregister = webServer.register({ kind: 'prefix', path: PREFIX,
      handler: createAdminHandler({ ...config,
        sessionServices: () => ({ registry: ctx.get('workspaceRegistry'),
          persistence: ctx.get('sessionPersistence'), query: ctx.get('sessionQuery'),
          deleter: ctx.get('sessionAdmin') }),
        requestRejection: req => connection.requestRejection(req),
        requestAdmission: typeof connection.admit === 'function' ? req => connection.admit(req) : undefined }) })
    ctx.logger.info('feishu-admin: management API registered on authenticated DSH Web')
    let running = false
    let lastRetentionRun = 0
    const stateDir = config.stateDir || path.join(config.home || os.homedir(),
      '.dsh', 'feishu-channel-state')
    const sessionServices = () => ({ registry: ctx.get('workspaceRegistry'),
      persistence: ctx.get('sessionPersistence'), query: ctx.get('sessionQuery') })
    const interval = setInterval(() => {
      if (running) return
      running = true
      void (async () => {
        const settings = await organizationSettings(stateDir)
        if (settings.enabled) await reconcileSessionOrganization(stateDir, sessionServices(), { dryRun: false })
        // Retention checks once per hour, not on every 15-second UI tick.
        // Never deletes native Session logs, even for expired trash entries.
        if (Date.now() - lastRetentionRun >= 3600000) {
          lastRetentionRun = Date.now()
          await autoArchiveExpiredSessions(stateDir, sessionServices())
        }
      })().catch(() => ctx.logger.warn('Feishu Session maintenance unavailable; history unchanged'))
        .finally(() => { running = false })
    }, 15000)
    interval.unref?.()
    return () => { clearInterval(interval); unregister?.() }
  }, 'feishu-admin.http')
}
export default { name, inject, apply }
