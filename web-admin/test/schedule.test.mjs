import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createAdminHandler, validateScheduleCommand, queueOperatorCommand } from '../src/server.mjs'
import { readScheduleModel, readScheduleResults } from '../src/schedule-read.mjs'
import { readOpsResults } from '../src/ops-read.mjs'
import { validateSpec, validateSpecShape, previewOccurrences, specSummary,
  validTimeZone, SCHEDULE_KINDS, PREVIEW_MAX } from '../src/schedule-spec.mjs'

const allowed = { cookie: 'sched-ok' }
const mutating = { ...allowed, 'content-type': 'application/json', 'x-dsh-feishu-admin': '1' }
const CLIENT_REF = '11111111-1111-4111-8111-111111111111'
const TASK_ID = 'schedule-22222222-2222-4222-8222-222222222222'
const FROM = Date.parse('2026-11-15T00:00:00.000Z')

async function fixture(extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-feishu-schedule-'))
  const stateDir = path.join(dir, 'state')
  const envFile = path.join(dir, 'feishu-channel.env')
  const handler = createAdminHandler({
    stateDir, envFile, healthPort: 39201, ...extra,
    requestRejection: req => req.headers.cookie === 'sched-ok' ? undefined : 401,
  })
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port + '/api/feishu-admin'
  const request = async (route, method = 'GET', body, headers = allowed) => {
    const response = await fetch(base + route, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, json: await response.json() }
  }
  return { dir, stateDir, envFile, handler, base, request,
    close: async () => {
      await new Promise(resolve => server.close(resolve))
      await rm(dir, { recursive: true, force: true })
    } }
}

/** Direct handler invocation with a minimal fake req/res (no live socket). */
function fakeRequest(method, url, body, headers = mutating) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return { url, method, headers,
    async *[Symbol.asyncIterator]() { if (payload !== undefined) yield payload } }
}
function fakeResponse() {
  const result = { status: 0, headers: {}, body: '' }
  const res = {
    writeHead(status, headers) { result.status = status; result.headers = headers },
    end(payload) { result.body = payload === undefined ? '' : String(payload) },
  }
  return { result, res, json: () => JSON.parse(result.body) }
}

// ---------------------------------------------------------------------------
// 1. Pure schedule-spec.mjs unit coverage
// ---------------------------------------------------------------------------

test('validateSpec accepts all 6 canonical kinds, trims nothing and rejects unknown keys', () => {
  const valid = [
    { kind: 'once', at: '2026-12-01T09:00:00', timeZone: 'Asia/Shanghai' },
    { kind: 'every', everySeconds: 60 },
    { kind: 'daily', time: '09:00:00', timeZone: 'UTC' },
    { kind: 'weekly', time: '09:00:00', timeZone: 'Asia/Shanghai', weekdays: [1, 3, 5] },
    { kind: 'monthly', time: '09:00:00', timeZone: 'UTC', day: 31 },
    { kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'Asia/Shanghai' },
  ]
  assert.deepEqual(SCHEDULE_KINDS, ['once', 'every', 'daily', 'weekly', 'monthly', 'cron'])
  for (const spec of valid) {
    const result = validateSpec(spec, FROM)
    assert.equal(result.ok, true, JSON.stringify(spec))
    assert.equal(result.spec.kind, spec.kind)
  }
  assert.equal(PREVIEW_MAX, 10)
  assert.equal(validTimeZone('Asia/Shanghai'), true)
  assert.equal(validTimeZone('UTC'), true)
  assert.equal(validTimeZone('America/Argentina/Buenos_Aires'), true)
  assert.equal(validTimeZone('+08:00'), false)
  assert.equal(validTimeZone('GMT'), false)
  assert.equal(validTimeZone('Not/AZone'), false)
  assert.equal(validTimeZone(42), false)
})

