import { JsonStore } from '../storage/json-store.js'

export interface SessionBinding {
  /** Stable native DSH Session id (also the Agent id). */
  readonly sessionId: string
  /** Filesystem root used when this native Session was created. Missing on legacy sessions. */
  readonly workspace?: string
  readonly createdAt: number
  readonly lastActiveAt: number
  /** True when the Session has been persisted by DSH and can be resumed. */
  readonly persisted: boolean
  /**
   * Authoritative Feishu chat type from the inbound event. Optional because
   * bindings created before this field existed have no recorded type.
   */
  readonly chatType?: 'p2p' | 'group'
  /** Gateway-local UI archive marker; never archives or deletes a native DSH Session. */
  readonly archived?: boolean
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

  async bind(chatKey: string, sessionId: string, now = Date.now(), workspace?: string,
    chatType?: 'p2p' | 'group'): Promise<SessionBinding> {
    this.state = await this.store.update((current) => {
      const existing = current.bindings[chatKey]
      const recordedChatType = chatType ?? existing?.chatType
      const binding: SessionBinding = {
        sessionId,
        ...(workspace ? { workspace } : {}),
        createdAt: existing?.createdAt ?? now,
        lastActiveAt: now,
        persisted: existing?.persisted ?? false,
        ...(recordedChatType ? { chatType: recordedChatType } : {}),
        ...(existing?.archived ? { archived: true } : {}),
      }
      return { bindings: { ...current.bindings, [chatKey]: binding } }
    })
    return this.state.bindings[chatKey]!
  }

  /** Record the authoritative chat type on an older binding without touching activity. */
  async setChatType(chatKey: string, chatType: 'p2p' | 'group'): Promise<void> {
    this.state = await this.store.update((current) => {
      const existing = current.bindings[chatKey]
      if (!existing || existing.chatType === chatType) return current
      return { bindings: { ...current.bindings, [chatKey]: { ...existing, chatType } } }
    })
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
          [chatKey]: { ...existing, lastActiveAt: now, persisted: true, archived: false },
        },
      }
    })
  }

  /** Snapshot of chat keys and bindings; never delete the native DSH Session. */
  entries(): readonly (readonly [string, SessionBinding])[] {
    return Object.entries(this.state.bindings)
  }

  async archiveIfUnchanged(chatKey: string, sessionId: string, lastActiveAt: number): Promise<boolean> {
    let changed = false
    this.state = await this.store.update((current) => {
      const binding = current.bindings[chatKey]
      if (!binding || binding.sessionId !== sessionId || binding.lastActiveAt !== lastActiveAt) return current
      changed = true
      return { bindings: { ...current.bindings, [chatKey]: { ...binding, archived: true } } }
    })
    return changed
  }

  /** Unlink Feishu -> DSH only. Do not call bridge.retire or touch native history. */
  async unbindIfUnchanged(chatKey: string, sessionId: string, lastActiveAt: number): Promise<boolean> {
    let changed = false
    this.state = await this.store.update((current) => {
      const binding = current.bindings[chatKey]
      if (!binding || binding.sessionId !== sessionId || binding.lastActiveAt !== lastActiveAt) return current
      const bindings = { ...current.bindings }
      delete bindings[chatKey]
      changed = true
      return { bindings }
    })
    return changed
  }

  bindings(): readonly SessionBinding[] {
    return Object.values(this.state.bindings)
  }

  async clear(): Promise<void> {
    this.state = { bindings: {} }
    await this.store.save(this.state)
  }
}
