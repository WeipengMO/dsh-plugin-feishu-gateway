import { randomUUID } from 'node:crypto'
import type {
  AgentRoute,
  AvailableModel,
  AvailableProvider,
  ModelCatalog,
  CordisLike,
  GatewayLogger,
  ModelTokenUsage,
  ObservedScheduleTurn,
  SessionBridge,
  SessionReply,
  SessionToolActivity,
  SessionCompactionResult,
  SessionCompactionStatus,
  WaitOptions,
} from '../types.js'
import { withTimeout } from '../util/retry.js'
import { extractText } from './session-bridge.js'
import { SessionTurnFailure } from './turn-failure.js'

/** Official `@deepseek-ai/dsh-llm` entry, imported lazily at runtime. */
const LLM_MODULE = '@deepseek-ai/dsh-llm'

interface AgentHandleLike {
  readonly agent: {
    readonly model?: { current(): { provider?: unknown; model?: unknown } | undefined; select(choice: { provider: string; model: string }): void }
    followup(message: unknown): void
    cancel(cause: { readonly kind: 'user' }, options?: { readonly keepInbox?: boolean }): void
    whenIdle(): Promise<void>
  }
  dispose(): Promise<void>
}

interface AgentRegistryLike {
  create(options: Record<string, unknown>): Promise<AgentHandleLike>
  resume(options: Record<string, unknown>): Promise<AgentHandleLike>
  /** The official registry exposes a live-agent lookup (not an owner handle). */
  get?(sessionId: string): AgentHandleLike['agent'] | undefined
}

interface NativeCompactionLike {
  compactNow(agent: unknown, signal: AbortSignal): Promise<{
    shadowedSeqs?: unknown
    shadowedTokenCount?: unknown
  } | null>
}

interface ObservedCompaction {
  readonly count: number
  readonly at: number
  readonly shadowedItems: number
  readonly shadowedTokens: number
}

interface SessionStoreLike {
  get?(sessionId: string): unknown
}

interface TurnState {
  readonly durable: string[]
  readonly attempts: string[]
  readonly live: string[]
  readonly done: Promise<void>
  onTextDelta?: (text: string) => void
  onToolActivity?: (activity: SessionToolActivity) => void
  readonly toolNames: Map<string, string>
  toolCalls: number
  toolFailures: number
  readonly resolve: () => void
  settled: boolean
  events: number
  model?: string
  usage?: ModelTokenUsage
  generationMs: number
  readonly attemptStarts: Map<string, number>
  /** Set when `turn/end` reports a non-completed reason (native Agent failure). */
  failure?: string
}

/**
 * A turn the native DSH schedule service injected into one of our Sessions
 * without a Gateway `submit()` call. Kept separate from `TurnState` so an
 * unsolicited reminder can never corrupt a normal inbound reply.
 */
interface ExternalTurn {
  readonly sessionId: string
  /** Native user message id of the delivered occurrence (dedupe key). */
  readonly messageId: string
  readonly startedAt: number
  readonly durable: string[]
  readonly live: string[]
  events: number
  tokens: number
  usage?: ModelTokenUsage
  model?: string
}

/**
 * Official path A adapter (see docs/ARCHITECTURE.md):
 *
 *   ctx.agents.create / resume   — native Agent + Session under one id
 *   agent.followup(...)          — queue one user turn (no second LLM loop)
 *   ctx.on('session/event')      — durable assistant/turn events
 *   ctx.on('agent/assistant-stream') — live text deltas
 *   AgentHandle.dispose()        — full cleanup on plugin unload
 *
 * No DSH package is imported at build time: the registry is resolved through
 * `ctx.get('agents')` using a structural port, and the optional
 * `createUserMessage` helper is loaded with a runtime dynamic import. That
 * keeps this third-party plugin independent of DSH internals while still using
 * only public services.
 */
