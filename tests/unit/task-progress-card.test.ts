import { describe, expect, it, vi } from 'vitest'
import { TaskProgressCard } from '../../src/channel/task-progress-card.js'
import { MockFeishuTransport } from '../../src/channel/mock-transport.js'
import { silentLogger } from '../../src/util/logger.js'

function finishedBody(t: MockFeishuTransport) {
  return t.streamReplacements.at(-1)?.card.body as { elements: Array<Record<string, unknown>> }
}

describe('CardKit single-message progress lifecycle', () => {
  it('replaces the progress card with authoritative final text and no cancel button', async () => {
    vi.useFakeTimers()
    try {
      const t = new MockFeishuTransport('default')
      const card = await TaskProgressCard.start(t, 'om_original', silentLogger, 500)
      expect(card).toBeDefined()
      expect(t.streamCards[0]?.nonce).toBe(card!.nonce)
      card!.onTextDelta('preview')
      await vi.advanceTimersByTimeAsync(500)
      card!.onTextDelta(' still streaming')
      await vi.advanceTimersByTimeAsync(500)
      expect(await card!.close('done', 'authoritative final answer', {
        elapsedMs: 4200, model: 'magpie/group-deepseek',
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 25 },
        generationMs: 2000,
      })).toBe(true)
      expect(t.streamUpdates.map(x => x.sequence)).toEqual([1, 2])
      expect(t.streamReplacements.map(x => x.sequence)).toEqual([3])
      expect(t.streamFinishes).toHaveLength(0)
      const body = finishedBody(t)
      expect(body.elements[0]?.content).toBe('authoritative final answer')
      expect(JSON.stringify(t.streamReplacements[0]?.card)).not.toContain('取消当前任务')
      const footer = String(body.elements.at(-1)?.content)
      expect(footer.split('  \n')).toEqual([
        '模型：magpie/group-deepseek',
        'Token 用量：175',
        '速度：25.0 tok/s',
        '用时：4.2s',
      ])
      expect(footer).not.toContain('入 ')
      expect(footer).not.toContain(' / 出 ')
      expect(footer).not.toContain('≈')
      await vi.advanceTimersByTimeAsync(5000)
      expect(t.streamUpdates).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it('can complete without intermediate stream deltas or available model usage', async () => {
    const t = new MockFeishuTransport('default')
    const card = await TaskProgressCard.start(t, 'om_original', silentLogger, 500)
    expect(await card!.close('done', '**full final**', { elapsedMs: 1200 })).toBe(true)
    const body = finishedBody(t)
    expect(body.elements[0]?.content).toBe('**full final**')
    expect(JSON.stringify(body)).not.toContain('Token')
    expect(JSON.stringify(body)).not.toContain('tok/s')
    expect(JSON.stringify(body)).toContain('1.2s')
  })

  it('omits throughput when DSH did not report a model stream duration', async () => {
    const t = new MockFeishuTransport('default')
    const card = await TaskProgressCard.start(t, 'om_original', silentLogger, 500)
    expect(await card!.close('done', 'answer', {
      elapsedMs: 120_000,
      model: 'deepseek-chat',
      usage: { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 200 },
    })).toBe(true)
    const footer = String(finishedBody(t).elements.at(-1)?.content)
    expect(footer.split('  \n')).toEqual([
      '模型：deepseek-chat',
      'Token 用量：2,000',
      '用时：120.0s',
    ])
    expect(footer).not.toContain('速度')
    expect(footer).not.toContain('≈')
    expect(footer).not.toContain('入 ')
  })

  it('removes the cancel button on cancelled or failed terminal states', async () => {
    for (const status of ['cancelled', 'failed'] as const) {
      const t = new MockFeishuTransport('default')
      const card = await TaskProgressCard.start(t, 'om_original', silentLogger, 500)
      expect(await card!.close(status)).toBe(true)
      expect(JSON.stringify(t.streamReplacements[0]?.card)).not.toContain('取消当前任务')
      expect(String(finishedBody(t).elements[0]?.content)).toContain(status === 'cancelled' ? '已取消' : '异常结束')
    }
  })

  it('falls back to durable text when final CardKit replacement fails', async () => {
    const t = new MockFeishuTransport('default')
    t.replaceStreamCard = async () => { throw new Error('no CardKit permission') }
    const card = await TaskProgressCard.start(t, 'om_original', silentLogger, 500)
    expect(await card!.close('done', 'final')).toBe(false)
    expect(t.streamFinishes).toHaveLength(1)
  })

  it('returns false for an oversized full answer instead of silently truncating it', async () => {
    const t = new MockFeishuTransport('default')
    const card = await TaskProgressCard.start(t, 'om_original', silentLogger, 500)
    const answer = '中'.repeat(11000)
    expect(await card!.close('done', answer)).toBe(false)
    const terminal = JSON.stringify(t.streamReplacements.at(-1)?.card)
    expect(terminal).toContain('切换为文本')
    expect(terminal).not.toContain(answer)
    expect(terminal).not.toContain('取消当前任务')
  })

  it('keeps the preview bounded for large multibyte deltas', async () => {
    vi.useFakeTimers()
    try {
      const t = new MockFeishuTransport('default')
      const card = await TaskProgressCard.start(t, 'om_original', silentLogger, 500)
      card!.onTextDelta('中'.repeat(10000))
      await vi.advanceTimersByTimeAsync(500)
      expect(Buffer.byteLength(t.streamUpdates[0]?.text ?? '', 'utf8')).toBeLessThan(18_010)
      expect(await card!.close('done', '短回复')).toBe(true)
      expect(finishedBody(t).elements[0]?.content).toBe('短回复')
    } finally { vi.useRealTimers() }
  })

  it('does not open an unfinishable card on a legacy transport', async () => {
    const t = new MockFeishuTransport('default')
    ;(t as unknown as { replaceStreamCard?: unknown }).replaceStreamCard = undefined
    expect(await TaskProgressCard.start(t, 'om_original', silentLogger, 500)).toBeUndefined()
    expect(t.streamCards).toHaveLength(0)
  })
})
