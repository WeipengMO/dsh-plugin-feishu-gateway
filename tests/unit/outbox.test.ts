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
})
