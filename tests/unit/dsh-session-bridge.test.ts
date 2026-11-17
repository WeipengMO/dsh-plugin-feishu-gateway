import { describe, expect, it } from 'vitest'
import { DshSessionBridge } from '../../src/session/dsh-session-bridge.js'
import { SessionTurnFailure } from '../../src/session/turn-failure.js'
import { extractText } from '../../src/session/session-bridge.js'
import { silentLogger } from '../../src/util/logger.js'
import type { CordisLike } from '../../src/types.js'

class FakeCtx implements CordisLike {
  readonly services = new Map<string, unknown>()
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()

  get(name: string): unknown {
    return this.services.get(name)
  }

  provide(name: string, value?: unknown): () => void {
    this.services.set(name, value)
    return () => {
      this.services.delete(name)
    }
  }

  on(name: string, listener: (...args: any[]) => void): () => boolean {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
    return () => {
      const current = this.listeners.get(name) ?? []
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
      return index >= 0
    }
  }

  effect(): () => void {
    return () => true
  }

  emit(name: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(name) ?? []) listener(...args)
  }

  listenerCount(name: string): number {
    return (this.listeners.get(name) ?? []).length
  }
}

interface FakeHandle {
  readonly agent: {
    followup(message: unknown): void
    cancel(cause: unknown, options?: unknown): void
    whenIdle(): Promise<void>
  }
  dispose(): Promise<void>
}

function fakeAgents() {
  const created: Array<Record<string, unknown>> = []
  const resumed: Array<Record<string, unknown>> = []
  const followups: unknown[] = []
  const cancels: unknown[] = []
  const disposed: string[] = []
  let handleCounter = 0

  const makeHandle = (): FakeHandle => {
    const id = `handle-${handleCounter++}`
    return {
      agent: {
        followup: (message) => followups.push(message),
        cancel: (cause) => cancels.push(cause),
        whenIdle: async () => {},
      },
      dispose: async () => {
        disposed.push(id)
      },
    }
  }

  const agents: {
    create: (options: Record<string, unknown>) => Promise<FakeHandle>
    resume: (options: Record<string, unknown>) => Promise<FakeHandle>
    get?: (sessionId: string) => FakeHandle['agent'] | undefined
  } = {
    create: async (options: Record<string, unknown>) => {
      created.push(options)
      return makeHandle()
    },
    resume: async (options: Record<string, unknown>) => {
      resumed.push(options)
      return makeHandle()
    },
  }
  return { agents, created, resumed, followups, cancels, disposed }
}

function setup(withAgents = true) {
  const ctx = new FakeCtx()
  const fake = fakeAgents()
  if (withAgents) ctx.services.set('agents', fake.agents)
  const bridge = new DshSessionBridge(ctx, silentLogger)
  return { ctx, fake, bridge }
}

