import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { dayInZone, parseUsageQuery, queryUsage, usageCsv } from '../src/usage-read.mjs'

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'feishu-usage-'))
  const usage = path.join(dir, 'ops-usage')
  await mkdir(usage, { mode: 0o700 })
  const write = async (date, records) =>
    writeFile(path.join(usage, date + '.jsonl'), records.map(x => JSON.stringify(x)).join('\n') + '\n')
  return { dir, write, close: () => rm(dir, { recursive: true, force: true }) }
}
const ref = 'a'.repeat(16)
const session = 'b'.repeat(16)
const user = 'c'.repeat(16)
const chat = 'd'.repeat(16)
const base = { version: 1, ref, botId: 'default', session, user, chat, model: 'deepseek/chat', status: 'done' }

test('date validation and IANA time zone enforce safe bounded queries', () => {
  const q = parseUsageQuery(new URLSearchParams('from=2026-11-14&to=2026-11-15&tz=Asia%2FShanghai'))
  assert.equal(q.from, '2026-11-14')
  assert.equal(dayInZone(Date.parse('2026-11-14T16:01:00Z'), 'Asia/Shanghai'), '2026-11-15')
  assert.throws(() => parseUsageQuery(new URLSearchParams('from=2026-02-30&to=2026-03-02')), /invalid date/)
  assert.throws(() => parseUsageQuery(new URLSearchParams('tz=Fake%2FZone')), /time zone/)
  assert.throws(() => parseUsageQuery(new URLSearchParams('from=2024-01-01&to=2026-01-01')), /366/)
  assert.throws(() => parseUsageQuery(new URLSearchParams('user=raw-feishu-id')), /invalid usage filter/)
  assert.throws(() => parseUsageQuery(new URLSearchParams('anything=secret')), /unsupported/)
})

test('cross-midnight settlement, retries, missing usage, filtering, aggregation, CSV', async () => {
  const f = await fixture()
  try {
    await f.write('2026-11-14', [
      { ...base, ts: Date.parse('2026-11-14T16:00:00Z'), inputTokens: 10, outputTokens: 5 },
      { ...base, ts: Date.parse('2026-11-14T16:01:00Z'), inputTokens: 20, outputTokens: 10 },
      { ...base, ref: 'e'.repeat(16), status: 'failed',
        ts: Date.parse('2026-11-14T16:02:00Z') },
      { ...base, ref: 'f'.repeat(16), model: 'other/model',
        ts: Date.parse('2026-11-14T16:03:00Z'), inputTokens: 4, outputTokens: 6 }
    ])
    const q = parseUsageQuery(new URLSearchParams(
      'from=2026-11-15&to=2026-11-15&tz=Asia%2FShanghai&period=day'))
    const result = await queryUsage(f.dir, q)
    assert.equal(result.summary.calls, 2)
    assert.equal(result.summary.turns, 3)
    assert.equal(result.summary.unknownTurns, 1)
    assert.equal(result.summary.failedTurns, 1)
    assert.equal(result.summary.totalTokens, 40)
    assert.equal(result.daily[0].date, '2026-11-15')
    assert.equal(result.daily[0].coverage, 'partial')
    assert.deepEqual(result.facets.sessions, [session])
    assert.match(usageCsv(result), /2026-11-15,partial,3,2,1,1,0,24,16/)
    const filtered = await queryUsage(f.dir, parseUsageQuery(new URLSearchParams(
      'from=2026-11-15&to=2026-11-15&tz=Asia%2FShanghai&model=deepseek%2Fchat&session=' + session)))
    assert.equal(filtered.summary.totalTokens, 30)
    assert.equal(filtered.summary.calls, 1)
    const byUser = await queryUsage(f.dir, parseUsageQuery(new URLSearchParams(
      'from=2026-11-15&to=2026-11-15&tz=Asia%2FShanghai&user=' + user +
      '&chat=' + chat)))
    assert.equal(byUser.summary.totalTokens, 40)
    const none = await queryUsage(f.dir, parseUsageQuery(new URLSearchParams(
      'from=2026-11-10&to=2026-11-15&tz=Asia%2FShanghai&period=week')))
    assert.equal(none.daily[0].coverage, 'unavailable')
    assert.equal(none.daily[0].value, null)
    assert.equal(none.series.length, 2)
  } finally { await f.close() }
})

test('never manufactures historic zero usage when the ledger does not exist', async () => {
  const f = await fixture()
  try {
    const q = parseUsageQuery(new URLSearchParams('from=2026-11-10&to=2026-11-11'))
    const result = await queryUsage(f.dir, q)
    assert.equal(result.coverage.available, false)
    assert.equal(result.summary.value, null)
    assert.deepEqual(result.daily.map(row => row.value), [null, null])
    assert.equal(result.summary.calls, 0)
  } finally { await f.close() }
})
