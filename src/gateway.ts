import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DedupIndex } from './inbox/dedup.js'
import { FeishuApprovalManager, type ApprovalRequestLike, type ApprovalOutcome } from './channel/approval-manager.js'
import { ApprovalStore } from './channel/approval-store.js'
import { TaskProgressCard } from './channel/task-progress-card.js'
import { CARD_NAMESPACE } from './channel/card-content.js'
import { commandHelp, parseControlCommand, type ControlCommand } from './control/commands.js'
import { DurableInbox, type InboxRecord } from './inbox/inbox.js'
import { DurableOutbox } from './outbox/outbox.js'
import { MessageRouter, type RejectReason } from './router/message-router.js'
import { SessionRegistry } from './session/session-registry.js'
import { truncateText } from './session/session-bridge.js'
import { SessionTurnFailure } from './session/turn-failure.js'
import { acquireStateDirOwnerLock, type StateDirOwnerLock } from './storage/owner-lock.js'
import type {
  FeishuTransport,
  CardActionEvent,
  GatewayConfig,
  GatewayLogger,
  InboundMessage,
  ModelTokenUsage,
  SessionBridge,
  SessionReply,
  TransportState,
} from './types.js'
import { chatKey, newId, sessionIdFor } from './util/id.js'
import { withTimeout } from './util/retry.js'
import { OpsTelemetry, opsRef, type OpsEvent, type OpsSnapshot } from './ops/telemetry.js'
import { resolveFeishuWorkspace, prepareFeishuWorkspace } from './agent-workspace.js'
import { loadManagedConfig } from './admin-config.js'
import { resolveConfig } from './config.js'
import { processOperatorCommands, type OperatorCommand, type OperatorResult } from './ops/commands.js'
import { ScheduleManager, type FeishuDeliveryInput, type ScheduleCommand } from './schedule/index.js'

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
  /** Non-sensitive network route chosen by the launcher preflight. */
  readonly network: { readonly proxySelected: string | null }
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
  readonly chatType: 'p2p' | 'group'
  readonly senderId: string
  readonly replyToMessageId: string
  stream?: TaskProgressCard
  readonly messageId: string
  readonly startedAt: number
  readonly controller: AbortController
  sessionId?: string
  cancelledByUser: boolean
  cancelSource?: 'card' | 'command' | 'operator'
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
  'group-not-allowlisted',
  'group-sender-not-allowlisted',
  'mention-required',
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
  private scheduleTimer: ReturnType<typeof setInterval> | undefined
  private commandRunning = false
  private commandPromise: Promise<void> | undefined
  private unwatchScheduleTurns: (() => void) | undefined
  /** Native DSH schedule bridge (task definitions live in the Host service). */
  private readonly schedules: ScheduleManager
  /** Reserved Gateway-owned Sessions for scheduled tasks, by command clientRef. */
  private readonly taskSessions = new Map<string, string>()
  private readonly restoredTaskSessions = new Set<string>()
  private readonly ops: OpsTelemetry
  private readonly isolatedWorkspace: string
  private readonly transportStats = new Map<string, { reconnects: number; failures: number; lastConnectedAt?: number; lastDisconnectedAt?: number }>()
  private readonly chatQueues = new Map<string, Promise<void>>()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly scheduledMessageIds = new Set<string>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly approvals: FeishuApprovalManager
  /** Durable permanent authorizations + approval audit for the Web Admin. */
  private readonly approvalStore: ApprovalStore
  private approvalPublish: Promise<void> = Promise.resolve()
  private readonly rejected: Record<RejectReason, number>
  private ownerLock: StateDirOwnerLock | undefined
  private modelCatalog: {
    ts: number
    incomplete: boolean
    models: string[]
    providers: Array<{ id: string; name?: string; models: Array<{ id: string; name?: string }> }>
  } | undefined
  private modelCatalogAttempt = 0
  private modelCatalogLoading = false
  /** DSH Agent preset roster published for the Web Admin working-mode selector. */
  private presetCatalog: OpsSnapshot['agentPresets'] | undefined
  private presetCatalogAttempt = 0
  private presetCatalogLoading = false
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
    this.isolatedWorkspace = resolveFeishuWorkspace(deps.config)
    this.router = new MessageRouter(deps.config)
    this.approvalStore = new ApprovalStore({ stateDir: deps.config.stateDir, logger: deps.logger })
    this.approvals = new FeishuApprovalManager(
      deps.config.approvalTimeoutMs,
      (owner, actor) => actor === owner.senderId &&
        this.router.allowedActor(owner.chatType ?? 'p2p', owner.chatId, actor),
      (sessionId) => {
        const active = [...this.activeTurns.values()].find(turn =>
          turn.sessionId === sessionId && turn.phase === 'running' && !turn.cancelledByUser)
        return active ? {
          botId: active.botId, chatId: active.chatId, chatType: active.chatType,
          senderId: active.senderId, replyToMessageId: active.replyToMessageId,
        } : undefined
      },
      (botId) => this.transports.get(botId),
      deps.logger,
      (sessionId, state, botId) => this.audit({ kind: 'approval', state, session: sessionId, botId }),
      { store: this.approvalStore, onChanged: () => { void this.publishApprovals() } },
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
    this.schedules = new ScheduleManager({
      logger: deps.logger,
      stateDir: deps.config.stateDir,
      now: () => Date.now(),
      isStopped: () => this.stopped,
      ensureTaskSession: (clientRef, title) => this.ensureTaskSession(clientRef, title),
      releaseTaskSession: (sessionId) => this.releaseTaskSession(sessionId),
      validateFeishuTarget: (target) => this.validateScheduleTarget(target),
      recordUsage: (value) => this.ops.recordUsage(value),
      sendFeishu: (botId, target, idempotencyKey) => this.outbox.send(botId, {
        chatId: target.chatId,
        ...(target.chatId.startsWith('ou_') ? { receiveIdType: 'open_id' as const } : {}),
        text: target.text,
        ...(target.card ? { card: target.card } : {}),
        ...(target.format === 'markdown' && !target.card ? { format: 'markdown' as const } : {}),
      }, idempotencyKey),
    })
  }

  /** Attached by `apply()` once the native `schedule` service resolves. */
  get scheduleManager(): ScheduleManager {
    return this.schedules
  }

  /** True when the Session belongs to a Gateway-managed scheduled task. */
  isTaskSession(sessionId: string): boolean {
    return this.schedules.isTaskSession(sessionId)
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
      await prepareFeishuWorkspace(this.config)
      await this.dedup.open()
      const pending = await this.inbox.open()
      await this.registry.open()
      const outboxPending = await this.outbox.open()
      await this.approvalStore.load()
      await this.schedules.start()
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
          await this.registry.unbind(this.scopeKey(record))
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
      void this.publishApprovals()
      this.opsTimer = setInterval(() => this.refreshOps(), 10000)
      this.opsTimer.unref?.()
      this.commandTimer = setInterval(() => this.runOperatorMailbox(), 1500)
      this.commandTimer.unref?.()
      // Native schedule deliveries inject a `source.kind === 'schedule'` user
      // message into one of our Feishu Sessions. The bridge observes the turn
      // and the manager forwards the answer through the durable Outbox.
      this.unwatchScheduleTurns = this.bridge.watchScheduleTurns?.((turn) => {
        void this.schedules.onScheduleTurn(turn).catch((error) => {
          this.logger.warn('scheduled task notification failed: %s', String(error))
        })
      })
      this.scheduleTimer = setInterval(() => {
        if (this.stopped) return
        void this.schedules.refresh().catch((error) => {
          this.logger.warn('schedule catalog refresh failed: %s', String(error))
        })
        void this.restoreTaskSessions().catch((error) => {
          this.logger.debug('schedule session restore failed: %s', String(error))
        })
      }, 10_000)
      this.scheduleTimer.unref?.()
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
    await this.approvalPublish.catch(() => undefined)
    if (this.outboxRetryTimer) clearInterval(this.outboxRetryTimer)
    if (this.opsTimer) clearInterval(this.opsTimer)
    this.opsTimer = undefined
    if (this.commandTimer) clearInterval(this.commandTimer)
    this.commandTimer = undefined
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    this.scheduleTimer = undefined
    this.unwatchScheduleTurns?.()
    this.unwatchScheduleTurns = undefined
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
    await this.schedules.stop()
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
    this.audit({ kind: 'message',
      state: record.chatType === 'group' ? 'group-received' : 'received',
      botId: record.botId, ref: record.messageId })
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
    const matching = [...this.activeTurns.values()].filter(active =>
      active.botId === event.botId && active.chatId === event.chatId &&
      active.senderId === event.actorOpenId)
    if (this.stopped || !matching.some(active =>
      this.router.allowedActor(active.chatType, active.chatId, event.actorOpenId))) {
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
    const active = matching.find(turn => turn.stream?.handle.messageId === event.messageId &&
      turn.stream.nonce === event.value.nonce)
    if (!active || active.botId !== event.botId || active.chatId !== event.chatId ||
      active.senderId !== event.actorOpenId || active.phase !== 'running' ||
      active.cancelledByUser || event.value.nonce !== active.stream?.nonce ||
      event.messageId !== active.stream?.handle.messageId) {
      return toast('warning', '任务已结束或无法验证卡片')
    }
    this.requestCancel(active, 'card')
    return toast('success', '已请求取消当前任务')
  }

  private requestCancel(active: ActiveTurn, source: 'card' | 'command' | 'operator' = 'command'): void {
    if (active.cancelledByUser || active.phase !== 'running') return
    active.cancelledByUser = true
    active.cancelSource = source
    this.logger.info('Feishu task cancellation requested: source=%s session=%s', source, active.sessionId ?? 'pending')
    this.audit({ kind: 'task', state: 'cancel-requested-' + source, botId: active.botId,
      ref: active.messageId, session: active.sessionId })
    active.controller.abort()
    if (active.sessionId) {
      this.approvals.cancelSession(active.sessionId)
      try { this.bridge.cancel(active.sessionId) }
      catch { this.logger.warn('native Agent cancellation failed') }
    }
  }

  /** Reauthorize persisted messages before any command or native Agent dispatch. */
  private recordMessage(record: InboxRecord): InboundMessage {
    return { messageId: record.messageId, botId: record.botId, chatId: record.chatId,
      chatType: record.chatType ?? 'p2p', senderId: record.senderId, senderType: 'user',
      text: record.text, createTime: record.receivedAt, messageType: record.messageType ?? 'text',
      mentionedBot: record.mentionedBot === true,
      ...(record.threadId ? { threadId: record.threadId } : {}),
      ...(record.rootId ? { rootId: record.rootId } : {}) }
  }

  private scopeKey(record: InboxRecord): string {
    const base = chatKey(record.botId, record.chatId)
    if (record.chatType !== 'group') return base
    const scope = this.router.groupRule(record.chatId)?.sessionScope ?? 'group_sender'
    const topic = record.threadId || record.rootId || record.messageId
    const parts = scope === 'group' ? [] :
      scope === 'group_sender' ? [record.senderId] :
      scope === 'group_topic' ? [topic] : [topic, record.senderId]
    const suffix = createHash('sha256').update(JSON.stringify([scope, ...parts])).digest('hex').slice(0, 32)
    return base + ':group:' + suffix
  }

  private async processRecord(record: InboxRecord): Promise<void> {
    const command = parseControlCommand(record.text)
    // A cancellation or status request MUST bypass the current chat's Agent
    // queue, otherwise a 5-minute turn would block the very control used to
    // stop or inspect it. /new remains serialized behind current work.
    if (command === 'cancel' || command === 'status' || command === 'help' || command === 'context') {
      await this.dispatchControl(record, command)
      return
    }
    await this.enqueue(record.botId, record.chatId, () =>
      command === 'new' || command === 'model' || command === 'models' || command === 'compact'
        ? this.dispatchControl(record, command) : this.dispatch(record), this.scopeKey(record))
  }

  /** Serialize work per chat so two rapid messages cannot interleave turns. */
  private enqueue(botId: string, chatId: string, work: () => Promise<void>, scope?: string): Promise<void> {
    const key = scope ?? chatKey(botId, chatId)
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
    const decision = this.router.decide(this.recordMessage(record))
    if (!decision.accepted) {
      this.rejected[decision.reason] += 1
      await this.inbox.markProcessed(record.messageId)
      return
    }

    const key = this.scopeKey(record)
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
      } else if (command === 'context') {
        const bound = this.registry.get(key)
        const status = this.bridge.compactionStatus?.(bound?.sessionId)
        reply = [
          'DSH 上下文压缩',
          '原生压缩引擎：' + (status?.available ? '可用' : '未检测到'),
          status?.available
            ? '自动触发：由 DSH compaction-basic 根据模型上下文与输出预留决定（飞书不重复设阈值）。'
            : '自动压缩：未确认启用；请在 Gateway 所属 DSH Profile 中检查 dsh-compaction-basic。',
          bound
            ? '当前聊天：已有 DSH 会话'
            : '当前聊天：尚未创建会话',
          status?.lastCompletedAt
            ? '本次 Gateway 启动后已观察到 ' + status.completedInProcess +
              ' 次完整压缩；最近一次：' + new Date(status.lastCompletedAt).toISOString() +
              '，替换历史项 ' + (status.lastShadowedItems ?? 0) + ' 个。'
            : '本次 Gateway 启动后尚未观察到该会话完成压缩；不代表历史上从未压缩。',
          '手动触发：/compact（仅已有会话；不影响其他聊天）。',
          '说明：累计模型用量不等于当前上下文占用；原生历史日志会保留。',
        ].join('\n')
      } else if (command === 'compact') {
        const bound = this.registry.get(key)
        const status = this.bridge.compactionStatus?.(bound?.sessionId)
        if (!bound) {
          reply = '当前聊天尚未创建 DSH 会话，没有可压缩的历史。先发送普通消息，再使用 /compact。'
        } else if (!status?.available || !this.bridge.compactNow) {
          reply = '此 DSH Profile 未检测到原生 compaction 后端。请检查 @deepseek-ai/dsh-compaction-basic 是否已加载；飞书不会生成替代摘要。'
        } else {
          // Per-chat queue serializes this against Feishu turns; DSH's own
          // compactNow() admission lock also rejects concurrent scheduled
          // turns or compactions. No second Agent turn is created.
          const sessionId = await this.ensureSession(key, record.botId, record.chatId,
            record.senderId, record.chatType)
          const signalController = new AbortController()
          const onStop = () => signalController.abort(new Error('gateway stopping'))
          const timeout = setTimeout(() => signalController.abort(new Error('compaction timed out')),
            Math.max(30_000, Math.min(this.config.replyTimeoutMs, 180_000)))
          this.abortController.signal.addEventListener('abort', onStop, { once: true })
          try {
            const result = await this.bridge.compactNow(sessionId, signalController.signal)
            reply = result.outcome === 'nothing-to-compact'
              ? '当前没有足够的旧历史可以安全压缩，未修改会话。'
              : '已完成 DSH 原生上下文压缩：替换 ' + (result.shadowedItems ?? 0) +
                ' 个旧历史项。原始日志仍保留，最近对话继续可用。' +
                (result.shadowedTokens !== undefined
                  ? '\n压缩前被替换区域估算约 ' + result.shadowedTokens +
                    ' tokens（不等于净节省量）。' : '')
          } catch (error) {
            const code = (error as { code?: unknown })?.code
            if (code === 'busy') reply = '当前会话仍有 Agent 任务或压缩在进行，无法同时压缩。请在任务结束后重试。'
            else if (code === 'cancelled' || signalController.signal.aborted)
              reply = '压缩已取消或超时；请使用 /context 查看状态，再决定是否重试。'
            else if (code === 'changed')
              reply = '压缩期间会话历史发生变化。本次没有替换旧历史，请稍后重试。'
            else if (code === 'summary')
              reply = '压缩模型未能产生有效摘要，DSH 没有用不可靠摘要替换历史。'
            else if (code === 'commit' || code === 'persistence')
              reply = '压缩保存阶段出现异常，会话可能已有部分变更；请检查 DSH 会话历史，不要立即重复执行。'
            else {
              this.logger.warn('native session compaction failed: %s', String(error))
              reply = 'DSH 原生压缩未完成，请检查 Gateway Host 的压缩服务和模型日志。'
            }
          } finally {
            clearTimeout(timeout)
            this.abortController.signal.removeEventListener('abort', onStop)
          }
        }
      } else if (command === 'models') {
        const extra = record.text.trim().replace(/^\/models\s*/i, '').trim()
        if (extra) {
          reply = '查看模型请发送 /models；切换模型请发送 /model provider/model。'
        } else {
          const existing = this.registry.get(key)
          let current: string | undefined
          if (existing) {
            const sessionId = await this.ensureSession(key, record.botId, record.chatId, record.senderId, record.chatType)
            const selected = this.bridge.currentModel?.(sessionId)
            if (selected) current = selected.provider + '/' + selected.model
          }
          const currentLine = current ? '当前会话模型：' + current
            : existing ? '当前会话模型暂不可用。' : '当前聊天尚未建立会话，暂没有当前会话模型。'
          const fallbacks = this.fallbackRoutes()
          const fallbackLine = fallbacks.length
            ? '备用模型（按顺序尝试，仅在未执行工具时重试）：' +
              fallbacks.map((item, index) => '\n' + (index + 1) + '. ' + item.provider + '/' + item.model).join('')
            : ''
          const listing = this.bridge.listModels ? await withTimeout(this.bridge.listModels(), 30_000) : undefined
          const catalog = listing && !listing.timedOut ? listing.value : undefined
          if (!catalog) {
            reply = [currentLine, fallbackLine, '模型目录暂不可用，请稍后重试。'].filter(Boolean).join('\n')
          } else {
            const routes = catalog.models.map(item => item.provider + '/' + item.model)
            reply = [currentLine, fallbackLine,
              routes.length ? '飞书通道可用模型：' : '飞书通道暂未发现可用模型。',
              ...routes.map(route => '• ' + route + (route === current ? '（当前）' : '')),
              catalog.incomplete ? '部分模型提供方查询失败，列表可能不完整。' : '',
              '使用 /model provider/model 切换当前会话模型。'].filter(Boolean).join('\n')
          }
        }
      } else if (command === 'model') {
        const choice = record.text.trim().replace(/^\/model\s*/i, '').trim()
        if (!choice) {
          reply = '请发送 /model provider/model 切换当前会话模型；发送 /models 查看可用模型。'
        } else {
          const listing = this.bridge.listModels ? await withTimeout(this.bridge.listModels(), 30_000) : undefined
          const catalog = listing && !listing.timedOut ? listing.value : undefined
          if (!catalog) {
            reply = '模型目录暂不可用，请稍后重试。'
          } else {
            const found = catalog.models.find(item => item.provider + '/' + item.model === choice)
            if (!found) {
              reply = '未找到该模型，请先发送 /models 查看飞书通道可用模型。'
            } else if (!this.bridge.selectModel) {
              reply = '当前 DSH Host 不支持会话模型切换。'
            } else {
              const sessionId = await this.ensureSession(key, record.botId, record.chatId, record.senderId, record.chatType)
              this.bridge.selectModel(sessionId, found.provider, found.model)
              reply = '当前会话已切换模型：' + found.provider + '/' + found.model + '\n下次请求生效；其他聊天和定时任务不受影响。'
            }
          }
        }
      } else if (command === 'cancel') {
        const active = this.activeTurns.get(key)
        if (!active || active.senderId !== record.senderId ||
          active.cancelledByUser || active.phase !== 'running') {
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
      if (command === 'models' && reply.length > 3000) {
        let part = ''
        let index = 0
        for (const line of reply.split('\n')) {
          if (part && part.length + line.length + 1 > 3000) {
            await this.replyDiagnostic(record, part, `models:${record.messageId}:${index++}`)
            part = ''
          }
          // Individual names are short and validated by the DSH directory.
          part += (part ? '\n' : '') + line
        }
        if (part) await this.replyDiagnostic(record, part, `models:${record.messageId}:${index}`)
      } else {
        await this.replyDiagnostic(record, reply)
      }
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
    const decision = this.router.decide(this.recordMessage(record))
    if (!decision.accepted) {
      this.rejected[decision.reason] += 1
      await this.inbox.markProcessed(record.messageId)
      return
    }
    const key = this.scopeKey(record)
    const turn: ActiveTurn = {
      botId: record.botId, chatId: record.chatId, chatType: record.chatType ?? 'p2p',
      senderId: record.senderId, replyToMessageId: record.messageId,
      messageId: record.messageId, startedAt: Date.now(),
      controller: new AbortController(), cancelledByUser: false, phase: 'running',
    }
    this.activeTurns.set(key, turn)
    this.audit({ kind: 'task', state: 'running', botId: record.botId, ref: record.messageId })
    const signal = AbortSignal.any([this.abortController.signal, turn.controller.signal])
    let activeSessionId: string | undefined
    let unsubscribeProgress: (() => void) | undefined
    let unsubscribeTools: (() => void) | undefined
    let progressStatus: 'done' | 'cancelled' | 'failed' = 'failed'
    let attempted = false
    let reportedUsage: ModelTokenUsage | undefined
    let reportedModel: string | undefined
    let usageOutcome: 'done' | 'failed' | 'cancelled' | 'timeout' | 'uncertain' = 'failed'
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

      const sessionId = await this.ensureSession(key, record.botId, record.chatId, record.senderId, record.chatType)
      activeSessionId = sessionId
      turn.sessionId = sessionId
      this.audit({ kind: 'task', state: 'session-ready', botId: record.botId,
        ref: record.messageId, session: sessionId })
      if (signal.aborted) throw new Error('turn aborted before submit')
      attempted = true
      // Ordered fallback chain: never replay after tools ran, and attempt each
      // configured route at most once. Legacy single-fallback is one-item chain.
      const pendingFallbacks = this.fallbackRoutes()
      const attachProgress = () => {
        if (!turn.stream) return
        const card = turn.stream
        unsubscribeProgress = this.bridge.onTextDelta?.(sessionId, (delta) => card.onTextDelta(delta))
        unsubscribeTools = this.bridge.onToolActivity?.(sessionId, (event) => card.onToolActivity(event))
      }
      let reply: SessionReply
      for (;;) {
        await this.bridge.submit(sessionId, record.text, signal)
        if (this.config.streamCards && !signal.aborted && !turn.stream) {
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
              if (progress && !signal.aborted) turn.stream = progress
            }
          } catch {
            // Non-durable progress must NEVER prevent a durable final reply.
            this.logger.warn('Feishu progress card unavailable; keeping durable reply')
          }
        }
        attachProgress()
        try {
          reply = await this.bridge.waitForReply(sessionId, {
            timeoutMs: this.config.replyTimeoutMs,
            signal,
          })
          break
        } catch (error) {
          if (!this.canRetryWithFallback(error)) throw error
          const current = this.bridge.currentModel?.(sessionId)
          let fallback = pendingFallbacks.shift()
          while (fallback && current?.provider === fallback.provider && current?.model === fallback.model) {
            fallback = pendingFallbacks.shift()
          }
          if (!fallback) throw error
          // The failed native turn already settled, so these observers belong
          // to the discarded attempt; the next iteration re-attaches them.
          unsubscribeProgress?.()
          unsubscribeProgress = undefined
          unsubscribeTools?.()
          unsubscribeTools = undefined
          this.logger.warn(
            'model request failed before any tool call; trying next fallback route %s/%s',
            fallback.provider, fallback.model)
          this.audit({ kind: 'task', state: 'fallback-retry', botId: record.botId,
            ref: record.messageId, session: sessionId,
            model: fallback.provider + '/' + fallback.model })
          try {
            this.bridge.selectModel?.(sessionId, fallback.provider, fallback.model)
          } catch (selectionError) {
            this.logger.warn('fallback model selection failed: %s', String(selectionError))
            throw error
          }
        }
      }
      // A task can consume tokens even if delivery fails or the turn times out.
      reportedUsage = reply.usage
      reportedModel = reply.model
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
        this.logger.warn('Feishu task exceeded reply deadline: session=%s timeoutMs=%d tools=%d failures=%d',
          sessionId, this.config.replyTimeoutMs, reply.toolCalls ?? 0, reply.toolFailures ?? 0)
        this.bridge.cancel(sessionId)
        // A late reply from the prior Agent must never enter the next turn.
        await this.registry.unbind(key)
        await this.bridge.retire?.(sessionId)
        await this.replyDiagnostic(record, `执行超时（上限 ${Math.round(this.config.replyTimeoutMs / 1000)} 秒），` +
          `已调用工具 ${reply.toolCalls ?? 0} 次（失败 ${reply.toolFailures ?? 0} 次）。` +
          '原会话已隔离以避免继续执行；可缩小问题范围后重试。')
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
          unsubscribeTools?.()
          unsubscribeTools = undefined
          try {
            const terminal = await withTimeout(card.close('done', answer, {
              elapsedMs: Date.now() - turn.startedAt,
              ...(reply.model ? { model: reply.model } : {}),
              ...(reply.usage ? { usage: reply.usage } : {}),
              ...(reply.generationMs ? { generationMs: reply.generationMs } : {}),
              toolCalls: reply.toolCalls, toolFailures: reply.toolFailures,
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
      usageOutcome = finalState === 'timed-out' ? 'timeout' : finalState
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
          String(error).includes('legacy Session uses the shared workspace')
            ? '本聊天仍绑定旧版共享 DSH 工作区的 Session。为避免继承普通 DSH 的身份与记忆，本次没有继续执行。请在飞书发送 /new 创建独立的飞书 Agent Session；原 Session 历史不会被删除。'
            : 'DSH 原有会话恢复失败，已保留会话绑定，没有重新创建空白会话。本次消息未提交给 Agent；请检查 DSH Host、Agent Loop 和 Session 持久化。')
      } else {
        await this.replyDiagnostic(record,
          '处理失败，可能已经执行部分操作；请先检查 DSH 会话，再决定是否重试。')
      }
    } finally {
      if (activeSessionId) this.approvals.cancelSession(activeSessionId)
      unsubscribeProgress?.()
      unsubscribeTools?.()
      if (turn.stream) {
        try {
          const closing = await withTimeout(turn.stream.close(progressStatus), 5_000)
          if (closing.timedOut) this.logger.warn('Feishu CardKit stream cleanup exceeded deadline')
        } catch { this.logger.warn('Feishu CardKit stream cleanup failed') }
      }
      if (attempted) {
        // Persist an explicit unknown-usage record for failed/cancelled turns.
        // The ledger is separate from bounded audit events and contains no text.
        const status = this.abortController.signal.aborted ? 'uncertain'
          : turn.cancelledByUser ? 'cancelled' : usageOutcome
        await this.ops.recordUsage({
          ref: record.messageId, botId: record.botId, chat: record.chatId,
          user: record.senderId, session: activeSessionId,
          model: reportedModel, status, usage: reportedUsage,
        }).catch(() => this.logger.warn('token history unavailable'))
      }
      if (this.activeTurns.get(key) === turn) this.activeTurns.delete(key)
      this.refreshOps()
    }
  }

  /**
   * Reserve one Gateway-owned native DSH Session for a scheduled task.
   * The native schedule service then targets it with `{ kind:'session' }`, so
   * `session/event` reaches our plugin-level listener (verified for Sessions
   * created through `ctx.agents.create`) and the answer can reach Feishu.
   */
  private async ensureTaskSession(clientRef: string, title?: string): Promise<string> {
    const existing = this.taskSessions.get(clientRef)
    if (existing) return existing
    const sessionId = `${sessionIdFor('schedule', clientRef)}-${newId('session')}`
    await this.bridge.create(sessionId, this.isolatedWorkspace, this.config.agent, this.config.agentPreset)
    await this.setNativeTitle(sessionId, '飞书定时·' + (title?.trim() || clientRef.slice(-8)))
    this.taskSessions.set(clientRef, sessionId)
    this.restoredTaskSessions.add(sessionId)
    this.logger.info('reserved native session %s for scheduled task %s', sessionId, clientRef)
    return sessionId
  }

  /** Retire a task Session after its native task is deleted (best effort). */
  private async releaseTaskSession(sessionId: string): Promise<void> {
    for (const [ref, id] of this.taskSessions) {
      if (id === sessionId) this.taskSessions.delete(ref)
    }
    this.restoredTaskSessions.delete(sessionId)
    try { await this.bridge.retire?.(sessionId) }
    catch (error) { this.logger.warn('failed to retire scheduled task session: %s', String(error)) }
  }

  /**
   * After a restart the persisted task -> Session map is known to the manager
   * but the Bridge owns no live handle yet. Restore them so native deliveries
   * can resolve an active Agent without a Web-only `sessionController`.
   */
  private async restoreTaskSessions(): Promise<void> {
    if (this.stopped || !this.bridge.available) return
    for (const task of this.schedules.snapshot().tasks) {
      const target = task.target as unknown as { sessionId?: unknown } | undefined
      const sessionId = typeof target?.sessionId === 'string' ? target.sessionId : undefined
      if (!sessionId || !this.schedules.isTaskSession(sessionId) ||
        this.restoredTaskSessions.has(sessionId)) continue
      try {
        await this.bridge.resume(sessionId, this.config.agent)
        await this.setNativeTitle(sessionId, '飞书定时·' + (task.title || sessionId.slice(-8)))
        this.restoredTaskSessions.add(sessionId)
      } catch (error) {
        this.logger.debug('cannot restore scheduled task session %s: %s', sessionId, String(error))
      }
    }
  }

  /**
   * Re-check a Feishu delivery target against the CURRENT managed policy.
   * Scheduled tasks must never bypass the user/group allowlist, group rules or
   * native tool approval. A hot revocation therefore also stops delivery.
   */
  private async validateScheduleTarget(
    target: FeishuDeliveryInput,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
    let config: GatewayConfig
    try {
      config = loadManagedConfig(resolveConfig(this.config))
    } catch (error) {
      this.logger.warn('scheduled delivery authorization unavailable: managed config could not be read (%s)',
        error instanceof Error ? error.name : 'unknown')
      return fail('authorization configuration unavailable')
    }
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(target.botId)) return fail('invalid bot id')
    if (!config.bots.some((bot) => bot.id === target.botId && bot.enabled !== false)) {
      return fail('unknown or disabled bot')
    }
    if (!/^(?:oc_|ou_)[A-Za-z0-9_-]{2,128}$/.test(target.chatId)) return fail('invalid chat id')
    if (target.chatType === 'p2p') {
      if (!target.senderId || !/^ou_[A-Za-z0-9_-]{2,128}$/.test(target.senderId)) {
        return fail('missing target user')
      }
      if (config.allowlist.length === 0 || !config.allowlist.includes(target.senderId)) {
        return fail('target user is not allowlisted')
      }
      return { ok: true }
    }
    if (target.chatType === 'group') {
      if (config.groupPolicy === 'disabled') return fail('group delivery is disabled')
      const rule = config.groups.find((group) =>
        group.chatId === target.chatId && group.enabled !== false)
      if (!rule) return fail('group is not authorized')
      if (config.groupSenderAllowlist.length === 0) return fail('no group senders allowed')
      // A sender-scoped scheduled delivery must remain authorized after the
      // creator is revoked. Owner-managed group broadcasts may omit senderId.
      if (target.senderId) {
        if (!config.groupSenderAllowlist.includes(target.senderId) ||
            (rule.senderAllowlist && !rule.senderAllowlist.includes(target.senderId))) {
          return fail('scheduled task sender was revoked')
        }
      } else if (rule.senderAllowlist &&
        !rule.senderAllowlist.some((id) => config.groupSenderAllowlist.includes(id))) {
        return fail('no allowed group senders')
      }
      return { ok: true }
    }
    return fail('invalid chat type')
  }

  private async setNativeTitle(sessionId: string, title: string): Promise<void> {
    if (!this.bridge.title || this.bridge.titleSource?.(sessionId) === 'user') return
    // DSH's sessionTitle service enforces its own configured maxTitleBytes.
    let safe = title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    while (Buffer.byteLength(safe, 'utf8') > 120) safe = safe.slice(0, -1)
    if (!safe) return
    try { await this.bridge.title(sessionId, safe) }
    catch { this.logger.warn('Feishu Session title unavailable; continuing normally') }
  }

  private async setChatTitle(sessionId: string, botId: string, chatId: string,
    senderId?: string, chatType?: 'p2p' | 'group'): Promise<void> {
    if (!this.bridge.title || this.bridge.titleSource?.(sessionId) === 'user') return
    const group = chatType === 'group' ||
      (chatType === undefined && this.config.groups.some(item => item.chatId === chatId))
    const transport = this.transports.get(botId)
    let name: string | undefined
    if (group) {
      name = this.config.groups.find(item => item.chatId === chatId)?.name?.trim()
      if (!name) {
        try { name = await transport?.lookupChatName?.(chatId) }
        catch { /* Feishu permission dependent */ }
      }
      await this.setNativeTitle(sessionId, '飞书群·' +
        (this.transports.size > 1 ? botId + '·' : '') + (name || chatId.slice(-6)))
    } else {
      if (senderId) {
        try { name = await transport?.lookupUserName?.(senderId) }
        catch { /* Feishu permission dependent */ }
      }
      await this.setNativeTitle(sessionId, '飞书·私聊·' + (name || chatId.slice(-6)))
    }
  }

  private async ensureSession(key: string, botId: string, chatId: string,
    senderId?: string, chatType?: 'p2p' | 'group'): Promise<string> {
    const existing = this.registry.get(key)
    if (!existing) {
      const sessionId = `${sessionIdFor(botId, chatId)}-${newId('session')}`
      try {
        await this.bridge.create(sessionId, this.isolatedWorkspace, this.config.agent, this.config.agentPreset)
      } catch (error) {
        throw new Error(`cannot create native DSH Session: ${String(error)}`)
      }
      await this.registry.bind(key, sessionId, Date.now(), this.isolatedWorkspace)
      await this.setChatTitle(sessionId, botId, chatId, senderId, chatType)
      return sessionId
    }
    // Legacy Sessions were created in the shared DSH workspace. Never resume
    // one under a new private identity; keep its history and ask for /new.
    if (existing.workspace !== this.isolatedWorkspace) {
      throw new SessionResumeError(existing.sessionId,
        new Error('legacy Session uses the shared workspace; send /new to start an isolated Feishu Session'))
    }
    try {
      await this.bridge.resume(existing.sessionId, this.config.agent)
    } catch (error) {
      // Do NOT silently replace a chat's conversation with an empty Session.
      // A closed host, missing factory, or broken persistence needs an explicit
      // recovery decision. Keep the original binding for diagnosis / retry.
      throw new SessionResumeError(existing.sessionId, error)
    }
    await this.setChatTitle(existing.sessionId, botId, chatId, senderId, chatType)
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

  /** Process the mailbox once. Public so integration tests avoid a timer wait. */
  async pollOperatorCommands(): Promise<number> {
    return processOperatorCommands(this.config.stateDir, (command) =>
      this.executeOperatorCommand(command))
  }

  private runOperatorMailbox(): void {
    if (this.stopped || this.commandRunning) return
    this.commandRunning = true
    const pending = this.pollOperatorCommands()
    this.commandPromise = pending.then(() => undefined).catch(() => {
      this.logger.warn('operations mailbox unavailable')
    }).finally(() => { this.commandRunning = false })
  }

  /**
   * Partial failures are explicit: each binding is re-resolved and checked in
   * the same scope queue as inbound turns. A crash after one item is uncertain,
   * NEVER replayed by the operator mailbox. Native DSH data is not touched.
   */
  private async executeSessionBatch(command: OperatorCommand): Promise<{
    readonly state: OperatorResult['state']; readonly detail: string
  }> {
    const batch = command.batch
    if (!batch || !['archive', 'unlink'].includes(batch.action) ||
      batch.items.length < 1 || batch.items.length > 20) return { state: 'rejected', detail: 'invalid batch' }
    let applied = 0
    let skipped = 0
    for (const item of batch.items) {
      const matches = this.registry.entries().filter(([key, binding]) => {
        const colon = key.indexOf(':')
        return colon > 0 && key.slice(0, colon) === item.botId &&
          opsRef(key.slice(colon + 1)) === item.chatRef &&
          opsRef(binding.sessionId) === item.ref &&
          binding.lastActiveAt === item.expectedLastActiveAt
      })
      if (matches.length !== 1) { skipped += 1; continue }
      const [key, binding] = matches[0]!
      const chatId = key.slice(item.botId.length + 1)
      await this.enqueue(item.botId, chatId, async () => {
        if (this.stopped || Date.now() - command.ts >= 30_000 ||
          this.activeTurns.has(key) || this.approvals.size > 0 ||
          this.inbox.hasUnresolvedFor(item.botId, chatId.split(':group:')[0]!) ||
          this.outbox.pending().length > 0 || (batch.action === 'archive' && binding.archived)) {
          skipped += 1
          return
        }
        const changed = batch.action === 'archive'
          ? await this.registry.archiveIfUnchanged(key, binding.sessionId, binding.lastActiveAt)
          : await this.registry.unbindIfUnchanged(key, binding.sessionId, binding.lastActiveAt)
        if (!changed) { skipped += 1; return }
        applied += 1
        this.audit({ kind: 'system',
          state: batch.action === 'archive' ? 'session-archived' : 'session-unbound',
          botId: item.botId, session: binding.sessionId })
        this.refreshOps()
      }, key)
    }
    this.audit({ kind: 'system', state: 'session-batch-' + batch.action })
    return { state: skipped ? 'conflict' : 'completed',
      detail: 'applied=' + applied + ' skipped=' + skipped + ' total=' + batch.items.length }
  }

  /** Publish the durable approval/permanent-authorization read model. */
  private publishApprovals(): Promise<void> {
    if (this.stopped) return this.approvalPublish
    this.approvalPublish = this.approvalPublish.then(async () => {
      if (this.stopped) return
      try {
        await this.approvalStore.publish(this.approvals.pendingViews(), this.config.approvalTimeoutMs)
      } catch (error) {
        this.logger.warn('approval read model publish failed: %s', String(error))
      }
    })
    return this.approvalPublish
  }

  private async executeOperatorCommand(command: OperatorCommand): Promise<OperatorResult['state'] | {
    readonly state: OperatorResult['state']; readonly detail?: string
  }> {
    if (this.stopped) return 'rejected'
    if (command.type === 'schedule') {
      if (!command.schedule) return { state: 'rejected', detail: 'missing schedule payload' }
      const outcome = await this.schedules.execute({
        ...command.schedule,
        actor: command.actor ?? 'dsh-web-admin',
      } as unknown as ScheduleCommand)
      this.audit({ kind: 'system', state: `schedule-${command.schedule.action}` })
      const detail = outcome.message ?? outcome.taskId ?? outcome.state
      return { state: outcome.state, detail: `${outcome.state} ${detail}`.slice(0, 200) }
    }
    if (command.type === 'approval-revoke') {
      if (!command.ref) return 'rejected'
      const removed = await this.approvalStore.revoke(command.ref)
      if (!removed) return 'not-found'
      this.audit({ kind: 'approval', state: 'rule-revoked' })
      await this.publishApprovals()
      return { state: 'completed', detail: `revoked ${removed.label}`.slice(0, 200) }
    }
    if (command.type === 'batch-sessions') return this.executeSessionBatch(command)
    if (command.type === 'retry-outbox') {
      // Existing durable Outbox UUID/idempotency and permanent-failure rules
      // remain intact. This NEVER re-executes an uncertain Agent turn.
      await this.outbox.drain()
      this.audit({ kind: 'delivery', state: 'operator-retry' })
      return 'completed'
    }
    if (command.type === 'archive-session' || command.type === 'unbind-session') {
      if (!command.ref || command.expectedLastActiveAt === undefined) return 'rejected'
      const matches = this.registry.entries().filter(([, binding]) =>
        opsRef(binding.sessionId) === command.ref &&
        binding.lastActiveAt === command.expectedLastActiveAt)
      // A hash is a display handle, NOT permission. Authentication happens in
      // DSH Web; on the owner process still require one exact current binding.
      if (matches.length !== 1) return 'not-found'
      const [key, binding] = matches[0]!
      const colon = key.indexOf(':')
      if (colon <= 0) return 'rejected'
      const botId = key.slice(0, colon)
      const chatId = key.slice(colon + 1)
      let state: OperatorResult['state'] = 'rejected'
      // Reserve the same per-chat queue used for inbound work BEFORE yielding.
      // Run checks again inside the queue after preceding work has completed.
      await this.enqueue(botId, chatId, async () => {
        if (this.stopped || Date.now() - command.ts >= 30_000 ||
          this.activeTurns.has(key) || this.approvals.size > 0 ||
          this.inbox.hasUnresolvedFor(botId, chatId.split(':group:')[0]!) ||
          this.outbox.pending().length > 0) return
        const changed = command.type === 'archive-session'
          ? await this.registry.archiveIfUnchanged(key, binding.sessionId, binding.lastActiveAt)
          : await this.registry.unbindIfUnchanged(key, binding.sessionId, binding.lastActiveAt)
        if (!changed) { state = 'not-found'; return }
        this.audit({ kind: 'system',
          state: command.type === 'archive-session' ? 'session-archived' : 'session-unbound',
          botId, session: binding.sessionId })
        this.refreshOps()
        state = 'completed'
      }, key)
      return state
    }
    if (command.type !== 'cancel-task' || !command.ref) return 'rejected'
    const matches = [...this.activeTurns.values()].filter(x =>
      opsRef(x.messageId) === command.ref && x.phase === 'running' && !x.cancelledByUser)
    if (matches.length !== 1) return 'not-found'
    const active = matches[0]!
    this.requestCancel(active, 'operator') // Same safe path as the owner's CardKit /cancel
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
    void this.publishApprovals()
    const now = Date.now()
    if (this.bridge.listModels && !this.modelCatalogLoading && now - this.modelCatalogAttempt >= 60_000) {
      this.modelCatalogAttempt = now
      this.modelCatalogLoading = true
      void withTimeout(this.bridge.listModels(), 30_000).then(result => {
        if (!result.timedOut && !this.stopped) {
          const routes = result.value.models.map(item => item.provider + '/' + item.model)
            .filter(name => /^[A-Za-z0-9_./:@+-]{1,256}$/.test(name))
          // Provider display names and model labels come from DSH, never from
          // the admin side: the Web Profile may mount a different provider set.
          const providers = (result.value.providers ?? []).map(provider => ({
            id: provider.id,
            ...(provider.name ? { name: provider.name.slice(0, 100) } : {}),
            models: provider.models.map(model => ({
              id: model.model.slice(0, 96),
              ...(model.name ? { name: model.name.slice(0, 100) } : {}),
            })),
          }))
          this.modelCatalog = { ts: Date.now(), incomplete: result.value.incomplete,
            models: routes, providers }
          this.refreshOps()
        }
      }).catch(() => this.logger.warn('model catalog unavailable'))
        .finally(() => { this.modelCatalogLoading = false })
    }
    if (this.bridge.listPresets && !this.presetCatalogLoading && now - this.presetCatalogAttempt >= 60_000) {
      this.presetCatalogAttempt = now
      this.presetCatalogLoading = true
      void withTimeout(this.bridge.listPresets(), 20_000).then(result => {
        if (!result.timedOut && !this.stopped) {
          // The Gateway re-sanitizes the Host roster: only id/display/broken
          // survive, bounded, so the admin read model can never receive raw
          // service objects or arbitrary text.
          this.presetCatalog = {
            ts: Date.now(),
            incomplete: result.value.incomplete === true,
            ...(result.value.defaultId ? { defaultId: result.value.defaultId } : {}),
            presets: result.value.presets.slice(0, 100).map(preset => ({
              id: preset.id,
              ...(preset.name ? { name: preset.name.slice(0, 100) } : {}),
              ...(preset.description ? { description: preset.description.slice(0, 200) } : {}),
              isDefault: preset.isDefault === true,
              ...(preset.broken ? { broken: preset.broken.slice(0, 200) } : {}),
            })),
          }
          this.refreshOps()
        }
      }).catch(() => this.logger.warn('agent preset roster unavailable'))
        .finally(() => { this.presetCatalogLoading = false })
    }
    const health = this.health()
    const snapshot: OpsSnapshot = {
      version: 1, ts: Date.now(), status: health.status,
      workspace: this.isolatedWorkspace,
      sharedProjectWorkspace: this.config.workspace,
      isolatedAgent: true,
      ...(this.modelCatalog ? { modelCatalog: this.modelCatalog } : {}),
      ...(this.presetCatalog ? { agentPresets: this.presetCatalog } : {}),
      ...(this.bridge.compactionStatus ? { compaction: this.bridge.compactionStatus() } : {}),
      ...(this.routeSnapshot() ? { agentRoute: this.routeSnapshot() } : {}),
      ...(this.profileDefaultRoute() ? { profileDefaultRoute: this.profileDefaultRoute() } : {}),
      tasks: [...this.activeTurns.values()].map(turn => ({
        ref: opsRef(turn.messageId), ...(turn.sessionId ? { session: opsRef(turn.sessionId) } : {}),
        botId: turn.botId, phase: turn.phase, elapsedMs: Date.now() - turn.startedAt,
      })),
      sessions: [...this.registry.bindings()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 500).map(binding => ({
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

  /** Effective non-secret route for the Web Admin read model. */
  private routeSnapshot(): {
    provider?: string
    model?: string
    reasoningEffort?: string
    fallback?: { provider: string; model: string }
    fallbacks?: readonly { provider: string; model: string }[]
  } | undefined {
    const route = this.config.agent
    if (!route) return undefined
    const snapshot: {
      provider?: string
      model?: string
      reasoningEffort?: string
      fallback?: { provider: string; model: string }
      fallbacks?: readonly { provider: string; model: string }[]
    } = {}
    if (route.provider) snapshot.provider = route.provider
    if (route.model) snapshot.model = route.model
    if (route.reasoningEffort) snapshot.reasoningEffort = route.reasoningEffort
    if (route.fallbacks) snapshot.fallbacks = route.fallbacks.map(item => ({ provider: item.provider, model: item.model }))
    else if (route.fallback) snapshot.fallback = { provider: route.fallback.provider, model: route.fallback.model }
    return Object.keys(snapshot).length > 0 ? snapshot : undefined
  }

  /** The Host Profile's own default selection, when DSH advertises one. */
  private profileDefaultRoute(): {
    provider?: string
    model?: string
    reasoningEffort?: string
  } | undefined {
    const route = this.bridge.defaultModel?.()
    if (!route || (!route.provider && !route.model)) return undefined
    return {
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    }
  }

  /** Ordered unique rescue routes. Legacy Profile fallback remains supported. */
  private fallbackRoutes(): Array<{ provider: string; model: string }> {
    const route = this.config.agent
    const candidates = route?.fallbacks ?? (route?.fallback ? [route.fallback] : [])
    const seen = new Set<string>()
    return candidates.filter(item => {
      if (!item.provider || !item.model ||
        (route?.provider === item.provider && route?.model === item.model)) return false
      const key = item.provider + '\0' + item.model
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).map(item => ({ provider: item.provider, model: item.model }))
  }

  /**
   * A fallback retry is allowed ONLY when the native turn failed before any
   * tool ran. Once a tool executed, replaying the turn could duplicate side
   * effects, so the existing fail-closed path is kept unchanged.
   */
  private canRetryWithFallback(error: unknown): boolean {
    if (this.stopped || !this.bridge.selectModel) return false
    if (!(error instanceof SessionTurnFailure)) return false
    if (error.toolCalls > 0 || error.toolFailures > 0) return false
    return true
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
      // Only the launcher's route marker: no URL, host or credential.
      network: { proxySelected: process.env.FEISHU_GATEWAY_PROXY_SELECTED ?? null },
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