test('validateSpec rejects malformed specs, invalid zones, bad cron and past once', () => {
  const invalid = [
    null, [], 'x', 42, { kind: 'nope' },
    { kind: 'daily', time: '09:00:00', timeZone: 'UTC', extra: 1 },
    { kind: 'daily', time: '25:00:00', timeZone: 'UTC' },
    { kind: 'daily', time: '09:60:00', timeZone: 'UTC' },
    { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    { kind: 'daily', time: '09:00:00', timeZone: '+08:00' },
    { kind: 'every', everySeconds: 59 },
    { kind: 'every', everySeconds: 61.5 },
    { kind: 'every', everySeconds: 60, timeZone: 'UTC' }, // unknown key for "every"
    { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [] },
    { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [1, 1] },
    { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [8] },
    { kind: 'monthly', time: '09:00:00', timeZone: 'UTC', day: 0 },
    { kind: 'monthly', time: '09:00:00', timeZone: 'UTC', day: 32 },
    { kind: 'cron', expression: '* * * *', timeZone: 'UTC' },
    { kind: 'cron', expression: '99 * * * *', timeZone: 'UTC' },
    { kind: 'cron', expression: '0 0 * * BOGUS', timeZone: 'UTC' },
    { kind: 'cron', expression: '0 9 * JAN *', timeZone: 'UTC' }, // named month: numeric-only parity
    { kind: 'cron', expression: '0 9 * * MON', timeZone: 'UTC' },  // named dow: numeric-only parity
    { kind: 'cron', expression: '*/0 * * * *', timeZone: 'UTC' },
    { kind: 'once', at: '2026-02-30T09:00:00', timeZone: 'UTC' }, // impossible date
    { kind: 'once', at: '2020-01-01T00:00:00Z', timeZone: 'UTC' }, // strictly past
  ]
  for (const spec of invalid) {
    const result = validateSpec(spec, FROM)
    assert.equal(result.ok, false, 'should reject ' + JSON.stringify(spec))
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.length <= 120)
  }
  // Past "once" specs are legitimate in a stored read model (historic tasks),
  // so shape-only validation must keep them.
  const historic = { kind: 'once', at: '2020-01-01T00:00:00Z', timeZone: 'UTC' }
  assert.equal(validateSpecShape(historic).ok, true)
})

test('cron validation is numeric-only with the exact Gateway field ranges', () => {
  const tz = 'UTC'
  // Ranges mirror src/schedule/spec.ts CRON_RANGES: minute 0-59, hour 0-23,
  // dom 1-31, month 1-12, dow 0-7. No JAN/MON name tokens on either side.
  const accepted = ['* * * * *', '0 9 * * 1-5', '*/15 9-17 * * *', '0 0 1 1 0',
    '59 23 31 12 7', '1,2,3 4 * * *', '0 9 1 1 7', '5/10 * * * *']
  const rejected = ['60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *',
    '* * * 13 *', '* * * * 8', '0 9 * JAN *', '0 9 * * MON',
    '0 9 * * 1-JAN', '*/0 * * * *', '1-2-3 * * * *']
  for (const expression of accepted) {
    assert.equal(validateSpec({ kind: 'cron', expression, timeZone: tz }, FROM).ok,
      true, 'should accept ' + expression)
  }
  for (const expression of rejected) {
    assert.equal(validateSpec({ kind: 'cron', expression, timeZone: tz }, FROM).ok,
      false, 'should reject ' + expression)
  }
})