export class DshSessionBridge implements SessionBridge {
  private readonly agents: AgentRegistryLike | undefined
  private readonly handles = new Map<string, AgentHandleLike>()
  private readonly turns = new Map<string, TurnState>()
  /** Schedule-sourced turns injected directly into our Sessions. */
  private readonly externalTurns = new Map<string, ExternalTurn>()
  private scheduleTurnHandler: ((turn: ObservedScheduleTurn) => void) | undefined
  /** Reuse the last confirmed native request route on subsequent turns. */
  private readonly sessionModels = new Map<string, string>()
  /** Host-local, privacy-safe compaction observations (never summaries). */
  private readonly compactionObserved = new Map<string, ObservedCompaction>()
  private readonly compactionPending = new Map<string, {
    sessionId: string; shadowedItems: number; shadowedTokens: number
  }>()
  private readonly completedCompactions = new Set<string>()
  private readonly disposers: Array<() => void> = []
  private disposed = false

  constructor(
    private readonly ctx: CordisLike,
    private readonly logger: GatewayLogger,
  ) {
    const candidate = ctx.get('agents') as Partial<AgentRegistryLike> | undefined
    this.agents = candidate && typeof candidate.create === 'function' && typeof candidate.resume === 'function'
      ? (candidate as AgentRegistryLike)
      : undefined

    if (this.agents) {
      // Both listeners are fiber-owned by Cordis; we also keep the returned
      // disposers so `dispose()` is deterministic in standalone tests.
      this.disposers.push(ctx.on('session/event', (session: unknown, event: unknown) => {
        this.onSessionEvent(session, event)
      }))
      this.disposers.push(ctx.on('agent/assistant-stream', (payload: unknown) => {
        this.onAssistantStream(payload)
      }))
    }
  }

  get available(): boolean {
    return !this.disposed && this.agents !== undefined
  }

  get unavailableReason(): string | undefined {
    return this.agents
      ? undefined
      : "DSH service 'agents' is not mounted in this profile; native Sessions are disabled"
  }

  private requireAgents(): AgentRegistryLike {
    if (!this.agents || this.disposed) {
      throw new Error('DSH agent registry is unavailable')
    }
    return this.agents
  }

