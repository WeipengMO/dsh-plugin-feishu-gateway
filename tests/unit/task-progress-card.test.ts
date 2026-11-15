import { describe, expect, it, vi } from 'vitest'
import { TaskProgressCard } from '../../src/channel/task-progress-card.js'
import { MockFeishuTransport } from '../../src/channel/mock-transport.js'
import { silentLogger } from '../../src/util/logger.js'

describe('CardKit progress lifecycle', () => {
  it('sends snapshots in order, closes with a higher sequence, and never swallows final answer', async () => {
    vi.useFakeTimers()
    try {
      const transport = new MockFeishuTransport('default')
      const card = await TaskProgressCard.start(transport, 'om_original', silentLogger, 500)
      expect(card).toBeDefined()
      const nonce = card!.nonce
      expect(transport.streamCards[0]?.nonce).toBe(nonce)
      card!.onTextDelta('hello')
      await vi.advanceTimersByTimeAsync(500)
      card!.onTextDelta(' world')
      await vi.advanceTimersByTimeAsync(500)
      await card!.close('done')
      expect(transport.streamUpdates.map(x => x.sequence)).toEqual([1, 2, 3])
      expect(transport.streamUpdates[1]?.text).toContain('hello world')
      expect(transport.streamUpdates[2]?.text).toContain('最终答复')
      expect(transport.streamFinishes).toEqual([{ cardId: card!.handle.cardId, sequence: 4 }])
      await vi.advanceTimersByTimeAsync(5000)
      expect(transport.streamUpdates).toHaveLength(3)
    } finally { vi.useRealTimers() }
  })

  it('keeps the final status safe after any CardKit write error', async () => {
    const t = new MockFeishuTransport('default')
    t.updateStreamCard = async () => { throw new Error('no cardkit permission') }
    const c = await TaskProgressCard.start(t, 'om_original', silentLogger, 500)
    expect(c).toBeDefined()
    await c!.close('failed')
    expect(t.streamFinishes).toHaveLength(1)
  })

  it('does not exceed preview size for huge chunks', async () => {
    const t = new MockFeishuTransport('default')
    const c = await TaskProgressCard.start(t, 'om_original', silentLogger, 500)
    c!.onTextDelta('a'.repeat(100000))
    await c!.close('cancelled')
    expect(t.streamUpdates[0]?.text.length).toBeLessThan(13000)
    expect(t.streamUpdates[0]?.text).toContain('已取消')
  })
})
