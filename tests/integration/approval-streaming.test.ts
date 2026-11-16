import { afterEach, describe, expect, it } from 'vitest'
import { createGateway } from '../../src/index.js'
import { resolveConfig } from '../../src/config.js'
import { MockFeishuTransport } from '../../src/channel/mock-transport.js'
import { MockSessionBridge } from '../../src/session/mock-session-bridge.js'
import { silentLogger } from '../../src/util/logger.js'
import { sleep } from '../../src/util/retry.js'
import { tempDir } from '../helpers.js'
import type { GatewayConfig, SessionReply, WaitOptions } from '../../src/types.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn() })

async function until(test: () => boolean): Promise<void> {
  for (let n = 0; n < 100 && !test(); n += 1)
    await new Promise(resolve => setTimeout(resolve, 10))
  if (!test()) throw new Error('condition not reached')
}
class SlowBridge extends MockSessionBridge {
  override async waitForReply(sessionId: string, options: WaitOptions): Promise<SessionReply> {
    await sleep(10_000, options.signal)
    return super.waitForReply(sessionId, options)
  }
}
async function boot(bridge: MockSessionBridge, config: Partial<GatewayConfig> = {}) {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const t = new MockFeishuTransport('default')
  const gateway = createGateway(resolveConfig({
    stateDir: dir, offline: true, allowlist: ['ou_alice'],
    sendRetries: 1, sendRetryBaseDelayMs: 1, streamIntervalMs: 500,
    ...config,
  }), { transports: [t], bridge, logger: silentLogger })
  await gateway.start()
  const emit = (id: string, text: string, chatId = 'oc_one') =>
    t.emitMessage({ messageId: id, chatId, senderId: 'ou_alice', text })
  return { gateway, bridge, t, emit }
}

