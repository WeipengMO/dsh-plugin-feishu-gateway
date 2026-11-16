import { afterEach, describe, expect, it } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
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
/** Keeps the owning turn alive longer than the multi-card approval scenario. */
class VerySlowBridge extends MockSessionBridge {
  override async waitForReply(sessionId: string, options: WaitOptions): Promise<SessionReply> {
    await sleep(60_000, options.signal)
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
  return { gateway, bridge, t, emit, dir }
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

describe('Permanent approvals end-to-end through the Gateway', () => {
  const bashRequest = (id: string, callId: string) => ({
    agent: {
      id,
      session: {
        deriveMessages: () => [{ role: 'assistant', content: [
          { type: 'tool-call', id: callId, name: 'bash',
            arguments: JSON.stringify({ command: 'lark-cli calendar +agenda --as user' }) },
        ] }],
      },
    },
    toolName: 'bash',
    callId,
  })
  const cardButton = (card: Record<string, unknown>, decision: string) => {
    const columns = ((card as any).body.elements.find((e: any) => e.tag === 'column_set').columns) as any[]
    for (const column of columns) {
      for (const element of column.elements) {
        if (element?.behaviors?.[0]?.value?.decision === decision) return element
      }
    }
    return undefined
  }
  const readApprovalModel = async (dir: string) => JSON.parse(
    await readFile(path.join(dir, 'ops-approvals.json'), 'utf8'))

  it('persists a permanent rule, auto-allows later matches and honors an operator revoke', async () => {
    const b = await boot(new VerySlowBridge(), { approvalCards: true })
    await b.emit('om_work', 'run tool')
    await until(() => b.bridge.prompts.length === 1)
    const sessionId = b.bridge.prompts[0]!.sessionId

    const first = b.gateway.answerApproval(bashRequest(sessionId, 'c1'), async () => 'unavailable')
    await until(() => b.gateway.health().pendingApprovals === 1)
    const firstCard = b.t.interactiveCards[0]!
    const permanent = cardButton(firstCard.card, 'allow-permanent')!
    expect(permanent).toBeTruthy()
    const event = {
      botId: 'default', chatId: 'oc_one', actorOpenId: 'ou_alice',
      messageId: firstCard.messageId,
      value: permanent.behaviors[0].value,
    }
    expect((await b.t.emitCardAction(event)).toast.type).toBe('success')
    expect(await first).toBe('allowed-once')
    await until(() => b.t.patchedCards.length > 0)
    expect(JSON.stringify(b.t.patchedCards.at(-1)!.card)).toContain('已永久允许')

    await until(() => true)
    await new Promise(resolve => setTimeout(resolve, 30))
    const model = await readApprovalModel(b.dir)
    expect(model.rules).toHaveLength(1)
    expect(model.rules[0]).toMatchObject({ tool: 'bash', commandRoot: 'lark-cli', label: 'bash · lark-cli*' })
    expect(JSON.stringify(model)).not.toContain('oc_one')

    // Matching command root: no new card, allowed automatically.
    expect(await b.gateway.answerApproval(bashRequest(sessionId, 'c2'), async () => 'unavailable'))
      .toBe('allowed-once')
    expect(b.t.interactiveCards).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect((await readApprovalModel(b.dir)).rules[0].uses).toBe(1)

    // Operator revoke travels through the validated ops-control mailbox.
    const ruleRef = (await readApprovalModel(b.dir)).rules[0].ref
    const requests = path.join(b.dir, 'ops-control', 'requests')
    await mkdir(requests, { recursive: true, mode: 0o700 })
    const id = randomUUID()
    await writeFile(path.join(requests, id + '.json'), JSON.stringify({
      version: 1, id, ts: Date.now(), type: 'approval-revoke', ref: ruleRef,
    }), { mode: 0o600 })
    expect(await b.gateway.pollOperatorCommands()).toBe(1)
    const afterRevoke = await readApprovalModel(b.dir)
    expect(afterRevoke.rules).toHaveLength(0)

    // Revoked: the next matching request needs a fresh human card again.
    const third = b.gateway.answerApproval(bashRequest(sessionId, 'c3'), async () => 'unavailable')
    await until(() => b.t.interactiveCards.length === 2)
    // The card message is delivered before its pending nonce is registered.
    await until(() => b.gateway.health().pendingApprovals === 1)
    const reject = cardButton(b.t.interactiveCards[1]!.card, 'reject')!
    expect((await b.t.emitCardAction({
      botId: 'default', chatId: 'oc_one', actorOpenId: 'ou_alice',
      messageId: b.t.interactiveCards[1]!.messageId,
      value: reject.behaviors[0].value,
    })).toast.type).toBe('info')
    expect(await third).toBe('rejected')
    await b.gateway.stop()
  })
})
