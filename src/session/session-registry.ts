import { JsonStore } from '../storage/json-store.js'

export interface SessionBinding {
  /** Stable native DSH Session id (also the Agent id). */
  readonly sessionId: string
  readonly createdAt: number
  readonly lastActiveAt: number
  /** True when the Session has been persisted by DSH and can be resumed. */
  readonly persisted: boolean
}

interface RegistryState {
  readonly bindings: Record<string, SessionBinding>
}

/**
 * Maps a Feishu chat (`<botId>:<chatId>`) to one native DSH Session id.
 *
 * This is *only a mapping*. Session content, history, model state and the
 * agent loop all belong to DSH; the plugin never stores a second conversation.
 */
export class SessionRegistry {
  private readonly store: JsonStore<RegistryState>
  private state: RegistryState = { bindings: {} }

  constructor(stateDir: string) {
    this.store = new JsonStore<RegistryState>(stateDir, 'sessions', { bindings: {} })
  }

  async open(): Promise<void> {
    this.state = await this.store.load()
  }

  get(chatKey: string): SessionBinding | undefined {
    return this.state.bindings[chatKey]
  }

  async bind(chatKey: string, sessionId: string, now = Date.now()): Promise<SessionBinding> {
    this.state = await this.store.update((current) => {
      const existing = current.bindings[chatKey]
      const binding: SessionBinding = {
        sessionId,
        createdAt: existing?.createdAt ?? now,
        lastActiveAt: now,
        persisted: existing?.persisted ?? false,
      }
      return { bindings: { ...current.bindings, [chatKey]: binding } }
    })
    return this.state.bindings[chatKey]!
  }

  /** Abandon a potentially still-running Session after a timeout. */
  async unbind(chatKey: string): Promise<void> {
    this.state = await this.store.update((current) => {
      const bindings = { ...current.bindings }
      delete bindings[chatKey]
      return { bindings }
    })
  }

  async touch(chatKey: string, now = Date.now()): Promise<void> {
    this.state = await this.store.update((current) => {
      const existing = current.bindings[chatKey]
      if (!existing) return current
      return {
        bindings: {
          ...current.bindings,
          [chatKey]: { ...existing, lastActiveAt: now, persisted: true },
        },
      }
    })
  }

  bindings(): readonly SessionBinding[] {
    return Object.values(this.state.bindings)
  }

  async clear(): Promise<void> {
    this.state = { bindings: {} }
    await this.store.save(this.state)
  }
}
