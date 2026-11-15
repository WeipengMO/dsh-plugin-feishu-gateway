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
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { readOpsEvents, readOpsSnapshot, readOpsResults, summarizeOps } from './ops-read.mjs'
import { parseSessionQuery, querySessions } from './session-read.mjs'
import { parseUsageQuery, queryUsage, usageCsv } from './usage-read.mjs'
import { listAgentFiles, readAgentFile, saveAgentFile, listAgentHistory,
  restoreAgentFile, saveAgentSettings, applyAgentProfile, detachLegacyOverlay } from './agent-profile.mjs'

export const name = 'feishu-channel-admin'
export const inject = ['webServer', 'connection']
const execFile = promisify(rawExecFile)
const PREFIX = '/api/feishu-admin'
const VERSION = 1
const SERVICE = 'dsh-feishu-channel.service'
const CFG_KEYS = ['bots', 'allowlist', 'workspace', 'agentWorkspace', 'agent', 'replyTimeoutMs', 'networkProxy',
  'replyFormat', 'sendRetries', 'outboxRetryIntervalMs', 'autoConnect',
  'approvalCards', 'streamCards', 'approvalTimeoutMs', 'streamIntervalMs']

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
    exactKeys(input.agent, ['provider', 'model'])
    const agent = {}
    for (const key of ['provider', 'model']) if (input.agent[key] !== undefined) {
      if (typeof input.agent[key] !== 'string' || !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(input.agent[key])) {
        throw httpError(400, 'invalid model route ' + key)
      }
      agent[key] = input.agent[key]
    }
    result.agent = agent
  }
  if (input.replyTimeoutMs !== undefined) result.replyTimeoutMs = integer(input.replyTimeoutMs, 'replyTimeoutMs', 5000, 1800000)
  if (input.networkProxy !== undefined) {
    const p = input.networkProxy
    if (!object(p)) throw httpError(400, 'networkProxy must be an object')
    exactKeys(p, ['enabled', 'urlEnv', 'fallbackDirect'])
    if (typeof p.enabled !== 'boolean' || typeof p.fallbackDirect !== 'boolean' ||
        typeof p.urlEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.urlEnv))
      throw httpError(400, 'invalid networkProxy')
    result.networkProxy = { enabled: p.enabled, urlEnv: p.urlEnv, fallbackDirect: p.fallbackDirect }
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
    result.approvalTimeoutMs = integer(input.approvalTimeoutMs, 'approvalTimeoutMs', 5000, 300000)
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
async function queueOperatorCommand(stateDir, body) {
  exactKeys(body, ['type', 'ref'])
  if (body.type !== 'cancel-task' && body.type !== 'retry-outbox')
    throw httpError(400, 'unsupported operator action')
  if (body.type === 'cancel-task' && (typeof body.ref !== 'string' || !/^[a-f0-9]{16}$/.test(body.ref)))
    throw httpError(400, 'invalid task correlation reference')
  if (body.type === 'retry-outbox' && body.ref !== undefined)
    throw httpError(400, 'retry-outbox takes no task reference')
  // Verified directory chain: refuse to write through a symlinked parent.
  await ensurePrivateDir(stateDir)
  const root = path.join(stateDir, 'ops-control')
  await ensurePrivateDir(root)
  const dir = path.join(root, 'requests')
  await ensurePrivateDir(dir)
  const command = { version: 1, id: randomUUID(), ts: Date.now(), type: body.type,
    ...(body.ref ? { ref: body.ref } : {}) }
  await atomicPrivateWrite(path.join(dir, command.id + '.json'), JSON.stringify(command) + '\n')
  return { id: command.id, type: command.type }
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
  const reject = options.requestRejection
  if (typeof reject !== 'function') throw new Error('DSH connection.requestRejection required')
  const managed = path.join(stateDir, 'admin-config.json')
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
        const [health, service, credentials] = await Promise.all([
          loopback(healthPort, '/health'), unitState(unit), credentialStatus(envFile, bots),
        ])
        const startedAt = health?.health?.uptimeMs == null ? 0 : Date.now() - health.health.uptimeMs
        return json(res, 200, { ok: true, apiVersion: VERSION, config: current.config,
          revision: current.revision, source: current.mtimeMs ? 'managed' : 'profile',
          pendingRestart: Boolean(current.mtimeMs && startedAt && current.mtimeMs > startedAt),
          health, service, credentials, bots })
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
        const commands = await readOpsResults(stateDir)
        return json(res, 200, { ok: true, snapshot, events, commands,
          summary: summarizeOps(events, snapshot), telemetryAvailable: snapshot !== null })
      }
      if (req.method === 'GET' && route === PREFIX + '/sessions') {
        const params = new URL(req.url ?? '', 'http://localhost').searchParams
        const report = await querySessions(stateDir, parseSessionQuery(params))
        return json(res, 200, { ok: true, report })
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
          const command = await queueOperatorCommand(stateDir, body)
          return json(res, 202, { ok: true, command, queued: true })
        })
      }
      if (req.method === 'PUT' && route === PREFIX + '/config') {
        return await serializeMutation(async () => {
          const body = await readBody(req)
          exactKeys(body, ['expectedRevision', 'config'])
          const before = await configFile(managed)
          if (body.expectedRevision !== before.revision) throw httpError(409, 'config changed; reload before saving')
          const config = validateConfig(body.config)
          await atomicPrivateWrite(managed, JSON.stringify({ version: VERSION, config }, null, 2) + '\n')
          const result = await configFile(managed)
          return json(res, 200, { ok: true, revision: result.revision, restartRequired: true })
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
      handler: createAdminHandler({ ...config, requestRejection: req => connection.requestRejection(req) }) })
    ctx.logger.info('feishu-admin: management API registered on authenticated DSH Web')
    return () => unregister?.()
  }, 'feishu-admin.http')
}
export default { name, inject, apply }
