import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpsTelemetry, opsRef } from '../../src/ops/telemetry.js'

describe('privacy-safe operations telemetry', () => {
  it('persists hashed correlation references and only allowlisted fields', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'feishu-ops-'))
    try {
      const ops = new OpsTelemetry(dir)
      const chat = 'om_private_message_123'
      const session = 'session-secret-foo'
      await ops.record({ kind: 'task', state: 'done', botId: 'default',
        ref: chat, session, model: 'deepseek-chat', tokens: 450, elapsedMs: 9000 })
      await ops.record({ kind: 'system', state: 'custom secret /home/private' })
      await ops.snapshot({ version: 1, ts: Date.now(), status: 'ok',
        tasks: [{ ref: opsRef(chat), botId: 'default', phase: 'running', elapsedMs: 123 }],
        sessions: [{ ref: opsRef(session), createdAt: 1, lastActiveAt: 10, persisted: true }],
        transport: { default: { state: 'connected', reconnects: 0, failures: 0 } },
        stats: { activeTurns: 1, boundSessions: 1, pendingApprovals: 0, processed: 1,
          errors: 0, outboxPending: 0, inboxPending: 0 } })
      await ops.whenIdle()
      const journal = await readFile(path.join(dir, 'ops-events.jsonl'), 'utf8')
      expect(journal).toContain(opsRef(chat))
      expect(journal).not.toContain(chat)
      expect(journal).not.toContain(session)
      expect(journal).not.toContain('/home/private')
      expect(journal.trim().split('\n')).toHaveLength(1)
      expect((await stat(path.join(dir, 'ops-events.jsonl'))).mode & 0o777).toBe(0o600)
      expect((await stat(path.join(dir, 'ops-runtime.json'))).mode & 0o777).toBe(0o600)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('generates stable hash refs without storing raw IDs', () => {
    expect(opsRef('a')).toMatch(/^[a-f0-9]{16}$/)
    expect(opsRef('a')).toBe(opsRef('a'))
    expect(opsRef('a')).not.toBe(opsRef('b'))
  })
})
