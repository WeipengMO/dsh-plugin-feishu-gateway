import { mkdir } from 'node:fs/promises'
import { DedupIndex } from './inbox/dedup.js'
import { FeishuApprovalManager, type ApprovalRequestLike, type ApprovalOutcome } from './channel/approval-manager.js'
import { TaskProgressCard } from './channel/task-progress-card.js'
import { CARD_NAMESPACE } from './channel/card-content.js'
import { commandHelp, parseControlCommand, type ControlCommand } from './control/commands.js'
import { DurableInbox, type InboxRecord } from './inbox/inbox.js'
import { DurableOutbox } from './outbox/outbox.js'
import { MessageRouter, type RejectReason } from './router/message-router.js'
import { SessionRegistry } from './session/session-registry.js'
import { truncateText } from './session/session-bridge.js'
import { acquireStateDirOwnerLock, type StateDirOwnerLock } from './storage/owner-lock.js'
import type {
  FeishuTransport,
  CardActionEvent,
  GatewayConfig,
  GatewayLogger,
  InboundMessage,
  SessionBridge,
  TransportState,
} from './types.js'
import { chatKey, newId, sessionIdFor } from './util/id.js'
import { withTimeout } from './util/retry.js'
import { OpsTelemetry, opsRef, type OpsEvent, type OpsSnapshot } from './ops/telemetry.js'
import { processOperatorCommands, type OperatorCommand, type OperatorResult } from './ops/commands.js'

export interface GatewayDeps {
  readonly config: GatewayConfig
  readonly logger: GatewayLogger
  readonly transports: readonly FeishuTransport[]
  readonly bridge: SessionBridge
}

export interface GatewayHealth {
  readonly status: 'ok' | 'degraded' | 'stopped'
  readonly transports: Record<string, TransportState>
  readonly sessionBridge: { readonly available: boolean; readonly reason?: string }
  readonly inbox: ReturnType<DurableInbox['stats']>
  readonly outbox: ReturnType<DurableOutbox['stats']>
  readonly dedupEntries: number
  readonly boundSessions: number
  readonly activeTurns: number
  readonly pendingApprovals: number
  readonly processed: number
  readonly rejected: Record<RejectReason, number>
  readonly errors: number
  readonly uptimeMs: number
}

interface ActiveTurn {
  readonly botId: string
  readonly chatId: string
  readonly senderId: string
  readonly replyToMessageId: string
  stream?: TaskProgressCard
  readonly messageId: string
  readonly startedAt: number
  readonly controller: AbortController
  sessionId?: string
  cancelledByUser: boolean
  phase: 'running' | 'finalizing'
}

class SessionResumeError extends Error {
  constructor(sessionId: string, cause: unknown) {
    super(`cannot restore DSH Session ${sessionId}: ${String(cause)}`, { cause })
    this.name = 'SessionResumeError'
  }
}

const REJECT_REASONS: readonly RejectReason[] = [
  'groups-disabled',
  'empty-allowlist',
  'sender-not-allowlisted',
  'sender-not-user',
  'unsupported-message-type',
  'empty-text',
]

/**
 * Wires the pipeline together:
 *
 *   FeishuTransport -> MessageRouter (security) -> DurableInbox + DedupIndex
 *     -> SessionRegistry / SessionBridge (native DSH Session)
 *     -> DurableOutbox -> FeishuTransport
 *
 * The gateway owns no listeners it does not remove and no sockets it does not
 * close: `stop()` is the single teardown path, called from the Cordis fiber.
 */
export class FeishuGateway {
  private readonly config: GatewayConfig
  private readonly logger: GatewayLogger
  private readonly transports = new Map<string, FeishuTransport>()
  private readonly bridge: SessionBridge
  private readonly router: MessageRouter
  private readonly dedup: DedupIndex
  private readonly inbox: DurableInbox
  private readonly registry: SessionRegistry
  private readonly outbox: DurableOutbox
  private readonly abortController = new AbortController()
  private outboxRetryTimer: ReturnType<typeof setInterval> | undefined
  private opsTimer: ReturnType<typeof setInterval> | undefined
  private commandTimer: ReturnType<typeof setInterval> | undefined
  private commandRunning = false
  private commandPromise: Promise<void> | undefined
  private readonly ops: OpsTelemetry
  private readonly transportStats = new Map<string, { reconnects: number; failures: number; lastConnectedAt?: number; lastDisconnectedAt?: number }>()
  private readonly chatQueues = new Map<string, Promise<void>>()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly scheduledMessageIds = new Set<string>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly approvals: FeishuApprovalManager
  private readonly rejected: Record<RejectReason, number>
  private ownerLock: StateDirOwnerLock | undefined
  private startedAt = 0
  private processed = 0
  private errors = 0
  private started = false
  private stopped = false

