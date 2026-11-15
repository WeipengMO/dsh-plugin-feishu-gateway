import { randomUUID } from 'node:crypto'
import { approvalCard, approvalResultCard, CARD_NAMESPACE } from './card-content.js'
import type { CardActionEvent, FeishuTransport, GatewayLogger } from '../types.js'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ApprovalRequestLike {
  readonly agent?: { readonly id?: unknown; readonly session?: { readonly id?: unknown } }
  readonly toolName?: string
  readonly signal?: AbortSignal
}

export interface ApprovalOwner {
  readonly botId: string
  readonly chatId: string
  readonly senderId: string
  readonly replyToMessageId: string
}

interface PendingApproval extends ApprovalOwner {
  readonly sessionId: string
  readonly nonce: string
  readonly cardMessageId: string
  readonly expiresAt: number
  readonly resolve: (value: ApprovalOutcome) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly abort?: () => void
  readonly transport: FeishuTransport
}

/**
 * Bridges DSH's approval/request waterfall to one-shot human decisions.
 * This manager NEVER changes the DSH approval policy. If the policy is never,
 * DSH won't dispatch an approval request and the card won't appear.
 */
export class FeishuApprovalManager {
  private readonly pending = new Map<string, PendingApproval>()
  private disposed = false

  constructor(
    private readonly timeoutMs: number,
    private readonly allowedSenders: ReadonlySet<string>,
    private readonly ownerOf: (sessionId: string) => ApprovalOwner | undefined,
    private readonly transportOf: (botId: string) => FeishuTransport | undefined,
    private readonly logger: GatewayLogger,
  ) {}

  get size(): number { return this.pending.size }

  /** Return next() only for requests that DO NOT belong to this Feishu channel. */
  async answer(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const id = typeof req.agent?.id === 'string' ? req.agent.id
      : typeof req.agent?.session?.id === 'string' ? req.agent.session.id : ''
    const owner = id ? this.ownerOf(id) : undefined
    if (!owner) return next()
    if (this.disposed || req.signal?.aborted) return 'cancelled'
    if (!this.allowedSenders.has(owner.senderId)) return 'rejected'
    const transport = this.transportOf(owner.botId)
    if (!transport?.sendInteractiveCard) return 'unavailable'
    const nonce = randomUUID()
    const toolName = typeof req.toolName === 'string' ? req.toolName : '受保护工具'
    let cardMessageId: string
    try {
      const result = await transport.sendInteractiveCard(
        { replyToMessageId: owner.replyToMessageId },
        approvalCard(toolName, nonce))
      cardMessageId = result.messageId
    } catch {
      this.logger.warn('Feishu tool approval card delivery failed; denying request')
      return 'unavailable'
    }
    if (!cardMessageId || req.signal?.aborted || this.disposed) return 'cancelled'
    // A single request may only be granted ONCE. Every callback must match
    // nonce, chat id, app/bot, sender open_id and this message id.
    const result = await new Promise<ApprovalOutcome>(resolve => {
      const timer = setTimeout(() => this.decide(nonce, 'unavailable'), this.timeoutMs)
      timer.unref?.()
      const abort = () => this.decide(nonce, 'cancelled')
      this.pending.set(nonce, {
        ...owner, sessionId: id, nonce, cardMessageId, expiresAt: Date.now() + this.timeoutMs,
        resolve, timer, signal: req.signal, abort, transport,
      })
      req.signal?.addEventListener('abort', abort, { once: true })
      if (req.signal?.aborted) this.decide(nonce, 'cancelled')
    })
    if (transport.updateInteractiveCard) {
      void transport.updateInteractiveCard(cardMessageId, approvalResultCard(result)).catch(() => {
        this.logger.warn('Feishu approval result card update failed')
      })
    }
    return result
  }

  /** Non-blocking callback: no network or filesystem write in the 3-second path. */
  consume(event: CardActionEvent): { toast: { type: string; content: string } } | undefined {
    if (event.value.namespace !== CARD_NAMESPACE || event.value.kind !== 'approval') return undefined
    const pending = typeof event.value.nonce === 'string' ? this.pending.get(event.value.nonce) : undefined
    if (!pending || this.disposed || Date.now() >= pending.expiresAt) {
      return { toast: { type: 'warning', content: '审批已过期或已处理' } }
    }
    if (!this.allowedSenders.has(event.actorOpenId) ||
      event.actorOpenId !== pending.senderId ||
      event.botId !== pending.botId ||
      event.chatId !== pending.chatId ||
      event.messageId !== pending.cardMessageId ||
      pending.signal?.aborted) {
      return { toast: { type: 'warning', content: '没有权限操作此审批卡片' } }
    }
    if (event.value.decision !== 'allow' && event.value.decision !== 'reject') {
      return { toast: { type: 'warning', content: '无效审批操作' } }
    }
    const allow = event.value.decision === 'allow'
    this.decide(pending.nonce, allow ? 'allowed-once' : 'rejected')
    return { toast: { type: allow ? 'success' : 'info', content: allow ? '已允许本次执行' : '已拒绝执行' } }
  }

  private decide(nonce: string, outcome: ApprovalOutcome): void {
    const pending = this.pending.get(nonce)
    if (!pending) return
    this.pending.delete(nonce)
    clearTimeout(pending.timer)
    if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort)
    pending.resolve(outcome)
  }

  /** Cancelling an Agent invalidates every approval card for that exact turn. */
  cancelSession(sessionId: string): void {
    for (const [nonce, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.decide(nonce, 'cancelled')
    }
  }

  stop(): void {
    this.disposed = true
    for (const nonce of [...this.pending.keys()]) this.decide(nonce, 'cancelled')
  }
}