test('previewOccurrences returns bounded strictly-future UTC instants for every kind', () => {
  const cases = [
    { spec: { kind: 'once', at: '2026-12-01T09:00:00', timeZone: 'Asia/Shanghai' }, count: 1 },
    { spec: { kind: 'every', everySeconds: 3600 }, count: 4 },
    { spec: { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' }, count: 5 },
    { spec: { kind: 'weekly', time: '08:30:00', timeZone: 'UTC', weekdays: [1, 3, 5] }, count: 5 },
    { spec: { kind: 'monthly', time: '07:00:00', timeZone: 'UTC', day: 31 }, count: 3 },
    { spec: { kind: 'cron', expression: '*/30 9 * * *', timeZone: 'UTC' }, count: 4 },
  ]
  for (const { spec, count } of cases) {
    const occurrences = previewOccurrences(spec, count, FROM)
    assert.equal(occurrences.length, count, spec.kind)
    for (let i = 0; i < occurrences.length; i++) {
      assert.match(occurrences[i], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      assert.ok(Date.parse(occurrences[i]) > FROM, spec.kind)
      if (i > 0) assert.ok(Date.parse(occurrences[i]) > Date.parse(occurrences[i - 1]), spec.kind)
    }
  }
  // Invalid count / fromMs / spec degrade to an empty array, never a throw.
  assert.deepEqual(previewOccurrences({ kind: 'every', everySeconds: 60 }, 0, FROM), [])
  assert.deepEqual(previewOccurrences({ kind: 'every', everySeconds: 60 }, 11, FROM), [])
  assert.deepEqual(previewOccurrences({ kind: 'every', everySeconds: 60 }, 5, NaN), [])
  assert.deepEqual(previewOccurrences({ kind: 'bogus' }, 5, FROM), [])
})

test('previewOccurrences is DST-safe via Intl offset probing (spring forward)', () => {
  const from = Date.parse('2026-03-06T00:00:00.000Z')
  const occurrences = previewOccurrences(
    { kind: 'daily', time: '09:00:00', timeZone: 'America/New_York' }, 4, from)
  assert.equal(occurrences.length, 4)
  // 09:00 EST = 14:00Z, 09:00 EDT = 13:00Z: a 23h gap across the DST change.
  assert.equal(Date.parse(occurrences[1]) - Date.parse(occurrences[0]), 24 * 3600000)
  assert.equal(Date.parse(occurrences[2]) - Date.parse(occurrences[1]), 23 * 3600000)
  assert.equal(Date.parse(occurrences[3]) - Date.parse(occurrences[2]), 24 * 3600000)
  // A fixed-offset implementation would keep all gaps at exactly 24h.
})

test('specSummary is bounded and uses only validated fields', () => {
  for (const spec of [
    { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' },
    { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [1, 5] },
    { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
  ]) {
    const summary = specSummary(spec)
    assert.ok(summary.length > 0 && summary.length <= 200)
    assert.match(summary, /daily|weekly|cron/)
  }
  assert.equal(specSummary(null), 'unknown')
})

// ---------------------------------------------------------------------------
// 2. Command mailbox validation via createAdminHandler
// ---------------------------------------------------------------------------

test('schedule command enqueues a bounded command file with a server-derived actor', async () => {
  const f = await fixture()
  try {
    const spec = { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' }
    const schedule = { action: 'create', clientRef: CLIENT_REF,
      title: '每日新闻简报', prompt: '汇总今天的新闻', spec, notify: 'both',
      delivery: { botId: 'default', chatId: 'oc_groupchat', chatType: 'group', senderId: 'ou_sender' } }
    const unauth = await f.request('/schedule/commands', 'POST', { type: 'schedule', schedule },
      { 'content-type': 'application/json', 'x-dsh-feishu-admin': '1' })
    assert.equal(unauth.status, 401)
    const accepted = await f.request('/schedule/commands', 'POST', { type: 'schedule', schedule }, mutating)
    assert.equal(accepted.status, 202)
    assert.equal(accepted.json.queued, true)
    assert.equal(accepted.json.command.type, 'schedule')
    const id = accepted.json.command.id
    assert.match(id, /^[a-f0-9-]{36}$/)
    const file = path.join(f.stateDir, 'ops-control', 'requests', id + '.json')
    const data = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(data.version, 1)
    assert.equal(data.type, 'schedule')
    assert.equal(data.actor, 'dsh-web-admin') // server-derived, never from the body
    assert.deepEqual(Object.keys(data).sort(), ['actor', 'id', 'schedule', 'ts', 'type', 'version'])
    assert.equal(data.schedule.action, 'create')
    assert.equal(data.schedule.title, '每日新闻简报')
    assert.equal(data.schedule.prompt, '汇总今天的新闻')
    assert.deepEqual(data.schedule.spec, spec)
    assert.equal(data.schedule.notify, 'both')
    assert.equal(data.schedule.delivery.chatId, 'oc_groupchat')
    assert.equal(data.schedule.delivery.senderId, 'ou_sender')
    assert.equal(data.schedule.actor, undefined) // no actor inside schedule
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const raw = await readFile(file, 'utf8')
    assert.ok(Buffer.byteLength(raw, 'utf8') <= 8192)
  } finally { await f.close() }
})

test('schedule command rejects forged actor, unknown fields, invalid specs and bad ids', async () => {
  const f = await fixture()
  try {
    const base = { action: 'create', clientRef: CLIENT_REF, title: 't' }
    const forgedInner = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { ...base, actor: 'attacker' } }, mutating)
    assert.equal(forgedInner.status, 400)
    const forgedTop = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', actor: 'attacker', schedule: base }, mutating)
    assert.equal(forgedTop.status, 400)
    const badSpec = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { ...base, spec: { kind: 'daily', time: '09:00:00', timeZone: '+08:00' } } }, mutating)
    assert.equal(badSpec.status, 400)
    const noClientRef = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { action: 'create', title: 'x' } }, mutating)
    assert.equal(noClientRef.status, 400)
    const badAction = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { action: 'shell' } }, mutating)
    assert.equal(badAction.status, 400)
    const badTaskId = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { action: 'pause', taskId: 'bad' } }, mutating)
    assert.equal(badTaskId.status, 400)
    const badNotify = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { action: 'refresh', notify: 'bogus' } }, mutating)
    assert.equal(badNotify.status, 400)
    const ok = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { action: 'pause', taskId: TASK_ID } }, mutating)
    assert.equal(ok.status, 202)
  } finally { await f.close() }
})