describe('Feishu callback and native DSH approval integration', () => {
  it('approves a single tool call for its active chat only and never invokes the LLM for the button', async () => {
    const b = await boot(new SlowBridge(), { approvalCards: true })
    await b.emit('om_work', 'run tool')
    await until(() => b.bridge.prompts.length === 1)
    const sessionId = b.bridge.prompts[0]!.sessionId
    const approved = b.gateway.answerApproval({ agent: { id: sessionId }, toolName: 'bash' },
      async () => 'unavailable')
    await until(() => b.gateway.health().pendingApprovals === 1)
    const card = b.t.interactiveCards[0]!
    const first = (((card.card as any).body.elements.find((e: any) => e.tag === 'column_set').columns[0].elements[0].behaviors[0].value))
    const event = {
      botId: 'default', chatId: 'oc_one', actorOpenId: 'ou_alice',
      messageId: card.messageId, value: first,
    }
    expect((await b.t.emitCardAction({ ...event, actorOpenId: 'ou_mallory' })).toast.type).toBe('warning')
    expect(b.gateway.health().pendingApprovals).toBe(1)
    expect((await b.t.emitCardAction(event)).toast.type).toBe('success')
    expect(await approved).toBe('allowed-once')
    expect(b.bridge.prompts).toHaveLength(1)
    await b.emit('om_cancel', '/cancel')
    await b.gateway.whenIdle()
    await b.gateway.stop()
  })

  it('cancel via stream card is allowed only from its exact chat, sender and message', async () => {
    const b = await boot(new SlowBridge(), { streamCards: true })
    await b.emit('om_slow', 'long task')
    await until(() => b.t.streamCards.length === 1)
    const card = b.t.streamCards[0]!
    expect(b.gateway.health().activeTurns).toBe(1)
    const click = { botId: 'default', chatId: 'oc_one', actorOpenId: 'ou_alice',
      messageId: card.messageId,
      value: { namespace: 'dsh-feishu-gateway', kind: 'cancel', nonce: card.nonce } }
    expect((await b.t.emitCardAction({ ...click, chatId: 'oc_other' })).toast.type).toBe('warning')
    expect((await b.t.emitCardAction({ ...click, messageId: 'fake' })).toast.type).toBe('warning')
    expect((await b.t.emitCardAction(click)).toast.type).toBe('success')
    await b.gateway.whenIdle()
    expect(b.bridge.cancelled).toContain(b.bridge.prompts[0]?.sessionId)
    expect(b.t.streamReplacements).toHaveLength(1)
    expect(JSON.stringify(b.t.streamReplacements[0]?.card)).toContain('已取消')
    expect(JSON.stringify(b.t.streamReplacements[0]?.card)).not.toContain('取消当前任务')
    expect(b.t.sent.find(x => x.replyToMessageId === 'om_slow')).toBeUndefined()
    await b.gateway.stop()
  })

  it('a Feishu cancelled Agent cannot approve a stale tool card', async () => {
    const b = await boot(new SlowBridge(), { approvalCards: true, streamCards: true })
    await b.emit('om_work', 'pending approval')
    await until(() => b.t.streamCards.length === 1)
    const session = b.bridge.prompts[0]!.sessionId
    const decision = b.gateway.answerApproval({ agent: { id: session }, toolName: 'shell' },
      async () => 'unavailable')
    await until(() => b.gateway.health().pendingApprovals === 1)
    const card = b.t.interactiveCards[0]!
    const value = (card.card as any).body.elements.find((e: any) => e.tag === 'column_set').columns[0].elements[0].behaviors[0].value
    await b.emit('om_cancel', '/cancel')
    await b.gateway.whenIdle()
    expect(await decision).toBe('cancelled')
    expect((await b.t.emitCardAction({
      botId: 'default', chatId: 'oc_one', actorOpenId: 'ou_alice',
      messageId: card.messageId, value,
    })).toast.type).toBe('warning')
    await b.gateway.stop()
  })

  it('revokes an outstanding approval when Feishu WS reconnects', async () => {
    const b = await boot(new SlowBridge(), { approvalCards: true })
    await b.emit('om_work', 'needs approval')
    await until(() => b.bridge.prompts.length === 1)
    const sessionId = b.bridge.prompts[0]!.sessionId
    const decision = b.gateway.answerApproval({ agent: { id: sessionId }, toolName: 'bash' },
      async () => 'unavailable')
    await until(() => b.gateway.health().pendingApprovals === 1)
    await b.t.simulateReconnect()
    expect(await decision).toBe('unavailable')
    expect(b.gateway.health().pendingApprovals).toBe(0)
    await b.emit('om_cancel', '/cancel')
    await b.gateway.whenIdle()
    await b.gateway.stop()
  })

  it('enforces the original sender for group approvals and cancellation even in a shared session', async () => {
    const b = await boot(new SlowBridge(), {
      approvalCards: true, streamCards: true,
      groupPolicy: 'open', groupSenderAllowlist: ['ou_alice', 'ou_bob'],
      groups: [{ chatId: 'oc_shared', enabled: true, requireMention: false, sessionScope: 'group' }],
    })
    await b.t.emitMessage({ messageId: 'om_group_work', chatId: 'oc_shared',
      senderId: 'ou_alice', chatType: 'group', text: 'run tool' })
    await until(() => b.bridge.prompts.length === 1 && b.t.streamCards.length === 1)
    const sessionId = b.bridge.prompts[0]!.sessionId
    const decision = b.gateway.answerApproval({ agent: { id: sessionId }, toolName: 'bash' },
      async () => 'unavailable')
    await until(() => b.gateway.health().pendingApprovals === 1)
    const card = b.t.interactiveCards[0]!
    const actionValue = (card.card as any).body.elements.find((e: any) => e.tag === 'column_set').columns[0].elements[0].behaviors[0].value
    const approval = { botId: 'default', chatId: 'oc_shared', messageId: card.messageId,
      actorOpenId: 'ou_bob', value: actionValue }
    // Bob is permitted to use the group, but is not Alice, the turn owner.
    expect((await b.t.emitCardAction(approval)).toast.type).toBe('warning')
    expect(b.gateway.health().pendingApprovals).toBe(1)
    expect((await b.t.emitCardAction({ ...approval, actorOpenId: 'ou_alice' })).toast.type).toBe('success')
    expect(await decision).toBe('allowed-once')

    const progress = b.t.streamCards[0]!
    const cancelCard = { botId: 'default', chatId: 'oc_shared', actorOpenId: 'ou_bob',
      messageId: progress.messageId,
      value: { namespace: 'dsh-feishu-gateway', kind: 'cancel', nonce: progress.nonce } }
    expect((await b.t.emitCardAction(cancelCard)).toast.type).toBe('warning')
    await b.t.emitMessage({ messageId: 'om_bob_cancel', chatId: 'oc_shared',
      senderId: 'ou_bob', chatType: 'group', text: '/cancel' })
    await until(() => b.t.sent.some(x => x.replyToMessageId === 'om_bob_cancel'))
    expect(b.bridge.cancelled).not.toContain(sessionId)
    expect((await b.t.emitCardAction({ ...cancelCard, actorOpenId: 'ou_alice' })).toast.type).toBe('success')
    await b.gateway.whenIdle()
    expect(b.bridge.cancelled).toContain(sessionId)
    await b.gateway.stop()
  })

  it('uses one final CardKit reply with no duplicate text and preserves the native Session', async () => {
    const b = await boot(new MockSessionBridge({ reply: 'final model response' }), { streamCards: true })
    await b.emit('om_answer', 'hello')
    await b.gateway.whenIdle()
    expect(b.t.streamCards).toHaveLength(1)
    expect(b.t.streamReplacements).toHaveLength(1)
    expect(b.t.sent.find(x => x.replyToMessageId === 'om_answer')).toBeUndefined()
    const card = b.t.streamReplacements[0]!.card as any
    expect(card.body.elements[0].content).toBe('final model response')
    expect(card.header.title.content).toBe('已完成')
    expect(card.config.streaming_mode).toBe(false)
    expect(JSON.stringify(card)).not.toContain('取消当前任务')
    expect(b.gateway.health().processed).toBe(1)
    expect(b.gateway.health().boundSessions).toBe(1)
    const sent = b.t.streamCards[0]!
    expect((await b.t.emitCardAction({
      botId: 'default', chatId: 'oc_one', actorOpenId: 'ou_alice',
      messageId: sent.messageId,
      value: { namespace: 'dsh-feishu-gateway', kind: 'cancel', nonce: sent.nonce },
    })).toast.type).toBe('warning')
    await b.gateway.stop()
  })

  it('uses DurableOutbox only when the final CardKit replacement fails', async () => {
    const b = await boot(new MockSessionBridge({ reply: 'fallback answer' }), { streamCards: true })
    b.t.replaceStreamCard = async () => { throw new Error('CardKit unavailable') }
    await b.emit('om_fallback', 'hello')
    await b.gateway.whenIdle()
    expect(b.t.streamCards).toHaveLength(1)
    expect(b.t.streamFinishes).toHaveLength(1)
    expect(b.t.sent.filter(x => x.replyToMessageId === 'om_fallback').map(x => x.text))
      .toEqual(['fallback answer'])
    await b.gateway.stop()
  })

  it('keeps durable text reply when native CardKit start fails', async () => {
    const b = await boot(new MockSessionBridge({ reply: 'final model response' }), { streamCards: true })
    b.t.startStreamCard = async () => { throw new Error('cardkit unlicensed') }
    await b.emit('om_answer', 'hello')
    await b.gateway.whenIdle()
    expect(b.t.sent.find(x => x.replyToMessageId === 'om_answer')?.text).toBe('final model response')
    expect(b.gateway.health().processed).toBe(1)
    await b.gateway.stop()
  })

  it('leaves old deployments unchanged when approval and streaming options are off', async () => {
    const b = await boot(new MockSessionBridge({ reply: 'classic' }))
    await b.emit('om_legacy', 'question')
    await b.gateway.whenIdle()
    expect(b.t.interactiveCards).toHaveLength(0)
    expect(b.t.streamCards).toHaveLength(0)
    expect(b.t.sent[0]?.text).toBe('classic')
    const result = await b.gateway.answerApproval({ agent: { id: 'unowned' }, toolName: 'bash' },
      async () => 'rejected')
    expect(result).toBe('rejected')
    await b.gateway.stop()
  })
})
