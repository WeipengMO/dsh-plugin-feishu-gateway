import { afterEach, describe, expect, it } from 'vitest'
import type { InboundMessage } from '../../src/types.js'
import { MockFeishuTransport } from '../../src/channel/mock-transport.js'
import { resolveConfig } from '../../src/config.js'
import { FeishuGateway, type GatewayHealth } from '../../src/gateway.js'
import { MockSessionBridge } from '../../src/session/mock-session-bridge.js'
import { silentLogger } from '../../src/util/logger.js'
import { createGateway } from '../../src/index.js'
import { DurableInbox } from '../../src/inbox/inbox.js'
import type { SessionReply, WaitOptions } from '../../src/types.js'
import type { GatewayConfig } from '../../src/types.js'
import { tempDir } from '../helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

interface Harness {
  readonly gateway: FeishuGateway
  readonly transport: MockFeishuTransport
  readonly bridge: MockSessionBridge
  readonly config: GatewayConfig
  readonly stateDir: string
}

async function harness(
  overrides: Partial<GatewayConfig> = {},
  reply?: string | ((text: string) => string),
): Promise<Harness> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const config = resolveConfig({
    stateDir: dir,
    allowlist: ['ou_alice'],
    offline: true,
    sendRetries: 2,
    sendRetryBaseDelayMs: 1,
    ...overrides,
  })
  const transport = new MockFeishuTransport('default')
  const bridge = new MockSessionBridge({ reply })
  const gateway = createGateway(config, {
    transports: [transport],
    bridge,
    logger: silentLogger,
  })
  await gateway.start()
  return { gateway, transport, bridge, config, stateDir: dir }
}

const alice = (overrides: Partial<InboundMessage> = {}): Partial<InboundMessage> => ({
  senderId: 'ou_alice',
  text: 'hello',
  chatType: 'p2p',
  ...overrides,
})

