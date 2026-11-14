import { JsonStore } from '../storage/json-store.js'
import type { FeishuTransport, GatewayConfig, GatewayLogger, OutboundTarget } from '../types.js'
import { newId } from '../util/id.js'
import { withRetry } from '../util/retry.js'

export interface OutboxRecord {
  readonly id: string
  readonly botId: string
  readonly target: OutboundTarget
  readonly createdAt: number
  readonly attempts: number
  readonly lastError?: string
}

interface OutboxState {
  readonly pending: readonly OutboxRecord[]
}

/**
 * Durable outbound queue. A reply is persisted before the first send attempt;
 * transient Feishu failures are retried with bounded backoff and, if still
 * failing, remain in `pending` until the WebSocket reconnects or the plugin
 * restarts. This is the v0.1.0 basis for retry + disconnect recovery.
 */
export class DurableOutbox {
  private readonly store: JsonStore<OutboxState>
  private state: OutboxState = { pending: [] }
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    stateDir: string,
    private readonly config: GatewayConfig,
    private readonly logger: GatewayLogger,
    private readonly transportFor: (botId: string) => FeishuTransport | undefined,
  ) {
    this.store = new JsonStore<OutboxState>(stateDir, 'outbox', { pending: [] })
  }

  private serialize<R>(work: () => Promise<R>): Promise<R> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async write(next: OutboxState): Promise<OutboxState> {
    return this.serialize(async () => {
      await this.store.save(next)
      this.state = next
      return next
    })
  }

  async open(): Promise<number> {
    this.state = await this.store.load()
    return this.state.pending.length
  }

  /** Persist then attempt delivery. Returns true when the message was sent. */
  async send(botId: string, target: OutboundTarget): Promise<boolean> {
    const record: OutboxRecord = {
      id: newId('out'),
      botId,
      target,
      createdAt: Date.now(),
      attempts: 0,
    }
    await this.write({ pending: [...this.state.pending, record] })
    await this.drain()
    return !this.state.pending.some((entry) => entry.id === record.id)
  }

  /** Try every pending record once, with bounded retry per record. */
  async drain(): Promise<number> {
    const pending = [...this.state.pending]
    let sent = 0
    for (const record of pending) {
      const transport = this.transportFor(record.botId)
      if (!transport) {
        this.logger.warn('no transport for bot %s; keeping outbox record %s', record.botId, record.id)
        continue
      }
      try {
        await withRetry(() => transport.sendText(record.target), {
          retries: this.config.sendRetries,
          baseDelayMs: this.config.sendRetryBaseDelayMs,
          onRetry: (error, attempt) => this.logger.warn(
            'outbox retry %s/%s for %s: %s',
            attempt, this.config.sendRetries, record.id, String(error),
          ),
        })
        await this.remove(record.id)
        sent += 1
      } catch (error) {
        await this.markFailure(record.id, String(error))
      }
    }
    return sent
  }

  private async remove(id: string): Promise<void> {
    await this.write({ pending: this.state.pending.filter((entry) => entry.id !== id) })
  }

  private async markFailure(id: string, error: string): Promise<void> {
    const pending = this.state.pending.map((entry) => entry.id === id
      ? { ...entry, attempts: entry.attempts + 1, lastError: error }
      : entry)
    await this.write({ pending })
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
    await this.write({ pending: [] })
  }
}
