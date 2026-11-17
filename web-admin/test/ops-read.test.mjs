import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readOpsSnapshot } from '../src/ops-read.mjs'

async function snapshotWith(doc) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'feishu-ops-read-'))
  await writeFile(path.join(dir, 'ops-runtime.json'), JSON.stringify({
    version: 1, ts: Date.now(), status: 'ok',
    tasks: [], sessions: [], transport: {}, stats: {}, ...doc,
  }), { mode: 0o600 })
  return { dir, read: () => readOpsSnapshot(dir) }
}

test('agent preset roster is strictly whitelisted and never leaks unknown fields', async () => {
  const f = await snapshotWith({
    agentPresets: {
      ts: Date.now(), incomplete: false, defaultId: 'planner', secret: 'TOP-SECRET',
      presets: [
        { id: 'planner', name: 'Planner', description: 'Plans work', isDefault: true, secret: 'row-secret' },
        { id: 'coder', isDefault: false, broken: 'missing preset files', rawError: { body: 'NEVER' } },
        { id: 'bad id', name: 'Invalid' },
        { name: 'no id' },
      ],
    },
  })
  try {
    const result = await f.read()
    assert.ok(result.agentPresets)
    assert.ok(Number.isFinite(result.agentPresets.ts))
    assert.equal(result.agentPresets.incomplete, false)
    assert.equal(result.agentPresets.defaultId, 'planner')
    assert.deepEqual(result.agentPresets.presets, [
      { id: 'planner', name: 'Planner', description: 'Plans work', isDefault: true },
      { id: 'coder', isDefault: false, broken: 'missing preset files' },
    ])
    const json = JSON.stringify(result)
    assert.doesNotMatch(json, /TOP-SECRET|row-secret|NEVER|rawError|"secret"/)
  } finally { await rm(f.dir, { recursive: true, force: true }) }
})

test('invalid or absent agent preset telemetry is omitted, not fabricated', async () => {
  const absent = await snapshotWith({})
  try {
    assert.equal(Object.prototype.hasOwnProperty.call(await absent.read(), 'agentPresets'), false)
  } finally { await rm(absent.dir, { recursive: true, force: true }) }

  const noTs = await snapshotWith({ agentPresets: { incomplete: false, presets: [] } })
  try {
    assert.equal(Object.prototype.hasOwnProperty.call(await noTs.read(), 'agentPresets'), false)
  } finally { await rm(noTs.dir, { recursive: true, force: true }) }

  const badShape = await snapshotWith({ agentPresets: ['not-an-object'] })
  try {
    assert.equal(Object.prototype.hasOwnProperty.call(await badShape.read(), 'agentPresets'), false)
  } finally { await rm(badShape.dir, { recursive: true, force: true }) }
})