describe('Gateway end-to-end pipeline (all transports mocked)', () => {
  it('receives an allowlisted DM, drives the native Session bridge and replies', async () => {
    const { gateway, transport, bridge } = await harness({}, 'model answer')
    await transport.emitMessage(alice())
    await gateway.whenIdle()

    expect(bridge.created).toHaveLength(1)
    expect(bridge.prompts).toEqual([{ sessionId: expect.any(String), text: 'hello' }])
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]).toMatchObject({ text: 'model answer', replyToMessageId: expect.any(String) })
    expect(gateway.health().status).toBe('ok')
    expect(gateway.health().processed).toBe(1)
    await gateway.stop()
  })

  it('drops messages from senders outside the allowlist', async () => {
    const { gateway, transport, bridge } = await harness()
    await transport.emitMessage(alice({ senderId: 'ou_mallory' }))
    await gateway.whenIdle()
    expect(transport.sent).toHaveLength(0)
    expect(bridge.created).toHaveLength(0)
    expect(gateway.health().rejected['sender-not-allowlisted']).toBe(1)
    await gateway.stop()
  })

  it('drops group chats by default', async () => {
    const { gateway, transport, bridge } = await harness()
    await transport.emitMessage(alice({ chatType: 'group' }))
    await gateway.whenIdle()
    expect(transport.sent).toHaveLength(0)
    expect(bridge.created).toHaveLength(0)
    expect(gateway.health().rejected['groups-disabled']).toBe(1)
    await gateway.stop()
  })

  it('deduplicates redelivered events (the WS reconnect case)', async () => {
    const { gateway, transport, bridge } = await harness()
    const messageId = 'om_duplicate'
    await transport.emitMessage(alice({ messageId }))
    await transport.emitMessage(alice({ messageId }))
    await gateway.whenIdle()
    expect(bridge.prompts).toHaveLength(1)
    expect(transport.sent).toHaveLength(1)
    await gateway.stop()
  })

  it('serializes rapid messages from the same chat', async () => {
    const { gateway, transport, bridge } = await harness({}, (text) => `reply:${text}`)
    await Promise.all([
      transport.emitMessage(alice({ messageId: 'om_1', text: 'one' })),
      transport.emitMessage(alice({ messageId: 'om_2', text: 'two' })),
    ])
    await gateway.whenIdle()
    expect(bridge.prompts.map((p) => p.text)).toEqual(['one', 'two'])
    expect(transport.sent.map((s) => s.text).sort()).toEqual(['reply:one', 'reply:two'])
    await gateway.stop()
  })

  it('keeps a chat on one Session over three same-process messages', async () => {
    const { gateway, transport, bridge } = await harness()
    for (const messageId of ['om_turn_1', 'om_turn_2', 'om_turn_3']) {
      await transport.emitMessage(alice({ messageId, chatId: 'oc_three_turns' }))
      await gateway.whenIdle()
    }
    expect(bridge.created).toHaveLength(1)
    expect(bridge.resumed).toEqual([
      bridge.created[0]!.sessionId,
      bridge.created[0]!.sessionId,
    ])
    expect(bridge.prompts.map((p) => p.sessionId)).toEqual([
      bridge.created[0]!.sessionId,
      bridge.created[0]!.sessionId,
      bridge.created[0]!.sessionId,
    ])
    await gateway.stop()
  })

  it('preserves the original Session mapping if cold resume fails', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const config = resolveConfig({ stateDir: dir, allowlist: ['ou_alice'], offline: true })
    const firstTransport = new MockFeishuTransport('default')
    const firstBridge = new MockSessionBridge()
    const first = createGateway(config, {
      transports: [firstTransport], bridge: firstBridge, logger: silentLogger,
    })
    await first.start()
    await firstTransport.emitMessage(alice({ messageId: 'om_session_first', chatId: 'oc_bound' }))
    await first.whenIdle()
    const originalSessionId = firstBridge.created[0]!.sessionId
    await first.stop()

    class FailingRestoreBridge extends MockSessionBridge {
      override async resume(_sessionId: string): Promise<void> {
        throw new Error('no agent factory registered')
      }
    }
    const secondTransport = new MockFeishuTransport('default')
    const secondBridge = new FailingRestoreBridge()
    const second = createGateway(config, {
      transports: [secondTransport], bridge: secondBridge, logger: silentLogger,
    })
    await second.start()
    await secondTransport.emitMessage(alice({ messageId: 'om_session_second', chatId: 'oc_bound' }))
    await second.whenIdle()
    expect(secondBridge.created).toHaveLength(0)
    expect(secondBridge.prompts).toHaveLength(0)
    expect(secondTransport.sent[0]?.text).toContain('已保留会话绑定')
    const { readFile } = await import('node:fs/promises')
    const data = JSON.parse(await readFile(`${dir}/sessions.json`, 'utf8')) as {
      bindings: Record<string, { sessionId: string }>
    }
    expect(data.bindings['default:oc_bound']?.sessionId).toBe(originalSessionId)
    await second.stop()
  })

  it('reuses one native Session per chat and resumes it after a restart', async () => {
    const { dir: stateDir, cleanup: cleanupState } = await tempDir()
    cleanups.push(cleanupState)
    const base = {
      stateDir,
      allowlist: ['ou_alice'],
      offline: true,
      sendRetries: 1,
      sendRetryBaseDelayMs: 1,
    }

    const transport1 = new MockFeishuTransport('default')
    const bridge1 = new MockSessionBridge({ reply: 'first' })
    const gateway1 = createGateway(resolveConfig(base), { transports: [transport1], bridge: bridge1, logger: silentLogger })
    await gateway1.start()
    await transport1.emitMessage(alice({ messageId: 'om_1', chatId: 'oc_persist' }))
    await gateway1.whenIdle()
    const firstSessionId = bridge1.created[0]!.sessionId
    await gateway1.stop()

    const transport2 = new MockFeishuTransport('default')
    const bridge2 = new MockSessionBridge({ reply: 'second' })
    const gateway2 = createGateway(resolveConfig(base), { transports: [transport2], bridge: bridge2, logger: silentLogger })
    await gateway2.start()
    await transport2.emitMessage(alice({ messageId: 'om_2', chatId: 'oc_persist' }))
    await gateway2.whenIdle()
    expect(bridge2.created).toHaveLength(0)
    expect(bridge2.resumed).toEqual([firstSessionId])
    expect(bridge2.prompts[0]?.sessionId).toBe(firstSessionId)
    await gateway2.stop()
  })

  it('replies with a diagnostic when the native Session bridge is unavailable', async () => {
    const { gateway, transport } = await harnessUnavailable()
    await transport.emitMessage(alice())
    await gateway.whenIdle()
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.text).toContain('DSH 原生 Session')
    await gateway.stop()
  })

  it('retries failed sends and drains the outbox on reconnect', async () => {
    const { gateway, transport } = await harness({}, 'retry reply')
    transport.remainingFailures = 2
    await transport.emitMessage(alice({ messageId: 'om_retry' }))
    await gateway.whenIdle()
    expect(transport.sent).toHaveLength(0)
    expect(gateway.health().outbox.pending).toBe(1)

    transport.remainingFailures = 0
    await transport.simulateReconnect()
    // Allow the reconnect-triggered drain to finish.
    await gateway.whenIdle()
    for (let i = 0; i < 20 && transport.sent.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(transport.sent).toHaveLength(1)
    await gateway.stop()
  })

  it('reports health and diagnostics without leaking secrets', async () => {
    const { gateway } = await harness()
    const health: GatewayHealth = await gateway.diagnostics()
    expect(health.status).toBe('ok')
    expect(health.transports).toEqual({ default: 'connected' })
    expect(health.sessionBridge.available).toBe(true)
    expect(JSON.stringify(health)).not.toContain('appSecret')
    await gateway.stop()
  })

  it('stops cleanly: closes transports and disposes every owned native Session', async () => {
    const { gateway, transport, bridge } = await harness()
    await transport.emitMessage(alice())
    await gateway.whenIdle()
    expect(bridge.created).toHaveLength(1)
    await gateway.stop()
    expect(transport.state).toBe('closed')
    expect(bridge.disposedSessions).toContain(bridge.created[0]?.sessionId)
    expect(gateway.health().status).toBe('stopped')
  })

  it('offline profile builds only mock transports (no network)', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const config = resolveConfig({
      stateDir: dir,
      offline: true,
      allowlist: [],
      bots: [{ id: 'default', enabled: true, domain: 'feishu', appIdEnv: 'APP_ID', appSecretEnv: 'APP_SECRET' }],
    })
    const gateway = createGateway(config, {
      logger: silentLogger,
      bridge: new MockSessionBridge(),
    })
    await gateway.start()
    expect(gateway.health().transports).toEqual({ default: 'connected' })
    expect(gateway.health().status).toBe('ok')
    await gateway.stop()
  })
  it('does not execute a formerly allowlisted message after access is revoked', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const inbox = new DurableInbox(dir)
    await inbox.open()
    await inbox.record({
      messageId: 'om_revoked', botId: 'default', chatId: 'oc_1',
      senderId: 'ou_alice', senderType: 'user', chatType: 'p2p',
      text: 'do something', createTime: 1, messageType: 'text',
    })
    const transport = new MockFeishuTransport('default')
    const bridge = new MockSessionBridge()
    const gateway = createGateway(resolveConfig({ stateDir: dir, allowlist: ['ou_other'], offline: true }),
      { transports: [transport], bridge, logger: silentLogger })
    await gateway.start()
    await gateway.whenIdle()
    expect(bridge.prompts).toHaveLength(0)
    expect(transport.sent).toHaveLength(0)
    await gateway.stop()
  })

  it('does not replay a crash-interrupted Agent turn; sends a recovery warning instead', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const inbox = new DurableInbox(dir)
    await inbox.open()
    await inbox.record({
      messageId: 'om_interrupted', botId: 'default', chatId: 'oc_1',
      senderId: 'ou_alice', senderType: 'user', chatType: 'p2p',
      text: 'modify files', createTime: 1, messageType: 'text',
    })
    await inbox.markRunning('om_interrupted')
    const transport = new MockFeishuTransport('default')
    const bridge = new MockSessionBridge()
    const gateway = createGateway(resolveConfig({ stateDir: dir, allowlist: ['ou_alice'], offline: true }),
      { transports: [transport], bridge, logger: silentLogger })
    await gateway.start()
    await gateway.whenIdle()
    expect(bridge.prompts).toHaveLength(0)
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.text).toContain('避免重复执行')
    await gateway.stop()
  })

  it('isolates the next message from the native Session of a timed-out turn', async () => {
    class TimeoutOnceBridge extends MockSessionBridge {
      private calls = 0
      override async waitForReply(sessionId: string, options: WaitOptions): Promise<SessionReply> {
        this.calls += 1
        if (this.calls === 1) return { text: 'incomplete', reason: 'timeout' }
        return super.waitForReply(sessionId, options)
      }
    }
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const transport = new MockFeishuTransport('default')
    const bridge = new TimeoutOnceBridge()
    const gateway = createGateway(resolveConfig({ stateDir: dir, allowlist: ['ou_alice'], offline: true }),
      { transports: [transport], bridge, logger: silentLogger })
    await gateway.start()
    await transport.emitMessage(alice({ messageId: 'om_timeout' }))
    await gateway.whenIdle()
    await transport.emitMessage(alice({ messageId: 'om_followup' }))
    await gateway.whenIdle()
    expect(bridge.cancelled).toContain(bridge.prompts[0]?.sessionId)
    expect(bridge.disposedSessions).toContain(bridge.prompts[0]?.sessionId)
    expect(bridge.created).toHaveLength(2)
    expect(bridge.prompts[0]?.sessionId).not.toBe(bridge.prompts[1]?.sessionId)
    expect(transport.sent[0]?.text).toContain('原会话已隔离')
    await gateway.stop()
  })

  it('isolates the Session of a crash-interrupted turn before the next message', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const config = resolveConfig({
      stateDir: dir, allowlist: ['ou_alice'], offline: true,
      replyTimeoutMs: 60_000, sendRetries: 1, sendRetryBaseDelayMs: 1,
    })
    const transport1 = new MockFeishuTransport('default')
    const bridge1 = new MockSessionBridge({ delayMs: 60_000 }) // hangs until aborted
    const gateway1 = createGateway(config, { transports: [transport1], bridge: bridge1, logger: silentLogger })
    await gateway1.start()
    await transport1.emitMessage(alice({ messageId: 'om_crash', chatId: 'oc_crash' }))
    for (let i = 0; i < 100 && bridge1.created.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(bridge1.created).toHaveLength(1)
    const interruptedSessionId = bridge1.created[0]!.sessionId
    // Abort leaves the record `running` and the chat->Session binding intact.
    await gateway1.stop()

    const transport2 = new MockFeishuTransport('default')
    const bridge2 = new MockSessionBridge({ reply: 'fresh answer' })
    const gateway2 = createGateway(config, { transports: [transport2], bridge: bridge2, logger: silentLogger })
    await gateway2.start()
    await gateway2.whenIdle()
    expect(bridge2.prompts).toHaveLength(0) // never auto-replay the uncertain turn
    await transport2.emitMessage(alice({ messageId: 'om_followup', chatId: 'oc_crash' }))
    await gateway2.whenIdle()
    // Recovery must have unbound the interrupted Session: a fresh one is used.
    expect(bridge2.resumed).not.toContain(interruptedSessionId)
    expect(bridge2.created).toHaveLength(1)
    expect(bridge2.prompts[0]?.sessionId).not.toBe(interruptedSessionId)
    await gateway2.stop()
  })

  it('rejects inbound events after stop instead of silently ACKing them', async () => {
    const { gateway } = await harness()
    await gateway.stop()
    await expect(gateway.handleInbound({
      messageId: 'om_late', botId: 'default', chatId: 'oc_1', chatType: 'p2p',
      senderId: 'ou_alice', senderType: 'user', text: 'late', createTime: 1, messageType: 'text',
    })).rejects.toThrow(/stopped/)
  })

  it('refuses a second live gateway on the same stateDir, then allows restart', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const config = resolveConfig({ stateDir: dir, allowlist: ['ou_alice'], offline: true })
    const first = createGateway(config, {
      transports: [new MockFeishuTransport('default')], bridge: new MockSessionBridge(), logger: silentLogger,
    })
    await first.start()
    const second = createGateway(config, {
      transports: [new MockFeishuTransport('default')], bridge: new MockSessionBridge(), logger: silentLogger,
    })
    await expect(second.start()).rejects.toThrow(/already owned by a running Feishu gateway/)
    await first.stop()
    const restarted = createGateway(config, {
      transports: [new MockFeishuTransport('default')], bridge: new MockSessionBridge(), logger: silentLogger,
    })
    await expect(restarted.start()).resolves.toBeUndefined()
    await restarted.stop()
  })

})

