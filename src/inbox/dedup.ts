import { JsonStore } from '../storage/json-store.js'

interface DedupState {
  /** message_id -> first-seen epoch millis. */
  readonly seen: Record<string, number>
}

/**
 * Durable message-id dedup index. Feishu long connections can redeliver an
 * event after a reconnect, so the router must remember ids across restarts.
 */
export class DedupIndex {
  private readonly store: JsonStore<DedupState>
  private state: DedupState = { seen: {} }

  constructor(
    stateDir: string,
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {
    this.store = new JsonStore<DedupState>(stateDir, 'dedup', { seen: {} })
  }

  async open(now = Date.now()): Promise<number> {
    this.state = await this.store.load()
    return this.prune(now)
  }

  /** Returns true when the id is new and atomically records it. */
  async checkAndRemember(messageId: string, now = Date.now()): Promise<boolean> {
    if (!messageId) return false
    let isNew = false
    this.state = await this.store.update((current) => {
      const seen = { ...current.seen }
      const existing = seen[messageId]
      if (existing === undefined || now - existing > this.ttlMs) {
        seen[messageId] = now
        isNew = true
      }
      return { seen: pruneRecord(seen, now, this.ttlMs, this.maxEntries) }
    })
    return isNew
  }

  /** Drop expired / overflow entries. Returns the number removed. */
  async prune(now = Date.now()): Promise<number> {
    const before = Object.keys(this.state.seen).length
    this.state = await this.store.update((current) => ({
      seen: pruneRecord(current.seen, now, this.ttlMs, this.maxEntries),
    }))
    return before - Object.keys(this.state.seen).length
  }

  async size(): Promise<number> {
    return Object.keys((await this.store.load()).seen).length
  }

  async clear(): Promise<void> {
    this.state = { seen: {} }
    await this.store.save(this.state)
  }

  has(messageId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.state.seen, messageId)
  }
}

function pruneRecord(
  seen: Record<string, number>,
  now: number,
  ttlMs: number,
  maxEntries: number,
): Record<string, number> {
  const alive = Object.entries(seen)
    .filter(([, at]) => typeof at === 'number' && Number.isFinite(at) && now - at <= ttlMs)
    .sort((a, b) => b[1] - a[1])
  return Object.fromEntries(alive.slice(0, maxEntries))
}
