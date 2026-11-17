import type {
  AgentRoute, ModelCatalog, ObservedScheduleTurn, SessionBridge, SessionReply, WaitOptions,
  SessionCompactionStatus, SessionCompactionResult,
} from '../types.js'
import { sleep } from '../util/retry.js'
import { SessionTurnFailure } from './turn-failure.js'

export interface MockSessionBridgeOptions {
  /** Fixed reply, or a function of the prompt. */
  readonly reply?: string | ((text: string) => string)
  /** Artificial turn latency (ms), clamped to `waitForReply`'s timeout. */
  readonly delayMs?: number
  /** Fail the next submit with this message. */
  readonly failNext?: string
  /** Directory advertised by `listModels`; defaults to two magpie routes. */
  readonly catalog?: ModelCatalog
  /** How many native turns fail (as `SessionTurnFailure`) before a reply. */
  readonly turnFailures?: ReadonlyArray<{
    readonly failure?: string
    readonly toolCalls?: number
    readonly toolFailures?: number
  }>
  /** Simulated DSH Profile `agent-default-model` selection. */
  readonly defaultRoute?: AgentRoute
}

/**
 * Deterministic in-memory SessionBridge for unit / integration tests.
 * It never touches a network, a model, or a real DSH Session.
 */
export class MockSessionBridge implements SessionBridge {
  readonly available = true
  readonly unavailableReason = undefined

  readonly created: Array<{ sessionId: string; cwd: string; route?: AgentRoute }> = []
  readonly titles = new Map<string, string>()
  readonly manuallyTitled = new Set<string>()
  titleSource(sessionId: string): 'user' | 'automatic' {
    return this.titles.has(sessionId) || this.manuallyTitled.has(sessionId) ? 'user' : 'automatic'
  }
  async title(sessionId: string, value: string): Promise<boolean> {
    if (this.titleSource(sessionId) === 'user') return false
    this.titles.set(sessionId, value)
    return true
  }
  readonly manualCompactions: string[] = []
  /** Simulates an optional native compaction service; DSH owns automatic policy. */
  compactionStatus(sessionId?: string): SessionCompactionStatus {
    const count = sessionId === undefined ? this.manualCompactions.length :
      this.manualCompactions.filter(id => id === sessionId).length
    return { available: true, completedInProcess: count }
  }
  async compactNow(sessionId: string, signal: AbortSignal): Promise<SessionCompactionResult> {
    this.assertLive()
    if (signal.aborted) throw signal.reason ?? new Error('cancelled')
    if (!this.live.has(sessionId)) throw new Error('unknown session')
    this.manualCompactions.push(sessionId)
    return { outcome: 'compacted', shadowedItems: 4, shadowedTokens: 1500 }
  }

  readonly resumed: string[] = []
  readonly resumedRoutes: Array<{ sessionId: string; route: AgentRoute }> = []
  readonly prompts: Array<{ sessionId: string; text: string }> = []
  readonly modelSelections: Array<{ sessionId: string; provider: string; model: string }> = []
  readonly cancelled: string[] = []
  readonly disposedSessions: string[] = []
  private readonly live = new Map<string, string>()
  private readonly modelChoices = new Map<string, { provider: string; model: string }>()
  private readonly scheduleHandlers = new Set<(turn: ObservedScheduleTurn) => void>()
  private pendingFailure: string | undefined
  private readonly pendingTurnFailures: Array<{
    failure?: string
    toolCalls?: number
    toolFailures?: number
  }>
  private disposed = false

  constructor(private readonly options: MockSessionBridgeOptions = {}) {
    this.pendingFailure = options.failNext
    this.pendingTurnFailures = [...(options.turnFailures ?? [])]
  }

  async create(sessionId: string, cwd: string, route?: AgentRoute): Promise<void> {
    this.assertLive()
    this.created.push({ sessionId, cwd, ...(route ? { route } : {}) })
    this.live.set(sessionId, cwd)
  }

  async resume(sessionId: string, route?: AgentRoute): Promise<void> {
    this.assertLive()
    this.resumed.push(sessionId)
    if (route) this.resumedRoutes.push({ sessionId, route })
    this.live.set(sessionId, 'resumed')
  }

  async listModels(): Promise<ModelCatalog> {
    return this.options.catalog ?? { models: [
      { provider: 'magpie', model: 'group/deepseek' },
      { provider: 'magpie', model: 'group/hy4-free' },
    ], providers: [{ id: 'magpie', name: 'Magpie', models: [
      { provider: 'magpie', model: 'group/deepseek', name: 'Deepseek' },
      { provider: 'magpie', model: 'group/hy4-free', name: 'HY4 free' },
    ] }], incomplete: false }
  }

  defaultModel(): AgentRoute | undefined {
    return this.options.defaultRoute
  }

  currentModel(sessionId: string) {
    return this.modelChoices.get(sessionId) ?? (this.live.has(sessionId)
      ? { provider: 'magpie', model: 'group/deepseek' } : undefined)
  }

  selectModel(sessionId: string, provider: string, model: string): void {
    if (!this.live.has(sessionId)) throw new Error('session not live')
    this.modelSelections.push({ sessionId, provider, model })
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
    const injected = this.pendingTurnFailures.shift()
    if (injected) {
      throw new SessionTurnFailure(injected.failure ?? 'mock provider failure', {
        toolCalls: injected.toolCalls, toolFailures: injected.toolFailures,
      })
    }
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
