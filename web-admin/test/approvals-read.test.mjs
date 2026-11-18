import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  readApprovalsModel, sanitizeApprovalsModel, emptyApprovalsModel,
} from '../src/approvals-read.mjs'

const NOW = 1_800_000_000_000
const ref = n => n.repeat(16)

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'feishu-approvals-'))
  const stateDir = path.join(dir, 'state')
  const write = async doc => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const raw = typeof doc === 'string' ? doc : JSON.stringify(doc)
    await writeFile(path.join(stateDir, 'ops-approvals.json'), raw, { mode: 0o600 })
  }
  return { dir, stateDir, write, close: () => rm(dir, { recursive: true, force: true }) }
}

function validModel() {
  return {
    version: 1, ts: NOW, available: true, reason: null, timeoutMs: 600000,
    pending: [{ ref: ref('a'), botId: 'default', chatRef: ref('b'), tool: 'bash',
      command: 'lark-cli calendar +agenda', requestedAt: NOW - 1000,
      expiresAt: NOW + 59000, secret: 'MUST-NOT-LEAK' }],
    rules: [{ ref: ref('c'), tool: 'bash', commandRoot: 'lark-cli',
      label: 'bash · lark-cli*', createdAt: NOW - 5000, createdByRef: ref('d'),
      lastUsedAt: null, uses: 3, secret: 'MUST-NOT-LEAK' }],
    records: [
      { ts: NOW - 100, tool: 'bash', command: 'lark-cli im +send',
        decision: 'allowed-permanent', botId: 'default', chatRef: ref('e'),
        ruleRef: ref('c'), elapsedMs: 42, secret: 'MUST-NOT-LEAK' },
      { ts: NOW - 200, tool: 'bash', command: null, decision: 'rejected',
        botId: 'default', chatRef: ref('e'), ruleRef: null, elapsedMs: null },
    ],
    recordLimit: 200,
    secretTop: 'MUST-NOT-LEAK-TOP',
  }
}

