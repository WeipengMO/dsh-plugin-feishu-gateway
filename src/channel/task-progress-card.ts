import { randomUUID } from 'node:crypto'
import type { FeishuCardHandle, FeishuTransport, GatewayLogger } from '../types.js'

/**
 * Optional, best-effort progress preview. Final answers ALWAYS use DurableOutbox.
 * All CardKit writes (text and settings) share one monotonic sequence.
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
  /** Stay below Feishu card content limits even for multibyte Unicode. */
  private readonly maxTextBytes = 18_000

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
    if (!transport.startStreamCard || !transport.updateStreamCard || !transport.finishStreamCard) return undefined
    const nonce = randomUUID()
    const handle = await transport.startStreamCard({ replyToMessageId }, nonce)
    if (!handle.cardId || !handle.messageId) return undefined
    return new TaskProgressCard(transport, logger, nonce, handle, intervalMs)
  }

  onTextDelta(delta: string): void {
    if (this.closed || this.failed || !delta) return
    if (this.textBytes >= this.maxTextBytes) return
    for (const point of delta) {
      const size = Buffer.byteLength(point, 'utf8')
      if (this.textBytes + size > this.maxTextBytes) break
      this.text += point
      this.textBytes += size
    }
  }

  private scheduleFlush(): void {
    if (this.closed || this.failed || this.text === this.lastRendered) return
    // At most one update per interval, no overlapping writes.
    const snapshot = this.text
    this.lastRendered = snapshot
    const next = ++this.sequence
    this.writing = this.writing.then(async () => {
      if (this.failed || this.closed || !this.handle.cardId) return
      try {
        await this.transport.updateStreamCard!(
          this.handle.cardId,
          snapshot + '\n\n---\n*实时预览；最终回复将另行发送。*', next)
      } catch {
        this.failed = true
        this.logger.warn('Feishu CardKit progress update disabled after API error')
      }
    })
  }

  async close(status: 'done' | 'cancelled' | 'failed'): Promise<void> {
    if (this.closed) return
    clearInterval(this.interval)
    // Prior writes settle before the final update; CardKit sequence stays ordered.
    await this.writing
    this.closed = true
    if (!this.handle.cardId) return
    if (!this.failed) {
      try {
        const final = status === 'done'
          ? '已完成；最终答复已发送或正在补发。'
          : status === 'cancelled'
            ? '任务已取消。已有工具操作可能无法撤销。'
            : '任务异常结束。请查看后续诊断回复。'
        await this.transport.updateStreamCard!(
          this.handle.cardId,
          (this.text ? this.text + '\n\n---\n' : '') + final,
          ++this.sequence)
      } catch {
        this.logger.warn('Feishu CardKit terminal content update failed')
      }
    }
    try {
      await this.transport.finishStreamCard!(this.handle.cardId, ++this.sequence)
    } catch {
      this.logger.warn('Feishu CardKit stream finalization failed')
    }
  }
}