test('schedule command enforces prompt/title bounds and the 8192-byte cap', async () => {
  const f = await fixture()
  try {
    const base = { action: 'create', clientRef: CLIENT_REF, title: 't' }
    const longPrompt = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { ...base, prompt: 'x'.repeat(4001) } }, mutating)
    assert.equal(longPrompt.status, 400)
    const okPrompt = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { ...base, prompt: 'x'.repeat(4000) } }, mutating)
    assert.equal(okPrompt.status, 202)
    const longTitle = await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { ...base, title: 'x'.repeat(121) } }, mutating)
    assert.equal(longTitle.status, 400)
    // A small explicit maxBytes forces the mailbox byte-cap branch (413).
    await assert.rejects(
      queueOperatorCommand(f.stateDir, { type: 'schedule', schedule: { action: 'refresh' } }, 16),
      error => { assert.equal(error.status, 413); return true })
  } finally { await f.close() }
})

test('validateScheduleCommand normalizes fields and allows delivery/expectedUpdatedAt null', () => {
  const spec = { kind: 'every', everySeconds: 120 }
  const result = validateScheduleCommand({ action: 'update', taskId: TASK_ID, spec,
    delivery: null, expectedUpdatedAt: null })
  assert.equal(result.delivery, null)
  assert.equal(result.expectedUpdatedAt, null)
  assert.deepEqual(result.spec, spec)
  assert.equal(result.action, 'update')
  assert.throws(() => validateScheduleCommand({ action: 'create' }), /clientRef/)
  assert.throws(() => validateScheduleCommand({ action: 'pause' }), /taskId/)
  assert.throws(() => validateScheduleCommand({ action: 'refresh', notify: 'bogus' }), /notify/)
  assert.throws(() => validateScheduleCommand({ action: 'refresh', actor: 'x' }), /unsupported field/)
  // Both oc_ (chat_id) and ou_ (open_id) chat ids are accepted.
  for (const chatId of ['oc_group', 'ou_alice']) {
    const ok = validateScheduleCommand({ action: 'refresh',
      delivery: { botId: 'default', chatId, chatType: chatId.startsWith('ou_') ? 'p2p' : 'group' } })
    assert.equal(ok.delivery.chatId, chatId)
  }
})

test('createAdminHandler writes a schedule command through a fake req/res object', async () => {
  const f = await fixture()
  try {
    const out = fakeResponse()
    const req = fakeRequest('POST', '/api/feishu-admin/schedule/commands',
      { type: 'schedule', schedule: { action: 'refresh' } })
    await f.handler(req, out.res)
    assert.equal(out.result.status, 202)
    const parsed = out.json()
    assert.equal(parsed.ok, true)
    assert.equal(parsed.command.type, 'schedule')
    const file = path.join(f.stateDir, 'ops-control', 'requests', parsed.command.id + '.json')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).actor, 'dsh-web-admin')
  } finally { await f.close() }
})

