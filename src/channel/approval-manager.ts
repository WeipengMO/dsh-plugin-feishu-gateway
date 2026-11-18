import { randomUUID } from 'node:crypto'
import { withTimeout } from '../util/retry.js'
import {
  approvalCard, approvalResultCard, CARD_NAMESPACE,
} from './card-content.js'
import {
  approvalRef, commandRoot, commandSummary,
  type ApprovalPendingView, type ApprovalStore,
} from './approval-store.js'
import type { CardActionEvent, FeishuTransport, GatewayLogger } from '../types.js'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ApprovalRequestLike {
  readonly agent?: { readonly id?: unknown; readonly session?: { readonly id?: unknown; deriveMessages?: () => unknown[] } }
  readonly callId?: unknown
  readonly reason?: unknown
  readonly displayReason?: { readonly zh?: unknown; readonly en?: unknown }
  readonly toolName?: string
  readonly signal?: AbortSignal
}

/** Match only the exact native call in this agent's own committed messages. */
export function approvalCommand(req: ApprovalRequestLike): string | undefined {
  if (req.toolName !== 'bash' || typeof req.callId !== 'string' || !req.callId) return undefined
  try {
    const messages = req.agent?.session?.deriveMessages?.()
    if (!Array.isArray(messages)) return undefined
    const matches: unknown[] = []
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const m = message as { role?: unknown; content?: unknown }
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
      for (const block of m.content) {
        if (block && typeof block === 'object') {
          const b = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }
          if (b.type === 'tool-call' && b.id === req.callId && b.name === 'bash') matches.push(b.arguments)
        }
      }
    }
    if (matches.length !== 1 || typeof matches[0] !== 'string') return undefined
    const args: unknown = JSON.parse(matches[0])
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
    const command = (args as { command?: unknown }).command
    if (typeof command !== 'string' || !command.trim() ||
        Buffer.byteLength(command, 'utf8') > 3500 || /[\x00-\x08\x0b-\x1f\x7f]/.test(command)) return undefined
    return command
  } catch { return undefined }
}

export interface ApprovalOwner {
  readonly botId: string
  readonly chatId: string
  readonly chatType?: 'p2p' | 'group'
  readonly senderId: string
  readonly replyToMessageId: string
}

interface PendingApproval extends ApprovalOwner {
  readonly sessionId: string
  readonly nonce: string
  readonly cardMessageId: string
  readonly expiresAt: number
  readonly requestedAt: number
  readonly toolName: string
  readonly command: string | undefined
  readonly reason: string | undefined
  readonly permanentLabel: string | undefined
  readonly permanentScope: string | undefined
  readonly chatRef: string
  readonly resolve: (value: ApprovalOutcome) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly abort?: () => void
  readonly transport: FeishuTransport
  countdown?: ReturnType<typeof setInterval>
  timedOut: boolean
  permanent: boolean
}

interface ApprovalStoreHooks {
  readonly store: ApprovalStore
  readonly onChanged?: () => void
}

/**
 * Bridges DSH's approval/request waterfall to human decisions in Feishu.
 *
 * DSH can only grant one call at a time, so "permanent" is implemented here:
 * a decision persisted by {@link ApprovalStore} scopes a narrow rule (tool +
 * bash command root) and later matching requests are auto-allowed without a
 * new card. This manager NEVER changes the DSH approval policy — if the policy
 * is `never`, DSH does not dispatch requests and no card appears.
 */
export class FeishuApprovalManager {
  private readonly pending = new Map<string, PendingApproval>()
  // Remember disconnect epochs even during in-flight REST delivery.
  private readonly botEpoch = new Map<string, number>()
  private disposed = false

  constructor(
    private readonly timeoutMs: number,
    private readonly allowedSenders: ReadonlySet<string> | ((owner: ApprovalOwner, actorId: string) => boolean),
    private readonly ownerOf: (sessionId: string) => ApprovalOwner | undefined,
    private readonly transportOf: (botId: string) => FeishuTransport | undefined,
    private readonly logger: GatewayLogger,
    private readonly onAudit?: (sessionId: string, state: string, botId: string) => void,
    private readonly hooks?: ApprovalStoreHooks,
    private readonly countdownIntervalMs = 5_000,
  ) {}

