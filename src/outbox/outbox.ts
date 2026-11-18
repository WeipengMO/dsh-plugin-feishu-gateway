import { JsonStore } from '../storage/json-store.js'
import type { FeishuTransport, GatewayConfig, GatewayLogger, OutboundTarget } from '../types.js'
import { newId } from '../util/id.js'
import { isRetryable, withRetry } from '../util/retry.js'

export interface OutboxRecord {
  readonly id: string
  readonly botId: string
  readonly target: OutboundTarget
  readonly createdAt: number
  readonly attempts: number
  readonly lastError?: string
  /** Do not repeatedly send permanently invalid requests on every timer tick. */
  readonly permanentFailure?: boolean
}

interface OutboxState {
  readonly pending: readonly OutboxRecord[]
  readonly sent?: Record<string, number>
}

/**
 * Durable outbound queue. A reply is persisted before the first send attempt;
 * transient Feishu failures are retried with bounded backoff and, if still
 * failing, remain in `pending` until the WebSocket reconnects or the plugin
 * restarts. This is the v0.1.0 basis for retry + disconnect recovery.
 */
export class DurableOutbox {
  private readonly store: JsonStore<OutboxState>
  private state: OutboxState = { pending: [], sent: {} }
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    stateDir: string,
    private readonly config: GatewayConfig,
    private readonly logger: GatewayLogger,
    private readonly transportFor: (botId: string) => FeishuTransport | undefined,
    private readonly onDelivery?: (state: 'sent' | 'failed', botId: string, ref: string) => void,
  ) {
    this.store = new JsonStore<OutboxState>(stateDir, 'outbox', { pending: [], sent: {} })
  }

  private serialize<R>(work: () => Promise<R>): Promise<R> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** This method is only called with the Outbox mutex held. */
  private async persist(next: OutboxState): Promise<void> {
    await this.store.save(next)
    this.state = next
  }

  async open(): Promise<number> {
    this.state = await this.store.load()
    return this.state.pending.length
  }

  /** Serialize admission and draining as ONE critical section. */
  async send(botId: string, target: OutboundTarget, idempotencyKey?: string): Promise<boolean> {
    return this.serialize(async () => {
      const id = idempotencyKey ? `idem:${botId}:${idempotencyKey}` : newId('out')
      if (Object.prototype.hasOwnProperty.call(this.state.sent ?? {}, id)) return true
      if (!this.state.pending.some((record) => record.id === id)) {
        const record: OutboxRecord = {
          id,
          botId,
          target: { ...target, uuid: target.uuid ?? newId('fg') },
          createdAt: Date.now(),
          attempts: 0,
        }
        await this.persist({ ...this.state, pending: [...this.state.pending, record] })
      }
      await this.drainUnsafe()
      return Object.prototype.hasOwnProperty.call(this.state.sent ?? {}, id)
    })
  }

  /** Single-flight drain: simultaneous reconnects cannot send twice. */
  async drain(): Promise<number> {
    return this.serialize(() => this.drainUnsafe())
  }

  private async drainUnsafe(): Promise<number> {
    let sent = 0
    for (const record of [...this.state.pending]) {
      if (record.permanentFailure) continue
      const transport = this.transportFor(record.botId)
      if (!transport) {
        this.logger.warn('no transport for bot %s; keeping outbox record %s', record.botId, record.id)
        continue
      }
      try {
        // The same UUID is reused across retries AND process restarts.
        await withRetry(() => transport.sendText(record.target), {
          retries: this.config.sendRetries,
          baseDelayMs: this.config.sendRetryBaseDelayMs,
          onRetry: (error, attempt) => this.logger.warn(
            'outbox retry %s/%s for %s: %s',
            attempt, this.config.sendRetries, record.id, String(error),
          ),
        })
        const priorSent = { ...(this.state.sent ?? {}), [record.id]: Date.now() }
        // Bound the delivery ledger; Inbox records remain the durable
        // authority for old inbound events.
        const boundedSent = Object.fromEntries(Object.entries(priorSent)
          .sort((a, b) => b[1] - a[1]).slice(0, 20_000))
        await this.persist({
          pending: this.state.pending.filter((entry) => entry.id !== record.id),
          sent: boundedSent,
        })
        sent += 1
        this.onDelivery?.('sent', record.botId, record.target.replyToMessageId ?? record.id)
      } catch (error) {
        await this.persist({
          ...this.state,
          pending: this.state.pending.map((entry) => entry.id === record.id
            ? { ...entry, attempts: entry.attempts + 1, lastError: String(error), permanentFailure: !isRetryable(error) }
            : entry),
        })
        this.onDelivery?.('failed', record.botId, record.target.replyToMessageId ?? record.id)
      }
    }
    return sent
  }

  /** Barrier used during Gateway teardown before releasing the stateDir lock. */
  async whenIdle(): Promise<void> {
    await this.chain
  }

  pending(): readonly OutboxRecord[] {
    return this.state.pending
  }

  stats(): { pending: number; failed: number } {
    return {
      pending: this.state.pending.length,
      failed: this.state.pending.filter((entry) => entry.attempts > 0).length,
    }
  }

  async clear(): Promise<void> {
    await this.serialize(() => this.persist({ ...this.state, pending: [] }))
  }
}