// ---------------------------------------------------------------------------
// 3. Preview endpoint (pure, no filesystem writes) + endpoint auth
// ---------------------------------------------------------------------------

test('POST /schedule/preview validates strictly and never writes state', async () => {
  const f = await fixture()
  try {
    const badSpec = await f.request('/schedule/preview', 'POST',
      { spec: { kind: 'daily', time: '09:00:00', timeZone: 'UTC', extra: 1 }, count: 5 }, mutating)
    assert.equal(badSpec.status, 400)
    const badCount = await f.request('/schedule/preview', 'POST',
      { spec: { kind: 'daily', time: '09:00:00', timeZone: 'UTC' }, count: 11 }, mutating)
    assert.equal(badCount.status, 400)
    const extraKey = await f.request('/schedule/preview', 'POST',
      { spec: { kind: 'daily', time: '09:00:00', timeZone: 'UTC' }, count: 5, nope: 1 }, mutating)
    assert.equal(extraKey.status, 400)
    const ok = await f.request('/schedule/preview', 'POST',
      { spec: { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' }, count: 5 }, mutating)
    assert.equal(ok.status, 200)
    assert.equal(ok.json.occurrences.length, 5)
    assert.match(ok.json.occurrences[0], /Z$/)
    assert.match(ok.json.summary, /daily/)
    // Pure: no command mailbox or state directory was created.
    await assert.rejects(stat(path.join(f.stateDir, 'ops-control')), error => error.code === 'ENOENT')
  } finally { await f.close() }
})

test('every schedule endpoint requires the authenticated DSH browser session', async () => {
  const f = await fixture()
  try {
    const write = { 'content-type': 'application/json', 'x-dsh-feishu-admin': '1' }
    assert.equal((await f.request('/schedule', 'GET', undefined, {})).status, 401)
    assert.equal((await f.request('/schedule/results', 'GET', undefined, {})).status, 401)
    assert.equal((await f.request('/schedule/preview', 'POST',
      { spec: { kind: 'every', everySeconds: 60 }, count: 1 }, write)).status, 401)
    assert.equal((await f.request('/schedule/commands', 'POST',
      { type: 'schedule', schedule: { action: 'refresh' } }, write)).status, 401)
  } finally { await f.close() }
})

// ---------------------------------------------------------------------------
// 4. Sanitized read model + results whitelisting
// ---------------------------------------------------------------------------

test('GET /schedule returns a whitelisted, bounded read model preserving the full session id', async () => {
  const f = await fixture()
  try {
    const unauth = await f.request('/schedule', 'GET', undefined, {})
    assert.equal(unauth.status, 401)
    await mkdir(f.stateDir, { recursive: true, mode: 0o700 })
    const fullSession = 'feishu-schedule-' + CLIENT_REF + '-session-abcdef0123456789'
    const doc = {
      version: 1, ts: Date.now(), available: true, reason: null,
      limits: { newSessionIntervalSeconds: 60 },
      tasks: [{
        id: TASK_ID, title: '每日简报', prompt: '汇总今天的新闻',
        spec: { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' },
        timingKind: 'daily', timeZone: 'Asia/Shanghai',
        scheduledAt: '2026-11-16T01:00:00.000Z', status: 'active',
        createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
        executionActive: false, secret: 'MUST-NOT-LEAK',
        lastDelivery: { scheduledAt: '2026-11-15T01:00:00.000Z',
          deliveredAt: '2026-11-15T01:00:02.000Z', messageId: 'm1', targetSessionId: fullSession },
        target: { kind: 'session', sessionId: fullSession },
        delivery: { botId: 'default', chatId: 'oc_group', chatType: 'group', notify: 'both' },
      }],
      deliveries: { [TASK_ID]: [{ scheduledAt: '2026-11-15T01:00:00.000Z',
        deliveredAt: '2026-11-15T01:00:02.000Z', messageId: 'm1', targetSessionId: fullSession }] },
      runs: [{ ts: Date.now(), taskId: TASK_ID, messageId: 'm1', sessionRef: '0123456789abcdef',
        status: 'success', elapsedMs: 1200, tokens: 123, model: 'deepseek/chat', delivered: true, error: null }],
      audit: [{ ts: Date.now(), actor: 'dsh-web-admin', action: 'create', taskId: TASK_ID,
        state: 'completed', summary: 'daily 09:00 Asia/Shanghai' }],
      extraTop: 'MUST-NOT-LEAK-TOP',
    }
    await writeFile(path.join(f.stateDir, 'ops-schedule.json'), JSON.stringify(doc), { mode: 0o600 })
    const res = await f.request('/schedule')
    assert.equal(res.status, 200)
    const model = res.json.model
    assert.equal(model.available, true)
    assert.equal(model.stale, false)
    assert.equal(model.limits.newSessionIntervalSeconds, 60)
    assert.equal(model.tasks.length, 1)
    const task = model.tasks[0]
    assert.equal(task.prompt, '汇总今天的新闻') // prompt is intentionally part of the DTO, bounded
    assert.equal(task.secret, undefined)
    assert.equal(task.target.sessionId, fullSession) // FULL raw id, never hashed/truncated
    assert.equal(task.lastDelivery.targetSessionId, fullSession)
    assert.equal(task.delivery.chatId, 'oc_group')
    assert.equal(model.deliveries[TASK_ID][0].targetSessionId, fullSession)
    assert.equal(model.runs[0].status, 'success')
    assert.equal(model.audit[0].action, 'create')
    assert.equal(model.extraTop, undefined)
    assert.doesNotMatch(JSON.stringify(res.json), /MUST-NOT-LEAK-TOP|MUST-NOT-LEAK/)
  } finally { await f.close() }
})

test('read model fails closed on symlink/oversize and degrades on bad version/ts', async () => {
  const f = await fixture()
  try {
    await mkdir(f.stateDir, { recursive: true, mode: 0o700 })
    const file = path.join(f.stateDir, 'ops-schedule.json')
    const outside = path.join(f.dir, 'outside.json')
    await writeFile(outside, 'DO-NOT-READ')
    await symlink(outside, file)
    const linked = await f.request('/schedule')
    assert.equal(linked.status, 500)
    assert.doesNotMatch(JSON.stringify(linked.json), /DO-NOT-READ|outside\.json/)
    await rm(file)
    await writeFile(file, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 })
    const big = await f.request('/schedule')
    assert.equal(big.status, 500)
    await rm(file)
    await writeFile(file, JSON.stringify({ version: 2, ts: Date.now(), available: true, tasks: [] }), { mode: 0o600 })
    const badVersion = await f.request('/schedule')
    assert.equal(badVersion.status, 200)
    assert.equal(badVersion.json.model, null)
    await writeFile(file, JSON.stringify({ version: 1, ts: -1, available: true, tasks: [] }), { mode: 0o600 })
    assert.equal((await f.request('/schedule')).json.model, null)
    await writeFile(file, JSON.stringify({ version: 1, ts: Date.now(), available: false,
      reason: 'DSH native schedule service is not mounted in this profile',
      tasks: [], deliveries: {}, runs: [], audit: [], limits: {} }), { mode: 0o600 })
    const off = await f.request('/schedule')
    assert.equal(off.json.model.available, false)
    assert.match(off.json.model.reason, /native schedule/)
    assert.deepEqual(off.json.model.tasks, []) // never fabricate tasks
  } finally { await f.close() }
})

test('readScheduleModel flags staleness, keeps ended/skipped states and historic once specs', async () => {
  const f = await fixture()
  try {
    await mkdir(f.stateDir, { recursive: true, mode: 0o700 })
    const doc = { version: 1, ts: Date.now() - 60000, available: true, limits: {},
      tasks: [{ id: TASK_ID, title: 'x', prompt: 'y',
        spec: { kind: 'once', at: '2020-01-01T00:00:00Z', timeZone: 'UTC' },
        status: 'ended', timingKind: 'at', timeZone: 'UTC' }],
      runs: [{ ts: 1, status: 'skipped' }], deliveries: {}, audit: [] }
    await writeFile(path.join(f.stateDir, 'ops-schedule.json'), JSON.stringify(doc), { mode: 0o600 })
    const model = await readScheduleModel(f.stateDir)
    assert.equal(model.stale, true)
    assert.equal(model.tasks[0].status, 'ended')
    assert.equal(model.tasks[0].spec.kind, 'once') // past once kept via validateSpecShape
    assert.equal(model.runs[0].status, 'skipped')
  } finally { await f.close() }
})

test('readScheduleResults and readOpsResults whitelist schedule outcomes with bounded detail', async () => {
  const f = await fixture()
  try {
    const resultsDir = path.join(f.stateDir, 'ops-control', 'results')
    await mkdir(resultsDir, { recursive: true, mode: 0o700 })
    const id = '33333333-3333-4333-8333-333333333333'
    await writeFile(path.join(resultsDir, id + '.json'), JSON.stringify({
      version: 1, id, ts: Date.now(), type: 'schedule', state: 'conflict',
      detail: '任务已被其他操作修改，请刷新后重试', secret: 'MUST-NOT-LEAK', extra: 1,
    }), { mode: 0o600 })
    // A legacy result must be filtered out of the schedule-only view.
    await writeFile(path.join(resultsDir, '55555555-5555-4555-8555-555555555555.json'),
      JSON.stringify({ version: 1, id: '55555555-5555-4555-8555-555555555555',
        ts: 2, type: 'cancel-task', state: 'completed' }), { mode: 0o600 })
    // An over-long detail is dropped (bounded <= 200).
    const longId = '44444444-4444-4444-8444-444444444444'
    await writeFile(path.join(resultsDir, longId + '.json'),
      JSON.stringify({ version: 1, id: longId, ts: 3, type: 'schedule', state: 'completed',
        detail: 'x'.repeat(201) }), { mode: 0o600 })
    const scheduleResults = await readScheduleResults(f.stateDir)
    assert.ok(scheduleResults.every(row => row.type === 'schedule'))
    const hit = scheduleResults.find(row => row.id === id)
    assert.equal(hit.state, 'conflict')
    assert.equal(hit.detail, '任务已被其他操作修改，请刷新后重试')
    assert.equal(hit.secret, undefined)
    assert.equal(hit.extra, undefined)
    assert.equal(scheduleResults.find(row => row.id === longId).detail, undefined)
    // readOpsResults keeps working for all types and now exposes schedule detail.
    const all = await readOpsResults(f.stateDir)
    assert.ok(all.some(row => row.type === 'schedule' && row.state === 'conflict'))
    assert.ok(all.some(row => row.type === 'cancel-task'))
    assert.equal(all.find(row => row.id === id).detail, '任务已被其他操作修改，请刷新后重试')
    const res = await f.request('/schedule/results')
    assert.equal(res.status, 200)
    assert.ok(res.json.commands.some(row => row.id === id))
  } finally { await f.close() }
})

// ---------------------------------------------------------------------------
// 5. Regression: existing behavior stays unchanged
// ---------------------------------------------------------------------------

test('legacy operator commands, /state auth and the 1024-byte cap are unchanged', async () => {
  const f = await fixture()
  try {
    const anonymous = await f.request('/state', 'GET', undefined, {})
    assert.equal(anonymous.status, 401)
    const state = await f.request('/state')
    assert.equal(state.status, 200)
    assert.equal(state.json.apiVersion, 1)
    assert.equal(state.json.source, 'profile')
    const accepted = await f.request('/ops/commands', 'POST',
      { type: 'cancel-task', ref: 'abcdef0123456789' }, mutating)
    assert.equal(accepted.status, 202)
    const id = accepted.json.command.id
    const data = JSON.parse(await readFile(path.join(f.stateDir, 'ops-control', 'requests', id + '.json'), 'utf8'))
    assert.deepEqual(Object.keys(data).sort(), ['id', 'ref', 'ts', 'type', 'version'])
    assert.equal(data.actor, undefined)
    const bad = await f.request('/ops/commands', 'POST', { type: 'shell', command: 'rm -rf /' }, mutating)
    assert.equal(bad.status, 400)
    // Legacy commands keep the 1024-byte cap (an explicit tiny cap yields 413).
    await assert.rejects(queueOperatorCommand(f.stateDir, { type: 'retry-outbox' }, 8),
      error => { assert.equal(error.status, 413); return true })
  } finally { await f.close() }
})
