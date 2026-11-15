import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appIdLooksValid } from '../../src/config.js'

/**
 * The real `@larksuiteoapi/node-sdk` is replaced by an in-memory double, so we
 * can verify the adapter's wiring (WSClient / EventDispatcher / im.message.*)
 * without credentials or a network connection. No real Feishu call is made.
 */
const sdkState = vi.hoisted(() => ({
  started: [] as Array<{ eventDispatcher: unknown }>,
  closed: 0,
  created: [] as Array<{ params: unknown; data: unknown }>,
  replied: [] as Array<{ data: unknown; path: unknown }>,
  handlers: {} as Record<string, (event: unknown) => unknown>,
  failCreate: false,
  /** Simulate a misconfigured bot: `start()` resolves but onReady never fires. */
  suppressReady: false,
}))

vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {
    im = {
      message: {
        create: async (payload: { params: unknown; data: unknown }) => {
          sdkState.created.push(payload)
          if (sdkState.failCreate) return { code: 99999, msg: 'simulated failure' }
          return { code: 0, data: { message_id: 'om_created' } }
        },
        reply: async (payload: { data: unknown; path: unknown }) => {
          sdkState.replied.push(payload)
          return { code: 0, data: { message_id: 'om_replied' } }
        },
      },
    }
    constructor(_params: unknown) {}
  }
  class EventDispatcher {
    register(handles: Record<string, (event: unknown) => unknown>) {
      Object.assign(sdkState.handlers, handles)
      return this
    }
    constructor(_params: unknown) {}
  }
  class WSClient {
    constructor(public params: Record<string, unknown>) {}
    async start(params: { eventDispatcher: unknown }) {
      sdkState.started.push(params)
      if (!sdkState.suppressReady) (this.params.onReady as (() => void) | undefined)?.()
    }
    close() {
      sdkState.closed += 1
    }
  }
  return { Client, EventDispatcher, WSClient, Domain: { Feishu: 0, Lark: 1 } }
})

const { LarkTransport } = await import('../../src/channel/lark-transport.js')
const { silentLogger } = await import('../../src/util/logger.js')

function transport(domain: 'feishu' | 'lark' = 'feishu') {
  return new LarkTransport(
    'default',
    { appId: 'cli_0123456789abcdef', appSecret: 'secret', domain },
    silentLogger,
  )
}

const rawEvent = (overrides: Record<string, unknown> = {}) => ({
  sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
  message: {
    message_id: 'om_1',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: 'hello' }),
    create_time: '1000',
  },
  create_time: '1000',
  ...overrides,
})

beforeEach(() => {
  sdkState.started.length = 0
  sdkState.closed = 0
  sdkState.created.length = 0
  sdkState.replied.length = 0
  sdkState.failCreate = false
  sdkState.suppressReady = false
  for (const key of Object.keys(sdkState.handlers)) delete sdkState.handlers[key]
})

describe('appIdLooksValid', () => {
  it('accepts a self-built app id and rejects lookalikes', () => {
    expect(appIdLooksValid('cli_0123456789abcdef')).toBe(true)
    expect(appIdLooksValid('cli_0123456789ABCDEF')).toBe(true)
    expect(appIdLooksValid('cli_short')).toBe(false)
    expect(appIdLooksValid('app_0123456789abcdef')).toBe(false)
  })
})