  get size(): number { return this.pending.size }

  private canAct(owner: ApprovalOwner, actor: string): boolean {
    return typeof this.allowedSenders === 'function'
      ? this.allowedSenders(owner, actor) : this.allowedSenders.has(actor)
  }

  /** Snapshot for the Web Admin read model; contains no raw chat/session ids. */
  pendingViews(): ApprovalPendingView[] {
    return [...this.pending.values()].map(pending => ({
      ref: approvalRef(pending.nonce),
      botId: pending.botId,
      chatRef: pending.chatRef,
      tool: pending.toolName,
      command: commandSummary(pending.command),
      requestedAt: pending.requestedAt,
      expiresAt: pending.expiresAt,
    }))
  }

  /** Return next() only for requests that DO NOT belong to this Feishu channel. */
  async answer(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const id = typeof req.agent?.id === 'string' ? req.agent.id
      : typeof req.agent?.session?.id === 'string' ? req.agent.session.id : ''
    const owner = id ? this.ownerOf(id) : undefined
    if (!owner) return next()
    if (this.disposed || req.signal?.aborted) return 'cancelled'
    if (!this.canAct(owner, owner.senderId)) return 'rejected'
    const transport = this.transportOf(owner.botId)
    if (!transport?.sendInteractiveCard) return 'unavailable'
    const toolName = typeof req.toolName === 'string' ? req.toolName : '受保护工具'
    const command = approvalCommand(req)
    const root = commandRoot(command)
    // Permanent scope stays narrow: bash is scoped to the executable root;
    // other tools are scoped to the tool name only. An unsafe/unknown tool
    // name (or a bash command without a derivable root) has NO permanent
    // option: it must never widen the allowlist through display text.
    const safeTool = /^[A-Za-z0-9_.:@/-]{1,96}$/.test(toolName)
    const permanentLabel = !safeTool ? undefined
      : toolName === 'bash'
        ? (root ? root.slice(0, 20) + '*' : undefined)
        : toolName.slice(0, 20)
    const permanentScope = permanentLabel === undefined ? undefined
      : toolName === 'bash'
        ? 'bash 中以 ' + root + ' 开头的命令'
        : '工具 ' + toolName
    const chatRef = approvalRef(owner.chatId)
    const requestedAt = Date.now()

    if (this.hooks) {
      const matched = this.hooks.store.ruleFor(toolName, root)
      if (matched) {
        await this.autoAllow(matched.ref, req, owner, toolName, command, chatRef, matched.label)
        return 'allowed-once'
      }
    }

    const nonce = randomUUID()
    const initialEpoch = this.botEpoch.get(owner.botId) ?? 0
    const rawReason = req.displayReason?.zh ?? req.displayReason?.en ?? req.reason
    const reason = typeof rawReason === 'string' && Buffer.byteLength(rawReason, 'utf8') <= 2000 ? rawReason : undefined
    const expiresAt = requestedAt + this.timeoutMs
    let cardMessageId: string
    try {
      const result = await withTimeout(
        transport.sendInteractiveCard(
          { replyToMessageId: owner.replyToMessageId },
          approvalCard(toolName, nonce, command, reason, {
            expiresAt, permanentLabel, ...(permanentScope ? { permanentScope } : {}),
            remainingMs: this.timeoutMs,
          })),
        Math.min(5_000, this.timeoutMs),
        req.signal,
      )
      if (result.timedOut) return 'unavailable'
      cardMessageId = result.value.messageId
    } catch {
      this.logger.warn('Feishu tool approval card delivery failed; denying request')
      return 'unavailable'
    }
    if (initialEpoch !== (this.botEpoch.get(owner.botId) ?? 0)) return 'unavailable'
    if (!cardMessageId || req.signal?.aborted || this.disposed) return 'cancelled'
    // Deny a card that arrived after its Session was cancelled/finished.
    const nowOwner = this.ownerOf(id)
    if (!nowOwner || nowOwner.botId !== owner.botId ||
      nowOwner.chatId !== owner.chatId || nowOwner.senderId !== owner.senderId ||
      nowOwner.replyToMessageId !== owner.replyToMessageId) return 'cancelled'

    // A single request may only be granted ONCE. Every callback must match
    // nonce, chat id, app/bot, sender open_id and this message id.
    this.onAudit?.(id, 'requested', owner.botId)
    void this.recordAudit({
      ts: requestedAt, tool: toolName, command: commandSummary(command),
      decision: 'requested', botId: owner.botId, chatRef, elapsedMs: null,
    })
    let settled: PendingApproval | undefined
    const result = await new Promise<ApprovalOutcome>(resolve => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(nonce)
        if (pending) pending.timedOut = true
        this.decide(nonce, 'unavailable')
      }, this.timeoutMs)
      timer.unref?.()
      const abort = () => this.decide(nonce, 'cancelled')
      const pending: PendingApproval = {
        ...owner, sessionId: id, nonce, cardMessageId, expiresAt, requestedAt,
        toolName, command, reason, permanentLabel, permanentScope, chatRef,
        resolve, timer, signal: req.signal, abort, transport, timedOut: false, permanent: false,
      }
      settled = pending
      this.pending.set(nonce, pending)
      req.signal?.addEventListener('abort', abort, { once: true })
      if (req.signal?.aborted) this.decide(nonce, 'cancelled')
      this.startCountdown(pending)
    })
    const permanent = settled?.permanent === true
    const timedOut = settled?.timedOut === true
    this.pending.delete(nonce)
    const decision = permanent ? 'allowed-permanent'
      : result === 'allowed-once' ? 'allowed-once'
        : result === 'rejected' ? 'rejected'
          : timedOut ? 'timed-out' : result
    this.onAudit?.(id, decision, owner.botId)
    void this.recordAudit({
      ts: Date.now(), tool: toolName, command: commandSummary(command), decision,
      botId: owner.botId, chatRef, elapsedMs: Date.now() - requestedAt,
    })
    let ruleLabel: string | undefined
    if (this.hooks) {
      if (permanent) {
        const rule = await this.rememberRule(toolName, root, owner.senderId, permanentScope)
        ruleLabel = rule?.label
      }
      this.hooks.onChanged?.()
    }
    const outcome: 'allowed-once' | 'allowed-permanent' | 'rejected' | 'cancelled' | 'unavailable' =
      permanent ? 'allowed-permanent' : result
    if (transport.updateInteractiveCard) {
      void transport.updateInteractiveCard(cardMessageId,
        approvalResultCard(outcome, ruleLabel ?? permanentScope)).catch(() => {
        this.logger.warn('Feishu approval result card update failed')
      })
    }
    return result
  }

  /** Record and apply one automatic allowance from a persisted rule. */
  private async autoAllow(
    ruleRef: string,
    req: ApprovalRequestLike,
    owner: ApprovalOwner,
    toolName: string,
    command: string | undefined,
    chatRef: string,
    label: string,
  ): Promise<void> {
    const id = typeof req.agent?.id === 'string' ? req.agent.id
      : typeof req.agent?.session?.id === 'string' ? req.agent.session.id : ''
    const now = Date.now()
    try {
      await this.hooks?.store.touch(ruleRef, now)
      await this.hooks?.store.record({
        ts: now, tool: toolName, command: commandSummary(command), decision: 'auto-allowed',
        botId: owner.botId, chatRef, ruleRef, elapsedMs: 0,
      })
    } catch {
      this.logger.warn('recording automatic approval failed for %s', ruleRef)
    }
    this.onAudit?.(id, 'auto-allowed', owner.botId)
    this.logger.info('auto-allowed %s for %s (%s)', toolName, owner.chatId, label)
    this.hooks?.onChanged?.()
  }

  private async rememberRule(
    toolName: string,
    root: string | undefined,
    createdBy: string,
    scope: string | undefined,
  ): Promise<{ label: string } | undefined> {
    if (!this.hooks) return undefined
    const rule = await this.hooks.store.remember({ tool: toolName, root, createdBy })
    if (rule) {
      this.logger.info('saved permanent approval %s for %s', rule.label, scope ?? rule.label)
    }
    return rule ? { label: rule.label } : undefined
  }

  private recordAudit(input: Parameters<ApprovalStore['record']>[0]): Promise<void> {
    return this.hooks?.store.record(input).catch(() => {
      this.logger.warn('approval audit write failed')
    }) ?? Promise.resolve()
  }

  /** Repaint the card with a live countdown; stops with the pending approval. */
  private startCountdown(pending: PendingApproval): void {
    const transport = pending.transport
    if (!transport.updateInteractiveCard || this.countdownIntervalMs <= 0) return
    if (this.timeoutMs <= this.countdownIntervalMs) return
    const tick = () => {
      const current = this.pending.get(pending.nonce)
      if (!current || this.disposed) return
      const remainingMs = current.expiresAt - Date.now()
      if (remainingMs <= 0) return
      void transport.updateInteractiveCard!(pending.cardMessageId, approvalCard(
        current.toolName, current.nonce, current.command, current.reason, {
          expiresAt: current.expiresAt, remainingMs,
          permanentLabel: current.permanentLabel,
          ...(current.permanentScope ? { permanentScope: current.permanentScope } : {}),
        })).catch(() => { /* the card may already be replaced; ignore */ })
    }
    const countdown = setInterval(tick, this.countdownIntervalMs)
    countdown.unref?.()
    pending.countdown = countdown
  }

  /** Non-blocking callback: no network or filesystem write in the 3-second path. */
  consume(event: CardActionEvent): { toast: { type: string; content: string } } | undefined {
    if (event.value.namespace !== CARD_NAMESPACE || event.value.kind !== 'approval') return undefined
    const pending = typeof event.value.nonce === 'string' ? this.pending.get(event.value.nonce) : undefined
    if (!pending || this.disposed || Date.now() >= pending.expiresAt) {
      return { toast: { type: 'warning', content: '审批已过期或已处理' } }
    }
    if (!this.canAct(pending, event.actorOpenId) ||
      event.actorOpenId !== pending.senderId ||
      event.botId !== pending.botId ||
      event.chatId !== pending.chatId ||
      event.messageId !== pending.cardMessageId ||
      pending.signal?.aborted) {
      return { toast: { type: 'warning', content: '没有权限操作此审批卡片' } }
    }
    const decision = event.value.decision
    if (decision !== 'allow' && decision !== 'reject' && decision !== 'allow-permanent') {
      return { toast: { type: 'warning', content: '无效审批操作' } }
    }
    if (decision === 'allow-permanent' && pending.permanentLabel === undefined) {
      return { toast: { type: 'warning', content: '该请求不支持永久授权' } }
    }
    if (decision === 'allow-permanent') pending.permanent = true
    this.decide(pending.nonce, decision === 'reject' ? 'rejected' : 'allowed-once')
    return {
      toast: {
        type: decision === 'reject' ? 'info' : 'success',
        content: decision === 'allow-permanent'
          ? '已永久允许：' + (pending.permanentScope ?? pending.permanentLabel)
          : decision === 'allow' ? '已允许本次执行' : '已拒绝执行',
      },
    }
  }

  private decide(nonce: string, outcome: ApprovalOutcome): void {
    const pending = this.pending.get(nonce)
    if (!pending) return
    if (pending.countdown) clearInterval(pending.countdown)
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

  /** WebSocket disconnect revokes all pending approvals for that bot. */
  cancelBot(botId: string): void {
    this.botEpoch.set(botId, (this.botEpoch.get(botId) ?? 0) + 1)
    for (const [nonce, pending] of this.pending) {
      if (pending.botId === botId) this.decide(nonce, 'unavailable')
    }
  }

  stop(): void {
    this.disposed = true
    for (const nonce of [...this.pending.keys()]) this.decide(nonce, 'cancelled')
  }
}