  constructor(deps: GatewayDeps) {
    this.config = deps.config
    this.logger = deps.logger
    this.bridge = deps.bridge
    this.ops = new OpsTelemetry(deps.config.stateDir)
    this.router = new MessageRouter(deps.config)
    this.approvals = new FeishuApprovalManager(
      deps.config.approvalTimeoutMs,
      new Set(deps.config.allowlist),
      (sessionId) => {
        const active = [...this.activeTurns.values()].find(turn =>
          turn.sessionId === sessionId && turn.phase === 'running' && !turn.cancelledByUser)
        return active ? {
          botId: active.botId, chatId: active.chatId,
          senderId: active.senderId, replyToMessageId: active.replyToMessageId,
        } : undefined
      },
      (botId) => this.transports.get(botId),
      deps.logger,
      (sessionId, state, botId) => this.audit({ kind: 'approval', state, session: sessionId, botId }),
    )
    for (const transport of deps.transports) this.transports.set(transport.botId, transport)

    this.dedup = new DedupIndex(deps.config.stateDir, deps.config.dedupTtlMs, deps.config.maxDedupEntries)
    this.inbox = new DurableInbox(deps.config.stateDir)
    this.registry = new SessionRegistry(deps.config.stateDir)
    this.outbox = new DurableOutbox(
      deps.config.stateDir,
      deps.config,
      deps.logger,
      (botId) => this.transports.get(botId),
      (state, botId, ref) => this.audit({ kind: 'delivery', state, botId, ref }),
    )
    this.rejected = Object.fromEntries(REJECT_REASONS.map((reason) => [reason, 0])) as Record<RejectReason, number>
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.startedAt = Date.now()
    try {
      await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
      // stateDir is exclusive to ONE gateway instance. The Inbox admission
      // authority is an in-memory Map, so two instances sharing a stateDir
      // would admit the same message_id and execute the Agent turn twice.
      this.ownerLock = await acquireStateDirOwnerLock(this.config.stateDir, this.logger)
      await this.dedup.open()
      const pending = await this.inbox.open()
      await this.registry.open()
      const outboxPending = await this.outbox.open()
      if (!this.bridge.available) {
        this.logger.warn('native DSH Sessions unavailable (%s); inbound messages will receive a diagnostic reply',
          this.bridge.unavailableReason ?? 'unknown reason')
      }
      this.logger.info(
        'starting: bots=%d allowlist=%d stateDir=%s pendingInbox=%d pendingOutbox=%d offline=%s',
        this.transports.size, this.config.allowlist.length, this.config.stateDir,
        pending.length, outboxPending, this.config.offline,
      )
      if (this.config.autoConnect) {
        // A single bot's failure must not disable all other bots.
        for (const transport of this.transports.values()) {
          try {
            await transport.connect({
              onMessage: (message) => this.handleInbound(message),
              onStateChange: (state, error) => this.onStateChange(transport.botId, state, error),
              onCardAction: (event) => this.handleCardAction(event),
            })
          } catch (error) {
            this.errors += 1
            this.logger.error('bot %s connect failed: %s', transport.botId, String(error))
          }
        }
        await this.outbox.drain()
      }
      // A crashed/shutdown turn may still be bound to a native Session that was
      // executing an (possibly side-effecting) Agent turn. Isolate that binding
      // BEFORE dispatching any pending work: timeout/error paths already unbind,
      // so this closes the crash/shutdown isolation asymmetry (otherwise the
      // next message would resume the interrupted Session).
      for (const record of this.inbox.uncertain()) {
        try {
          await this.registry.unbind(chatKey(record.botId, record.chatId))
        } catch (error) {
          this.logger.error('session isolation during recovery failed for %s: %s', record.messageId, String(error))
        }
        await this.replyDiagnostic(record,
          '此前请求在服务重启时处于执行中，可能已经产生实际操作。为避免重复执行，已暂停自动重试；请检查 DSH 会话后决定是否重新发送。',
          `recovery:${record.messageId}`)
        await this.inbox.markRecoveryNotified(record.messageId)
      }
      // Replay only work that was never started. A running Agent may already
      // have changed files or executed shell commands before the crash.
      for (const record of pending) this.scheduleRecord(record)
      this.dedupSnapshot = await this.dedup.size()
      this.audit({ kind: 'system', state: 'started' })
      this.refreshOps()
      this.opsTimer = setInterval(() => this.refreshOps(), 10000)
      this.opsTimer.unref?.()
      this.commandTimer = setInterval(() => this.runOperatorMailbox(), 1500)
      this.commandTimer.unref?.()
      if (this.config.autoConnect) {
        this.outboxRetryTimer = setInterval(() => {
          if (this.stopped || this.outbox.stats().pending === 0) return
          void this.outbox.drain().catch((error) => {
            this.errors += 1
            this.logger.warn('periodic outbox retry failed: %s', String(error))
          })
        }, this.config.outboxRetryIntervalMs)
        this.outboxRetryTimer.unref?.()
      }
    } catch (error) {
      this.started = false
      // A partially started Gateway may already have live WebSockets and
      // listeners. Close them BEFORE releasing the exclusive stateDir lock.
      try {
        await this.stop()
      } catch (cleanupError) {
        this.logger.error('startup cleanup failed: %s', String(cleanupError))
      }
      await this.releaseOwnerLock()
      throw error
    }
  }

