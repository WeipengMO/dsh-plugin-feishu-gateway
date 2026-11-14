import { mkdir } from 'node:fs/promises'
import { DedupIndex } from './inbox/dedup.js'
import { DurableInbox, type InboxRecord } from './inbox/inbox.js'
import { DurableOutbox } from './outbox/outbox.js'
import { MessageRouter, type RejectReason } from './router/message-router.js'
import { SessionRegistry } from './session/session-registry.js'
import { truncateText } from './session/session-bridge.js'
import type {
  FeishuTransport,
  GatewayConfig,
  GatewayLogger,
  InboundMessage,
  SessionBridge,
  TransportState,
} from './types.js'
import { chatKey, newId, sessionIdFor } from './util/id.js'

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
  readonly processed: number
  readonly rejected: Record<RejectReason, number>
  readonly errors: number
  readonly uptimeMs: number
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
  private readonly chatQueues = new Map<string, Promise<void>>()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly rejected: Record<RejectReason, number>
  private startedAt = 0
  private processed = 0
  private errors = 0
  private started = false
  private stopped = false

  constructor(deps: GatewayDeps) {
    this.config = deps.config
    this.logger = deps.logger
    this.bridge = deps.bridge
    this.router = new MessageRouter(deps.config)
    for (const transport of deps.transports) this.transports.set(transport.botId, transport)

    this.dedup = new DedupIndex(deps.config.stateDir, deps.config.dedupTtlMs, deps.config.maxDedupEntries)
    this.inbox = new DurableInbox(deps.config.stateDir)
    this.registry = new SessionRegistry(deps.config.stateDir)
    this.outbox = new DurableOutbox(
      deps.config.stateDir,
      deps.config,
      deps.logger,
      (botId) => this.transports.get(botId),
    )
    this.rejected = Object.fromEntries(REJECT_REASONS.map((reason) => [reason, 0])) as Record<RejectReason, number>
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.startedAt = Date.now()
    try {
      await mkdir(this.config.stateDir, { recursive: true })
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
            })
          } catch (error) {
            this.errors += 1
            this.logger.error('bot %s connect failed: %s', transport.botId, String(error))
          }
        }
        await this.outbox.drain()
      }
      // Replay only work that was never started. A running Agent may already
      // have changed files or executed shell commands before the crash.
      for (const record of pending) this.track(this.replayRecord(record))
      for (const record of this.inbox.uncertain()) {
        await this.replyDiagnostic(record,
          '此前请求在服务重启时处于执行中，可能已经产生实际操作。为避免重复执行，已暂停自动重试；请检查 DSH 会话后决定是否重新发送。',
          `recovery:${record.messageId}`)
        await this.inbox.markRecoveryNotified(record.messageId)
      }
      this.dedupSnapshot = await this.dedup.size()
    } catch (error) {
      this.started = false
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.abortController.abort()

    for (const [botId, transport] of this.transports) {
      try {
        await transport.close()
      } catch (error) {
        this.logger.warn('close failed for bot %s: %s', botId, String(error))
      }
    }

    await Promise.allSettled([...this.inFlight])
    await this.bridge.dispose()
    this.chatQueues.clear()
    this.logger.info(
      'stopped: processed=%d rejected=%d errors=%d outboxPending=%d',
      this.processed,
      Object.values(this.rejected).reduce((a, b) => a + b, 0),
      this.errors,
      this.outbox.stats().pending,
    )
  }

  /** Entry point for every inbound event from any transport. */
  async handleInbound(message: InboundMessage): Promise<void> {
    if (this.stopped) return
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
      this.logger.debug('duplicate message %s ignored', message.messageId)
      return
    }
    try {
      await this.dedup.checkAndRemember(record.messageId)
      this.dedupSnapshot += 1
    } catch (error) {
      // The dedup index is non-authoritative: Inbox already owns the ID.
      this.logger.warn('dedup index update failed for %s: %s', record.messageId, String(error))
    }
    this.track(this.processRecord(record))
  }

  /** Replay path used at startup; skips router/dedup but not the per-chat queue. */
  private async replayRecord(record: InboxRecord): Promise<void> {
    if (record.status === 'done') return
    await this.enqueue(record.botId, record.chatId, () => this.dispatch(record))
  }

  private async processRecord(record: InboxRecord): Promise<void> {
    await this.enqueue(record.botId, record.chatId, () => this.dispatch(record))
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
    const signal = this.abortController.signal
    try {
      // Durable execution boundary, before any Agent-side effects.
      await this.inbox.markRunning(record.messageId)
      if (!this.bridge.available) {
        await this.replyDiagnostic(record, 'DSH 原生 Session 服务未就绪，插件已按安全默认降级。')
        await this.inbox.markProcessed(record.messageId)
        this.errors += 1
        return
      }

      const sessionId = await this.ensureSession(key, record.botId, record.chatId)
      await this.bridge.submit(sessionId, record.text, signal)
      const reply = await this.bridge.waitForReply(sessionId, {
        timeoutMs: this.config.replyTimeoutMs,
        signal,
      })
      if (reply.reason === 'timeout' || reply.reason === 'cancelled') {
        this.bridge.cancel(sessionId)
        // A late reply from the prior Agent must never enter the next turn.
        await this.registry.unbind(key)
        await this.replyDiagnostic(record, '长任务超时或已取消。原会话已隔离，后续消息将使用新会话。')
      } else {
        const text = truncateText(reply.text, this.config.maxTextLength)
        await this.replyDiagnostic(record, text || '模型未返回文本内容。')
      }
      await this.registry.touch(key)
      await this.inbox.markProcessed(record.messageId)
      this.processed += 1
    } catch (error) {
      this.errors += 1
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('message %s failed: %s', record.messageId, reason)
      if (signal.aborted) return
      // Never blindly replay a turn that may have caused real side effects.
      await this.inbox.markFailed(record.messageId, reason)
      await this.replyDiagnostic(record, '处理失败，可能已经执行部分操作；请先检查 DSH 会话，再决定是否重试。')
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
      this.logger.warn('resume of %s failed, creating a fresh Session: %s', existing.sessionId, String(error))
      const sessionId = `${sessionIdFor(botId, chatId)}-${newId('retry')}`
      await this.bridge.create(sessionId, this.config.workspace, this.config.agent)
      await this.registry.bind(key, sessionId)
      return sessionId
    }
    return existing.sessionId
  }

  private async replyDiagnostic(record: InboxRecord, text: string, key = `reply:${record.messageId}`): Promise<void> {
    await this.outbox.send(record.botId, { replyToMessageId: record.messageId, text }, key)
  }

  /** Wait until every tracked message handler has settled (tests / shutdown). */
  async whenIdle(): Promise<void> {
    for (let guard = 0; guard < 100 && this.inFlight.size > 0; guard += 1) {
      await Promise.allSettled([...this.inFlight])
    }
  }

  private onStateChange(botId: string, state: TransportState, error?: Error): void {
    if (error) this.logger.error('transport %s -> %s: %s', botId, state, error.message)
    else this.logger.info('transport %s -> %s', botId, state)
    if (state === 'connected') {
      void this.outbox.drain().catch((drainError) => {
        this.logger.warn('outbox drain on reconnect failed: %s', String(drainError))
      })
    }
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
