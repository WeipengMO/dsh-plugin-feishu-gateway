import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises'
import path from 'node:path'
import type { InboundMessage } from '../types.js'

export type InboxStatus = 'pending' | 'running' | 'done' | 'failed' | 'uncertain'

export interface InboxRecord {
  readonly messageId: string
  readonly botId: string
  readonly chatId: string
  readonly senderId: string
  readonly chatType?: 'p2p' | 'group'
  readonly mentionedBot?: boolean
  readonly threadId?: string
  readonly rootId?: string
  readonly messageType?: string
  readonly text: string
  readonly receivedAt: number
  readonly status: InboxStatus
  readonly attempts: number
  readonly error?: string
  readonly recoveryNotified?: boolean
}

export type InboxEvent =
  | { readonly type: 'received'; readonly record: InboxRecord }
  | { readonly type: 'running'; readonly messageId: string }
  | { readonly type: 'processed'; readonly messageId: string }
  | { readonly type: 'failed'; readonly messageId: string; readonly error: string }
  | { readonly type: 'uncertain'; readonly messageId: string }
  | { readonly type: 'recovery-notified'; readonly messageId: string }

/**
 * Durable append-only inbox. Every inbound message is written *before* it is
 * handed to the native Session, so a crash or a plugin reload can replay the
 * pending work on the next start (basic disconnect recovery).
 *
 * The file is JSONL; status changes are appended as new events and the current
 * state is folded in memory. v0.1.0 intentionally keeps this simple rather
 * than adding a database dependency.
 */
export class DurableInbox {
  private readonly file: string
  private readonly records = new Map<string, InboxRecord>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly stateDir: string) {
    this.file = path.join(stateDir, 'inbox.jsonl')
  }

  get path(): string {
    return this.file
  }

  private serialize<R>(work: () => Promise<R>): Promise<R> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  private fold(event: InboxEvent): void {
    if (event.type === 'received') {
      this.records.set(event.record.messageId, event.record)
      return
    }
    const current = this.records.get(event.messageId)
    if (!current) return
    if (event.type === 'running') {
      this.records.set(event.messageId, { ...current, status: 'running' })
    } else if (event.type === 'processed') {
      this.records.set(event.messageId, { ...current, status: 'done' })
    } else if (event.type === 'uncertain') {
      this.records.set(event.messageId, { ...current, status: 'uncertain' })
    } else if (event.type === 'recovery-notified') {
      this.records.set(event.messageId, { ...current, recoveryNotified: true })
    } else {
      this.records.set(event.messageId, {
        ...current,
        status: 'failed',
        attempts: current.attempts + 1,
        error: event.error,
      })
    }
  }

  private async append(event: InboxEvent): Promise<void> {
    return this.serialize(async () => {
      await mkdir(this.stateDir, { recursive: true })
      await appendFile(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 })
      this.fold(event)
    })
  }

  /** Load the log and return the records that still need processing. */
  async open(): Promise<InboxRecord[]> {
    return this.serialize(async () => {
      let text = ''
      try {
        text = await readFile(this.file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.records.clear()
      const lines = text.split('\n')
      let validBytes = 0
      let truncated = false
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!
        if (!line.trim()) {
          if (index < lines.length - 1) validBytes += Buffer.byteLength(line + '\n')
          continue
        }
        try {
          this.fold(JSON.parse(line) as InboxEvent)
        } catch (error) {
          // Only the incomplete final line may be discarded. Invalid completed
          // records are a storage error, not silently ignored data loss.
          if (index !== lines.length - 1 || text.endsWith('\n')) throw error
          await truncate(this.file, validBytes)
          truncated = true
          break
        }
        validBytes += Buffer.byteLength(line + (index < lines.length - 1 ? '\n' : ''))
      }
      // A torn write can leave a *complete* final JSON object with no trailing
      // newline. The fold above accepts it, but the next append would then
      // concatenate `}{...}` into one line and make the file unparseable on the
      // following open(). Normalize the tail before any new event is appended.
      if (!truncated && text.length > 0 && !text.endsWith('\n')) {
        await appendFile(this.file, '\n', { mode: 0o600 })
      }
      // A crashed process must never automatically replay an in-progress
      // Agent operation: the side effects may have already happened.
      for (const record of [...this.records.values()]) {
        if (record.status !== 'running') continue
        const event: InboxEvent = { type: 'uncertain', messageId: record.messageId }
        await appendFile(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 })
        this.fold(event)
      }
      return this.pending()
    })
  }

  /** Atomically admit an event only if its id was never recorded.
   * The inbox, not a separately written dedup cache, is the admission authority.
   */
  async recordIfAbsent(
    message: InboundMessage,
    receivedAt = Date.now(),
  ): Promise<{ record: InboxRecord; isNew: boolean }> {
    return this.serialize(async () => {
      const existing = this.records.get(message.messageId)
      if (existing) return { record: existing, isNew: false }
      const record: InboxRecord = {
        messageId: message.messageId,
        botId: message.botId,
        chatId: message.chatId,
        senderId: message.senderId,
        chatType: message.chatType,
        mentionedBot: message.mentionedBot === true,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        ...(message.rootId ? { rootId: message.rootId } : {}),
        messageType: message.messageType,
        text: message.text,
        receivedAt,
        status: 'pending',
        attempts: 0,
      }
      const event: InboxEvent = { type: 'received', record }
      await mkdir(this.stateDir, { recursive: true })
      await appendFile(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 })
      this.fold(event)
      return { record, isNew: true }
    })
  }

  async record(message: InboundMessage, receivedAt = Date.now()): Promise<InboxRecord> {
    return (await this.recordIfAbsent(message, receivedAt)).record
  }

  async markRunning(messageId: string): Promise<void> {
    await this.append({ type: 'running', messageId })
  }

  async markUncertain(messageId: string): Promise<void> {
    await this.append({ type: 'uncertain', messageId })
  }

  async markRecoveryNotified(messageId: string): Promise<void> {
    await this.append({ type: 'recovery-notified', messageId })
  }

  async markProcessed(messageId: string): Promise<void> {
    await this.append({ type: 'processed', messageId })
  }

  async markFailed(messageId: string, error: string): Promise<void> {
    await this.append({ type: 'failed', messageId, error })
  }

  pending(): InboxRecord[] {
    return [...this.records.values()].filter((r) => r.status === 'pending')
  }

  uncertain(): InboxRecord[] {
    return [...this.records.values()].filter((r) => r.status === 'uncertain' && !r.recoveryNotified)
  }

  /** Fail closed on any unconfirmed inbound work for this chat. */
  hasUnresolvedFor(botId: string, chatId: string): boolean {
    for (const record of this.records.values()) {
      if (record.botId === botId && record.chatId === chatId &&
        (record.status === 'pending' || record.status === 'running' || record.status === 'uncertain')) return true
    }
    return false
  }

  get(messageId: string): InboxRecord | undefined {
    return this.records.get(messageId)
  }

  stats(): { total: number; pending: number; done: number; failed: number } {
    const all = [...this.records.values()]
    return {
      total: all.length,
      pending: all.filter((r) => r.status === 'pending' || r.status === 'running').length,
      done: all.filter((r) => r.status === 'done').length,
      failed: all.filter((r) => r.status === 'failed' || r.status === 'uncertain').length,
    }
  }
}