  /** Best-effort, owner-checked release. Safe to call twice. */
  private async releaseOwnerLock(): Promise<void> {
    const lock = this.ownerLock
    this.ownerLock = undefined
    if (!lock) return
    try {
      await lock.release()
    } catch (error) {
      this.logger.warn('failed to release stateDir owner lock: %s', String(error))
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.outboxRetryTimer) clearInterval(this.outboxRetryTimer)
    if (this.opsTimer) clearInterval(this.opsTimer)
    this.opsTimer = undefined
    if (this.commandTimer) clearInterval(this.commandTimer)
    this.commandTimer = undefined
    await this.commandPromise
    this.outboxRetryTimer = undefined
    this.abortController.abort()
    this.approvals.stop()

    for (const [botId, transport] of this.transports) {
      try {
        await transport.close()
      } catch (error) {
        this.logger.warn('close failed for bot %s: %s', botId, String(error))
      }
    }

    await Promise.allSettled([...this.inFlight])
    await this.outbox.whenIdle()
    await this.bridge.dispose()
    this.audit({ kind: 'system', state: 'stopped' })
    this.refreshOps()
    await this.ops.whenIdle()
    this.chatQueues.clear()
    this.scheduledMessageIds.clear()
    this.logger.info(
      'stopped: processed=%d rejected=%d errors=%d outboxPending=%d',
      this.processed,
      Object.values(this.rejected).reduce((a, b) => a + b, 0),
      this.errors,
      this.outbox.stats().pending,
    )
    await this.releaseOwnerLock()
  }

  /** Entry point for every inbound event from any transport. */
  async handleInbound(message: InboundMessage): Promise<void> {
    // During shutdown the transport may still deliver an event. Resolving here
    // would make the SDK send a 200 ACK for a message that was never durably
    // admitted (silent loss). Reject so the event is treated as unsuccessful.
    if (this.stopped) throw new Error('feishu gateway is stopped; event was not admitted')
    const decision = this.router.decide(message)
    if (!decision.accepted) {
      this.rejected[decision.reason] += 1
      this.logger.debug('dropped message %s: %s', message.messageId, decision.reason)
      return
    }
    // Atomic Inbox admission is authoritative. Never acknowledge an event
    // as a duplicate if its inbound payload has not been durably recorded.
    const { record, isNew } = await this.inbox.recordIfAbsent(decision.message)
    if (!isNew) {
      // A crash/failure after durable admission but before queueing must not
      // leave a pending event stranded until the next full service restart.
      if (record.status === 'pending') this.scheduleRecord(record)
      this.logger.debug('duplicate message %s already admitted', message.messageId)
      return
    }
    try {
      await this.dedup.checkAndRemember(record.messageId)
      this.dedupSnapshot += 1
    } catch (error) {
      // The dedup index is non-authoritative: Inbox already owns the ID.
      this.logger.warn('dedup index update failed for %s: %s', record.messageId, String(error))
    }
    this.audit({ kind: 'message', state: 'received', botId: record.botId, ref: record.messageId })
    this.scheduleRecord(record)
  }

  /** Schedule a pending durable event exactly once within this process. */
  private scheduleRecord(record: InboxRecord): void {
    if (record.status !== 'pending' || this.scheduledMessageIds.has(record.messageId)) return
    this.scheduledMessageIds.add(record.messageId)
    const work = this.processRecord(record)
    this.track(work.then(
      () => { this.scheduledMessageIds.delete(record.messageId) },
      (error) => {
        this.scheduledMessageIds.delete(record.messageId)
        throw error
      },
    ))
  }

