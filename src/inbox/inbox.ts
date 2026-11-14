import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { InboundMessage } from '../types.js'

export type InboxStatus = 'pending' | 'done' | 'failed'

export interface InboxRecord {
  readonly messageId: string
  readonly botId: string
  readonly chatId: string
  readonly senderId: string
  readonly text: string
  readonly receivedAt: number
  readonly status: InboxStatus
  readonly attempts: number
  readonly error?: string
}

export type InboxEvent =
  | { readonly type: 'received'; readonly record: InboxRecord }
  | { readonly type: 'processed'; readonly messageId: string }
  | { readonly type: 'failed'; readonly messageId: string; readonly error: string }

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
    if (event.type === 'processed') {
      this.records.set(event.messageId, { ...current, status: 'done' })
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
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          this.fold(JSON.parse(line) as InboxEvent)
        } catch {
          // Skip a torn trailing line; the next append continues the log.
        }
      }
      return this.pending()
    })
  }

  async record(message: InboundMessage, receivedAt = Date.now()): Promise<InboxRecord> {
    const record: InboxRecord = {
      messageId: message.messageId,
      botId: message.botId,
      chatId: message.chatId,
      senderId: message.senderId,
      text: message.text,
      receivedAt,
      status: 'pending',
      attempts: 0,
    }
    await this.append({ type: 'received', record })
    return record
  }

  async markProcessed(messageId: string): Promise<void> {
    await this.append({ type: 'processed', messageId })
  }

  async markFailed(messageId: string, error: string): Promise<void> {
    await this.append({ type: 'failed', messageId, error })
  }

  pending(): InboxRecord[] {
    return [...this.records.values()].filter((r) => r.status !== 'done')
  }

  get(messageId: string): InboxRecord | undefined {
    return this.records.get(messageId)
  }

  stats(): { total: number; pending: number; done: number; failed: number } {
    const all = [...this.records.values()]
    return {
      total: all.length,
      pending: all.filter((r) => r.status === 'pending').length,
      done: all.filter((r) => r.status === 'done').length,
      failed: all.filter((r) => r.status === 'failed').length,
    }
  }
}
