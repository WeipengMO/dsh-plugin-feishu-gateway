import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createAdminHandler, validateConfig, validateProxyUrl, redactProxyUrl, name, inject } from '../src/server.mjs'

const allowed = { cookie: 'test-session=good' }
const mutating = { ...allowed, 'content-type': 'application/json', 'x-dsh-feishu-admin': '1' }
async function fixture(extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-feishu-admin-'))
  const stateDir = path.join(dir, 'state')
  const envFile = path.join(dir, 'feishu-channel.env')
  const handler = createAdminHandler({
    stateDir, envFile, healthPort: 39191, ...extra,
    requestRejection: req => req.headers.cookie === 'test-session=good' ? undefined : 401
  })
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = 'http://127.0.0.1:' + address.port + '/api/feishu-admin'
  const close = async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
  const request = async (route, method = 'GET', body, headers = allowed) => {
    const response = await fetch(base + route, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, json: await response.json() }
  }
  return { dir, stateDir, envFile, request, close, base }
}

test('official DSH plugin shape uses only web services', () => {
  assert.equal(name, 'feishu-channel-admin')
  assert.deepEqual(inject, ['webServer', 'connection'])
})

test('strict config validation rejects secrets, forged paths, and env name collisions', () => {
  const valid = validateConfig({ allowlist: ['ou_alice'], agent: { provider: 'magpie', model: 'group/deepseek' },
    bots: [{ id: 'default', domain: 'feishu', enabled: true }], replyTimeoutMs: 300000 })
  assert.equal(valid.bots[0].id, 'default')
  assert.throws(() => validateConfig({ appSecret: 'SHOULD_NEVER_APPEAR' }), /unsupported/)
  assert.throws(() => validateConfig({ workspace: 'relative/path' }), /absolute/)
  assert.throws(() => validateConfig({ allowlist: ['bad'] }), /allowlist/)
  assert.throws(() => validateConfig({ bots: [{ id: 'a-b', domain: 'feishu' }, { id: 'a_b', domain: 'feishu' }] }), /colliding/)
  assert.throws(() => validateConfig({ agent: { secret: 'xxx' } }), /unsupported/)
  const proxy = validateConfig({ networkProxy: {
    enabled: true, urlEnv: 'HTTPS_PROXY', fallbackDirect: true,
  } })
  assert.equal(proxy.networkProxy.urlEnv, 'HTTPS_PROXY')
  assert.throws(() => validateConfig({ networkProxy: {
    enabled: true, urlEnv: 'BAD;SHELL', fallbackDirect: true,
  } }), /networkProxy/)
  assert.throws(() => validateConfig({ networkProxy: {
    enabled: true, urlEnv: 'HTTPS_PROXY', url: 'http://secret.invalid', fallbackDirect: true,
  } }), /unsupported/)
})

test('every read and mutation requires authorized DSH browser session', async () => {
  const f = await fixture()
  try {
    const anonymous = await f.request('/state', 'GET', undefined, {})
    assert.equal(anonymous.status, 401)
    const write = await f.request('/config', 'PUT', { config: {} }, {
      'content-type': 'application/json', 'x-dsh-feishu-admin': '1'
    })
    assert.equal(write.status, 401)
    const allowedState = await f.request('/state')
    assert.equal(allowedState.status, 200)
    assert.equal(allowedState.json.source, 'profile')
    assert.equal(allowedState.json.apiVersion, 1)
  } finally { await f.close() }
})

test('CSRF and content-type checks block non-browser and cross-site writes', async () => {
  const f = await fixture()
  try {
    const state = await f.request('/state')
    const body = { expectedRevision: state.json.revision, config: {} }
    const noHeader = await f.request('/config', 'PUT', body, {
      ...allowed, 'content-type': 'application/json'
    })
    assert.equal(noHeader.status, 403)
    const badOrigin = await f.request('/config', 'PUT', body, {
      ...mutating, origin: 'https://evil.example'
    })
    assert.equal(badOrigin.status, 403)
    const crossSite = await f.request('/config', 'PUT', body, {
      ...mutating, 'sec-fetch-site': 'cross-site'
    })
    assert.equal(crossSite.status, 403)
    const badType = await f.request('/config', 'PUT', body, {
      ...allowed, 'x-dsh-feishu-admin': '1', 'content-type': 'text/plain'
    })
    assert.equal(badType.status, 415)
  } finally { await f.close() }
})

test('atomic config write is private; stale save is rejected; inherit works', async () => {
  const f = await fixture()
  try {
    const first = await f.request('/state')
    const body = { expectedRevision: first.json.revision, config: {
      allowlist: ['ou_alpha'], workspace: '/tmp', replyTimeoutMs: 300000
    } }
    const saved = await f.request('/config', 'PUT', body, mutating)
    assert.equal(saved.status, 200)
    assert.equal(saved.json.restartRequired, true)
    const filename = path.join(f.stateDir, 'admin-config.json')
    assert.equal((await stat(filename)).mode & 0o777, 0o600)
    const raw = JSON.parse(await readFile(filename, 'utf8'))
    assert.deepEqual(raw.config.allowlist, ['ou_alpha'])
    const current = await f.request('/state')
    assert.deepEqual(current.json.config.allowlist, ['ou_alpha'])
    assert.notEqual(first.json.revision, current.json.revision)
    const stale = await f.request('/config', 'PUT', body, mutating)
    assert.equal(stale.status, 409)
    const secretAttempt = await f.request('/config', 'PUT', { expectedRevision: current.json.revision,
      config: { appSecret: 'bad' } }, mutating)
    assert.equal(secretAttempt.status, 400)
    assert.equal((await readFile(filename, 'utf8')).includes('appSecret'), false)
  } finally { await f.close() }
})

test('write-only credentials preserve old keys and never return secrets', async () => {
  const f = await fixture()
  const appId = 'cli_0123456789abcdef'
  const secret = 'TESTSECRETabcdefgh123456'
  try {
    const response = await f.request('/credentials', 'PUT', { botId: 'default', appId, appSecret: secret }, mutating)
    assert.equal(response.status, 200)
    assert.equal(JSON.stringify(response.json).includes(secret), false)
    assert.equal((await stat(f.envFile)).mode & 0o777, 0o600)
    const status = await f.request('/state')
    assert.deepEqual(status.json.credentials, [{ id: 'default', configured: true }])
    assert.equal(JSON.stringify(status.json).includes(secret), false)
    const newSecret = 'NEWSUPERSECRET9876543210'
    const changed = await f.request('/credentials', 'PUT', { botId: 'default', appSecret: newSecret }, mutating)
    assert.equal(changed.status, 200)
    const content = await readFile(f.envFile, 'utf8')
    assert.match(content, /FEISHU_GATEWAY_DEFAULT_APP_ID=cli_0123456789abcdef/)
    assert.match(content, /FEISHU_GATEWAY_DEFAULT_APP_SECRET=NEWSUPERSECRET9876543210/)
    assert.ok(!content.includes(secret))
    const injection = await f.request('/credentials', 'PUT', {
      botId: 'default', appSecret: 'bad\nOTHER_VAR=evil'
    }, mutating)
    assert.equal(injection.status, 400)
    assert.equal((await readFile(f.envFile, 'utf8')).includes('evil'), false)
  } finally { await f.close() }
})