  /** DSH native approval waterfall: only active Feishu-owned agents are answered. */
  async answerApproval(
    request: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (!this.config.approvalCards || this.stopped) return next()
    return this.approvals.answer(request, next)
  }

  /** Feishu callback handler: verify who clicked, from which chat and card. */
  async handleCardAction(event: CardActionEvent): Promise<{ toast: { type: string; content: string } }> {
    const toast = (type: string, content: string) => ({ toast: { type, content } })
    if (this.stopped || !this.config.allowlist.includes(event.actorOpenId)) {
      return toast('warning', '无权执行该操作')
    }
    if (this.config.approvalCards) {
      const result = this.approvals.consume(event)
      if (result) return result
    }
    if (!this.config.streamCards ||
      event.value.namespace !== CARD_NAMESPACE || event.value.kind !== 'cancel') {
      return toast('warning', '未知或已过期的卡片操作')
    }
    const active = this.activeTurns.get(chatKey(event.botId, event.chatId))
    if (!active || active.botId !== event.botId || active.chatId !== event.chatId ||
      active.senderId !== event.actorOpenId || active.phase !== 'running' ||
      active.cancelledByUser || event.value.nonce !== active.stream?.nonce ||
      event.messageId !== active.stream?.handle.messageId) {
      return toast('warning', '任务已结束或无法验证卡片')
    }
    this.requestCancel(active)
    return toast('success', '已请求取消当前任务')
  }

  private requestCancel(active: ActiveTurn): void {
    if (active.cancelledByUser || active.phase !== 'running') return
    active.cancelledByUser = true
    this.audit({ kind: 'task', state: 'cancel-requested', botId: active.botId,
      ref: active.messageId, session: active.sessionId })
    active.controller.abort()
    if (active.sessionId) {
      this.approvals.cancelSession(active.sessionId)
      try { this.bridge.cancel(active.sessionId) }
      catch { this.logger.warn('native Agent cancellation failed') }
    }
  }

  private async processRecord(record: InboxRecord): Promise<void> {
    const command = parseControlCommand(record.text)
    // A cancellation or status request MUST bypass the current chat's Agent
    // queue, otherwise a 5-minute turn would block the very control used to
    // stop or inspect it. /new remains serialized behind current work.
    if (command === 'cancel' || command === 'status' || command === 'help') {
      await this.dispatchControl(record, command)
      return
    }
    await this.enqueue(record.botId, record.chatId, () =>
      command === 'new' ? this.dispatchControl(record, command) : this.dispatch(record))
  }