describe('extractText', () => {
  it('reads assistant message content blocks', () => {
    expect(extractText({ message: { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] } }))
      .toBe('Hello world')
  })

  it('reads live text-delta chunks', () => {
    expect(extractText({ type: 'text-delta', text: 'token' })).toBe('token')
  })

  it('ignores tool-call deltas and unknown payloads', () => {
    expect(extractText({ type: 'tool-call-delta', argumentsDelta: '{}' })).toBe('')
    expect(extractText(undefined)).toBe('')
    expect(extractText({ stream: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('')
  })
})

describe('DshSessionBridge model catalog and scheduled usage', () => {
  it('uses live Host model providers and switches only the selected Agent', async () => {
    const { ctx, fake, bridge } = setup()
    let selected = { provider: 'magpie', model: 'group/deepseek' }
    fake.agents.create = async () => ({
      agent: {
        model: { current: () => selected, select: (value: { provider: string; model: string }) => { selected = value } },
        followup: () => {}, cancel: () => {}, whenIdle: async () => {},
      } as any,
      dispose: async () => {},
    })
    ctx.services.set('llm', {
      listProviders: () => [{ id: 'magpie', name: 'Magpie routing' }, { id: 'broken' }],
      listModels: async (provider: string) => {
        if (provider === 'broken') throw new Error('offline')
        return [{ id: 'group/deepseek', name: 'DeepSeek' }, { id: 'group/hy4-free', name: 'HY' }]
      },
    })
    const catalog = await bridge.listModels()
    expect(catalog).toMatchObject({ incomplete: true, models: [
      { provider: 'magpie', model: 'group/deepseek' }, { provider: 'magpie', model: 'group/hy4-free' },
    ] })
    // Provider-grouped directory for selectors; the failed provider is omitted.
    expect(catalog.providers).toMatchObject([{ id: 'magpie', name: 'Magpie routing', models: [
      { provider: 'magpie', model: 'group/deepseek', name: 'DeepSeek' },
      { provider: 'magpie', model: 'group/hy4-free', name: 'HY' },
    ] }])
    await bridge.create('s', '/tmp')
    expect(bridge.currentModel('s')).toEqual({ provider: 'magpie', model: 'group/deepseek' })
    bridge.selectModel('s', 'magpie', 'group/hy4-free')
    expect(bridge.currentModel('s')).toEqual({ provider: 'magpie', model: 'group/hy4-free' })
    expect(() => bridge.selectModel('another', 'magpie', 'group/deepseek')).toThrow()
    await bridge.dispose()
  })

  it('carries provider-reported schedule usage components without inventing missing values', async () => {
    const { ctx, bridge } = setup()
    const seen: any[] = []
    bridge.watchScheduleTurns(turn => seen.push(turn))
    const session = { id: 'schedule-session' }
    ctx.emit('session/event', session, { type: 'user/message',
      data: { message: { id: 'msg-1', source: { kind: 'schedule' } } } })
    ctx.emit('session/event', session, { type: 'request/context',
      data: { provider: 'magpie', model: 'group/deepseek' } })
    ctx.emit('session/event', session, { type: 'assistant/message', data: {
      message: { content: [{ type: 'text', text: 'done' }] },
      usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
    } })
    ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ model: 'magpie/group/deepseek', tokens: 30,
      usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 } })
    await bridge.dispose()
  })
})

