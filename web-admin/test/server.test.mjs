import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