async function harnessUnavailable(): Promise<{ gateway: FeishuGateway; transport: MockFeishuTransport }> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const config = resolveConfig({ stateDir: dir, allowlist: ['ou_alice'], offline: true })
  const transport = new MockFeishuTransport('default')
  const unavailable = {
    available: false,
    unavailableReason: 'agents service missing',
    create: async () => {},
    resume: async () => {},
    submit: async () => {},
    waitForReply: async () => ({ text: '', reason: 'empty' as const }),
    cancel: () => {},
    dispose: async () => {},
  }
  const gateway = createGateway(config, { transports: [transport], bridge: unavailable, logger: silentLogger })
  await gateway.start()
  return { gateway, transport }
}

describe('periodic parked reply recovery', () => {
  it('retries a parked reply while the transport remains connected and no new inbound arrives', async () => {
    const { gateway, transport } = await harness({ outboxRetryIntervalMs: 25 })
    transport.remainingFailures = 2
    await transport.emitMessage(alice({ messageId: 'om_periodic_retry' }))
    await gateway.whenIdle()
    expect(gateway.health().outbox.pending).toBe(1)
    expect(transport.state).toBe('connected')
    // Wait for BOTH the delivery and the durable removal of the parked record.
    // `DurableOutbox.persist()` writes to disk *before* it swaps the in-memory
    // state, so observing `transport.sent` alone can be one write too early
    // (this made the assertion flaky under full-suite load, not in isolation).
    for (let i = 0; i < 100; i += 1) {
      if (transport.sent.length > 0 && gateway.health().outbox.pending === 0) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(transport.sent).toHaveLength(1)
    expect(gateway.health().outbox.pending).toBe(0)
    await gateway.stop()
  })
})

describe('fail-closed corrupt startup', () => {
  it('does not start with empty state or leave a connected transport behind', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const { writeFile, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(dir, 'outbox.json'), '{broken-json', 'utf8')
    const transport = new MockFeishuTransport('default')
    const gateway = createGateway(resolveConfig({ stateDir: dir, allowlist: ['ou_alice'] }), {
      transports: [transport], bridge: new MockSessionBridge(), logger: silentLogger,
    })
    await expect(gateway.start()).rejects.toThrow(/invalid durable state/)
    expect(await readFile(join(dir, 'outbox.json'), 'utf8')).toBe('{broken-json')
    expect(transport.state).not.toBe('connected')
    const retry = createGateway(resolveConfig({ stateDir: dir, allowlist: ['ou_alice'] }), {
      transports: [new MockFeishuTransport('default')], bridge: new MockSessionBridge(), logger: silentLogger,
    })
    await expect(retry.start()).rejects.toThrow(/invalid durable state/)
  })
})