  /** Optional: the host's `agent-default-model` service (absent in mocks). */
  private defaultModelSelection(): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
    try {
      const service = this.ctx.get('agentDefaultModel') as {
        currentSelection?: () => { provider?: string; model?: string; reasoningEffort?: string }
      } | undefined
      return typeof service?.currentSelection === 'function' ? service.currentSelection() : undefined
    } catch {
      return undefined
    }
  }

  async listModels(): Promise<ModelCatalog> {
    let llm: {
      listProviders?: () => unknown
      listModels?: (provider: string) => Promise<unknown>
    } | undefined
    try { llm = this.ctx.get('llm') as typeof llm } catch { return { models: [], incomplete: true } }
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function')
      return { models: [], incomplete: true }
    try {
      const providers = llm.listProviders()
      if (!Array.isArray(providers)) return { models: [], incomplete: true }
      const source = llm
      const models: AvailableModel[] = []
      const directory: AvailableProvider[] = []
      const seen = new Set<string>()
      let incomplete = false
      // Query every advertised provider, but limit concurrent requests so a
      // large catalog does not overload the native DSH LLM service.
      const availableProviders = providers.flatMap(entry => {
        const id = entry && typeof entry.id === 'string' ? entry.id : ''
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) return []
        const name = typeof entry?.name === 'string' ? entry.name.trim().slice(0, 100) : ''
        return [{ id, name }]
      })
      for (let offset = 0; offset < availableProviders.length; offset += 6) {
        const batch = await Promise.all(availableProviders.slice(offset, offset + 6).map(async provider => {
          try {
            return { provider, result: await source.listModels!(provider.id) }
          } catch {
            return { provider, result: undefined }
          }
        }))
        for (const { provider, result } of batch) {
          if (!Array.isArray(result)) { incomplete = true; continue }
          const providerModels: AvailableModel[] = []
          for (const item of result) {
            const model = item && typeof item.id === 'string' ? item.id : ''
            if (!/^[A-Za-z0-9_./:@+-]{1,160}$/.test(model)) continue
            const key = provider.id + '/' + model
            if (seen.has(key)) continue
            seen.add(key)
            const name = typeof item.name === 'string' ? item.name.slice(0, 100) : ''
            const availableModel: AvailableModel = {
              provider: provider.id, model, ...(name ? { name } : {}),
            }
            models.push(availableModel)
            providerModels.push(availableModel)
          }
          if (providerModels.length > 0) {
            directory.push({ id: provider.id, ...(provider.name ? { name: provider.name } : {}),
              models: providerModels })
          }
        }
      }
      return { models, providers: directory, incomplete }
    } catch { return { models: [], incomplete: true } }
  }

  /** The Profile's own `agent-default-model` selection, when the Host mounts it. */
  defaultModel(): AgentRoute | undefined {
    const selection = this.defaultModelSelection()
    if (!selection?.provider || !selection.model) return undefined
    return { provider: selection.provider, model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
  }

  currentModel(sessionId: string): { provider: string; model: string } | undefined {
    const selected = this.handles.get(sessionId)?.agent.model?.current()
    return selected && typeof selected.provider === 'string' && typeof selected.model === 'string'
      ? { provider: selected.provider, model: selected.model } : undefined
  }

  selectModel(sessionId: string, provider: string, model: string): void {
    const agent = this.handles.get(sessionId)?.agent
    if (!agent?.model || typeof agent.model.select !== 'function') throw new Error('model selection unavailable')
    agent.model.select({ provider, model })
  }

  /**
   * A native Agent created through `ctx.agents.create()` — and a persisted one
   * loaded through `ctx.agents.resume()` — has NO provider/model unless one is
   * supplied: the `agent-default-model` service only records a model selection
   * for agents the host creates itself. Verified in a real DSH 0.2.2-rc.1
   * runtime — without this, every turn ends with
   * "agent ... has no provider/model" and the user gets an empty-reply /
   * fallback-notice instead of content. Prefer the plugin's explicit `agent`
   * route, then the profile's own default selection (the default case).
   */
  private routeAgentOptions(route?: AgentRoute): Record<string, unknown> | undefined {
    const selection = this.defaultModelSelection()
    const provider = route?.provider ?? selection?.provider
    const model = route?.model ?? selection?.model
    const reasoningEffort = route?.reasoningEffort ?? selection?.reasoningEffort
    const agentOptions: Record<string, unknown> = {}
    if (provider) agentOptions.provider = provider
    if (model) agentOptions.model = model
    if (reasoningEffort) agentOptions.reasoningEffort = reasoningEffort
    return Object.keys(agentOptions).length > 0 ? agentOptions : undefined
  }

  /** Use only the live owned Session; never reopen persistent logs from the Web host. */
  titleSource(sessionId: string): 'user' | 'automatic' | 'unknown' {
    try {
      if (!this.handles.has(sessionId)) return 'unknown'
      const port = this.ctx.get('sessionTitle') as { get?: (session: unknown) => { source?: { kind?: string } | string } } | undefined
      const store = this.ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
      const session = store?.get?.(sessionId)
      if (!session || typeof port?.get !== 'function') return 'unknown'
      const source = port.get(session)?.source
      return (source === 'user' || (typeof source === 'object' && source?.kind === 'user'))
        ? 'user' : 'automatic'
    } catch { return 'unknown' }
  }

  async title(sessionId: string, value: string): Promise<boolean> {
    if (!this.handles.has(sessionId)) return false
    try {
      const port = this.ctx.get('sessionTitle') as {
        get?: (session: unknown) => { source?: { kind?: string } | string }
        rename?: (session: unknown, title: string) => Promise<unknown>
      } | undefined
      const store = this.ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
      const session = store?.get?.(sessionId)
      if (!session || !port?.get || typeof port.rename !== 'function') {
        this.logger.warn('DSH sessionTitle service unavailable; retaining automatic session title')
        return false
      }
      const source = port.get(session)?.source
      if (source === 'user' || (typeof source === 'object' && source?.kind === 'user')) return false
      await port.rename(session, value)
      return true
    } catch {
      this.logger.warn('native session title write failed; Feishu conversation remains usable')
      return false
    }
  }

  private nativeCompaction(): NativeCompactionLike | undefined {
    try {
      const service = this.ctx.get('compaction') as Partial<NativeCompactionLike> | undefined
      return typeof service?.compactNow === 'function' ? service as NativeCompactionLike : undefined
    } catch { return undefined }
  }

  /** Availability means the host has a compaction backend, NOT that auto=true was verified. */
  compactionStatus(sessionId?: string): SessionCompactionStatus {
    const observed = sessionId ? this.compactionObserved.get(sessionId) : undefined
    return {
      available: !this.disposed && Boolean(this.nativeCompaction()),
      completedInProcess: observed?.count ?? 0,
      ...(observed ? {
        lastCompletedAt: observed.at,
        lastShadowedItems: observed.shadowedItems,
        lastShadowedTokens: observed.shadowedTokens,
      } : {}),
    }
  }

  /** Safe manual hook: DSH holds its own per-Session compaction lock and writes
   * durable checkpoint events. Never duplicate a compaction using followup(). */
  async compactNow(sessionId: string, signal: AbortSignal): Promise<SessionCompactionResult> {
    const engine = this.nativeCompaction()
    if (!engine || this.disposed) throw new Error('DSH compaction service unavailable')
    const handle = this.handles.get(sessionId)
    if (!handle || (typeof this.agents?.get === 'function' && this.agents.get(sessionId) !== handle.agent)) {
      throw new Error('DSH Session is not owned by this Gateway')
    }
    if (signal.aborted) throw signal.reason ?? new Error('compaction cancelled')
    const result = await engine.compactNow(handle.agent, signal)
    if (result === null) return { outcome: 'nothing-to-compact' }
    const items = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0
    const n = result.shadowedTokenCount
    return { outcome: 'compacted', shadowedItems: items,
      ...(Number.isSafeInteger(n) && (n as number) >= 0 ? { shadowedTokens: n as number } : {}) }
  }

  async create(sessionId: string, cwd: string, route?: AgentRoute): Promise<void> {
    if (this.handles.has(sessionId)) return
    const agents = this.requireAgents()
    const meta: Record<string, unknown> = { cwd }

    const agentOptions = this.routeAgentOptions(route)
    const handle = await agents.create({
      sessionId,
      meta,
      ...(agentOptions ? { agentOptions } : {}),
    })
    this.handles.set(sessionId, handle)
    this.logger.info('created native DSH session %s', sessionId)
  }

  async resume(sessionId: string, route?: AgentRoute): Promise<void> {
    const agents = this.requireAgents()
    const cached = this.handles.get(sessionId)

    if (cached) {
      // Normal follow-up in the SAME live host: reuse the owning AgentHandle.
      // AgentHandle.dispose() removes the Session from SessionStore. Disposing
      // it before every turn destroys the very context we want to preserve.
      // A cold resume belongs ONLY to a new bridge/host after persistence has
      // been mounted and agent-loop has registered its factory.
      if (typeof agents.get === 'function' && agents.get(sessionId) !== cached.agent) {
        throw new Error(
          `native DSH Agent ${sessionId} is no longer registered; ` +
          'the host/agent-loop may have unloaded. Refusing to reuse a stale handle.',
        )
      }
      const sessions = this.ctx.get('sessions') as SessionStoreLike | undefined
      if (typeof sessions?.get === 'function' && !sessions.get(sessionId)) {
        throw new Error(
          `native DSH Session ${sessionId} is not in the active SessionStore; ` +
          'the host may have shut down. Refusing to append to a detached Session.',
        )
      }
      this.logger.debug('reusing live native DSH session %s', sessionId)
      return
    }

    try {
      // Cold resume drops the creation-time route unless it is supplied again.
      // Without agentOptions the loaded Agent has no provider/model and the next
      // scheduled or user turn fails before any message is emitted.
      const agentOptions = this.routeAgentOptions(route)
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        ...(agentOptions ? { agentOptions } : {}),
      })
      this.handles.set(sessionId, handle)
      this.logger.info('restored persisted native DSH session %s', sessionId)
    } catch (error) {
      throw new Error(
        `cannot resume persisted DSH Session ${sessionId}; ensure a persistent DSH host ` +
        `has agent-loop and session-persistence mounted: ${String(error)}`,
        { cause: error },
      )
    }
  }

  async submit(sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (!handle) throw new Error(`session ${sessionId} is not live`)
    if (signal.aborted) throw new Error('submit aborted')
    const submittedTurn = this.ensureTurn(sessionId)
    handle.agent.followup(await makeUserMessage(text))

    // Secondary completion signal. `turn/end` is the authoritative boundary,
    // but a profile whose scope-filtered event delivery skips our root listener
    // would otherwise wait for the full timeout. `whenIdle()` only settles the
    // turn once some assistant content has actually been observed, so an early
    // idle (driver not yet started) cannot truncate the reply.
    const whenIdle = handle.agent.whenIdle
    if (typeof whenIdle === 'function') {
      void whenIdle.call(handle.agent).then(() => {
        const turn = this.turns.get(sessionId)
        if (turn === submittedTurn && (turn.durable.length > 0 || turn.attempts.length > 0 || turn.live.length > 0)) {
          this.settle(sessionId)
        }
      }).catch(() => undefined)
    }
  }

  async waitForReply(sessionId: string, options: WaitOptions): Promise<SessionReply> {
    const turn = this.turns.get(sessionId)
    if (!turn) return { text: '', reason: 'empty' }
    const result = await withTimeout(turn.done, options.timeoutMs, options.signal)
    const durable = turn.durable.join('').trim()
    const text = durable || turn.attempts.join('').trim() || turn.live.join('').trim()
    const reason = !result.timedOut ? 'idle' : 'timeout'
    const failure = turn.failure
    this.turns.delete(sessionId)
    // A `turn/end` with reason.kind === 'error' means the native Agent loop
    // failed (e.g. LLM 5xx after retries) WITHOUT producing an assistant
    // message. Returning an empty "success" here would make the Gateway mark
    // the message `done` with a useless "model returned no text" reply and keep
    // the (possibly half-updated) Session bound. Propagate it so the existing
    // failure path marks `failed` + unbinds, isolating the next message.
    if (failure) {
      // Typed failure: the Gateway may retry once with the configured fallback
      // model, but ONLY when the failure carries no executable side effects.
      throw new SessionTurnFailure(failure, { toolCalls: turn.toolCalls, toolFailures: turn.toolFailures })
    }
    return {
      text,
      reason,
      assistantEvents: turn.events,
      ...(turn.model ? { model: turn.model } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(turn.generationMs > 0 ? { generationMs: turn.generationMs } : {}),
      toolCalls: turn.toolCalls,
      toolFailures: turn.toolFailures,
    }
  }

  onTextDelta(sessionId: string, callback: (text: string) => void): () => void {
    const turn = this.turns.get(sessionId)
    if (!turn || turn.settled) return () => undefined
    turn.onTextDelta = callback
    return () => {
      if (turn.onTextDelta === callback) turn.onTextDelta = undefined
    }
  }

  onToolActivity(sessionId: string, callback: (activity: SessionToolActivity) => void): () => void {
    const turn = this.turns.get(sessionId)
    if (!turn || turn.settled) return () => undefined
    turn.onToolActivity = callback
    return () => { if (turn.onToolActivity === callback) turn.onToolActivity = undefined }
  }

  /**
   * Observe turns delivered by the native DSH schedule service. The Gateway
   * registers one handler; the returned disposer is called on plugin unload.
   */
  watchScheduleTurns(handler: (turn: ObservedScheduleTurn) => void): () => void {
    this.scheduleTurnHandler = handler
    return () => {
      if (this.scheduleTurnHandler === handler) this.scheduleTurnHandler = undefined
    }
  }

  cancel(sessionId: string): void {
    const handle = this.handles.get(sessionId)
    if (!handle) return
    try {
      handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch (error) {
      this.logger.warn('cancel failed for %s: %s', sessionId, String(error))
    }
    this.settle(sessionId)
  }

  async retire(sessionId: string): Promise<void> {
    // An aborted Session must not retain a Handle until the entire Host exits.
    // Never invoke this on a healthy follow-up turn.
    this.settle(sessionId)
    this.turns.delete(sessionId)
    this.sessionModels.delete(sessionId)
    const handle = this.handles.get(sessionId)
    if (!handle) return
    this.handles.delete(sessionId)
    try {
      const result = await withTimeout(handle.dispose(), 5_000)
      if (result.timedOut) this.logger.warn('retired AgentHandle %s did not dispose within 5s', sessionId)
    } catch (error) {
      this.logger.warn('retired AgentHandle %s disposal failed: %s', sessionId, String(error))
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.disposers.splice(0)) {
      try {
        off()
      } catch (error) {
        this.logger.warn('listener disposal failed: %s', String(error))
      }
    }
    for (const id of [...this.turns.keys()]) this.settle(id)
    this.turns.clear()
    this.externalTurns.clear()
    this.scheduleTurnHandler = undefined
    this.sessionModels.clear()
    this.compactionObserved.clear()
    this.compactionPending.clear()
    this.completedCompactions.clear()
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map((handle) => handle.dispose()))
  }

  private ensureTurn(sessionId: string): TurnState {
    let resolve!: () => void
    const done = new Promise<void>((r) => {
      resolve = r
    })
    const turn: TurnState = {
      durable: [], attempts: [], live: [], done, resolve, settled: false,
      events: 0, generationMs: 0, attemptStarts: new Map(),
      toolNames: new Map(), toolCalls: 0, toolFailures: 0,
      ...(this.sessionModels.has(sessionId) ? { model: this.sessionModels.get(sessionId) } : {}),
    }
    this.turns.set(sessionId, turn)
    return turn
  }

  private settle(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (!turn || turn.settled) return
    turn.settled = true
    turn.resolve()
  }

  private onSessionEvent(session: unknown, event: unknown): void {
    const sessionId = String((session as { id?: unknown })?.id ?? '')
    if (!sessionId) return
    const type = (event as { type?: unknown })?.type
    const data = (event as { data?: Record<string, unknown> })?.data
    if (type === 'compaction/summary' && typeof data?.compactionId === 'string') {
      const key = sessionId + ':' + data.compactionId
      // No summary text, tool data or raw events are read into Gateway state.
      const shadowedItems = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0
      const shadowedTokens = Number.isSafeInteger(data.shadowedTokenCount) &&
        (data.shadowedTokenCount as number) >= 0 ? data.shadowedTokenCount as number : 0
      if (this.compactionPending.size >= 256) this.compactionPending.clear()
      this.compactionPending.set(key, { sessionId, shadowedItems, shadowedTokens })
    } else if (type === 'compaction/end' && typeof data?.compactionId === 'string') {
      const key = sessionId + ':' + data.compactionId
      const pending = this.compactionPending.get(key)
      this.compactionPending.delete(key)
      if (pending && !data.error && !this.completedCompactions.has(key)) {
        this.completedCompactions.add(key)
        if (this.completedCompactions.size > 512) this.completedCompactions.clear()
        const before = this.compactionObserved.get(sessionId)
        this.compactionObserved.set(sessionId, {
          count: (before?.count ?? 0) + 1, at: Date.now(),
          shadowedItems: pending.shadowedItems, shadowedTokens: pending.shadowedTokens,
        })
      }
    }
    // Native DSH records the effective route under request/context (or
    // request/header). Read from the same stream as token settlements.
    const context = type === 'request/context' ? data :
      type === 'request/header' ? (data?.header as { config?: Record<string, unknown> } | undefined)?.config : undefined
    if (context && typeof context.model === 'string' && context.model.length > 0) {
      const provider = typeof context.provider === 'string' ? context.provider : ''
      const name = provider ? provider + '/' + context.model : context.model
      this.sessionModels.set(sessionId, name)
    }

    // Native schedule delivery injects a `createUserMessage` with
    // `source: { kind: 'schedule' }` directly through `agent.followup()`.
    // There is no Gateway `submit()` call for it, so track it separately.
    if (type === 'user/message') {
      const direct = data as { id?: unknown; source?: { kind?: unknown }; message?: unknown } | undefined
      const nested = direct?.message as { id?: unknown; source?: { kind?: unknown } } | undefined
      const source = direct?.source?.kind === 'schedule' ? direct
        : nested?.source?.kind === 'schedule' ? nested : undefined
      if (source && typeof source.id === 'string' && source.id) {
        this.externalTurns.set(sessionId, {
          sessionId, messageId: source.id, startedAt: Date.now(),
          durable: [], live: [], events: 0, tokens: 0,
          ...(this.sessionModels.get(sessionId) ? { model: this.sessionModels.get(sessionId) } : {}),
        })
      }
    }
    const external = this.externalTurns.get(sessionId)
    if (external) {
      if (Date.now() - external.startedAt > 10 * 60_000) {
        // A turn with no `turn/end` is abandoned. The Gateway's fallback
        // notice (from the native delivery receipt) still reaches Feishu.
        this.externalTurns.delete(sessionId)
      } else if (type === 'assistant/message' || type === 'assistant/attempt') {
        const text = extractText(data)
        if (text) (type === 'assistant/message' ? external.durable : external.live).push(text)
        external.events += 1
        const usage = reportedUsage(data)
        if (usage) {
          external.tokens += usage.inputTokens + usage.outputTokens +
            (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          external.usage = {
            inputTokens: (external.usage?.inputTokens ?? 0) + usage.inputTokens,
            outputTokens: (external.usage?.outputTokens ?? 0) + usage.outputTokens,
            cacheReadTokens: (external.usage?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
            cacheWriteTokens: (external.usage?.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          }
        }
        if (!external.model && this.sessionModels.has(sessionId)) {
          external.model = this.sessionModels.get(sessionId)
        }
      } else if (type === 'turn/end') {
        const reason = (event as {
          data?: { reason?: { kind?: string } }
        })?.data?.reason
        const text = (external.durable.join('') || external.live.join('')).trim()
        const status: ObservedScheduleTurn['status'] = reason?.kind === 'error' ? 'failed'
          : text ? 'success' : 'empty'
        this.externalTurns.delete(sessionId)
        const handler = this.scheduleTurnHandler
        if (handler) {
          try {
            handler({
              sessionId, messageId: external.messageId, text, status,
              elapsedMs: Date.now() - external.startedAt,
              ...(external.model ? { model: external.model } : {}),
              ...(external.usage ? { usage: external.usage, tokens: external.tokens } : {}),
            })
          } catch { /* an observer failure must never break native event delivery */ }
        }
      }
    }

    const turn = this.turns.get(sessionId)
    if (!turn) return
    if (this.sessionModels.has(sessionId)) turn.model = this.sessionModels.get(sessionId)
    // DSH native tool events are observable without reading/storing arguments.
    // Never send raw tool output, URLs, file paths or error messages to CardKit.
    if (type === 'tool/call') {
      const id = typeof data?.callId === 'string' ? data.callId : ''
      const raw = typeof data?.name === 'string' ? data.name : ''
      const name = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(raw) ? raw : 'tool'
      if (id) turn.toolNames.set(id, name)
      turn.toolCalls += 1
      try { turn.onToolActivity?.({ name, phase: 'started', calls: turn.toolCalls, failures: turn.toolFailures }) }
      catch { /* progress telemetry must not break native sessions */ }
    } else if (type === 'tool/result') {
      const msg = data?.message as { toolCallId?: unknown; source?: { callId?: unknown }; isError?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } | undefined
      const id = typeof msg?.toolCallId === 'string' ? msg.toolCallId
        : typeof msg?.source?.callId === 'string' ? msg.source.callId : ''
      const name = turn.toolNames.get(id) ?? 'tool'
      turn.toolNames.delete(id)
      // Native web_fetch records the HTTP status in data.meta.statusCode.
      // Prefer this structured field over parsing the returned, untrusted webpage.
      const metadata = data?.meta as { statusCode?: unknown } | undefined
      const first = msg?.content?.find(block => block.type === 'text' && typeof block.text === 'string')?.text
      const parsed = typeof first === 'string' && name === 'web_fetch'
        ? Number(/^Fetched .*? \(HTTP (\d{3})\)/s.exec(first)?.[1]) : NaN
      const status = name === 'web_fetch' && typeof metadata?.statusCode === 'number'
        ? metadata.statusCode : parsed
      const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
      const failed = msg?.isError === true || (httpStatus !== undefined && httpStatus >= 400)
      if (failed) turn.toolFailures += 1
      try { turn.onToolActivity?.({ name, phase: failed ? 'failed' : 'succeeded',
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        calls: turn.toolCalls, failures: turn.toolFailures }) }
      catch { /* progress telemetry must not break native sessions */ }
    }
    if (type === 'assistant/message' || type === 'assistant/attempt') {
      const usage = reportedUsage(data)
      if (usage) {
        const before = turn.usage
        turn.usage = {
          inputTokens: (before?.inputTokens ?? 0) + usage.inputTokens,
          outputTokens: (before?.outputTokens ?? 0) + usage.outputTokens,
          cacheReadTokens: (before?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: (before?.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        }
      }
      const text = extractText((event as { data?: unknown })?.data)
      if (text) (type === 'assistant/message' ? turn.durable : turn.attempts).push(text)
      turn.events += 1
    } else if (type === 'turn/end') {
      // dsh-session emits the authoritative outcome here. Verified on
      // 0.2.2-rc.1: a failed Agent turn ends with
      // data.reason = { kind: 'error', error: { message, code } } and produces
      // no assistant/message. Only `completed` is a real success.
      const reason = (event as {
        data?: { reason?: { kind?: string; error?: { message?: string; code?: string } } }
      })?.data?.reason
      // Only a genuine Agent failure is surfaced as an error. `aborted` /
      // `interrupted` are user/cancellation outcomes that the Gateway already
      // handles via its own signal + `cancelled` reply path.
      if (reason?.kind === 'error') {
        const detail = reason.error?.message ?? reason.error?.code ?? 'unknown error'
        turn.failure = `error: ${detail}`
      }
      this.settle(sessionId)
    }
  }

  private onAssistantStream(payload: unknown): void {
    const agent = (payload as { agent?: { id?: unknown } })?.agent
    const sessionId = String(agent?.id ?? '')
    if (!sessionId) return
    const turn = this.turns.get(sessionId)
    const external = this.externalTurns.get(sessionId)
    if (!turn && !external) return
    const frame = (payload as {
      frame?: { type?: unknown; attemptId?: unknown; chunk?: unknown }
    })?.frame
    const attemptId = typeof frame?.attemptId === 'string' ? frame.attemptId : 'default'
    if (frame?.type === 'start') {
      turn?.attemptStarts.set(attemptId, Date.now())
    } else if (frame?.type === 'end') {
      const started = turn?.attemptStarts.get(attemptId)
      if (turn && started !== undefined) {
        turn.generationMs += Math.max(0, Date.now() - started)
        turn.attemptStarts.delete(attemptId)
      }
    } else if (frame?.type === 'chunk') {
      const chunk = frame.chunk as { type?: unknown; text?: unknown } | undefined
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        turn?.live.push(chunk.text)
        external?.live.push(chunk.text)
        try { turn?.onTextDelta?.(chunk.text) }
        catch { /* A failed progress UI must not abort the native Agent turn. */ }
      }
    }
  }
}

/**
 * Build a user message via the official `createUserMessage` from
 * `@deepseek-ai/dsh-llm` when that package is resolvable in the host profile.
 * The literal fallback mirrors the same documented shape (identified, frozen,
 * `role: 'user'`, `source: { kind: 'user' }`) for standalone/offline profiles.
 */
async function makeUserMessage(text: string): Promise<unknown> {
  try {
    const mod = (await import(LLM_MODULE)) as {
      createUserMessage?: (input: unknown) => unknown
    }
    if (typeof mod?.createUserMessage === 'function') {
      return mod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    }
  } catch {
    // Host profile may not expose the package to this plugin's resolver.
  }
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/** Read native DSH provider usage; never approximate tokens from text length. */
function reportedUsage(data: Record<string, unknown> | undefined): ModelTokenUsage | undefined {
  if (!data) return undefined
  const entries = Array.isArray(data.stream) ? data.stream : []
  let candidate: unknown = data.usage
  if (!candidate) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const item = entries[i] as { chunk?: { type?: string; usage?: unknown }; type?: string; usage?: unknown } | undefined
      if (item?.chunk?.type === 'usage') { candidate = item.chunk.usage; break }
      if (item?.type === 'usage') { candidate = item.usage; break }
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const value = candidate as Record<string, unknown>
  const valid = (num: unknown) => typeof num === 'number' && Number.isSafeInteger(num) && num >= 0
  if (!valid(value.inputTokens) || !valid(value.outputTokens)) return undefined
  return {
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    ...(valid(value.cacheReadTokens) ? { cacheReadTokens: value.cacheReadTokens as number } : {}),
    ...(valid(value.cacheWriteTokens) ? { cacheWriteTokens: value.cacheWriteTokens as number } : {}),
  }
}