test('corrupt managed JSON blocks overwrite rather than silently resetting config', async () => {
  const f = await fixture()
  try {
    await (await import('node:fs/promises')).mkdir(f.stateDir, { recursive: true })
    const file = path.join(f.stateDir, 'admin-config.json')
    await writeFile(file, '{broken', 'utf8')
    const state = await f.request('/state')
    assert.equal(state.status, 409)
    const attempt = await f.request('/config', 'PUT', { expectedRevision: 'anything', config: {} }, mutating)
    assert.equal(attempt.status, 409)
    assert.equal(await readFile(file, 'utf8'), '{broken')
  } finally { await f.close() }
})

test('refuses symlinked state directory when saving managed config', async () => {
  const f = await fixture()
  try {
    await symlink(f.dir, f.stateDir)
    const state = await f.request('/state')
    assert.equal(state.status, 200)
    const response = await f.request('/config', 'PUT', {
      expectedRevision: state.json.revision, config: { replyTimeoutMs: 5000 }
    }, mutating)
    assert.equal(response.status, 409)
  } finally { await f.close() }
})

test('simultaneous edits with the same revision accept only one commit', async () => {
  const f = await fixture()
  try {
    const initial = await f.request('/state')
    const rev = initial.json.revision
    const outcomes = await Promise.all([
      f.request('/config', 'PUT', { expectedRevision: rev, config: { replyTimeoutMs: 5000 } }, mutating),
      f.request('/config', 'PUT', { expectedRevision: rev, config: { replyTimeoutMs: 6000 } }, mutating),
    ])
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409])
    const now = await f.request('/state')
    assert.ok([5000, 6000].includes(now.json.config.replyTimeoutMs))
  } finally { await f.close() }
})

test('Cordis registration exposes only a guarded Web management handler', async () => {
  const { apply } = await import('../src/server.mjs')
  let registered
  let disposed = false
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register(data) { registered = data; return () => { disposed = true } } }
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
    logger: { info: () => undefined },
    effect(install) { this.dispose = install() },
  }
  apply(ctx, {})
  assert.equal(registered?.kind, 'prefix')
  assert.equal(registered?.path, '/api/feishu-admin')
  assert.equal(typeof registered?.handler, 'function')
  ctx.dispose()
  assert.equal(disposed, true)
})

test('admin validates reply format and persists the optional Markdown setting', async () => {
  const f = await fixture()
  try {
    const first = await f.request('/state')
    const invalid = await f.request('/config', 'PUT', {
      expectedRevision: first.json.revision, config: { replyFormat: 'html' }
    }, mutating)
    assert.equal(invalid.status, 400)
    const success = await f.request('/config', 'PUT', {
      expectedRevision: first.json.revision, config: { replyFormat: 'markdown' }
    }, mutating)
    assert.equal(success.status, 200)
    const latest = await f.request('/state')
    assert.equal(latest.json.config.replyFormat, 'markdown')
    assert.equal(latest.json.pendingRestart, false) // no running channel health
  } finally { await f.close() }
})