  /** Serialize work per chat so two rapid messages cannot interleave turns. */
  private enqueue(botId: string, chatId: string, work: () => Promise<void>): Promise<void> {
    const key = chatKey(botId, chatId)
    const previous = this.chatQueues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.chatQueues.set(key, next)
    const clean = () => {
      if (this.chatQueues.get(key) === next) this.chatQueues.delete(key)
    }
    void next.then(clean, clean)
    return next
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise)
    void promise.then(
      () => { this.inFlight.delete(promise) },
      (error) => {
        this.inFlight.delete(promise)
        this.errors += 1
        this.logger.error('unhandled message worker failure: %s', String(error))
      },
    )
  }

  private async dispatchControl(record: InboxRecord, command: ControlCommand): Promise<void> {
    if (this.stopped) return
    // Re-validate on crash recovery / dequeuing. Commands are NOT an
    // authorization bypass and never trigger native Agent tool execution.
    const decision = this.router.decide({
      messageId: record.messageId, botId: record.botId, chatId: record.chatId,
      chatType: 'p2p', senderId: record.senderId, senderType: 'user',
      text: record.text, createTime: record.receivedAt, messageType: 'text',
    })
    if (!decision.accepted) {
      this.rejected[decision.reason] += 1
      await this.inbox.markProcessed(record.messageId)
      return
    }

    const key = chatKey(record.botId, record.chatId)
    try {
      await this.inbox.markRunning(record.messageId)
      if (this.stopped) return
      let reply: string
      if (command === 'help') {
        reply = commandHelp
      } else if (command === 'status') {
        const active = this.activeTurns.get(key)
        const health = this.health()
        const seconds = active ? Math.floor((Date.now() - active.startedAt) / 1000) : 0
        reply = [
          active
            ? `当前聊天：${active.phase === 'running' ? '任务运行中' : '正在发送回复'}（约 ${seconds} 秒）`
            : '当前聊天：没有正在运行的任务',
          `原生 DSH Session：${health.sessionBridge.available ? '可用' : '不可用'}`,
          `飞书连接：${health.transports[record.botId] ?? '未知'}`,
          `待发送回复：${health.outbox.pending}`,
          `当前已绑定会话：${this.registry.get(key) ? '是' : '否'}`,
        ].join('\n')
      } else if (command === 'cancel') {
        const active = this.activeTurns.get(key)
        if (!active || active.cancelledByUser || active.phase !== 'running') {
          reply = '当前聊天没有可以取消的运行中任务。'
        } else {
          // One chat's AbortController cannot affect another chat.
          this.requestCancel(active)
          reply = '已请求取消当前任务。可能已经执行的工具操作不会自动回滚；请检查执行结果后再发起新请求。'
        }
      } else {
        // /new is queued AFTER the currently executing turn. Retiring an
        // active Handle before the prior turn is complete would detach a
        // still-running Agent and destroy the user's context unexpectedly.
        const existing = this.registry.get(key)
        if (existing) {
          await this.registry.unbind(key)
          await this.bridge.retire?.(existing.sessionId)
        }
        reply = '已开启新会话。下一条消息将使用全新的 DSH Session；原会话历史仍由 DSH 保存。'
      }
      await this.replyDiagnostic(record, reply)
      await this.inbox.markProcessed(record.messageId)
      this.processed += 1
    } catch (error) {
      this.errors += 1
      this.logger.error('control command %s failed for %s: %s', command, record.messageId, String(error))
      await this.inbox.markFailed(record.messageId, 'control command failed')
      // No blind replay of controls that have already changed a Session.
      await this.replyDiagnostic(record, '控制命令处理失败，请检查后台状态后再操作。')
    }
  }

  private async finalizeUserCancellation(record: InboxRecord, key: string, sessionId?: string): Promise<void> {
    if (sessionId) {
      try { this.bridge.cancel(sessionId) }
      catch (error) { this.logger.warn('cancel failed for %s: %s', sessionId, String(error)) }
      await this.registry.unbind(key)
      await this.bridge.retire?.(sessionId)
    }
    // Cancelled Agent turns may already have had irreversible side effects.
    // Terminal failed means the Inbox MUST NEVER automatically replay them.
    await this.inbox.markFailed(record.messageId, 'cancelled by user; prior operations may have taken effect')
    this.audit({ kind: 'task', state: 'cancelled', botId: record.botId,
      ref: record.messageId, session: sessionId })
  }

  private async dispatch(record: InboxRecord): Promise<void> {
    if (this.stopped) return
    // Recheck authorization on replay / at dequeue time. Revocation must
    // prevent a previously queued message from executing after a restart.
    const decision = this.router.decide({
      messageId: record.messageId, botId: record.botId, chatId: record.chatId,
      chatType: 'p2p', senderId: record.senderId, senderType: 'user',
      text: record.text, createTime: record.receivedAt, messageType: 'text',
    })
    if (!decision.accepted) {
      this.rejected[decision.reason] += 1
      await this.inbox.markProcessed(record.messageId)
      return
    }
    const key = chatKey(record.botId, record.chatId)
    const turn: ActiveTurn = {
      botId: record.botId, chatId: record.chatId,
      senderId: record.senderId, replyToMessageId: record.messageId,
      messageId: record.messageId, startedAt: Date.now(),
      controller: new AbortController(), cancelledByUser: false, phase: 'running',
    }
    this.activeTurns.set(key, turn)
    this.audit({ kind: 'task', state: 'running', botId: record.botId, ref: record.messageId })
    const signal = AbortSignal.any([this.abortController.signal, turn.controller.signal])
    let activeSessionId: string | undefined
    let unsubscribeProgress: (() => void) | undefined
    let progressStatus: 'done' | 'cancelled' | 'failed' = 'failed'
    try {
      // Durable execution boundary, before any Agent-side effects.
      await this.inbox.markRunning(record.messageId)
      if (signal.aborted) {
        if (turn.cancelledByUser && !this.abortController.signal.aborted) {
          await this.finalizeUserCancellation(record, key)
        }
        return
      }
      if (!this.bridge.available) {
        await this.replyDiagnostic(record, 'DSH 原生 Session 服务未就绪，插件已按安全默认降级。')
        await this.inbox.markProcessed(record.messageId)
        this.errors += 1
        return
      }

      const sessionId = await this.ensureSession(key, record.botId, record.chatId)
      activeSessionId = sessionId
      turn.sessionId = sessionId
      this.audit({ kind: 'task', state: 'session-ready', botId: record.botId,
        ref: record.messageId, session: sessionId })
      if (signal.aborted) throw new Error('turn aborted before submit')
      await this.bridge.submit(sessionId, record.text, signal)
      if (this.config.streamCards && !signal.aborted) {
        try {
          const transport = this.transports.get(record.botId)
          if (transport) {
            const opened = await withTimeout(
              TaskProgressCard.start(
                transport, record.messageId, this.logger, this.config.streamIntervalMs),
              5_000,
              signal,
            )
            const progress = opened.timedOut ? undefined : opened.value
            if (progress && !signal.aborted) {
              turn.stream = progress
              unsubscribeProgress = this.bridge.onTextDelta?.(sessionId, (delta) => progress.onTextDelta(delta))
            }
          }
        } catch {
          // Non-durable progress must NEVER prevent a durable final reply.
          this.logger.warn('Feishu progress card unavailable; keeping durable reply')
        }
      }
      const reply = await this.bridge.waitForReply(sessionId, {
        timeoutMs: this.config.replyTimeoutMs,
        signal,
      })
      // Shutdown leaves a running turn uncertain; it may have had side effects.
      if (this.abortController.signal.aborted) return
      if (turn.cancelledByUser) {
        progressStatus = 'cancelled'
        await this.finalizeUserCancellation(record, key, activeSessionId)
        return
      }
      turn.phase = 'finalizing'
      this.audit({ kind: 'task', state: 'finalizing', botId: record.botId,
        ref: record.messageId, session: sessionId })
      if (reply.reason === 'timeout' || reply.reason === 'cancelled') {
        this.bridge.cancel(sessionId)
        // A late reply from the prior Agent must never enter the next turn.
        await this.registry.unbind(key)
        await this.bridge.retire?.(sessionId)
        await this.replyDiagnostic(record, '长任务超时或已取消。原会话已隔离，后续消息将使用新会话。')
      } else {
        const text = truncateText(reply.text, this.config.maxTextLength)
        const answer = text || '模型未返回文本内容。'
        progressStatus = 'done'
        // A fully updated CardKit entity IS the answer. Only fall back to
        // DurableOutbox if the card never opened or its final PUT failed.
        let deliveredAsCard = false
        if (turn.stream) {
          const card = turn.stream
          turn.stream = undefined
          unsubscribeProgress?.()
          unsubscribeProgress = undefined
          try {
            const terminal = await withTimeout(card.close('done', answer, {
              elapsedMs: Date.now() - turn.startedAt,
              ...(reply.model ? { model: reply.model } : {}),
              ...(reply.usage ? { usage: reply.usage } : {}),
              ...(reply.generationMs ? { generationMs: reply.generationMs } : {}),
            }), 5_000)
            deliveredAsCard = !terminal.timedOut && terminal.value === true
            if (terminal.timedOut) this.logger.warn('Feishu CardKit final delivery timed out; falling back to text')
          } catch {
            this.logger.warn('Feishu CardKit final delivery failed; falling back to text')
          }
        }
        if (!deliveredAsCard) {
          await this.replyDiagnostic(record, answer,
            `reply:${record.messageId}`, text ? this.config.replyFormat : 'text')
        }
      }
      await this.registry.touch(key)
      await this.inbox.markProcessed(record.messageId)
      this.processed += 1
      const finalState = reply.reason === 'timeout' ? 'timed-out'
        : reply.reason === 'cancelled' ? 'cancelled' : 'done'
      this.audit({ kind: 'task', state: finalState, botId: record.botId, ref: record.messageId,
        session: activeSessionId, elapsedMs: Date.now() - turn.startedAt,
        ...(finalState === 'done' ? { model: reply.model,
          tokens: reply.usage ? reply.usage.inputTokens + reply.usage.outputTokens +
            (reply.usage.cacheReadTokens ?? 0) + (reply.usage.cacheWriteTokens ?? 0) : undefined } : {}) })
    } catch (error) {
      if (this.abortController.signal.aborted) return
      if (turn.cancelledByUser) {
        progressStatus = 'cancelled'
        await this.finalizeUserCancellation(record, key, activeSessionId)
        return
      }
      this.errors += 1
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('message %s failed: %s', record.messageId, reason)
      // A failure after agent creation might still leave an active turn.
      // Prevent late events from leaking into the next chat request.
      if (activeSessionId) {
        this.bridge.cancel(activeSessionId)
        try {
          await this.registry.unbind(key)
        } catch (unbindError) {
          this.logger.error('session isolation failed for %s: %s', activeSessionId, String(unbindError))
        }
        try {
          await this.bridge.retire?.(activeSessionId)
        } catch (retireError) {
          this.logger.warn('failed to retire abandoned session %s: %s', activeSessionId, String(retireError))
        }
      }
      // Never blindly replay a turn that may have caused real side effects.
      await this.inbox.markFailed(record.messageId, reason)
      this.audit({ kind: 'task', state: 'failed', botId: record.botId, ref: record.messageId,
        session: activeSessionId, elapsedMs: Date.now() - turn.startedAt })
      if (error instanceof SessionResumeError) {
        await this.replyDiagnostic(record,
          'DSH 原有会话恢复失败，已保留会话绑定，没有重新创建空白会话。本次消息未提交给 Agent；请检查 DSH Host、Agent Loop 和 Session 持久化。')
      } else {
        await this.replyDiagnostic(record,
          '处理失败，可能已经执行部分操作；请先检查 DSH 会话，再决定是否重试。')
      }
    } finally {
      if (activeSessionId) this.approvals.cancelSession(activeSessionId)
      unsubscribeProgress?.()
      if (turn.stream) {
        try {
          const closing = await withTimeout(turn.stream.close(progressStatus), 5_000)
          if (closing.timedOut) this.logger.warn('Feishu CardKit stream cleanup exceeded deadline')
        } catch { this.logger.warn('Feishu CardKit stream cleanup failed') }
      }
      if (this.activeTurns.get(key) === turn) this.activeTurns.delete(key)
      this.refreshOps()
    }
  }

  private async ensureSession(key: string, botId: string, chatId: string): Promise<string> {
    const existing = this.registry.get(key)
    if (!existing) {
      const sessionId = `${sessionIdFor(botId, chatId)}-${newId('session')}`
      try {
        await this.bridge.create(sessionId, this.config.workspace, this.config.agent)
      } catch (error) {
        throw new Error(`cannot create native DSH Session: ${String(error)}`)
      }
      await this.registry.bind(key, sessionId)
      return sessionId
    }
    try {
      await this.bridge.resume(existing.sessionId)
    } catch (error) {
      // Do NOT silently replace a chat's conversation with an empty Session.
      // A closed host, missing factory, or broken persistence needs an explicit
      // recovery decision. Keep the original binding for diagnosis / retry.
      throw new SessionResumeError(existing.sessionId, error)
    }
    return existing.sessionId
  }

  private async replyDiagnostic(
    record: InboxRecord, text: string, key = `reply:${record.messageId}`,
    format: 'text' | 'markdown' = 'text',
  ): Promise<void> {
    await this.outbox.send(record.botId, { replyToMessageId: record.messageId, text,
      ...(format === 'markdown' ? { format: 'markdown' as const } : {}),
    }, key)
  }

  /** Wait until every tracked message handler has settled (tests / shutdown). */
  async whenIdle(): Promise<void> {
    for (let guard = 0; guard < 100 && this.inFlight.size > 0; guard += 1) {
      await Promise.allSettled([...this.inFlight])
    }
  }

  private onStateChange(botId: string, state: TransportState, error?: Error): void {
    const current = this.transportStats.get(botId) ?? { reconnects: 0, failures: 0 }
    const now = Date.now()
    this.transportStats.set(botId, {
      ...current,
      reconnects: current.reconnects + (state === 'reconnecting' ? 1 : 0),
      failures: current.failures + (state === 'failed' ? 1 : 0),
      ...(state === 'connected' ? { lastConnectedAt: now } : {}),
      ...(state === 'closed' || state === 'failed' || state === 'reconnecting' ? { lastDisconnectedAt: now } : {}),
    })
    this.audit({ kind: 'transport', state, botId })
    this.refreshOps()
    if (state === 'reconnecting' || state === 'failed' || state === 'closing' || state === 'closed') {
      this.approvals.cancelBot(botId)
    }
    if (error) this.logger.error('transport %s -> %s: %s', botId, state, error.message)
    else this.logger.info('transport %s -> %s', botId, state)
    if (state === 'connected') {
      void this.outbox.drain().catch((drainError) => {
        this.logger.warn('outbox drain on reconnect failed: %s', String(drainError))
      })
    }
  }

  private runOperatorMailbox(): void {
    if (this.stopped || this.commandRunning) return
    this.commandRunning = true
    const pending = processOperatorCommands(this.config.stateDir, async (command) =>
      this.executeOperatorCommand(command))
    this.commandPromise = pending.then(() => undefined).catch(() => {
      this.logger.warn('operations mailbox unavailable')
    }).finally(() => { this.commandRunning = false })
  }

  private async executeOperatorCommand(command: OperatorCommand): Promise<OperatorResult['state']> {
    if (this.stopped) return 'rejected'
    if (command.type === 'retry-outbox') {
      // Existing durable Outbox UUID/idempotency and permanent-failure rules
      // remain intact. This NEVER re-executes an uncertain Agent turn.
      await this.outbox.drain()
      this.audit({ kind: 'delivery', state: 'operator-retry' })
      return 'completed'
    }
    if (command.type !== 'cancel-task' || !command.ref) return 'rejected'
    const matches = [...this.activeTurns.values()].filter(x =>
      opsRef(x.messageId) === command.ref && x.phase === 'running' && !x.cancelledByUser)
    if (matches.length !== 1) return 'not-found'
    const active = matches[0]!
    this.requestCancel(active) // Same safe path as the owner's CardKit /cancel
    this.audit({ kind: 'task', state: 'operator-cancel', botId: active.botId,
      ref: active.messageId, session: active.sessionId })
    return 'completed'
  }

  private audit(event: {
    kind: OpsEvent['kind']; state: string; botId?: string; ref?: string
    session?: string; model?: string; tokens?: number; elapsedMs?: number
  }): void {
    void this.ops.record(event).catch(() => this.logger.warn('operations journal unavailable'))
  }

  private refreshOps(): void {
    if (this.startedAt === 0) return
    const health = this.health()
    const snapshot: OpsSnapshot = {
      version: 1, ts: Date.now(), status: health.status,
      tasks: [...this.activeTurns.values()].map(turn => ({
        ref: opsRef(turn.messageId), ...(turn.sessionId ? { session: opsRef(turn.sessionId) } : {}),
        botId: turn.botId, phase: turn.phase, elapsedMs: Date.now() - turn.startedAt,
      })),
      sessions: this.registry.bindings().map(binding => ({
        ref: opsRef(binding.sessionId), createdAt: binding.createdAt,
        lastActiveAt: binding.lastActiveAt, persisted: binding.persisted,
      })),
      transport: Object.fromEntries([...this.transports].map(([botId, transport]) => [
        botId, { state: transport.state, ...(this.transportStats.get(botId) ??
          { reconnects: 0, failures: 0 }) },
      ])),
      stats: {
        activeTurns: health.activeTurns, boundSessions: health.boundSessions,
        pendingApprovals: health.pendingApprovals, processed: health.processed,
        errors: health.errors, outboxPending: health.outbox.pending,
        inboxPending: health.inbox.pending,
      },
    }
    void this.ops.snapshot(snapshot).catch(() => this.logger.warn('operations snapshot unavailable'))
  }

  health(): GatewayHealth {
    const configuredBots = this.config.bots.filter((bot) => bot.enabled).length
    const degraded = !this.bridge.available
      || this.transports.size < configuredBots
      || [...this.transports.values()].some((t) => t.state === 'failed'
        || (this.started && this.config.autoConnect && t.state !== 'connected'))
    return {
      status: this.stopped ? 'stopped' : degraded ? 'degraded' : 'ok',
      transports: Object.fromEntries([...this.transports].map(([id, t]) => [id, t.state])),
      sessionBridge: {
        available: this.bridge.available,
        ...(this.bridge.unavailableReason ? { reason: this.bridge.unavailableReason } : {}),
      },
      inbox: this.inbox.stats(),
      outbox: this.outbox.stats(),
      dedupEntries: this.dedupSnapshot,
      boundSessions: this.registry.bindings().length,
      activeTurns: this.activeTurns.size,
      pendingApprovals: this.approvals.size,
      processed: this.processed,
      rejected: { ...this.rejected },
      errors: this.errors,
      uptimeMs: this.startedAt === 0 ? 0 : Date.now() - this.startedAt,
    }
  }

  /** Updated on admission and refreshed by `diagnostics()`. */
  private dedupSnapshot = 0

  async diagnostics(): Promise<GatewayHealth> {
    this.dedupSnapshot = await this.dedup.size()
    return this.health()
  }
}
