import { afterEach, describe, expect, it } from 'vitest'
import { MockFeishuTransport } from '../../src/channel/mock-transport.js'
import { DurableOutbox } from '../../src/outbox/outbox.js'
import { resolveConfig } from '../../src/config.js'
import { silentLogger } from '../../src/util/logger.js'
import { tempDir } from '../helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const config = resolveConfig({ stateDir: dir, sendRetries: 2, sendRetryBaseDelayMs: 1 })
  const transport = new MockFeishuTransport('default')
  await transport.connect({ onMessage: () => {}, onStateChange: () => {} })
  const make = () => new DurableOutbox(dir, config, silentLogger, (id) => (id === 'default' ? transport : undefined))
  return { dir, transport, make }
}

describe('DurableOutbox', () => {
  it('sends immediately and removes the record', async () => {
    const { transport, make } = await fixture()
    const outbox = make()
    await outbox.open()
    expect(await outbox.send('default', { replyToMessageId: 'om_1', text: 'hi' })).toBe(true)
    expect(transport.sent).toHaveLength(1)
    expect(outbox.pending()).toHaveLength(0)
  })

  it('keeps a record after transient failures and drains it later', async () => {
    const { transport, make } = await fixture()
    transport.remainingFailures = 5 // always fails during the first send
    const outbox = make()
    await outbox.open()
    expect(await outbox.send('default', { replyToMessageId: 'om_1', text: 'hi' })).toBe(false)
    expect(outbox.pending()).toHaveLength(1)
    expect(outbox.stats().failed).toBe(1)

    transport.remainingFailures = 0
    expect(await outbox.drain()).toBe(1)
    expect(outbox.pending()).toHaveLength(0)
  })

  it('reloads pending records from disk across restarts', async () => {
    const { transport, make } = await fixture()
    transport.remainingFailures = 5
    const first = make()
    await first.open()
    await first.send('default', { replyToMessageId: 'om_1', text: 'hi' })

    const second = make()
    expect(await second.open()).toBe(1)
    expect(second.pending()[0]?.target.text).toBe('hi')
  })

  it('keeps records for bots with no transport', async () => {
    const { make } = await fixture()
    const outbox = make()
    await outbox.open()
    expect(await outbox.send('missing-bot', { chatId: 'oc_1', text: 'hi' })).toBe(false)
    expect(outbox.pending()).toHaveLength(1)
  })
  it('never overwrites two concurrent pending sends', async () => {
    const { transport, make } = await fixture()
    const outbox = make()
    await outbox.open()
    await Promise.all([
      outbox.send('default', { replyToMessageId: 'om_a', text: 'A' }, 'reply:a'),
      outbox.send('default', { replyToMessageId: 'om_b', text: 'B' }, 'reply:b'),
    ])
    expect(transport.sent.map((m) => m.text).sort()).toEqual(['A', 'B'])
    expect(outbox.pending()).toHaveLength(0)
  })

  it('coalesces concurrent drains and duplicate deliveries for the same idempotency key', async () => {
    const { transport, make } = await fixture()
    const outbox = make()
    await outbox.open()
    transport.remainingFailures = 2
    await outbox.send('default', { replyToMessageId: 'om_once', text: 'only once' }, 'reply:once')
    expect(outbox.pending()).toHaveLength(1)
    transport.remainingFailures = 0
    await Promise.all([outbox.drain(), outbox.drain()])
    expect(transport.sent).toHaveLength(1)
    await outbox.send('default', { replyToMessageId: 'om_once', text: 'only once' }, 'reply:once')
    expect(transport.sent).toHaveLength(1)
  })

  // This asserts the UUID persisted on the OUTBOX RECORD, not the value the
  // Lark REST adapter passes to `im.message.create`. The latter is covered by
  // the "reuses the persisted REST UUID on the create path" test in
  // tests/unit/lark-transport.test.ts — MockFeishuTransport.sent records the
  // target, so it cannot detect an adapter-level uuid regression.
  it('reloads the persisted outbox target UUID across restarts', async () => {
    const { transport, make } = await fixture()
    const first = make()
    await first.open()
    transport.remainingFailures = 2
    await first.send('default', { chatId: 'oc_1', text: 'persist' }, 'reply:persist')
    const originalUuid = first.pending()[0]?.target.uuid
    expect(originalUuid).toBeTruthy()
    transport.remainingFailures = 0
    const restarted = make()
    await restarted.open()
    await restarted.drain()
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.uuid).toBe(originalUuid)
  })

})

describe('permanent send errors', () => {
  it('parks a non-retryable response instead of continually re-sending it', async () => {
    const { dir, transport, make } = await fixture()
    const outbox = make()
    await outbox.open()
    const send = transport.sendText.bind(transport)
    let calls = 0
    transport.sendText = async (target) => {
      calls += 1
      if (target.text === 'invalid') {
        const err = new Error('HTTP 403') as Error & { code: number }
        err.code = 403
        throw err
      }
      return send(target)
    }
    await outbox.send('default', { replyToMessageId: 'om_bad', text: 'invalid' }, 'bad')
    expect(outbox.pending()[0]?.permanentFailure).toBe(true)
    await outbox.drain()
    expect(calls).toBe(1)
    const reopened = new DurableOutbox(dir, resolveConfig({ stateDir: dir }), silentLogger, () => transport)
    await reopened.open()
    await reopened.drain()
    expect(calls).toBe(1)
  })
})