describe('LarkTransport (SDK mocked)', () => {
  it('starts with state idle and refuses to send before connecting', async () => {
    const t = transport()
    expect(t.state).toBe('idle')
    await expect(t.sendText({ chatId: 'oc_1', text: 'hi' })).rejects.toThrow('not connected')
  })

  it('connects a WSClient with an EventDispatcher and reports connected', async () => {
    const t = transport()
    const states: string[] = []
    await t.connect({ onMessage: () => {}, onStateChange: (s) => states.push(s) })
    expect(sdkState.started).toHaveLength(1)
    expect(typeof sdkState.handlers['im.message.receive_v1']).toBe('function')
    expect(t.state).toBe('connected')
    expect(states).toContain('connected')
  })

  it('normalizes im.message.receive_v1 into an InboundMessage', async () => {
    const t = transport()
    const received: unknown[] = []
    await t.connect({ onMessage: (m) => { received.push(m) }, onStateChange: () => {} })
    sdkState.handlers['im.message.receive_v1']!(rawEvent())
    expect(received).toEqual([expect.objectContaining({
      messageId: 'om_1',
      botId: 'default',
      chatId: 'oc_1',
      chatType: 'p2p',
      senderId: 'ou_alice',
      text: 'hello',
      messageType: 'text',
    })])
  })

  it('drops bot-originated messages to avoid echo loops', async () => {
    const t = transport()
    const received: unknown[] = []
    await t.connect({ onMessage: (m) => { received.push(m) }, onStateChange: () => {} })
    sdkState.handlers['im.message.receive_v1']!(rawEvent({
      sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'app' },
    }))
    expect(received).toHaveLength(0)
  })

  it('prefers reply over create when a replyToMessageId is present', async () => {
    const t = transport()
    await t.connect({ onMessage: () => {}, onStateChange: () => {} })
    const receipt = await t.sendText({ replyToMessageId: 'om_1', text: 'answer' })
    expect(receipt.messageId).toBe('om_replied')
    expect(sdkState.replied[0]?.data).toEqual({ content: JSON.stringify({ text: 'answer' }), msg_type: 'text', uuid: expect.any(String) })
    expect(sdkState.created).toHaveLength(0)
  })

  it('uses the official post/md structure for Markdown replies and reuses UUID', async () => {
    const t = transport()
    await t.connect({ onMessage: () => {}, onStateChange: () => {} })
    await t.sendText({ replyToMessageId: 'om_md', text: '**bold**\n\n\`\`\`ts\nconst x = 1\n\`\`\`',
      format: 'markdown', uuid: 'STABLE-MARKDOWN-UUID' })
    const data = sdkState.replied[0]?.data as { content: string; msg_type: string; uuid: string }
    expect(data.msg_type).toBe('post')
    expect(data.uuid).toBe('STABLE-MARKDOWN-UUID')
    const post = JSON.parse(data.content)
    expect(post.zh_cn.content[0][0]).toMatchObject({ tag: 'md', text: expect.stringContaining('**bold**') })
    await t.sendText({ chatId: 'oc_md', text: '# Header', format: 'markdown' })
    const created = sdkState.created[0]?.data as { content: string; msg_type: string }
    expect(created.msg_type).toBe('post')
    expect(JSON.parse(created.content).zh_cn.content[0][0].tag).toBe('md')
  })

  it('extracts text-only Feishu rich post events without losing content', async () => {
    const t = transport()
    const received: unknown[] = []
    await t.connect({ onMessage: m => { received.push(m) }, onStateChange: () => {} })
    await sdkState.handlers['im.message.receive_v1']!(rawEvent({ message: {
      ...(rawEvent().message as object), message_type: 'post',
      content: JSON.stringify({ zh_cn: { content: [
        [{ tag: 'text', text: '阅读' }, { tag: 'a', text: '论文', href: 'https://example.org' }],
      ] } }),
    } }))
    expect(received).toEqual([expect.objectContaining({
      messageType: 'post', text: '阅读[论文](https://example.org)',
    })])
  })

  it('sends via create with chat_id when there is no reply target', async () => {
    const t = transport()
    await t.connect({ onMessage: () => {}, onStateChange: () => {} })
    const receipt = await t.sendText({ chatId: 'oc_1', text: 'answer' })
    expect(receipt.messageId).toBe('om_created')
    expect(sdkState.created[0]?.params).toEqual({ receive_id_type: 'chat_id' })
    expect(sdkState.created[0]?.data).toMatchObject({ receive_id: 'oc_1', msg_type: 'text' })
  })

  it('rejects a send without any target and surfaces SDK error codes', async () => {
    const t = transport()
    await t.connect({ onMessage: () => {}, onStateChange: () => {} })
    await expect(t.sendText({ text: 'answer' })).rejects.toThrow('requires replyToMessageId or chatId')
    sdkState.failCreate = true
    await expect(t.sendText({ chatId: 'oc_1', text: 'answer' })).rejects.toThrow('code=99999')
  })

  it('supports the lark domain and closes the WS with force', async () => {
    const t = transport('lark')
    await t.connect({ onMessage: () => {}, onStateChange: () => {} })
    await t.close()
    expect(sdkState.closed).toBe(1)
    expect(t.state).toBe('closed')
  })
  it('propagates asynchronous admission errors instead of ACKing a lost event', async () => {
    const t = transport()
    await t.connect({ onMessage: async () => { throw new Error('disk full') }, onStateChange: () => {} })
    await expect(sdkState.handlers['im.message.receive_v1']!(rawEvent())).rejects.toThrow('disk full')
  })

  it('fails closed for an ambiguous chat type or a missing open_id', async () => {
    const t = transport()
    const received: unknown[] = []
    await t.connect({ onMessage: (m) => { received.push(m) }, onStateChange: () => {} })
    await sdkState.handlers['im.message.receive_v1']!(rawEvent({
      message: { ...rawEvent().message, chat_type: 'unknown' },
    }))
    expect(received).toEqual([expect.objectContaining({ chatType: 'group' })])
    await sdkState.handlers['im.message.receive_v1']!(rawEvent({
      sender: { sender_id: { user_id: 'id_only' }, sender_type: 'user' },
    }))
    expect(received).toHaveLength(1)
  })

  it('reuses the persisted REST UUID on the create path across retries', async () => {
    // Regression: `create` used to mint a fresh uuid on every attempt, so
    // Feishu server-side idempotency could never dedupe a retried send.
    const t = transport()
    await t.connect({ onMessage: () => {}, onStateChange: () => {} })
    sdkState.failCreate = true
    await expect(t.sendText({ chatId: 'oc_1', text: 'answer', uuid: 'FIXED-UUID' })).rejects.toThrow('code=99999')
    sdkState.failCreate = false
    await t.sendText({ chatId: 'oc_1', text: 'answer', uuid: 'FIXED-UUID' })
    expect(sdkState.created).toHaveLength(2)
    expect(sdkState.created.map((c) => (c.data as { uuid?: string }).uuid)).toEqual(['FIXED-UUID', 'FIXED-UUID'])
  })

  it('does not report connected when the WS never becomes ready', async () => {
    // A bad appId makes WSClient.start() resolve silently without onReady.
    // Marking it `connected` would hide the failure from health().
    sdkState.suppressReady = true
    const t = transport()
    const states: string[] = []
    await t.connect({ onMessage: () => {}, onStateChange: (s) => states.push(s) })
    expect(t.state).toBe('connecting')
    expect(states).not.toContain('connected')
  })

})