describe('DshSessionBridge', () => {
  it('is unavailable when the agents service is missing', () => {
    const { bridge } = setup(false)
    expect(bridge.available).toBe(false)
    expect(bridge.unavailableReason).toContain('agents')
  })

  it('creates a native Session through ctx.agents with cwd and model route', async () => {
    const { bridge, fake } = setup()
    await bridge.create('session-1', '/workspace', { provider: 'deepseek', model: 'deepseek-chat' })
    expect(fake.created[0]).toMatchObject({
      sessionId: 'session-1',
      meta: { cwd: '/workspace' },
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    })
  })

  it('queues one user turn via agent.followup', async () => {
    const { bridge, fake } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.submit('session-1', 'hello', new AbortController().signal)
    expect(fake.followups).toHaveLength(1)
    const message = fake.followups[0] as { role?: string; content?: Array<{ text?: string }> }
    expect(message.role).toBe('user')
    expect(message.content?.[0]?.text).toBe('hello')
  })

  it('collects durable assistant text and settles on turn/end', async () => {
    const { ctx, bridge } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.submit('session-1', 'hi', new AbortController().signal)
    const waiting = bridge.waitForReply('session-1', { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'native reply' }] } },
    })
    ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: {} })
    const reply = await waiting
    expect(reply).toMatchObject({ text: 'native reply', reason: 'idle' })
  })

  it('tracks native tool failures without exposing URL or tool output', async () => {
    const { ctx, bridge } = setup()
    await bridge.create('session-tools', '/workspace')
    await bridge.submit('session-tools', 'query', new AbortController().signal)
    const observed: unknown[] = []
    bridge.onToolActivity?.('session-tools', event => observed.push(event))
    const waiting = bridge.waitForReply('session-tools', {
      timeoutMs: 1000, signal: new AbortController().signal,
    })
    ctx.emit('session/event', { id: 'session-tools' }, {
      type: 'tool/call',
      data: { callId: 'call-1', name: 'web_fetch', arguments: '{"url":"https://private.invalid"}' },
    })
    ctx.emit('session/event', { id: 'session-tools' }, {
      type: 'tool/result',
      data: { message: { toolCallId: 'call-1',
        content: [{ type: 'text', text: 'Proxy error page from https://private.invalid' }] },
        meta: { statusCode: 567, url: 'https://private.invalid' } },
    })
    ctx.emit('session/event', { id: 'session-tools' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'I could not verify that source.' }] } },
    })
    ctx.emit('session/event', { id: 'session-tools' }, { type: 'turn/end', data: {} })
    const result = await waiting
    expect(result.toolCalls).toBe(1)
    expect(result.toolFailures).toBe(1)
    expect(observed).toMatchObject([
      { name: 'web_fetch', phase: 'started', calls: 1, failures: 0 },
      { name: 'web_fetch', phase: 'failed', httpStatus: 567, calls: 1, failures: 1 },
    ])
    expect(JSON.stringify(observed)).not.toContain('private.invalid')
  })

  it('reads provider-model and real token usage from native Session settlements', async () => {
    const { ctx, bridge } = setup()
    await bridge.create('session-metrics', '/workspace')
    await bridge.submit('session-metrics', 'first', new AbortController().signal)
    const waiting = bridge.waitForReply('session-metrics',
      { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('session/event', { id: 'session-metrics' }, {
      type: 'request/context', data: { provider: 'magpie', model: 'group/deepseek' },
    })
    ctx.emit('session/event', { id: 'session-metrics' }, {
      type: 'assistant/attempt',
      data: { stream: [{ chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } } }] },
    })
    ctx.emit('session/event', { id: 'session-metrics' }, {
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: 'final' }] },
        usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 25, cacheWriteTokens: 5 },
      },
    })
    ctx.emit('session/event', { id: 'session-metrics' }, { type: 'turn/end', data: {} })
    const reply = await waiting
    expect(reply.text).toBe('final')
    expect(reply.model).toBe('magpie/group/deepseek')
    expect(reply.usage).toEqual({
      inputTokens: 110, outputTokens: 41, cacheReadTokens: 25, cacheWriteTokens: 5,
    })

    // Route is not necessarily re-emitted on every follow-up in the same
    // native Session. Keep the last observed value across turns.
    await bridge.submit('session-metrics', 'second', new AbortController().signal)
    const next = bridge.waitForReply('session-metrics',
      { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('session/event', { id: 'session-metrics' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'again' }] } },
    })
    ctx.emit('session/event', { id: 'session-metrics' }, { type: 'turn/end', data: {} })
    expect((await next).model).toBe('magpie/group/deepseek')
  })

  it('falls back to live text deltas when no durable message arrives', async () => {
    const { ctx, bridge } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.submit('session-1', 'hi', new AbortController().signal)
    const waiting = bridge.waitForReply('session-1', { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('agent/assistant-stream', {
      agent: { id: 'session-1' },
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'live ' } },
    })
    ctx.emit('agent/assistant-stream', {
      agent: { id: 'session-1' },
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'tokens' } },
    })
    ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: {} })
    expect((await waiting).text).toBe('live tokens')
  })

  it('reports a timeout when the turn never settles', async () => {
    const { bridge } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.submit('session-1', 'hi', new AbortController().signal)
    const reply = await bridge.waitForReply('session-1', { timeoutMs: 5, signal: new AbortController().signal })
    expect(reply.reason).toBe('timeout')
    expect(reply.text).toBe('')
  })

  it('cancels via the official agent.cancel cause', async () => {
    const { bridge, fake } = setup()
    await bridge.create('session-1', '/workspace')
    bridge.cancel('session-1')
    expect(fake.cancels).toEqual([{ kind: 'user' }])
  })

  it('disposes handles and removes every listener', async () => {
    const { ctx, bridge, fake } = setup()
    expect(ctx.listenerCount('session/event')).toBe(1)
    expect(ctx.listenerCount('agent/assistant-stream')).toBe(1)
    await bridge.create('session-1', '/workspace')
    await bridge.dispose()
    expect(fake.disposed).toHaveLength(1)
    expect(ctx.listenerCount('session/event')).toBe(0)
    expect(ctx.listenerCount('agent/assistant-stream')).toBe(0)
    expect(bridge.available).toBe(false)
  })
  it('does not concatenate assistant/attempt with the final assistant/message', async () => {
    const { ctx, bridge } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.submit('session-1', 'hi', new AbortController().signal)
    const waiting = bridge.waitForReply('session-1', { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'assistant/attempt',
      data: { message: { content: [{ type: 'text', text: 'draft' }] } },
    })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'final' }] } },
    })
    ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: {} })
    expect((await waiting).text).toBe('final')
  })

  it('falls back to the host default model selection when no route is configured', async () => {
    // Real-runtime regression: ctx.agents.create() without agentOptions leaves
    // the Agent with no provider/model, so every turn errors with
    // "agent ... has no provider/model" and the user gets an empty reply.
    const { ctx, bridge, fake } = setup()
    ctx.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'mock-route', model: 'mock-model' }),
    })
    await bridge.create('session-1', '/workspace')
    expect(fake.created[0]).toMatchObject({
      agentOptions: { provider: 'mock-route', model: 'mock-model' },
    })
  })

  it('prefers an explicit plugin route over the host default', async () => {
    const { ctx, bridge, fake } = setup()
    ctx.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'host-default', model: 'host-model' }),
    })
    await bridge.create('session-1', '/workspace', { provider: 'explicit', model: 'explicit-model' })
    expect(fake.created[0]).toMatchObject({
      agentOptions: { provider: 'explicit', model: 'explicit-model' },
    })
  })

  it('stays usable (no agentOptions) when the default-model service is absent or throws', async () => {
    const { bridge, fake } = setup()
    await bridge.create('session-1', '/workspace')
    expect(fake.created[0]).not.toHaveProperty('agentOptions')
    const ctx2 = new FakeCtx()
    const fake2 = fakeAgents()
    ctx2.services.set('agents', fake2.agents)
    ctx2.services.set('agentDefaultModel', { currentSelection: () => { throw new Error('no route') } })
    const bridge2 = new DshSessionBridge(ctx2, silentLogger)
    await bridge2.create('session-2', '/workspace')
    expect(fake2.created[0]).not.toHaveProperty('agentOptions')
  })

  it('keeps one live AgentHandle for three sequential turns without destroying context', async () => {
    const { ctx, bridge, fake } = setup()
    await bridge.create('session-1', '/workspace')
    for (const [index, prompt] of ['remember alpha', 'what was it?', 'repeat it'].entries()) {
      await bridge.resume('session-1')
      await bridge.submit('session-1', prompt, new AbortController().signal)
      const waiting = bridge.waitForReply('session-1', {
        timeoutMs: 1000,
        signal: new AbortController().signal,
      })
      ctx.emit('session/event', { id: 'session-1' }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: `turn-${index + 1}` }] } },
      })
      ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: {} })
      expect((await waiting).text).toBe(`turn-${index + 1}`)
    }
    expect(fake.created).toHaveLength(1)
    expect(fake.resumed).toHaveLength(0)
    expect(fake.disposed).toHaveLength(0)
    expect(fake.followups).toHaveLength(3)
    await bridge.dispose()
    expect(fake.disposed).toHaveLength(1)
  })

  it('cold-resumes a persisted Session exactly once in a new bridge', async () => {
    const { ctx, bridge, fake } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.dispose()
    const restored = new DshSessionBridge(ctx, silentLogger)
    await restored.resume('session-1')
    await restored.resume('session-1')
    expect(fake.resumed).toEqual([{ resumeSessionId: 'session-1' }])
    expect(fake.disposed).toHaveLength(1)
    await restored.dispose()
    expect(fake.disposed).toHaveLength(2)
  })

  it('passes the host default model selection on cold resume', async () => {
    // Real-runtime regression (dsh 0.2.2-rc.1): a persisted Agent restored by
    // ctx.agents.resume() has no provider/model, so the next scheduled turn
    // ended immediately with "agent ... has no provider/model" before any
    // assistant message, and Feishu only received the fallback notice card.
    const { ctx, fake } = setup()
    ctx.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'mock-route', model: 'mock-model' }),
    })
    const restored = new DshSessionBridge(ctx, silentLogger)
    await restored.resume('session-1')
    expect(fake.resumed[0]).toMatchObject({
      resumeSessionId: 'session-1',
      agentOptions: { provider: 'mock-route', model: 'mock-model' },
    })
    await restored.dispose()
  })

  it('prefers an explicit plugin route on cold resume and keeps no empty agentOptions', async () => {
    const { ctx, fake } = setup()
    ctx.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'host-default', model: 'host-model' }),
    })
    const restored = new DshSessionBridge(ctx, silentLogger)
    await restored.resume('session-1', { provider: 'explicit', model: 'explicit-model' })
    expect(fake.resumed[0]).toMatchObject({
      agentOptions: { provider: 'explicit', model: 'explicit-model' },
    })
    await restored.dispose()

    // No default-model service and no route: stay compatible (no agentOptions).
    const bare = setup()
    const bridge = new DshSessionBridge(bare.ctx, silentLogger)
    await bridge.resume('session-2')
    expect(bare.fake.resumed[0]).toEqual({ resumeSessionId: 'session-2' })
    await bridge.dispose()
  })

  it('refuses to use a cached Agent when the official registry no longer owns it', async () => {
    const { ctx, bridge, fake } = setup()
    await bridge.create('session-1', '/workspace')
    ctx.services.set('agents', fake.agents)
    fake.agents.get = () => undefined
    await expect(bridge.resume('session-1')).rejects.toThrow(/no longer registered/)
    expect(fake.resumed).toHaveLength(0)
    expect(fake.disposed).toHaveLength(0)
    await bridge.dispose()
  })

  it('refuses to append to a detached SessionStore', async () => {
    const { ctx, bridge, fake } = setup()
    await bridge.create('session-1', '/workspace')
    ctx.services.set('sessions', { get: (_sessionId: string) => undefined })
    await expect(bridge.resume('session-1')).rejects.toThrow(/not in the active SessionStore/)
    expect(fake.followups).toHaveLength(0)
    await bridge.dispose()
  })

  it('reports a missing Agent Factory during cold restore without creating a new Session', async () => {
    const ctx = new FakeCtx()
    const fake = fakeAgents()
    ctx.services.set('agents', {
      ...fake.agents,
      resume: async () => { throw new Error('no agent factory registered (load an agent-loop plugin)') },
    })
    const bridge = new DshSessionBridge(ctx, silentLogger)
    await expect(bridge.resume('previous-session')).rejects.toThrow(/no agent factory registered/)
    expect(fake.created).toHaveLength(0)
  })

  it('propagates a native `turn/end` error instead of faking a successful empty reply', async () => {
    // Real-runtime regression (dsh 0.2.2-rc.1): an LLM 5xx ends the turn with
    // data.reason = { kind:'error', error:{ message, code } } and NO
    // assistant/message. Treating it as success silently marked the message
    // `done` and kept the Session bound.
    const { ctx, bridge } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.submit('session-1', 'hi', new AbortController().signal)
    const waiting = bridge.waitForReply('session-1', { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { message: '500: upstream failure', code: 'SERVER' } } },
    })
    await expect(waiting).rejects.toThrow(/native DSH Agent turn failed \(error: 500: upstream failure\)/)
  })

  it('exposes the Profile default route without inventing a fallback', async () => {
    const { ctx, bridge } = setup()
    expect(bridge.defaultModel()).toBeUndefined()
    ctx.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'magpie', model: 'group/deepseek', reasoningEffort: 'high' }),
    })
    expect(bridge.defaultModel()).toEqual({
      provider: 'magpie', model: 'group/deepseek', reasoningEffort: 'high',
    })
  })

  it('carries tool counters on a native turn failure so the Gateway can decide on fallback safely', async () => {
    const { ctx, bridge } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.submit('session-1', 'hi', new AbortController().signal)
    const waiting = bridge.waitForReply('session-1', { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: '{}' },
    })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { message: '429 rate limited', code: 'RATE_LIMIT' } } },
    })
    const error = await waiting.catch((value: unknown) => value)
    expect(error).toBeInstanceOf(SessionTurnFailure)
    expect((error as SessionTurnFailure).toolCalls).toBe(1)
    expect((error as SessionTurnFailure).failure).toBe('error: 429 rate limited')
  })

  it('accepts a `turn/end` with reason.kind completed', async () => {
    const { ctx, bridge } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.submit('session-1', 'hi', new AbortController().signal)
    const waiting = bridge.waitForReply('session-1', { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'ok' }] } },
    })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(await waiting).toMatchObject({ text: 'ok', reason: 'idle' })
  })

  it('does not treat a user-aborted `turn/end` as an Agent failure', async () => {
    const { ctx, bridge } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.submit('session-1', 'hi', new AbortController().signal)
    const waiting = bridge.waitForReply('session-1', { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'turn/end', data: { reason: { kind: 'aborted', cause: 'user' } },
    })
    expect(await waiting).toMatchObject({ text: '', reason: 'idle' })
  })

  it('isolates the next turn after a native Agent error (turn state is cleared)', async () => {
    const { ctx, bridge } = setup()
    await bridge.create('session-1', '/workspace')
    await bridge.submit('session-1', 'hi', new AbortController().signal)
    const failed = bridge.waitForReply('session-1', { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } },
    })
    await expect(failed).rejects.toThrow(/boom/)
    // The failed turn must not poison the next one on the same Session.
    await bridge.submit('session-1', 'again', new AbortController().signal)
    const next = bridge.waitForReply('session-1', { timeoutMs: 1000, signal: new AbortController().signal })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'fresh' }] } },
    })
    ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(await next).toMatchObject({ text: 'fresh' })
  })

})

