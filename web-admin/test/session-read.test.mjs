import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { parseSessionQuery, querySessions, sessionStorage } from '../src/session-read.mjs'

const parse = value => parseSessionQuery(new URLSearchParams(value))
const ref = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'feishu-sessions-'))
  const dir = path.join(root, 'state')
  await mkdir(dir)
  const cleanup = async () => rm(root, { recursive: true, force: true })
  return { root, dir, cleanup }
}
const bindings = {
  'bot-a:ou_secret_1': { sessionId: 'private-session-1', createdAt: Date.parse('2026-01-01'),
    lastActiveAt: Date.parse('2026-02-03'), persisted: true },
  'bot-b:oc_secret_2': { sessionId: 'private-session-2', createdAt: Date.parse('2026-01-10'),
    lastActiveAt: Date.parse('2026-03-04'), persisted: false },
  'bot-a:ou_secret_3': { sessionId: 'private-session-3', createdAt: Date.parse('2026-02-05'),
    lastActiveAt: Date.parse('2026-04-06'), persisted: true, archived: true },
}

test('empty or missing state returns a safe empty inventory', async () => {
  const f = await fixture()
  try {
    const report = await querySessions(path.join(f.root, 'absent'), parse(''))
    assert.equal(report.total, 0)
    assert.equal(report.storage.totalBytes, 0)
    assert.deepEqual(report.items, [])
    const empty = await querySessions(f.dir, parse(''))
    assert.equal(empty.total, 0)
  } finally { await f.cleanup() }
})

test('inventory filters/sorts/paginates and never exposes native session or chat IDs', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.dir, 'sessions.json'), JSON.stringify({ bindings }))
    const q = parse('from=2026-02-01&to=2026-04-30&sort=lastActiveAt&pageSize=1')
    const result = await querySessions(f.dir, q)
    assert.equal(result.total, 3)
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].sessionRef, ref('private-session-3'))
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('private-session-'), false)
    assert.equal(serialized.includes('ou_secret'), false)
    assert.equal(serialized.includes('oc_secret'), false)
    assert.equal(result.items[0].status, 'archived')
    assert.equal((await querySessions(f.dir, parse('bot=bot-a&status=idle'))).total, 1)
    assert.equal((await querySessions(f.dir, parse('chat=ou_secret_1'))).total, 1)
    assert.equal((await querySessions(f.dir, parse('session=' + ref('private-session-2')))).total, 1)
    assert.equal((await querySessions(f.dir, parse('to=2026-02-02'))).total, 0)
    assert.equal((await querySessions(f.dir, parse('page=99&pageSize=1'))).items.length, 0)
  } finally { await f.cleanup() }
})

test('fresh runtime snapshot can mark an active session, stale one cannot', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.dir, 'sessions.json'), JSON.stringify({ bindings }))
    const state = { version: 1, ts: Date.now(), status: 'ok',
      tasks: [{ ref: 'a'.repeat(16), session: ref('private-session-1'), botId: 'bot-a', phase: 'running', elapsedMs: 10 }],
      sessions: [], transport: {}, stats: {} }
    await writeFile(path.join(f.dir, 'ops-runtime.json'), JSON.stringify(state))
    assert.equal((await querySessions(f.dir, parse('status=active'))).total, 1)
    await writeFile(path.join(f.dir, 'ops-runtime.json'), JSON.stringify({ ...state, ts: Date.now() - 60_000 }))
    assert.equal((await querySessions(f.dir, parse('status=active'))).total, 0)
  } finally { await f.cleanup() }
})

test('strict queries reject unknown, duplicate, malformed and oversized inputs', () => {
  for (const x of ['status=unsafe', 'from=2026-02-30', 'from=2026-03-01&to=2026-02-01',
    'page=0', 'pageSize=101', 'sort=__proto__', 'foo=bar', 'bot=x&bot=y', 'chat=%00bad']) {
    assert.throws(() => parse(x), { status: 400 })
  }
})

test('only whitelisted storage is counted, symlinks and corrupted state fail closed', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.dir, 'sessions.json'), JSON.stringify({ bindings }))
    await writeFile(path.join(f.dir, 'inbox.jsonl'), 'event\n')
    await writeFile(path.join(f.dir, 'unrelated-private-data.txt'), 'not counted')
    const storage = await sessionStorage(f.dir)
    assert.equal(storage.totalBytes,
      storage.categories.reduce((n, item) => n + item.bytes, 0))
    assert.equal(storage.categories.find(x => x.key === 'inbox').bytes, 6)
    await writeFile(path.join(f.dir, 'sessions.json'), '{broken')
    await assert.rejects(querySessions(f.dir, parse('')), /corrupt/)
    await rm(path.join(f.dir, 'sessions.json'))
    await symlink(path.join(f.dir, 'inbox.jsonl'), path.join(f.dir, 'sessions.json'))
    await assert.rejects(querySessions(f.dir, parse('')), /unsafe|ELOOP/)
  } finally { await f.cleanup() }
})
