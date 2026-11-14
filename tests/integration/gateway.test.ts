import { afterEach, describe, expect, it } from 'vitest'
import type { InboundMessage } from '../../src/types.js'
import { MockFeishuTransport } from '../../src/channel/mock-transport.js'
import { resolveConfig } from '../../src/config.js'
import { FeishuGateway, type GatewayHealth } from '../../src/gateway.js'
import { MockSessionBridge } from '../../src/session/mock-session-bridge.js'
import { silentLogger } from '../../src/util/logger.js'
import { createGateway } from '../../src/index.js'
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