test('operations API requires DSH login and strips arbitrary private fields', async () => {
  const f = await fixture()
  try {
    const unauth = await f.request('/ops', 'GET', undefined, {})
    assert.equal(unauth.status, 401)
    await mkdir(f.stateDir, { recursive: true, mode: 0o700 })
    const runtime = { version: 1, ts: Date.now(), status: 'ok', secret: 'MUST-NOT-LEAK',
      tasks: [{ ref: '1234567890abcdef', botId: 'default', phase: 'running', elapsedMs: 900, text: 'PRIVATE' }],
      sessions: [{ ref: 'fedcba0987654321', createdAt: 10, lastActiveAt: 20, persisted: true, chatId: 'CHAT' }],
      transport: { default: { state: 'connected', reconnects: 2, failures: 0 } },
      stats: { activeTurns: 1, boundSessions: 1, pendingApprovals: 0, processed: 4, errors: 0,
        inboxPending: 0, outboxPending: 0 } }
    await writeFile(path.join(f.stateDir, 'ops-runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    await writeFile(path.join(f.stateDir, 'ops-events.jsonl'),
      JSON.stringify({ version: 1, kind: 'task', state: 'done', ts: Date.now(),
        ref: '1234567890abcdef', botId: 'default', model: 'deepseek-chat', tokens: 400,
        text: 'chat content', password: 'secret' }) + '\n', { mode: 0o600 })
    const result = await f.request('/ops')
    assert.equal(result.status, 200)
    assert.equal(result.json.telemetryAvailable, true)
    assert.equal(result.json.snapshot.tasks.length, 1)
    assert.equal(result.json.summary.usage[0].tokens, 400)
    assert.equal(result.json.summary.messages[0].state, 'done')
    assert.doesNotMatch(JSON.stringify(result.json), /MUST-NOT-LEAK|PRIVATE|CHAT|chat content|password|secret/)
    const filtered = await f.request('/ops/events?kind=task&limit=5')
    assert.equal(filtered.status, 200)
    assert.equal(filtered.json.events.length, 1)
    const invalid = await f.request('/ops/events?kind=unknown')
    assert.equal(invalid.status, 400)
  } finally { await f.close() }
})

test('operations API refuses symlinked telemetry files', async () => {
  const f = await fixture()
  try {
    await mkdir(f.stateDir, { recursive: true, mode: 0o700 })
    const outside = path.join(f.dir, 'private.txt')
    await writeFile(outside, 'DO-NOT-READ')
    await symlink(outside, path.join(f.stateDir, 'ops-runtime.json'))
    const result = await f.request('/ops')
    assert.equal(result.status, 500)
    assert.doesNotMatch(JSON.stringify(result.json), /DO-NOT-READ|private.txt/)
  } finally { await f.close() }
})

test('operator command writes are authenticated, narrow and do not execute a command in Web', async () => {
  const f = await fixture()
  try {
    const unauth = await f.request('/ops/commands', 'POST', { type: 'retry-outbox' },
      { 'content-type': 'application/json', 'x-dsh-feishu-admin': '1' })
    assert.equal(unauth.status, 401)
    const bad = await f.request('/ops/commands', 'POST', { type: 'shell', command: 'rm -rf /' }, mutating)
    assert.equal(bad.status, 400)
    const malformed = await f.request('/ops/commands', 'POST', { type: 'cancel-task', ref: 'bad' }, mutating)
    assert.equal(malformed.status, 400)
    const accepted = await f.request('/ops/commands', 'POST',
      { type: 'cancel-task', ref: 'abcdef0123456789' }, mutating)
    assert.equal(accepted.status, 202)
    assert.equal(accepted.json.queued, true)
    const id = accepted.json.command.id
    assert.match(id, /^[a-f0-9-]{36}$/)
    const data = JSON.parse(await readFile(path.join(f.stateDir, 'ops-control', 'requests', id + '.json'), 'utf8'))
    assert.deepEqual(Object.keys(data).sort(), ['id', 'ref', 'ts', 'type', 'version'])
    assert.equal(data.type, 'cancel-task')
    assert.equal((await stat(path.join(f.stateDir, 'ops-control', 'requests', id + '.json'))).mode & 0o777, 0o600)
    const result = await f.request('/ops')
    assert.equal(result.status, 200)
    assert.equal(result.json.telemetryAvailable, false)
    assert.deepEqual(result.json.commands, [])
  } finally { await f.close() }
})


test('Agent profile endpoints require DSH auth and use only the running Gateway workspace', async () => {
  const f = await fixture()
  try {
    const denied = await f.request('/agent-profile','GET',undefined,{})
    assert.equal(denied.status,401)
    const unavailable = await f.request('/agent-profile')
    assert.equal(unavailable.status,503)
    const workspace = path.join(f.dir,'workspace')
    await mkdir(f.stateDir,{recursive:true,mode:0o700})
    await mkdir(workspace,{mode:0o700})
    const runtime = {version:1,ts:Date.now(),workspace,status:'ok',isolatedAgent:true,
      tasks:[],sessions:[],transport:{},stats:{}}
    await writeFile(path.join(f.stateDir,'ops-runtime.json'),JSON.stringify(runtime),{mode:0o600})
    const initial = await f.request('/agent-profile')
    assert.equal(initial.status,200)
    assert.equal(initial.json.profile.workspace,workspace)
    assert.equal(initial.json.profile.files.find(x=>x.name==='SOUL.md').revision,'absent')
    const badOrigin = await f.request('/agent-profile/file','PUT',
      {name:'SOUL.md',content:'a',expectedRevision:'absent'},
      {...mutating,origin:'https://evil.example'})
    assert.equal(badOrigin.status,403)
    const invalid = await f.request('/agent-profile/file','PUT',
      {name:'../../.ssh/id_rsa',content:'a',expectedRevision:'absent'},mutating)
    assert.equal(invalid.status,400)
    const saved = await f.request('/agent-profile/file','PUT',
      {name:'SOUL.md',content:'# Persona\nBe concise.',expectedRevision:'absent'},mutating)
    assert.equal(saved.status,200)
    assert.equal(saved.json.result.saved,true)
    const loaded = await f.request('/agent-profile/file?name=SOUL.md')
    assert.equal(loaded.status,200)
    assert.match(loaded.json.file.content,/Be concise/)
    assert.match(await readFile(path.join(workspace,'AGENTS.local.md'),'utf8'),/Be concise/)
    const conflict = await f.request('/agent-profile/file','PUT',
      {name:'SOUL.md',content:'overwrite',expectedRevision:'absent'},mutating)
    assert.equal(conflict.status,409)
    const versions = await f.request('/agent-profile/history?name=SOUL.md')
    assert.equal(versions.status,200)
    assert.ok(versions.json.history.length>0)
    const config = initial.json.profile.settings
    const setting = await f.request('/agent-profile/settings','PUT',{
      expectedRevision:config.revision,
      settings:{enabled:{...config.enabled,'SOUL.md':false},maxBytes:8192,perFileBytes:2048},
    },mutating)
    assert.equal(setting.status,200)
    const after = await f.request('/agent-profile')
    assert.equal(after.json.profile.loaded.length,0)
    const overlay = await readFile(path.join(workspace,'AGENTS.local.md'),'utf8')
    assert.doesNotMatch(overlay,/Be concise/)
    const stale = await f.request('/agent-profile/settings','PUT',{
      expectedRevision:config.revision,
      settings:{enabled:config.enabled,maxBytes:8192,perFileBytes:2048},
    },mutating)
    assert.equal(stale.status,409)
    const synced=await f.request('/agent-profile/sync','POST',{},mutating)
    assert.equal(synced.status,200)
    assert.equal((await f.request('/agent-profile')).json.profile.syncNeeded,false)
  } finally { await f.close() }
})

test('Agent profile API never follows symlinks or accepts stale Gateway workspaces', async () => {
  const f=await fixture()
  try{
    const workspace=path.join(f.dir,'workspace')
    await mkdir(f.stateDir,{recursive:true,mode:0o700})
    await mkdir(workspace,{mode:0o700})
    const snapshot={version:1,ts:Date.now(),workspace,status:'ok',isolatedAgent:true,
      transport:{},tasks:[],sessions:[],stats:{}}
    const filename=path.join(f.stateDir,'ops-runtime.json')
    await writeFile(filename,JSON.stringify(snapshot),{mode:0o600})
    const outside=path.join(f.dir,'secret.txt')
    await writeFile(outside,'SECRET_SHOULD_NOT_LEAK')
    await symlink(outside,path.join(workspace,'SOUL.md'))
    const blocked=await f.request('/agent-profile/file?name=SOUL.md')
    assert.equal(blocked.status,409)
    assert.doesNotMatch(JSON.stringify(blocked.json),/SECRET_SHOULD_NOT_LEAK/)
    snapshot.ts=Date.now()-90000
    await writeFile(filename,JSON.stringify(snapshot),{mode:0o600})
    const expired=await f.request('/agent-profile')
    assert.equal(expired.status,503)
  } finally { await f.close() }
})


test('Agent profile explicitly rejects a legacy nonisolated Gateway snapshot', async () => {
  const f=await fixture()
  try {
    const workspace=path.join(f.dir,'normal-dsh')
    await mkdir(f.stateDir,{recursive:true,mode:0o700})
    await mkdir(workspace)
    const runtime={version:1,ts:Date.now(),workspace,status:'ok',
      tasks:[],sessions:[],transport:{},stats:{}}
    await writeFile(path.join(f.stateDir,'ops-runtime.json'),JSON.stringify(runtime),{mode:0o600})
    assert.equal((await f.request('/agent-profile')).status,503)
    assert.equal((await f.request('/agent-profile/file','PUT',{
      name:'SOUL.md',content:'must not write',expectedRevision:'absent',
    },mutating)).status,503)
    await assert.rejects(readFile(path.join(workspace,'SOUL.md'),'utf8'),e=>e.code==='ENOENT')
  } finally { await f.close() }
})

test('Agent profile removes only tagged legacy shared DSH instructions after explicit backup and confirmation', async () => {
  const f=await fixture()
  try {
    const isolated=path.join(f.dir,'feishu-agent')
    const regular=path.join(f.dir,'normal-dsh')
    await mkdir(f.stateDir,{recursive:true,mode:0o700})
    await mkdir(isolated)
    await mkdir(regular)
    const legacyFile=path.join(regular,'AGENTS.local.md')
    const original='# DSH original instructions\n\n<!-- DSH-FEISHU-AGENT-PROFILE:BEGIN -->\n## Feishu only\nDO_NOT_LOAD_IN_DSH\n<!-- DSH-FEISHU-AGENT-PROFILE:END -->\n\n# Keep this tail\n'
    await writeFile(legacyFile,original)
    const runtime={version:1,ts:Date.now(),workspace:isolated,sharedProjectWorkspace:regular,
      isolatedAgent:true,status:'ok',tasks:[],sessions:[],transport:{},stats:{}}
    await writeFile(path.join(f.stateDir,'ops-runtime.json'),JSON.stringify(runtime),{mode:0o600})
    const initial=await f.request('/agent-profile')
    assert.equal(initial.status,200)
    assert.equal(initial.json.profile.sharedWorkspace,false)
    assert.equal(initial.json.profile.legacy.detected,true)
    const revision=initial.json.profile.legacy.revision
    const noAuth=await f.request('/agent-profile/detach-legacy','POST',{expectedRevision:revision},{
      'content-type':'application/json','x-dsh-feishu-admin':'1',
    })
    assert.equal(noAuth.status,401)
    const conflict=await f.request('/agent-profile/detach-legacy','POST',{expectedRevision:'f'.repeat(64)},mutating)
    assert.equal(conflict.status,409)
    assert.equal(await readFile(legacyFile,'utf8'),original)
    const result=await f.request('/agent-profile/detach-legacy','POST',{expectedRevision:revision},mutating)
    assert.equal(result.status,200)
    assert.equal(result.json.result.detached,true)
    assert.equal(result.json.result.backupCreated,true)
    const modified=await readFile(legacyFile,'utf8')
    assert.equal(modified,'# DSH original instructions\n\n\n\n# Keep this tail\n')
    assert.doesNotMatch(modified,/DO_NOT_LOAD_IN_DSH/)
    const backups=await (await import('node:fs/promises')).readdir(path.join(f.stateDir,'agent-profile-legacy-backups'))
    assert.equal(backups.length,1)
    assert.equal(await readFile(path.join(f.stateDir,'agent-profile-legacy-backups',backups[0]),'utf8'),original)
    const now=await f.request('/agent-profile')
    assert.equal(now.json.profile.legacy.detected,false)
  } finally { await f.close() }
})

test('historical usage and CSV endpoints inherit DSH browser authorization', async () => {
  const f = await fixture()
  try {
    const day = new Date().toISOString().slice(0, 10)
    const dir = path.join(f.stateDir, 'ops-usage')
    await mkdir(dir, { recursive: true })
    const row = { version: 1, ts: Date.now(), ref: 'a'.repeat(16),
      botId: 'default', status: 'done', model: 'deepseek/chat',
      inputTokens: 27, outputTokens: 13 }
    await writeFile(path.join(dir, day + '.jsonl'), JSON.stringify(row) + '\n')
    const query = 'from=' + day + '&to=' + day + '&tz=UTC'
    assert.equal((await f.request('/ops/usage?' + query, 'GET', undefined, {})).status, 401)
    assert.equal((await fetch(f.base + '/ops/usage/export?' + query)).status, 401)
    const report = await f.request('/ops/usage?' + query)
    assert.equal(report.status, 200)
    assert.equal(report.json.report.summary.totalTokens, 40)
    assert.equal(report.json.report.summary.unknownTurns, 0)
    const csv = await fetch(f.base + '/ops/usage/export?' + query, { headers: allowed })
    assert.equal(csv.status, 200)
    assert.match(csv.headers.get('content-type'), /text\/csv/)
    assert.match(await csv.text(), /27,13,0,0,40/)
    assert.equal((await f.request('/ops/usage?from=2020-01-01&to=2026-11-15')).status, 400)
  } finally { await f.close() }
})

// --- Network proxy management (write-only URL, CONNECT probe, env import) ---

async function fakeProxy(handler) {
  const seen = []
  const tunnels = new Set()
  const server = createServer((req, res) => { res.writeHead(405); res.end() })
  server.on('connect', (req, socket) => {
    tunnels.add(socket)
    socket.on('close', () => tunnels.delete(socket))
    seen.push({ method: req.method, target: req.url, authorization: req.headers['proxy-authorization'] })
    handler(req, socket)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { port, seen, close: () => new Promise(resolve => {
    for (const socket of tunnels) socket.destroy()
    server.closeAllConnections()
    server.close(resolve)
  }) }
}

async function closedPort() {
  const server = createServer(() => undefined)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

test('proxy URL validation accepts only http(s) authorities and never echoes the value', () => {
  const accepted = ['http://127.0.0.1:7890', 'https://proxy.example.com:443',
    'http://proxy.example.com', 'http://user:proxy-secret-token@proxy.example.com:8080',
    'http://127.0.0.1:7890/', 'HTTP://Proxy.Example.COM:8080']
  for (const raw of accepted) assert.equal(validateProxyUrl(raw), new URL(raw).href)
  assert.equal(redactProxyUrl('http://user:proxy-secret-token@proxy.example.com:8080/path?q=1#frag'),
    'http://proxy.example.com:8080')
  assert.equal(redactProxyUrl('not a url'), null)
  const rejected = ['ftp://proxy.example.com', 'socks5://127.0.0.1:1080',
    'http://proxy.example.com/path', 'http://proxy.example.com/?q=1', 'http://proxy.example.com/#frag',
    'http://proxy.example.com:8080?q=1', 'http://proxy.example.com:8080/path', 'http://',
    'proxy.example.com:8080', 'http://proxy.example.com:0', 'http://proxy.example.com:70000',
    'http://proxy.example.com/\n', ' http://proxy.example.com', '', 'x'.repeat(2049), 42, null]
  for (const raw of rejected) {
    assert.throws(() => validateProxyUrl(raw), error => {
      assert.equal(error.status, 400)
      assert.equal(error.message, 'invalid proxy url')
      return true
    })
  }
})

test('saved proxy URL is private, never echoed, and reported as managed state', async () => {
  const f = await fixture()
  const proxyPass = 'proxy-secret-token'
  const secretUrl = 'http://alice:' + proxyPass + '@127.0.0.1:7890'
  try {
    const first = await f.request('/state')
    assert.deepEqual(first.json.networkProxy, { enabled: false, fallbackDirect: true, source: 'none',
      configured: false, display: null, envName: 'FEISHU_CHANNEL_PROXY_URL', envConfigured: false })
    assert.equal('url' in (first.json.config.networkProxy ?? {}), false)
    const saved = await f.request('/config', 'PUT', { expectedRevision: first.json.revision, config: {
      networkProxy: { enabled: true, fallbackDirect: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', url: secretUrl },
    } }, mutating)
    assert.equal(saved.status, 200)
    assert.equal(saved.json.restartRequired, true)
    assert.equal(saved.json.networkProxy.source, 'managed')
    assert.equal(saved.json.networkProxy.configured, true)
    assert.equal(saved.json.networkProxy.display, 'http://127.0.0.1:7890')
    assert.doesNotMatch(JSON.stringify(saved.json), /alice|proxy-secret-token/)
    const proxyFile = path.join(f.stateDir, 'network-proxy.json')
    assert.equal((await stat(proxyFile)).mode & 0o777, 0o600)
    const stored = JSON.parse(await readFile(proxyFile, 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.url, new URL(secretUrl).href)
    const adminRaw = await readFile(path.join(f.stateDir, 'admin-config.json'), 'utf8')
    assert.doesNotMatch(adminRaw, /alice|proxy-secret-token|"url"/)
    const state = await f.request('/state')
    assert.equal(state.json.networkProxy.source, 'managed')
    assert.equal(state.json.networkProxy.display, 'http://127.0.0.1:7890')
    assert.equal(state.json.networkProxy.enabled, true)
    assert.doesNotMatch(JSON.stringify(state.json), /alice|proxy-secret-token/)
    assert.equal('url' in state.json.config.networkProxy, false)
    assert.equal(state.json.config.networkProxy.urlEnv, 'FEISHU_CHANNEL_PROXY_URL')
  } finally { await f.close() }
})

test('clearing and omitting the proxy URL follow the documented contract', async () => {
  const f = await fixture()
  try {
    await writeFile(f.envFile, 'FEISHU_CHANNEL_PROXY_URL=http://env-proxy.example.com:3128\n', { mode: 0o600 })
    const first = await f.request('/state')
    assert.equal(first.json.networkProxy.source, 'env')
    assert.equal(first.json.networkProxy.display, 'http://env-proxy.example.com:3128')
    assert.equal(first.json.networkProxy.envConfigured, true)
    const saved = await f.request('/config', 'PUT', { expectedRevision: first.json.revision, config: {
      networkProxy: { enabled: true, fallbackDirect: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL',
        url: 'http://managed.example.com:8080' },
    } }, mutating)
    assert.equal(saved.status, 200)
    assert.equal(saved.json.networkProxy.source, 'managed')
    const kept = await f.request('/config', 'PUT', { expectedRevision: saved.json.revision, config: {
      networkProxy: { enabled: true, fallbackDirect: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL' },
    } }, mutating)
    assert.equal(kept.status, 200)
    assert.equal(kept.json.networkProxy.source, 'managed')
    assert.equal(kept.json.networkProxy.display, 'http://managed.example.com:8080')
    assert.equal((await stat(path.join(f.stateDir, 'network-proxy.json'))).mode & 0o777, 0o600)
    const cleared = await f.request('/config', 'PUT', { expectedRevision: kept.json.revision, config: {
      networkProxy: { enabled: true, fallbackDirect: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', url: null },
    } }, mutating)
    assert.equal(cleared.status, 200)
    assert.equal(cleared.json.networkProxy.source, 'env')
    assert.equal(cleared.json.networkProxy.display, 'http://env-proxy.example.com:3128')
    await assert.rejects(readFile(path.join(f.stateDir, 'network-proxy.json'), 'utf8'), e => e.code === 'ENOENT')
    const again = await f.request('/config', 'PUT', { expectedRevision: cleared.json.revision, config: {
      networkProxy: { enabled: false, fallbackDirect: false, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', url: null },
    } }, mutating)
    assert.equal(again.status, 200)
    assert.equal(again.json.networkProxy.enabled, false)
    assert.equal(again.json.networkProxy.fallbackDirect, false)
  } finally { await f.close() }
})

test('invalid proxy URLs are rejected without writing state or echoing the value', async () => {
  const f = await fixture()
  const bad = 'ftp://secret-host.example.com:2121'
  try {
    const first = await f.request('/state')
    const rejected = await f.request('/config', 'PUT', { expectedRevision: first.json.revision, config: {
      networkProxy: { enabled: true, fallbackDirect: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', url: bad },
    } }, mutating)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.json.error, 'invalid proxy url')
    assert.doesNotMatch(JSON.stringify(rejected.json), /secret-host|2121/)
    await assert.rejects(readFile(path.join(f.stateDir, 'network-proxy.json'), 'utf8'), e => e.code === 'ENOENT')
    for (const value of ['http://host.example.com:8080/path', 'http://host.example.com:8080/?q=1']) {
      const result = await f.request('/config', 'PUT', { expectedRevision: first.json.revision, config: {
        networkProxy: { enabled: true, fallbackDirect: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', url: value },
      } }, mutating)
      assert.equal(result.status, 400)
      assert.doesNotMatch(JSON.stringify(result.json), /host\.example\.com/)
    }
    assert.equal((await f.request('/state')).json.revision, first.json.revision)
  } finally { await f.close() }
})

test('proxy URL import reads only the configured env variable and never returns it', async () => {
  const f = await fixture()
  const envUrl = 'http://envuser:env-secret-pass@env-proxy.example.com:3128'
  try {
    const denied = await f.request('/network-proxy/import-env', 'POST', {}, {
      'content-type': 'application/json', 'x-dsh-feishu-admin': '1',
    })
    assert.equal(denied.status, 401)
    const missing = await f.request('/network-proxy/import-env', 'POST', {}, mutating)
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error, 'proxy url not found in env file')
    await writeFile(f.envFile, '# managed credentials\nFEISHU_GATEWAY_DEFAULT_APP_ID=cli_0123456789abcdef\n' +
      'FEISHU_CHANNEL_PROXY_URL=' + envUrl + '\n', { mode: 0o600 })
    const imported = await f.request('/network-proxy/import-env', 'POST', {}, mutating)
    assert.equal(imported.status, 200)
    assert.equal(imported.json.restartRequired, true)
    assert.equal(imported.json.networkProxy.source, 'managed')
    assert.equal(imported.json.networkProxy.display, 'http://env-proxy.example.com:3128')
    assert.equal(imported.json.networkProxy.envConfigured, true)
    assert.doesNotMatch(JSON.stringify(imported.json), /envuser|env-secret-pass/)
    const proxyFile = path.join(f.stateDir, 'network-proxy.json')
    assert.equal((await stat(proxyFile)).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(proxyFile, 'utf8')).url, new URL(envUrl).href)
    const state = await f.request('/state')
    const custom = await f.request('/config', 'PUT', { expectedRevision: state.json.revision, config: {
      networkProxy: { enabled: true, fallbackDirect: true, urlEnv: 'MY_PROXY_URL' },
    } }, mutating)
    assert.equal(custom.status, 200)
    await writeFile(f.envFile, 'MY_PROXY_URL=http://custom.example.com:9000\n', { mode: 0o600 })
    const customImport = await f.request('/network-proxy/import-env', 'POST', {}, mutating)
    assert.equal(customImport.status, 200)
    assert.equal(customImport.json.networkProxy.envName, 'MY_PROXY_URL')
    assert.equal(customImport.json.networkProxy.display, 'http://custom.example.com:9000')
    await writeFile(f.envFile, 'MY_PROXY_URL=ftp://bad.example.com\n', { mode: 0o600 })
    const invalid = await f.request('/network-proxy/import-env', 'POST', {}, mutating)
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error, 'invalid proxy url')
    assert.doesNotMatch(JSON.stringify(invalid.json), /bad\.example\.com/)
    assert.equal(JSON.parse(await readFile(proxyFile, 'utf8')).url, 'http://custom.example.com:9000/')
  } finally { await f.close() }
})

test('proxy test performs a CONNECT probe and reports reachable without leaking the URL', async () => {
  const f = await fixture()
  const proxy = await fakeProxy((req, socket) => {
    socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
  })
  const proxyUrl = 'http://probe-user:probe-secret@127.0.0.1:' + proxy.port
  try {
    const noProxy = await f.request('/network-proxy/test', 'POST', {}, mutating)
    assert.equal(noProxy.status, 400)
    assert.equal(noProxy.json.error, 'no proxy configured')
    const result = await f.request('/network-proxy/test', 'POST', { url: proxyUrl }, mutating)
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.result.reachable, true)
    assert.equal(result.json.result.target, 'open.feishu.cn:443')
    assert.equal(typeof result.json.result.latencyMs, 'number')
    assert.equal(result.json.result.error, undefined)
    assert.doesNotMatch(JSON.stringify(result.json), /probe-user|probe-secret|127\.0\.0\.1/)
    assert.equal(proxy.seen.length, 1)
    assert.equal(proxy.seen[0].method, 'CONNECT')
    assert.equal(proxy.seen[0].target, 'open.feishu.cn:443')
    assert.ok(proxy.seen[0].authorization?.startsWith('Basic '))
    assert.equal(Buffer.from(proxy.seen[0].authorization.slice(6), 'base64').toString(),
      'probe-user:probe-secret')
  } finally { await proxy.close(); await f.close() }
})

test('proxy test reports stable error codes for refused, denied and lark targets', async () => {
  const f = await fixture()
  try {
    const port = await closedPort()
    const refused = await f.request('/network-proxy/test', 'POST',
      { url: 'http://refused-secret@127.0.0.1:' + port }, mutating)
    assert.equal(refused.status, 200)
    assert.equal(refused.json.result.reachable, false)
    assert.equal(refused.json.result.error, 'ECONNREFUSED')
    assert.doesNotMatch(JSON.stringify(refused.json), /refused-secret|127\.0\.0\.1/)
    const authProxy = await fakeProxy((req, socket) => {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n')
    })
    try {
      const denied = await f.request('/network-proxy/test', 'POST',
        { url: 'http://auth-secret@127.0.0.1:' + authProxy.port }, mutating)
      assert.equal(denied.status, 200)
      assert.equal(denied.json.result.reachable, false)
      assert.equal(denied.json.result.error, 'HTTP_407')
      assert.doesNotMatch(JSON.stringify(denied.json), /auth-secret/)
    } finally { await authProxy.close() }
    const envProxy = await fakeProxy((req, socket) => {
      socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
    })
    try {
      await writeFile(f.envFile, 'FEISHU_CHANNEL_PROXY_URL=http://127.0.0.1:' + envProxy.port + '\n', { mode: 0o600 })
      const viaEnv = await f.request('/network-proxy/test', 'POST', {}, mutating)
      assert.equal(viaEnv.status, 200)
      assert.equal(viaEnv.json.result.reachable, true)
      assert.equal(viaEnv.json.result.target, 'open.feishu.cn:443')
      const state = await f.request('/state')
      const lark = await f.request('/config', 'PUT', { expectedRevision: state.json.revision, config: {
        bots: [{ id: 'larkbot', domain: 'lark', enabled: true }],
        networkProxy: { enabled: true, fallbackDirect: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL' },
      } }, mutating)
      assert.equal(lark.status, 200)
      const larkProbe = await f.request('/network-proxy/test', 'POST', {}, mutating)
      assert.equal(larkProbe.json.result.target, 'open.larksuite.com:443')
      assert.equal(envProxy.seen.at(-1).target, 'open.larksuite.com:443')
    } finally { await envProxy.close() }
  } finally { await f.close() }
})

test('stored proxy file refuses symlinks and non-regular files, degrades on corrupt content', async () => {
  const f = await fixture()
  try {
    await mkdir(f.stateDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(f.stateDir, 'admin-config.json'),
      JSON.stringify({ version: 1, config: {} }), { mode: 0o600 })
    const revision = (await f.request('/state')).json.revision
    const proxyFile = path.join(f.stateDir, 'network-proxy.json')
    const outside = path.join(f.dir, 'outside-proxy.json')
    await writeFile(outside, JSON.stringify({ version: 1, url: 'http://127.0.0.1:9' }), { mode: 0o600 })
    await writeFile(f.envFile, 'FEISHU_CHANNEL_PROXY_URL=http://127.0.0.1:9\n', { mode: 0o600 })
    await symlink(outside, proxyFile)
    const symlinked = await f.request('/state')
    assert.equal(symlinked.status, 409)
    assert.doesNotMatch(JSON.stringify(symlinked.json), /outside-proxy|127\.0\.0\.1/)
    const symlinkSave = await f.request('/config', 'PUT', { expectedRevision: revision, config: {
      networkProxy: { enabled: true, fallbackDirect: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL',
        url: 'http://managed.example.com:8080' },
    } }, mutating)
    assert.equal(symlinkSave.status, 409)
    const symlinkImport = await f.request('/network-proxy/import-env', 'POST', {}, mutating)
    assert.equal(symlinkImport.status, 409)
    assert.equal(await readFile(outside, 'utf8'), JSON.stringify({ version: 1, url: 'http://127.0.0.1:9' }))
    await rm(proxyFile)
    await mkdir(proxyFile)
    assert.equal((await f.request('/state')).status, 409)
    await rm(proxyFile, { recursive: true })
    // Corrupt *content* must not take down the whole management panel: it is
    // reported as storedError, the env fallback stays usable, and a later save
    // repairs the file without any manual Linux edit.
    const corruptCases = ['{broken', JSON.stringify({ version: 2, url: 'http://127.0.0.1:9' }),
      JSON.stringify({ version: 1, url: 'ftp://bad.example.com' }),
      JSON.stringify({ version: 1, url: 'http://127.0.0.1:9', extra: 1 })]
    for (const content of corruptCases) {
      await writeFile(proxyFile, content, { mode: 0o600 })
      const state = await f.request('/state')
      assert.equal(state.status, 200)
      assert.equal(state.json.networkProxy.storedError, true)
      assert.equal(state.json.networkProxy.source, 'env')
      assert.equal(state.json.networkProxy.display, 'http://127.0.0.1:9')
      assert.doesNotMatch(JSON.stringify(state.json), /bad\.example\.com|broken/)
    }
    const repaired = await f.request('/config', 'PUT', { expectedRevision: (await f.request('/state')).json.revision, config: {
      networkProxy: { enabled: true, fallbackDirect: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL',
        url: 'http://managed.example.com:8080' },
    } }, mutating)
    assert.equal(repaired.status, 200)
    assert.equal(repaired.json.networkProxy.source, 'managed')
    assert.equal(repaired.json.networkProxy.storedError, undefined)
  } finally { await f.close() }
})

test('legacy networkProxy config without url or urlEnv keeps working', async () => {
  const f = await fixture()
  try {
    await mkdir(f.stateDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(f.stateDir, 'admin-config.json'), JSON.stringify({ version: 1, config: {
      networkProxy: { enabled: true, fallbackDirect: true },
    } }), { mode: 0o600 })
    const state = await f.request('/state')
    assert.equal(state.status, 200)
    assert.deepEqual(state.json.config.networkProxy,
      { enabled: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', fallbackDirect: true })
    assert.equal('url' in state.json.config.networkProxy, false)
    assert.equal(state.json.networkProxy.envName, 'FEISHU_CHANNEL_PROXY_URL')
    assert.equal(state.json.networkProxy.enabled, true)
    assert.equal(state.json.networkProxy.source, 'none')
    assert.equal(state.json.networkProxy.configured, false)
    assert.equal(state.json.networkProxy.display, null)
    const saved = await f.request('/config', 'PUT', { expectedRevision: state.json.revision, config: {
      networkProxy: { enabled: true, fallbackDirect: false },
    } }, mutating)
    assert.equal(saved.status, 200)
    assert.deepEqual(JSON.parse(await readFile(path.join(f.stateDir, 'admin-config.json'), 'utf8')).config.networkProxy,
      { enabled: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', fallbackDirect: false })
    await writeFile(f.envFile, 'FEISHU_CHANNEL_PROXY_URL=http://env.example.com:3128\n', { mode: 0o600 })
    const envState = await f.request('/state')
    assert.equal(envState.json.networkProxy.source, 'env')
    assert.equal(envState.json.networkProxy.envConfigured, true)
    const managed = await f.request('/config', 'PUT', { expectedRevision: envState.json.revision, config: {
      networkProxy: { enabled: false, fallbackDirect: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL',
        url: 'http://managed.example.com:8080' },
    } }, mutating)
    assert.equal(managed.status, 200)
    assert.equal(managed.json.networkProxy.source, 'managed')
    assert.equal(managed.json.networkProxy.enabled, false)
  } finally { await f.close() }
})

test('proxy test times out against a silent proxy with a stable code', async () => {
  const f = await fixture({ proxyTestTimeoutMs: 150 })
  const silent = await fakeProxy(() => undefined)
  try {
    const result = await f.request('/network-proxy/test', 'POST',
      { url: 'http://127.0.0.1:' + silent.port }, mutating)
    assert.equal(result.status, 200)
    assert.equal(result.json.result.reachable, false)
    assert.equal(result.json.result.error, 'ETIMEDOUT')
    assert.doesNotMatch(JSON.stringify(result.json), /127\.0\.0\.1/)
    assert.ok(result.json.result.latencyMs >= 100)
  } finally { await silent.close(); await f.close() }
})

test('authenticated Session inventory endpoint is paginated and does not disclose raw IDs', async () => {
  const f = await fixture()
  try {
    await mkdir(f.stateDir, { recursive: true })
    await writeFile(path.join(f.stateDir, 'sessions.json'), JSON.stringify({ bindings: {
      'default:oc_sensitive_chat': {
        sessionId: 'dsh-sensitive-session', createdAt: Date.parse('2026-01-03'),
        lastActiveAt: Date.parse('2026-02-04'), persisted: true,
      },
    } }))
    const anonymous = await f.request('/sessions', 'GET', undefined, {})
    assert.equal(anonymous.status, 401)
    const res = await f.request('/sessions?from=2026-02-01&pageSize=1')
    assert.equal(res.status, 200)
    assert.equal(res.json.report.total, 1)
    const raw = JSON.stringify(res.json)
    assert.equal(raw.includes('oc_sensitive_chat'), false)
    assert.equal(raw.includes('dsh-sensitive-session'), false)
    const invalid = await f.request('/sessions?status=invalid')
    assert.equal(invalid.status, 400)
    const duplicate = await f.request('/sessions?bot=a&bot=b')
    assert.equal(duplicate.status, 400)
  } finally { await f.close() }
})


test('Session action preview requires fresh idle state and a single-use confirmation', async () => {
  const f = await fixture()
  try {
    await mkdir(f.stateDir, { recursive: true })
    const sessionId = 'dsh-sensitive-session'
    const ref = (await import('node:crypto')).createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
    const now = Date.now()
    const lastActiveAt = now - 120_000
    await writeFile(path.join(f.stateDir, 'sessions.json'), JSON.stringify({ bindings: {
      'default:oc_private_chat': { sessionId, createdAt: now - 500_000, lastActiveAt, persisted: true },
    } }))
    const snapshot = { version: 1, ts: now, status: 'ok', tasks: [],
      sessions: [], transport: {}, stats: {} }
    await writeFile(path.join(f.stateDir, 'ops-runtime.json'), JSON.stringify(snapshot))
    const body = { type: 'archive-session', ref, expectedLastActiveAt: lastActiveAt }
    const unauth = await f.request('/sessions/preview', 'POST', body, {})
    assert.equal(unauth.status, 401)
    const preview = await f.request('/sessions/preview', 'POST', body, mutating)
    assert.equal(preview.status, 200)
    assert.equal(preview.json.preview.nativeSessionPreserved, true)
    assert.equal(JSON.stringify(preview.json).includes('oc_private_chat'), false)
    const noToken = await f.request('/sessions/commands', 'POST', { token: 'bad' }, mutating)
    assert.equal(noToken.status, 400)
    const accepted = await f.request('/sessions/commands', 'POST', { token: preview.json.preview.token }, mutating)
    assert.equal(accepted.status, 202)
    assert.equal(accepted.json.command.type, 'archive-session')
    const once = await f.request('/sessions/commands', 'POST', { token: preview.json.preview.token }, mutating)
    assert.equal(once.status, 409)
    const requests = await (await import('node:fs/promises')).readdir(path.join(f.stateDir, 'ops-control', 'requests'))
    assert.equal(requests.length, 1)
    const command = JSON.parse(await readFile(path.join(f.stateDir, 'ops-control', 'requests', requests[0]), 'utf8'))
    assert.equal(command.ref, ref)
    assert.equal(command.expectedLastActiveAt, lastActiveAt)
    assert.equal(command.type, 'archive-session')

    await writeFile(path.join(f.stateDir, 'ops-runtime.json'),
      JSON.stringify({ ...snapshot, ts: now - 60_000 }))
    const stale = await f.request('/sessions/preview', 'POST', { ...body, type: 'unbind-session' }, mutating)
    assert.equal(stale.status, 409)
    await writeFile(path.join(f.stateDir, 'ops-runtime.json'),
      JSON.stringify({ ...snapshot, ts: Date.now(), stats: { outboxPending: 1 } }))
    const unsent = await f.request('/sessions/preview', 'POST', body, mutating)
    assert.equal(unsent.status, 409)
    await writeFile(path.join(f.stateDir, 'ops-runtime.json'),
      JSON.stringify({ ...snapshot, ts: Date.now(), tasks: [
        { ref: 'a'.repeat(16), session: ref, botId: 'default', phase: 'running', elapsedMs: 30 },
      ] }))
    const active = await f.request('/sessions/preview', 'POST', body, mutating)
    assert.equal(active.status, 409)
  } finally { await f.close() }
})

test('Session batch preview is authenticated, single-use, and queues hashed references only', async () => {
  const f = await fixture()
  try {
    await mkdir(f.stateDir, { recursive: true })
    const ref = v => createHash('sha256').update(v).digest('hex').slice(0, 16)
    const now = Date.now()
    const bindings = {
      'default:oc_private_1': { sessionId: 'native-private-1', createdAt: now - 400000,
        lastActiveAt: now - 300000, persisted: true },
      'default:oc_private_2': { sessionId: 'native-private-2', createdAt: now - 400000,
        lastActiveAt: now - 200000, persisted: true },
    }
    await writeFile(path.join(f.stateDir, 'sessions.json'), JSON.stringify({ bindings }))
    const snapshot = { version: 1, ts: now, status: 'ok', tasks: [],
      sessions: [], transport: {}, stats: {} }
    await writeFile(path.join(f.stateDir, 'ops-runtime.json'), JSON.stringify(snapshot))
    const items = Object.entries(bindings).map(([key, value]) => ({
      ref: ref(value.sessionId), chatRef: ref(key.split(':')[1]),
      botId: 'default', expectedLastActiveAt: value.lastActiveAt,
    }))
    const batch = { action: 'unlink', items }
    assert.equal((await f.request('/sessions/batch/preview', 'POST', batch, {})).status, 401)
    const preview = await f.request('/sessions/batch/preview', 'POST', batch, mutating)
    assert.equal(preview.status, 200)
    assert.equal(preview.json.preview.count, 2)
    assert.equal(preview.json.preview.nativeSessionPreserved, true)
    assert.ok(preview.json.preview.estimatedBindingBytes > 0)
    assert.doesNotMatch(JSON.stringify(preview.json), /oc_private_|native-private-/)
    const queued = await f.request('/sessions/commands', 'POST',
      { token: preview.json.preview.token }, mutating)
    assert.equal(queued.status, 202)
    assert.equal(queued.json.command.type, 'batch-sessions')
    assert.equal((await f.request('/sessions/commands', 'POST',
      { token: preview.json.preview.token }, mutating)).status, 409)
    const files = await (await import('node:fs/promises')).readdir(
      path.join(f.stateDir, 'ops-control', 'requests'))
    assert.equal(files.length, 1)
    const payload = JSON.parse(await readFile(path.join(f.stateDir, 'ops-control', 'requests', files[0]), 'utf8'))
    assert.deepEqual(payload.batch, batch)
    assert.doesNotMatch(JSON.stringify(payload), /oc_private_|native-private-/)
    const duplicate = await f.request('/sessions/batch/preview', 'POST',
      { action: 'unlink', items: [items[0], items[0]] }, mutating)
    assert.equal(duplicate.status, 400)
    const invalid = await f.request('/sessions/batch/preview', 'POST',
      { action: 'unlink', items: [{ ...items[0], expectedLastActiveAt: -1 }] }, mutating)
    assert.equal(invalid.status, 400)
    await writeFile(path.join(f.stateDir, 'ops-runtime.json'),
      JSON.stringify({ ...snapshot, ts: now - 60000 }))
    assert.equal((await f.request('/sessions/batch/preview', 'POST', batch, mutating)).status, 409)
  } finally { await f.close() }
})

test('group validation and explicit open-mode confirmation', async () => {
  const rule = { chatId: 'oc_group', enabled: true, requireMention: true, sessionScope: 'group_sender' }
  assert.equal(validateConfig({ groupPolicy: 'allowlist', groupSenderAllowlist: ['ou_alice'], groups: [rule] }).groups[0].chatId, rule.chatId)
  assert.throws(() => validateConfig({ groupPolicy: 'everyone' }), /groupPolicy/)
  assert.throws(() => validateConfig({ groups: [rule, rule] }), /duplicate/)
  assert.throws(() => validateConfig({ groups: [{ ...rule, sessionScope: 'bad' }] }), /sessionScope/)
  const f = await fixture()
  try {
    const state = await f.request('/state')
    const payload = { expectedRevision: state.json.revision,
      config: { groupPolicy: 'open', groupSenderAllowlist: ['ou_alice'], groups: [rule] } }
    assert.equal((await f.request('/config', 'PUT', payload, mutating)).status, 400)
    assert.equal((await f.request('/config', 'PUT', { ...payload, confirmOpenGroups: true }, mutating)).status, 200)
    const saved = await f.request('/state')
    assert.equal(saved.json.config.groupPolicy, 'open')
  } finally { await f.close() }
})

test('exec-policy endpoint seeds from profile, persists overlay, and validates input', async () => {
  const profDir = await mkdtemp(path.join(tmpdir(), 'dsh-exec-profile-'))
  const profilePath = path.join(profDir, 'cordis.patch.yml')
  await writeFile(profilePath, [
    '- id: sandbox-policy',
    "  name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    '    mode: workspace-write',
    '    workspaceRoot: /home/ubuntu/dsh-workspace',
    '    additionalWritableRoots:',
    '      - /home/ubuntu/.lark-cli',
    '- id: approval',
    "  name: '@deepseek-ai/dsh-user-approval'",
    '  config:',
    '    policy: ask',
    '',
  ].join('\n'))
  const f = await fixture({ profilePath })
  try {
    const seeded = await f.request('/exec-policy')
    assert.equal(seeded.status, 200)
    assert.equal(seeded.json.source, 'profile')
    assert.equal(seeded.json.policy.mode, 'workspace-write')
    assert.deepEqual(seeded.json.policy.additionalWritableRoots, ['/home/ubuntu/.lark-cli'])

    assert.equal((await f.request('/exec-policy', 'POST',
      { mode: 'read-only', approvalPolicy: 'never', additionalWritableRoots: [] }, mutating)).status, 200)
    const after = await f.request('/exec-policy')
    assert.equal(after.json.source, 'managed')
    assert.equal(after.json.policy.mode, 'read-only')
    assert.equal(after.json.policy.approvalPolicy, 'never')
    const overlay = await readFile(path.join(f.stateDir, 'exec-policy.patch.yml'), 'utf8')
    assert.match(overlay, /defaultPreset: managed/)
    assert.match(overlay, /mode: read-only/)

    assert.equal((await f.request('/exec-policy', 'POST',
      { mode: 'read-only', approvalPolicy: 'bogus', additionalWritableRoots: [] }, mutating)).status, 400)
    assert.equal((await f.request('/exec-policy', 'POST',
      { mode: 'workspace-write', approvalPolicy: 'ask', additionalWritableRoots: ['relative'] }, mutating)).status, 400)
    assert.equal((await f.request('/exec-policy', 'POST',
      { mode: 'read-only', approvalPolicy: 'ask', additionalWritableRoots: [] },
      { ...allowed, 'content-type': 'application/json' })).status, 403)
  } finally {
    await f.close()
    await rm(profDir, { recursive: true, force: true })
  }
})
