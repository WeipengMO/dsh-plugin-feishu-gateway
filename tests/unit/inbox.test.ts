import { afterEach, describe, expect, it } from 'vitest'
import { DurableInbox } from '../../src/inbox/inbox.js'
import type { InboundMessage } from '../../src/types.js'
import { tempDir } from '../helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(): Promise<{ dir: string; make: () => DurableInbox }> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return { dir, make: () => new DurableInbox(dir) }
}

function message(id: string, text = 'hello'): InboundMessage {
  return {
    messageId: id,
    botId: 'default',
    chatId: 'oc_1',
    chatType: 'p2p',
    senderId: 'ou_alice',
    senderType: 'user',
    text,
    createTime: 1,
    messageType: 'text',
  }
}

describe('DurableInbox', () => {
  it('records, completes and reports stats', async () => {
    const { make } = await fixture()
    const inbox = make()
    await inbox.open()
    await inbox.record(message('om_1'))
    expect(inbox.pending()).toHaveLength(1)
    await inbox.markProcessed('om_1')
    expect(inbox.pending()).toHaveLength(0)
    expect(inbox.stats()).toEqual({ total: 1, pending: 0, done: 1, failed: 0 })
  })

  it('replays pending work after a restart', async () => {
    const { make } = await fixture()
    const first = make()
    await first.open()
    await first.record(message('om_pending'))
    await first.record(message('om_done'))
    await first.markProcessed('om_done')

    const second = make()
    const pending = await second.open()
    expect(pending.map((r) => r.messageId)).toEqual(['om_pending'])
    expect(second.get('om_done')?.status).toBe('done')
  })

  it('tracks failures and attempt counts', async () => {
    const { make } = await fixture()
    const inbox = make()
    await inbox.open()
    await inbox.record(message('om_1'))
    await inbox.markFailed('om_1', 'boom')
    expect(inbox.get('om_1')).toMatchObject({ status: 'failed', attempts: 1, error: 'boom' })
    expect(inbox.pending()).toHaveLength(1)
  })

  it('tolerates a torn trailing line', async () => {
    const { dir, make } = await fixture()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(`${dir}/inbox.jsonl`, '{"type":"processed","messageId":"om_x"}\n{"type":"proces', 'utf8')
    const inbox = make()
    expect(await inbox.open()).toEqual([])
  })
})