describe('abandoned native handles', () => {
  it('retires a cancelled Session without affecting a later healthy Session', async () => {
    const { bridge, fake } = setup()
    await bridge.create('timed-out', '/workspace')
    await bridge.create('healthy', '/workspace')
    bridge.cancel('timed-out')
    await bridge.retire('timed-out')
    expect(fake.disposed).toHaveLength(1)
    await bridge.submit('healthy', 'still alive', new AbortController().signal)
    expect(fake.followups).toHaveLength(1)
    await bridge.dispose()
    expect(fake.disposed).toHaveLength(2)
  })
})

describe('DSH native Session compaction port', () => {
  it('uses the existing compaction service rather than generating a new assistant turn', async () => {
    const { ctx, bridge, fake } = setup()
    expect(bridge.compactionStatus('feishu-default-compact').available).toBe(false)
    const calls: Array<{ agent: unknown; signal: AbortSignal }> = []
    ctx.services.set('compaction', {
      async compactNow(agent: unknown, signal: AbortSignal) {
        calls.push({ agent, signal })
        return { shadowedSeqs: [1,2,3], shadowedTokenCount: 1200,
          summary: [{ type: 'text', text: 'PRIVATE SUMMARY NOT FOR FEISHU' }] }
      }
    })
    await bridge.create('feishu-default-compact', '/tmp')
    const signal = new AbortController().signal
    const result = await bridge.compactNow('feishu-default-compact', signal)
    expect(result).toEqual({outcome:'compacted',shadowedItems:3,shadowedTokens:1200})
    expect(calls).toHaveLength(1)
    expect(calls[0]?.signal).toBe(signal)
    expect(fake.followups).toHaveLength(0)
    await bridge.dispose()
  })

  it('observes only completed native compactions without copying summary text', async () => {
    const {ctx,bridge} = setup()
    ctx.services.set('compaction', { compactNow: async () => null })
    await bridge.create('feishu-summary-a', '/tmp')
    await bridge.create('feishu-summary-b', '/tmp')
    ctx.emit('session/event',{id:'feishu-summary-a'},{type:'compaction/summary',
      data:{compactionId:'test-1',shadowedSeqs:[9,10,11],shadowedTokenCount:600,
        summary:[{type:'text',text:'PRIVATE STUFF'}]}})
    expect(bridge.compactionStatus('feishu-summary-a').completedInProcess).toBe(0)
    ctx.emit('session/event',{id:'feishu-summary-a'},{type:'compaction/end',
      data:{compactionId:'test-1',turn:1}})
    expect(bridge.compactionStatus('feishu-summary-a')).toMatchObject({
      available:true,completedInProcess:1,lastShadowedItems:3,lastShadowedTokens:600
    })
    expect(bridge.compactionStatus('feishu-summary-a').lastCompletedAt).toBeGreaterThan(0)
    ctx.emit('session/event',{id:'feishu-summary-a'},{type:'compaction/end',
      data:{compactionId:'test-1',turn:1}})
    ctx.emit('session/event',{id:'feishu-summary-b'},{type:'compaction/summary',
      data:{compactionId:'test-2',shadowedSeqs:[15,16],shadowedTokenCount:400,
        summary:[{type:'text',text:'PRIVATE B'}]}})
    ctx.emit('session/event',{id:'feishu-summary-b'},{type:'compaction/end',
      data:{compactionId:'test-2',turn:1,error:'summary failed'}})
    expect(bridge.compactionStatus().completedInProcess).toBe(1)
    expect(JSON.stringify(bridge.compactionStatus())).not.toContain('PRIVATE')
    await bridge.dispose()
  })

  it('handles no compactable content and missing native engine without inventing a substitute summary', async () => {
    const {ctx,bridge,fake}=setup()
    await bridge.create('feishu-default-short', '/tmp')
    await expect(bridge.compactNow('feishu-default-short',new AbortController().signal))
      .rejects.toThrow('unavailable')
    ctx.services.set('compaction',{compactNow: async () => null})
    await expect(bridge.compactNow('feishu-default-short',new AbortController().signal))
      .resolves.toEqual({outcome:'nothing-to-compact'})
    expect(fake.followups).toHaveLength(0)
    await bridge.dispose()
  })
})
