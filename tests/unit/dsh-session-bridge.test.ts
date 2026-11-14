import { describe, expect, it } from 'vitest'
import { DshSessionBridge } from '../../src/session/dsh-session-bridge.js'
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

  const agents = {
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

  it('re-hydrates a Session from persistence on every resume, even with a cached handle', async () => {
    // Real-runtime regression: reusing a live handle after a completed turn
    // fails with "cannot append outside a SessionStore".
    const { bridge, fake } = setup()
    await bridge.create('session-1', '/workspace')
    expect(fake.resumed).toHaveLength(0)
    await bridge.resume('session-1')
    expect(fake.resumed).toEqual([{ resumeSessionId: 'session-1' }])
    expect(fake.disposed).toHaveLength(1)
    await bridge.resume('session-1')
    expect(fake.resumed).toHaveLength(2)
    expect(fake.disposed).toHaveLength(2)
  })

})
