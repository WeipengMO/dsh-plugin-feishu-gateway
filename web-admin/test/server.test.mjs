import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createAdminHandler, validateConfig, name, inject } from '../src/server.mjs'

const allowed = { cookie: 'test-session=good' }
const mutating = { ...allowed, 'content-type': 'application/json', 'x-dsh-feishu-admin': '1' }
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-feishu-admin-'))
  const stateDir = path.join(dir, 'state')
  const envFile = path.join(dir, 'feishu-channel.env')
  const handler = createAdminHandler({
    stateDir, envFile, healthPort: 39191,
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
