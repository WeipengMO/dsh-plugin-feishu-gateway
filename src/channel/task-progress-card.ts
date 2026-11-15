import { randomUUID } from 'node:crypto'
import { completedProgressCard } from './card-content.js'
import type { CardCompletionStats, FeishuCardHandle, FeishuTransport, GatewayLogger } from '../types.js'

/**
 * Best-effort progress UI. On successful CardKit terminal replacement the
 * card IS the final answer; DurableOutbox is only needed as a fallback.
 * All CardKit writes share one monotonic sequence.
 */
export class TaskProgressCard {
  readonly handle: FeishuCardHandle
  readonly nonce: string
  private readonly interval: ReturnType<typeof setInterval>
  private readonly transport: FeishuTransport
  private readonly logger: GatewayLogger
  private text = ''
  private lastRendered = ''
  private sequence = 0
  private writing: Promise<void> = Promise.resolve()
  private closed = false
  private failed = false
  private textBytes = 0
  /** CardKit message/card JSON must stay below Feishu's payload limit. */
  private readonly maxTextBytes = 18_000
  private readonly maxFinalBytes = 27_000

  private constructor(
    transport: FeishuTransport, logger: GatewayLogger, nonce: string,
    handle: FeishuCardHandle, intervalMs: number,
  ) {
    this.transport = transport
    this.logger = logger
    this.nonce = nonce
    this.handle = handle
    this.interval = setInterval(() => this.scheduleFlush(), intervalMs)
    this.interval.unref?.()
  }

  static async start(
    transport: FeishuTransport, replyToMessageId: string,
    logger: GatewayLogger, intervalMs: number,
  ): Promise<TaskProgressCard | undefined> {
    // Older adapters cannot replace the complete card to remove cancel; do
    // not send a preview that would inevitably duplicate the text fallback.
    if (!transport.startStreamCard || !transport.updateStreamCard ||
        !transport.replaceStreamCard || !transport.finishStreamCard) return undefined
    const nonce = randomUUID()
    const handle = await transport.startStreamCard({ replyToMessageId }, nonce)
    if (!handle.cardId || !handle.messageId) return undefined
    return new TaskProgressCard(transport, logger, nonce, handle, intervalMs)
  }

  onTextDelta(delta: string): void {
    if (this.closed || this.failed || !delta || this.textBytes >= this.maxTextBytes) return
    for (const point of delta) {
      const size = Buffer.byteLength(point, 'utf8')
      if (this.textBytes + size > this.maxTextBytes) break
      this.text += point
      this.textBytes += size
    }
  }

  private scheduleFlush(): void {
    if (this.closed || this.failed || this.text === this.lastRendered) return
    const snapshot = this.text
    this.lastRendered = snapshot
    const next = ++this.sequence
    this.writing = this.writing.then(async () => {
      if (this.failed || this.closed || !this.handle.cardId) return
      try {
        await this.transport.updateStreamCard!(this.handle.cardId, snapshot, next)
      } catch {
        this.failed = true
        this.logger.warn('Feishu CardKit progress updates disabled after API error')
      }
    })
  }

  /**
   * true means a final card was acknowledged. false means the caller must
   * use the usual DurableOutbox for a complete text answer.
   * Cancelled/failed turns are already handled by the gateway's diagnostics.
   */
  async close(
    status: 'done' | 'cancelled' | 'failed',
    finalText?: string,
    stats?: CardCompletionStats,
  ): Promise<boolean> {
    if (this.closed) return false
    clearInterval(this.interval)
    this.closed = true
    // A previous stream write must finish before a full replacement.
    await this.writing
    const cardId = this.handle.cardId
    if (!cardId) return false
    const body = status === 'done' ? (finalText || '模型未返回文本内容。')
      : status === 'cancelled'
        ? '任务已取消。此前执行的工具操作可能无法撤销。'
        : '任务异常结束。请查看后续诊断信息。'
    const finalCard = completedProgressCard(status, body, stats)
    if (Buffer.byteLength(JSON.stringify(finalCard), 'utf8') > this.maxFinalBytes) {
      // A full entity over CardKit's limit would lose the answer. Keep this
      // card short and deliver the full text via the existing durable path.
      try {
        await this.transport.replaceStreamCard!(
          cardId,
          completedProgressCard('failed', '回复超过卡片大小限制，已切换为文本完整发送。', stats),
          ++this.sequence,
        )
      } catch {
        await this.finishQuietly(cardId)
      }
      return false
    }
    try {
      // One full PUT atomically replaces the body and removes cancel, while
      // setting streaming_mode=false. No second text reply after success.
      await this.transport.replaceStreamCard!(cardId, finalCard, ++this.sequence)
      return true
    } catch {
      this.logger.warn('Feishu CardKit final replacement failed; durable text fallback required')
      await this.finishQuietly(cardId)
      return false
    }
  }

  private async finishQuietly(cardId: string): Promise<void> {
    try {
      await this.transport.finishStreamCard!(cardId, ++this.sequence)
    } catch {
      this.logger.warn('Feishu CardKit fallback finalization failed')
    }
  }
}
