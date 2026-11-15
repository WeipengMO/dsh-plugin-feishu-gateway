import { afterEach, describe, expect, it } from 'vitest'
import { createGateway } from '../../src/index.js'
import { resolveConfig } from '../../src/config.js'
import { MockFeishuTransport } from '../../src/channel/mock-transport.js'
import { MockSessionBridge } from '../../src/session/mock-session-bridge.js'
import { DurableInbox } from '../../src/inbox/inbox.js'
import { sleep } from '../../src/util/retry.js'
import { silentLogger } from '../../src/util/logger.js'
import { tempDir } from '../helpers.js'
import type { SessionReply, WaitOptions } from '../../src/types.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup(bridge: MockSessionBridge = new MockSessionBridge()) {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const transport = new MockFeishuTransport('default')
  const gateway = createGateway(resolveConfig({ stateDir: dir, allowlist: ['ou_alice'],
    offline: true, sendRetries: 1, sendRetryBaseDelayMs: 1 }),
  { transports: [transport], bridge, logger: silentLogger })
  await gateway.start()
  const send = (text: string, id: string, chatId = 'oc_one', senderId = 'ou_alice') =>
    transport.emitMessage({ text, messageId: id, chatId, senderId })
  return { gateway, bridge, transport, dir, send }
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('wait condition not met')
}

class SelectiveSlowBridge extends MockSessionBridge {
  override async waitForReply(sessionId: string, options: WaitOptions): Promise<SessionReply> {
    const prompt = [...this.prompts].reverse().find(p => p.sessionId === sessionId)
    if (prompt?.text === 'slow') await sleep(60_000, options.signal)
    return super.waitForReply(sessionId, options)
  }
}

