import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { processOperatorCommands } from '../../src/ops/commands.js'

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ops-command-'))
  const folder = path.join(dir, 'ops-control', 'requests')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  return { dir, folder }
}
async function command(folder: string, kind: string, ref?: string, ts = Date.now()) {
  const id = randomUUID()
  await writeFile(path.join(folder, id + '.json'), JSON.stringify({ version: 1,
    id, ts, type: kind, ...(ref ? { ref } : {}) }), { mode: 0o600 })
  return id
}
describe('at-most-once operator mailbox', () => {
  it('claims a cancel command once and exposes only a narrow result', async () => {
    const { dir, folder } = await setup()
    try {
      const ref = 'ab1234567890cdef'
      const id = await command(folder, 'cancel-task', ref)
      const executed: string[] = []
      const run = () => processOperatorCommands(dir, async cmd => {
        executed.push(cmd.type + ':' + cmd.ref)
        return 'completed'
      })
      expect(await run()).toBe(1)
      expect(await run()).toBe(0)
      expect(executed).toEqual(['cancel-task:' + ref])
      const result = JSON.parse(await readFile(path.join(dir, 'ops-control', 'results', id + '.json'), 'utf8'))
      expect(result).toMatchObject({ version: 1, id, type: 'cancel-task', state: 'completed', ref })
      expect(JSON.stringify(result)).not.toContain('chat')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('does not execute expired or malformed requests', async () => {
    const { dir, folder } = await setup()
    try {
      await command(folder, 'retry-outbox', undefined, Date.now() - 45_000)
      await command(folder, 'dangerous-tool')
      await command(folder, 'cancel-task', 'invalid-id')
      let calls = 0
      expect(await processOperatorCommands(dir, async () => {
        calls += 1
        return 'completed'
      })).toBe(3)
      expect(calls).toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('retries existing outbox queue only as a declared capability', async () => {
    const { dir, folder } = await setup()
    try {
      await command(folder, 'retry-outbox')
      const types: string[] = []
      await processOperatorCommands(dir, async cmd => {
        types.push(cmd.type)
        expect(cmd.ref).toBeUndefined()
        return 'completed'
      })
      expect(types).toEqual(['retry-outbox'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('Session lifecycle commands', () => {
  it('dispatches versioned archive/unbind once without carrying sensitive IDs', async () => {
    const { dir, folder } = await setup()
    try {
      const refs = ['archive-session', 'unbind-session'] as const
      const seen: string[] = []
      for (const type of refs) {
        const id = randomUUID()
        await writeFile(path.join(folder, id + '.json'), JSON.stringify({
          version: 1, id, ts: Date.now(), type, ref: 'abcdef1234567890',
          expectedLastActiveAt: 12345,
        }), { mode: 0o600 })
      }
      expect(await processOperatorCommands(dir, async cmd => {
        seen.push(cmd.type + ':' + cmd.expectedLastActiveAt)
        return 'completed'
      })).toBe(2)
      expect(seen.sort()).toEqual(['archive-session:12345', 'unbind-session:12345'])
      expect(await processOperatorCommands(dir, async () => 'completed')).toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects Session commands without a valid version or reference', async () => {
    const { dir, folder } = await setup()
    try {
      const cases = [
        { type: 'archive-session', ref: 'abcdef1234567890' },
        { type: 'unbind-session', ref: 'invalid', expectedLastActiveAt: 111 },
        { type: 'unbind-session', ref: 'abcdef1234567890', expectedLastActiveAt: -1 },
      ]
      for (const bad of cases) {
        const id = randomUUID()
        await writeFile(path.join(folder, id + '.json'),
          JSON.stringify({ version: 1, id, ts: Date.now(), ...bad }))
      }
      let executed = 0
      expect(await processOperatorCommands(dir, async () => { executed += 1; return 'completed' })).toBe(3)
      expect(executed).toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('bounded bulk Session commands', () => {
  const item = { ref: 'a'.repeat(16), chatRef: 'b'.repeat(16),
    botId: 'default', expectedLastActiveAt: 1_700_000_000_000 }
  async function writeBatch(folder: string, payload: unknown): Promise<string> {
    const id = randomUUID()
    await writeFile(path.join(folder, id + '.json'), JSON.stringify({
      version: 1, id, ts: Date.now(), type: 'batch-sessions', batch: payload,
    }), { mode: 0o600 })
    return id
  }

  it('executes only a strictly validated hashed batch, once', async () => {
    const { dir, folder } = await setup()
    try {
      const id = await writeBatch(folder, { action: 'unlink', items: [item] })
      const calls: string[] = []
      expect(await processOperatorCommands(dir, async cmd => {
        calls.push(cmd.type + ':' + cmd.batch?.action + ':' + cmd.batch?.items.length)
        return { state: 'completed', detail: 'applied=1 skipped=0 total=1' }
      })).toBe(1)
      expect(calls).toEqual(['batch-sessions:unlink:1'])
      expect(await processOperatorCommands(dir, async () => 'completed')).toBe(0)
      const result = JSON.parse(await readFile(path.join(dir, 'ops-control', 'results', id + '.json'), 'utf8'))
      expect(result).toMatchObject({ type: 'batch-sessions', state: 'completed',
        detail: 'applied=1 skipped=0 total=1' })
      expect(JSON.stringify(result)).not.toContain(item.chatRef)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects duplicates, malformed fields, oversized arrays and unknown actions', async () => {
    const { dir, folder } = await setup()
    try {
      const bad = [
        { action: 'delete-native', items: [item] },
        { action: 'unlink', items: [] },
        { action: 'archive', items: Array(21).fill(item) },
        { action: 'unlink', items: [item, item] },
        { action: 'archive', items: [{ ...item, chatRef: 'oc_secret' }] },
        { action: 'archive', items: [{ ...item, expectedLastActiveAt: -1 }] },
        { action: 'archive', items: [{ ...item, workspace: '/tmp' }] },
        { action: 'archive', items: [item], force: true },
      ]
      const ids: string[] = []
      for (const payload of bad) ids.push(await writeBatch(folder, payload))
      let executed = 0
      expect(await processOperatorCommands(dir, async () => { executed += 1; return 'completed' }))
        .toBe(bad.length)
      expect(executed).toBe(0)
      for (const id of ids) {
        const result = JSON.parse(await readFile(path.join(dir, 'ops-control', 'results', id + '.json'), 'utf8'))
        expect(result.type).toBe('batch-sessions')
        expect(result.state).toBe('rejected')
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('native schedule operator commands', () => {
  const valid = () => ({
    action: 'create',
    clientRef: randomUUID(),
    title: '每日简报',
    prompt: '汇总今天的新闻',
    spec: { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' },
    notify: 'both',
    delivery: { botId: 'default', chatId: 'oc_abc123', chatType: 'p2p', senderId: 'ou_allowed123' },
  })
  async function schedule(dir: string, folder: string, payload: unknown, extra: Record<string, unknown> = {}) {
    const id = randomUUID()
    await writeFile(path.join(folder, id + '.json'), JSON.stringify({
      version: 1, id, ts: Date.now(), type: 'schedule', actor: 'dsh-web-admin',
      schedule: payload, ...extra,
    }), { mode: 0o600 })
    return id
  }

  it('delivers a bounded schedule payload exactly once with a typed result', async () => {
    const { dir, folder } = await setup()
    try {
      const id = await schedule(dir, folder, valid())
      const seen: string[] = []
      await processOperatorCommands(dir, async (cmd) => {
        seen.push(cmd.type + ':' + (cmd.schedule?.action ?? 'none'))
        return { state: 'completed', detail: 'created schedule-abc' }
      })
      expect(seen).toEqual(['schedule:create'])
      const result = JSON.parse(await readFile(path.join(dir, 'ops-control', 'results', id + '.json'), 'utf8'))
      expect(result).toMatchObject({ type: 'schedule', state: 'completed', detail: 'created schedule-abc' })
      expect(await processOperatorCommands(dir, async () => 'completed')).toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects malformed schedule payloads without invoking the executor', async () => {
    const { dir, folder } = await setup()
    try {
      const base = valid()
      const cases = [
        { ...base, action: 'dangerous' },
        { ...base, prompt: 'x'.repeat(4001) },
        { ...base, delivery: { botId: 'default', chatId: 'bad', chatType: 'p2p' } },
        { ...base, action: 'create', unknownField: true },
      ]
      const ids: string[] = []
      for (const payload of cases) ids.push(await schedule(dir, folder, payload))
      let executed = 0
      await processOperatorCommands(dir, async () => { executed += 1; return 'completed' })
      expect(executed).toBe(0)
      for (const id of ids) {
        const result = JSON.parse(await readFile(path.join(dir, 'ops-control', 'results', id + '.json'), 'utf8'))
        expect(result).toMatchObject({ type: 'schedule', state: 'rejected' })
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('skips oversized schedule requests and maps an unknown state to error', async () => {
    const { dir, folder } = await setup()
    try {
      const id = await schedule(dir, folder, { ...valid(), prompt: 'x'.repeat(9000) })
      expect(await processOperatorCommands(dir, async () => 'completed')).toBe(0)
      const resultNames = await readdir(path.join(dir, 'ops-control', 'results')).catch(() => [])
      expect(resultNames).toHaveLength(0)
      const second = await schedule(dir, folder, valid())
      await processOperatorCommands(dir, async () => ({ state: 'weird-state' } as never))
      const result = JSON.parse(await readFile(path.join(dir, 'ops-control', 'results', second + '.json'), 'utf8'))
      expect(result.state).toBe('error')
      expect(id).toBeTruthy()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('permanent approval revocation command', () => {
  it('dispatches one versioned approval-revoke carrying only a 16-hex ref', async () => {
    const { dir, folder } = await setup()
    try {
      const ref = 'ab1234567890cdef'
      const id = await command(folder, 'approval-revoke', ref)
      const seen: Array<{ type: string; ref?: string }> = []
      expect(await processOperatorCommands(dir, async cmd => {
        seen.push({ type: cmd.type, ...(cmd.ref ? { ref: cmd.ref } : {}) })
        return { state: 'completed', detail: 'revoked bash · lark-cli*' }
      })).toBe(1)
      expect(seen).toEqual([{ type: 'approval-revoke', ref }])
      const result = JSON.parse(await readFile(path.join(dir, 'ops-control', 'results', id + '.json'), 'utf8'))
      expect(result).toMatchObject({ version: 1, type: 'approval-revoke', state: 'completed', ref })
      expect(result.detail).toContain('revoked')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects malformed, extra-field or expired revocation requests', async () => {
    const { dir, folder } = await setup()
    try {
      await command(folder, 'approval-revoke', 'not-a-ref')
      const extra = randomUUID()
      await writeFile(path.join(folder, extra + '.json'), JSON.stringify({
        version: 1, id: extra, ts: Date.now(), type: 'approval-revoke',
        ref: 'ab1234567890cdef', extra: 'nope',
      }), { mode: 0o600 })
      await command(folder, 'approval-revoke', 'ab1234567890cdef', Date.now() - 45_000)
      let calls = 0
      expect(await processOperatorCommands(dir, async () => {
        calls += 1
        return 'completed'
      })).toBe(3)
      expect(calls).toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