test('readApprovalsModel parses a published model and strips unknown fields', async () => {
  const f = await fixture()
  try {
    await f.write(validModel())
    const model = await readApprovalsModel(f.stateDir, NOW)
    assert.equal(model.version, 1)
    assert.equal(model.ts, NOW)
    assert.equal(model.available, true)
    assert.equal(model.reason, null)
    assert.equal(model.timeoutMs, 600000)
    assert.equal(model.recordLimit, 200)
    assert.equal(model.pending.length, 1)
    assert.equal(model.pending[0].ref, ref('a'))
    assert.equal(model.pending[0].botId, 'default')
    assert.equal(model.pending[0].tool, 'bash')
    assert.equal(model.pending[0].command, 'lark-cli calendar +agenda')
    assert.equal(model.pending[0].expiresAt, NOW + 59000)
    assert.equal(model.rules.length, 1)
    assert.equal(model.rules[0].label, 'bash · lark-cli*')
    assert.equal(model.rules[0].commandRoot, 'lark-cli')
    assert.equal(model.rules[0].createdByRef, ref('d'))
    assert.equal(model.rules[0].lastUsedAt, null)
    assert.equal(model.rules[0].uses, 3)
    assert.equal(model.records.length, 2)
    assert.equal(model.records[0].decision, 'allowed-permanent')
    assert.equal(model.records[1].decision, 'rejected')
    assert.equal(model.records[1].command, null)
    assert.equal(model.records[1].ruleRef, null)
    assert.equal(model.records[1].elapsedMs, null)
    assert.doesNotMatch(JSON.stringify(model), /MUST-NOT-LEAK|secretTop|secret"/)
  } finally { await f.close() }
})

test('missing approvals state or file degrades to a safe empty model', async () => {
  const f = await fixture()
  try {
    const absentDir = await readApprovalsModel(path.join(f.dir, 'missing'), NOW)
    assert.equal(absentDir.available, false)
    assert.equal(absentDir.version, 1)
    assert.equal(absentDir.ts, NOW)
    assert.equal(absentDir.timeoutMs, 600000)
    assert.equal(absentDir.recordLimit, 200)
    assert.match(absentDir.reason, /not been published/)
    assert.deepEqual(absentDir.pending, [])
    assert.deepEqual(absentDir.rules, [])
    assert.deepEqual(absentDir.records, [])

    await mkdir(f.stateDir, { recursive: true, mode: 0o700 })
    const absentFile = await readApprovalsModel(f.stateDir, NOW)
    assert.equal(absentFile.available, false)
    assert.match(absentFile.reason, /not been published/)
    assert.deepEqual(absentFile.pending, [])
  } finally { await f.close() }
})

test('corrupt, wrong-version, symlinked and oversized files degrade instead of throwing', async () => {
  const f = await fixture()
  try {
    await f.write('{broken json')
    let model = await readApprovalsModel(f.stateDir, NOW)
    assert.equal(model.available, false)
    assert.match(model.reason, /unavailable/)
    assert.deepEqual(model.pending, [])

    await f.write({ version: 2, ts: NOW, available: true, pending: [] })
    assert.equal((await readApprovalsModel(f.stateDir, NOW)).available, false)

    await f.write({ version: 1, ts: -1, available: true, pending: [] })
    assert.equal((await readApprovalsModel(f.stateDir, NOW)).available, false)

    await f.write({ version: 1, ts: NOW, available: true, pending: 'not-an-array' })
    model = await readApprovalsModel(f.stateDir, NOW)
    assert.equal(model.available, true)
    assert.deepEqual(model.pending, [])

    // Symlinked model file is refused (never read), not followed.
    const outside = path.join(f.dir, 'outside.json')
    await writeFile(outside, JSON.stringify(validModel()), { mode: 0o600 })
    await rm(path.join(f.stateDir, 'ops-approvals.json'))
    await symlink(outside, path.join(f.stateDir, 'ops-approvals.json'))
    model = await readApprovalsModel(f.stateDir, NOW)
    assert.equal(model.available, false)
    assert.match(model.reason, /unavailable/)
    assert.deepEqual(model.records, [])

    // Symlinked state directory is refused too.
    const linkedState = path.join(f.dir, 'linked-state')
    await symlink(f.stateDir, linkedState)
    assert.equal((await readApprovalsModel(linkedState, NOW)).available, false)

    // Oversized file fails closed to the safe empty model.
    await rm(path.join(f.stateDir, 'ops-approvals.json'))
    await f.write('x'.repeat(1024 * 1024 + 1))
    model = await readApprovalsModel(f.stateDir, NOW)
    assert.equal(model.available, false)
    assert.deepEqual(model.pending, [])
  } finally { await f.close() }
})

test('sanitizer bounds arrays, strings and numbers and drops invalid rows', () => {
  const records = Array.from({ length: 250 }, (_, i) => ({
    ts: NOW - i, tool: 'bash', command: 'lark-cli', decision: 'auto-allowed',
    botId: 'default', chatRef: ref('e'), ruleRef: null, elapsedMs: i,
  }))
  const rules = Array.from({ length: 250 }, (_, i) => ({
    ref: i.toString(16).padStart(16, '0'), tool: 'bash', label: 'rule ' + i,
    createdAt: NOW - i, createdByRef: ref('d'), lastUsedAt: null, uses: 1,
  }))
  const pending = Array.from({ length: 60 }, (_, i) => ({
    ref: i.toString(16).padStart(16, '0'), botId: 'default', chatRef: ref('b'),
    tool: 'bash', command: null, requestedAt: NOW, expiresAt: NOW + 1000,
  }))
  const model = sanitizeApprovalsModel({
    version: 1, ts: NOW, available: true, reason: null, timeoutMs: 9e15,
    pending, rules, records, recordLimit: 0,
  }, NOW)
  assert.equal(model.pending.length, 50)
  assert.equal(model.rules.length, 200)
  assert.equal(model.records.length, 200)
  // Newest-first order is preserved when capping.
  assert.equal(model.records[0].ts, NOW)
  assert.equal(model.records[1].ts, NOW - 1)
  assert.equal(model.timeoutMs, 24 * 60 * 60 * 1000)
  assert.equal(model.recordLimit, 1)

  const raw = {
    version: 1, ts: NOW, available: true,
    pending: [
      { ref: 'NOT-A-REF', tool: 'bash', requestedAt: NOW, expiresAt: NOW },
      { ref: ref('a'), tool: 'bash', requestedAt: NOW, expiresAt: NOW,
        command: 'a'.repeat(500) },
      { ref: ref('a'), tool: 'bash', requestedAt: NOW, expiresAt: NOW,
        command: 'ls\n\t-a\r\n' },
    ],
    rules: [
      { ref: 'UPPERCASE1234567', tool: 'bash', createdAt: NOW },
      { ref: ref('c'), tool: 'bash', createdAt: NOW, commandRoot: 'bad root!',
        label: 'x'.repeat(121), createdByRef: 'bad', lastUsedAt: 'nope', uses: 2.9 },
    ],
    records: [
      { ts: NOW, tool: 'bash', decision: 'approved' },
      { ts: NOW, tool: 'bash', decision: 'auto-allowed', elapsedMs: -1 },
      { ts: 'nope', tool: 'bash', decision: 'rejected' },
      { ts: NOW, tool: 'bash', decision: 'allowed-once', ruleRef: 'bad', elapsedMs: 7 },
    ],
  }
  const bounded = sanitizeApprovalsModel(raw, NOW)
  assert.equal(bounded.pending.length, 2)
  assert.equal(bounded.pending[0].command.length, 200)
  assert.equal(bounded.pending[1].command, 'ls -a')
  assert.equal(bounded.rules.length, 1)
  const rule = bounded.rules[0]
  assert.equal(rule.commandRoot, undefined)
  assert.equal(rule.label, 'bash') // over-long label falls back to the tool
  assert.equal(rule.createdByRef, null) // invalid ref degrades to null
  assert.equal(rule.lastUsedAt, null)
  assert.equal(rule.uses, 2) // clamped to an integer
  assert.equal(bounded.records.length, 2)
  assert.equal(bounded.records[0].elapsedMs, null) // invalid number -> null
  assert.equal(bounded.records[1].ruleRef, null) // invalid ref -> null, row kept
  assert.equal(bounded.records[1].elapsedMs, 7)
})

test('sanitizer keeps null-vs-missing semantics and rejects unknown top-level keys', () => {
  const missing = sanitizeApprovalsModel({
    version: 1, ts: NOW, available: true,
    pending: [{ ref: ref('a'), tool: 'bash', requestedAt: NOW, expiresAt: NOW }],
    rules: [{ ref: ref('c'), tool: 'bash', createdAt: NOW }],
    records: [{ ts: NOW, tool: 'bash', decision: 'requested' }],
  }, NOW)
  assert.equal(missing.pending[0].command, null)
  assert.equal(missing.rules[0].lastUsedAt, null)
  assert.equal(missing.rules[0].createdByRef, null)
  assert.equal(missing.rules[0].uses, 0)
  assert.equal(missing.records[0].ruleRef, null)
  assert.equal(missing.records[0].command, null)
  assert.equal(missing.records[0].elapsedMs, null)
  assert.equal(missing.timeoutMs, 600000)
  assert.equal(missing.recordLimit, 200)
  assert.ok(!('chatRef' in missing.pending[0]))

  const extra = sanitizeApprovalsModel({ version: 1, ts: NOW, available: true,
    pending: [], rules: [], records: [], anything: 'MUST-NOT-LEAK' }, NOW)
  assert.equal(extra.anything, undefined)
  assert.doesNotMatch(JSON.stringify(extra), /MUST-NOT-LEAK/)
})

test('unavailable models keep the gateway reason and never look available', () => {
  const model = sanitizeApprovalsModel({
    version: 1, ts: NOW, available: false,
    reason: 'DSH native approval service is not mounted in this profile',
    timeoutMs: 600000, pending: [], rules: [], records: [], recordLimit: 200,
  }, NOW)
  assert.equal(model.available, false)
  assert.match(model.reason, /native approval service/)
  assert.deepEqual(model.pending, [])
  assert.deepEqual(model.rules, [])
  assert.deepEqual(model.records, [])

  // Non-boolean `available` is never treated as true, and a non-string reason
  // is dropped instead of being surfaced.
  const invalid = sanitizeApprovalsModel({ version: 1, ts: NOW, available: 'yes',
    reason: { secret: 'MUST-NOT-LEAK' } }, NOW)
  assert.equal(invalid.available, false)
  assert.equal(invalid.reason, null)

  // The raised 30-minute approval window is preserved and clamped, never
  // rewritten by the Web Admin read model.
  assert.equal(sanitizeApprovalsModel({ version: 1, ts: NOW, available: true,
    timeoutMs: 1800000 }, NOW).timeoutMs, 1800000)
  assert.equal(sanitizeApprovalsModel({ version: 1, ts: NOW, available: true,
    timeoutMs: 1800001 }, NOW).timeoutMs, 1800001)

  const empty = emptyApprovalsModel('model offline', NOW)
  assert.equal(empty.version, 1)
  assert.equal(empty.ts, NOW)
  assert.equal(empty.available, false)
  assert.equal(empty.reason, 'model offline')
  assert.equal(empty.timeoutMs, 600000)
  assert.equal(empty.recordLimit, 200)
})
