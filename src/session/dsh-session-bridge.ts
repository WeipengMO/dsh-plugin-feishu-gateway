import { randomUUID } from 'node:crypto'
import type {
  AgentRoute,
  CordisLike,
  GatewayLogger,
  SessionBridge,
  SessionReply,
  WaitOptions,
} from '../types.js'
import { withTimeout } from '../util/retry.js'
import { extractText } from './session-bridge.js'

/** Official `@deepseek-ai/dsh-llm` entry, imported lazily at runtime. */
const LLM_MODULE = '@deepseek-ai/dsh-llm'

interface AgentHandleLike {
  readonly agent: {
    followup(message: unknown): void
    cancel(cause: { readonly kind: 'user' }, options?: { readonly keepInbox?: boolean }): void
    whenIdle(): Promise<void>
  }
  dispose(): Promise<void>
}

interface AgentRegistryLike {
  create(options: Record<string, unknown>): Promise<AgentHandleLike>
  resume(options: Record<string, unknown>): Promise<AgentHandleLike>
}

interface TurnState {
  readonly durable: string[]
  readonly live: string[]
  readonly done: Promise<void>
  readonly resolve: () => void
  settled: boolean
  events: number
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

  async create(sessionId: string, cwd: string, route?: AgentRoute): Promise<void> {
    if (this.handles.has(sessionId)) return
    const agents = this.requireAgents()
    const meta: Record<string, unknown> = { cwd }
    const agentOptions: Record<string, unknown> = {}
    if (route?.provider) agentOptions.provider = route.provider
    if (route?.model) agentOptions.model = route.model
    if (route?.reasoningEffort) agentOptions.reasoningEffort = route.reasoningEffort
    const handle = await agents.create({
      sessionId,
      meta,
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
    })
    this.handles.set(sessionId, handle)
    this.logger.info('created native DSH session %s', sessionId)
  }

  async resume(sessionId: string): Promise<void> {
    if (this.handles.has(sessionId)) return
    const agents = this.requireAgents()
    const handle = await agents.resume({ resumeSessionId: sessionId })
    this.handles.set(sessionId, handle)
    this.logger.info('resumed native DSH session %s', sessionId)
  }

  async submit(sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (!handle) throw new Error(`session ${sessionId} is not live`)
    if (signal.aborted) throw new Error('submit aborted')
    this.ensureTurn(sessionId)
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
        if (turn && (turn.durable.length > 0 || turn.live.length > 0)) this.settle(sessionId)
      }).catch(() => undefined)
    }
  }

  async waitForReply(sessionId: string, options: WaitOptions): Promise<SessionReply> {
    const turn = this.turns.get(sessionId)
    if (!turn) return { text: '', reason: 'empty' }
    const result = await withTimeout(turn.done, options.timeoutMs, options.signal)
    const durable = turn.durable.join('').trim()
    const text = durable || turn.live.join('').trim()
    const reason = !result.timedOut ? 'idle' : 'timeout'
    this.turns.delete(sessionId)
    return {
      text,
      reason,
      assistantEvents: turn.events,
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
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map((handle) => handle.dispose()))
  }

  private ensureTurn(sessionId: string): TurnState {
    let resolve!: () => void
    const done = new Promise<void>((r) => {
      resolve = r
    })
    const turn: TurnState = { durable: [], live: [], done, resolve, settled: false, events: 0 }
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
    const turn = this.turns.get(sessionId)
    if (!turn) return
    const type = (event as { type?: unknown })?.type
    if (type === 'assistant/message' || type === 'assistant/attempt') {
      const text = extractText((event as { data?: unknown })?.data)
      if (text) turn.durable.push(text)
      turn.events += 1
    } else if (type === 'turn/end') {
      this.settle(sessionId)
    }
  }

  private onAssistantStream(payload: unknown): void {
    const agent = (payload as { agent?: { id?: unknown } })?.agent
    const sessionId = String(agent?.id ?? '')
    if (!sessionId) return
    const turn = this.turns.get(sessionId)
    if (!turn) return
    const frame = (payload as { frame?: { type?: unknown; chunk?: unknown } })?.frame
    if (frame?.type === 'chunk') {
      const chunk = frame.chunk as { type?: unknown; text?: unknown } | undefined
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        turn.live.push(chunk.text)
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
