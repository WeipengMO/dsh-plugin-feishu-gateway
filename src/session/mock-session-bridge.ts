import type { AgentRoute, ObservedScheduleTurn, SessionBridge, SessionReply, WaitOptions } from '../types.js'
import { sleep } from '../util/retry.js'

export interface MockSessionBridgeOptions {
  /** Fixed reply, or a function of the prompt. */
  readonly reply?: string | ((text: string) => string)
  /** Artificial turn latency (ms), clamped to `waitForReply`'s timeout. */
  readonly delayMs?: number
  /** Fail the next submit with this message. */
  readonly failNext?: string
}

/**
 * Deterministic in-memory SessionBridge for unit / integration tests.
 * It never touches a network, a model, or a real DSH Session.
 */
export class MockSessionBridge implements SessionBridge {
  readonly available = true
  readonly unavailableReason = undefined

  readonly created: Array<{ sessionId: string; cwd: string; route?: AgentRoute }> = []
  readonly resumed: string[] = []
  readonly prompts: Array<{ sessionId: string; text: string }> = []
  readonly cancelled: string[] = []
  readonly disposedSessions: string[] = []
  private readonly live = new Map<string, string>()
  private readonly modelChoices = new Map<string, { provider: string; model: string }>()
  private readonly scheduleHandlers = new Set<(turn: ObservedScheduleTurn) => void>()
  private pendingFailure: string | undefined
  private disposed = false

  constructor(private readonly options: MockSessionBridgeOptions = {}) {
    this.pendingFailure = options.failNext
  }

  async create(sessionId: string, cwd: string, route?: AgentRoute): Promise<void> {
    this.assertLive()
    this.created.push({ sessionId, cwd, ...(route ? { route } : {}) })
    this.live.set(sessionId, cwd)
  }

  async resume(sessionId: string): Promise<void> {
    this.assertLive()
    this.resumed.push(sessionId)
    this.live.set(sessionId, 'resumed')
  }

  async listModels() {
    return { models: [
      { provider: 'magpie', model: 'group/deepseek' },
      { provider: 'magpie', model: 'group/hy4-free' },
    ], incomplete: false }
  }

  currentModel(sessionId: string) {
    return this.modelChoices.get(sessionId) ?? (this.live.has(sessionId)
      ? { provider: 'magpie', model: 'group/deepseek' } : undefined)
  }

  selectModel(sessionId: string, provider: string, model: string): void {
    if (!this.live.has(sessionId)) throw new Error('session not live')
    this.modelChoices.set(sessionId, { provider, model })
  }

  async submit(sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    this.assertLive()
    if (!this.live.has(sessionId)) throw new Error(`session ${sessionId} is not live`)
    if (signal.aborted) throw new Error('submit aborted')
    if (this.pendingFailure) {
      const message = this.pendingFailure
      this.pendingFailure = undefined
      throw new Error(message)
    }
    this.prompts.push({ sessionId, text })
  }

  async waitForReply(sessionId: string, options: WaitOptions): Promise<SessionReply> {
    this.assertLive()
    const last = [...this.prompts].reverse().find((p) => p.sessionId === sessionId)
    const delay = Math.min(this.options.delayMs ?? 0, Math.max(0, options.timeoutMs))
    if (delay > 0) await sleep(delay, options.signal)
    if (options.signal.aborted) return { text: '', reason: 'cancelled' }
    if (!last) return { text: '', reason: 'empty' }
    const reply = typeof this.options.reply === 'function'
      ? this.options.reply(last.text)
      : (this.options.reply ?? `echo: ${last.text}`)
    return { text: reply, reason: 'idle', assistantEvents: 1 }
  }

  watchScheduleTurns(handler: (turn: ObservedScheduleTurn) => void): () => void {
    this.scheduleHandlers.add(handler)
    return () => { this.scheduleHandlers.delete(handler) }
  }

  /** Test helper: simulate one native schedule delivery turn. */
  emitScheduleTurn(turn: ObservedScheduleTurn): void {
    for (const handler of [...this.scheduleHandlers]) {
      try { handler(turn) } catch { /* observers must not break the test bridge */ }
    }
  }

  cancel(sessionId: string): void {
    this.cancelled.push(sessionId)
  }

  async retire(sessionId: string): Promise<void> {
    if (this.live.delete(sessionId)) this.disposedSessions.push(sessionId)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const id of this.live.keys()) this.disposedSessions.push(id)
    this.live.clear()
    this.scheduleHandlers.clear()
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('MockSessionBridge is disposed')
  }
}