describe('native Feishu control commands', () => {
  it('/help and /status do not call the Agent and are idempotent', async () => {
    const t = await setup()
    await t.send('/help', 'om_help')
    await t.send('/help', 'om_help')
    await t.send('/status', 'om_status')
    await t.gateway.whenIdle()
    expect(t.bridge.created).toHaveLength(0)
    expect(t.bridge.prompts).toHaveLength(0)
    expect(t.transport.sent).toHaveLength(2)
    expect(t.transport.sent[0]?.text).toContain('/cancel')
    expect(t.transport.sent[1]?.text).toContain('没有正在运行')
    expect(t.gateway.health().processed).toBe(2)
    await t.gateway.stop()
  })

  it('/new rotates Session without destroying native DSH history or calling the LLM', async () => {
    const t = await setup()
    await t.send('first', 'om_first')
    await t.gateway.whenIdle()
    const oldId = t.bridge.created[0]!.sessionId
    await t.send('/new', 'om_new')
    await t.gateway.whenIdle()
    expect(t.bridge.prompts).toHaveLength(1)
    expect(t.bridge.disposedSessions).toContain(oldId)
    expect(t.transport.sent[1]?.text).toContain('新会话')
    await t.send('second', 'om_second')
    await t.gateway.whenIdle()
    expect(t.bridge.created).toHaveLength(2)
    expect(t.bridge.created[1]?.sessionId).not.toBe(oldId)
    expect(t.bridge.prompts[1]?.sessionId).toBe(t.bridge.created[1]?.sessionId)
    await t.gateway.stop()
  })

  it('/cancel bypasses the active chat queue and cancels only its native turn', async () => {
    const t = await setup(new SelectiveSlowBridge())
    await t.send('slow', 'om_slow', 'oc_a')
    await until(() => t.bridge.prompts.length === 1)
    const originalId = t.bridge.prompts[0]!.sessionId
    expect(t.gateway.health().activeTurns).toBe(1)

    await t.send('/status', 'om_running_status', 'oc_a')
    await until(() => t.transport.sent.some(x => x.replyToMessageId === 'om_running_status'))
    expect(t.transport.sent.find(x => x.replyToMessageId === 'om_running_status')?.text).toContain('任务运行中')

    // Another sender and another chat cannot cancel this chat's Agent.
    await t.send('/cancel', 'om_unauthorized', 'oc_a', 'ou_mallory')
    await t.send('/cancel', 'om_other_chat', 'oc_b')
    await until(() => t.transport.sent.some(x => x.replyToMessageId === 'om_other_chat'))
    expect(t.transport.sent.find(x => x.replyToMessageId === 'om_other_chat')?.text).toContain('没有可以取消')
    expect(t.bridge.cancelled).not.toContain(originalId)

    await t.send('/cancel', 'om_cancel', 'oc_a')
    await t.gateway.whenIdle()
    expect(t.bridge.cancelled).toContain(originalId)
    expect(t.bridge.disposedSessions).toContain(originalId)
    expect(t.transport.sent.find(x => x.replyToMessageId === 'om_cancel')?.text).toContain('已请求取消')
    expect(t.transport.sent.find(x => x.replyToMessageId === 'om_slow')).toBeUndefined()
    expect(t.gateway.health().activeTurns).toBe(0)

    const inbox = new DurableInbox(t.dir)
    await inbox.open()
    expect(inbox.get('om_slow')?.status).toBe('failed')
    await t.send('fresh', 'om_fresh', 'oc_a')
    await t.gateway.whenIdle()
    expect(t.bridge.created).toHaveLength(2)
    expect(t.bridge.prompts[1]?.sessionId).not.toBe(originalId)
    await t.gateway.stop()
  })

  it('a cancellation in one chat does not abort a normal turn in another', async () => {
    const t = await setup(new SelectiveSlowBridge())
    await t.send('slow', 'om_a', 'oc_a')
    await until(() => t.bridge.prompts.length === 1)
    await t.send('hello b', 'om_b', 'oc_b')
    await until(() => t.transport.sent.some(x => x.replyToMessageId === 'om_b'))
    await t.send('/cancel', 'om_cancel_a', 'oc_a')
    await t.gateway.whenIdle()
    expect(t.transport.sent.find(x => x.replyToMessageId === 'om_b')?.text).toContain('hello b')
    expect(t.transport.sent.find(x => x.replyToMessageId === 'om_a')).toBeUndefined()
    expect(t.bridge.created).toHaveLength(2)
    await t.gateway.stop()
  })

  it('/new is serialized behind an active turn and commands remain scoped to allowlisted DMs', async () => {
    const t = await setup(new SelectiveSlowBridge())
    await t.send('slow', 'om_slow')
    await until(() => t.bridge.prompts.length === 1)
    const originalId = t.bridge.prompts[0]!.sessionId

    await t.send('/new', 'om_new_denied', 'oc_one', 'ou_mallory')
    await t.transport.emitMessage({ text: '/cancel', messageId: 'om_group', chatId: 'oc_one',
      senderId: 'ou_alice', chatType: 'group' })
    expect(t.gateway.health().rejected['sender-not-allowlisted']).toBeGreaterThan(0)
    expect(t.gateway.health().rejected['groups-disabled']).toBeGreaterThan(0)

    await t.send('/new', 'om_new')
    // /new must never detach an Agent that is still executing.
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(t.bridge.disposedSessions).not.toContain(originalId)
    await t.send('/cancel', 'om_cancel')
    await t.gateway.whenIdle()
    expect(t.transport.sent.find(x => x.replyToMessageId === 'om_new')?.text).toContain('新会话')
    await t.send('new context', 'om_new_message')
    await t.gateway.whenIdle()
    expect(t.bridge.created[1]?.sessionId).not.toBe(originalId)
    await t.gateway.stop()
  })

  it('/cancel with no active task is a harmless, persisted command', async () => {
    const t = await setup()
    await t.send('/cancel', 'om_no_task')
    await t.gateway.whenIdle()
    expect(t.transport.sent[0]?.text).toContain('没有可以取消')
    expect(t.bridge.cancelled).toHaveLength(0)
    expect(t.bridge.created).toHaveLength(0)
    await t.gateway.stop()
  })
})
