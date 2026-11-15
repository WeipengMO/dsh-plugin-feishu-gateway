import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  patched: [] as Array<{ data: unknown; path: unknown }>,
  requests: [] as Array<{ method: string; url: string; data: Record<string, unknown> }>,
  handlers: {} as Record<string, (event: unknown) => unknown>,
  /** Constructor params of every WSClient (proxy agent inspection). */
  wsParams: [] as Array<Record<string, unknown>>,
  /** URLs passed to the mocked HttpsProxyAgent factory. */
  proxyAgentCalls: [] as string[],
  failCreate: false,
  /** Simulate a misconfigured bot: `start()` resolves but onReady never fires. */
  suppressReady: false,
}))

// https-proxy-agent@5 is a CommonJS factory; mock it so tests never build a
// real agent and can assert exactly which URL the transport selected.
vi.mock('https-proxy-agent', () => ({
  __esModule: true,
  default: (url: string) => {
    sdkState.proxyAgentCalls.push(url)
    return { mockedAgentFor: url }
  },
}))

vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {
    im = {
      message: {
        patch: async (payload: { data: unknown; path: unknown }) => {
          sdkState.patched.push(payload)
          return { code: 0 }
        },
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
    async request(payload: { method: string; url: string; data: Record<string, unknown> }) {
      sdkState.requests.push(payload)
      if (payload.method === 'GET' && payload.url === '/open-apis/bot/v3/info')
         return { code: 0, bot: { open_id: 'ou_this_bot' } }
       if (payload.method === 'POST' && payload.url === '/open-apis/cardkit/v1/cards')
        return { code: 0, data: { card_id: 'card123' } }
      return { code: 0 }
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
    constructor(public params: Record<string, unknown>) {
      sdkState.wsParams.push(params)
    }
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
type NetworkProxyConfig = import('../../src/types.js').NetworkProxyConfig
type GatewayLogger = import('../../src/types.js').GatewayLogger

function transport(
  domain: 'feishu' | 'lark' = 'feishu',
  networkProxy?: NetworkProxyConfig,
  logger: GatewayLogger = silentLogger,
) {
  return new LarkTransport(
    'default',
    { appId: 'cli_0123456789abcdef', appSecret: 'secret', domain },
    logger,
    networkProxy,
  )
}

/** Recording logger for assertions on warning messages. */
function recordingLogger() {
  const warnings: string[] = []
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string, ...args: unknown[]) => { warnings.push([message, ...args].join(' ')) },
      error: () => {},
    },
  }
}

const savedEnv: Array<[string, string | undefined]> = []
function setEnv(key: string, value: string | undefined): void {
  savedEnv.push([key, process.env[key]])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
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
  sdkState.patched.length = 0
  sdkState.requests.length = 0
  sdkState.wsParams.length = 0
  sdkState.proxyAgentCalls.length = 0
  sdkState.failCreate = false
  sdkState.suppressReady = false
  for (const key of Object.keys(sdkState.handlers)) delete sdkState.handlers[key]
})

afterEach(() => {
  for (const [key, value] of savedEnv.splice(0)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
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
    expect(received).toEqual([])
    await sdkState.handlers['im.message.receive_v1']!(rawEvent({
      sender: { sender_id: { user_id: 'id_only' }, sender_type: 'user' },
    }))
    expect(received).toHaveLength(0)
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

describe('Feishu native CardKit and signed WS callback contract (mock SDK)', () => {
  it('accepts the official v2 callback with root-level context and event-scoped operator', async () => {
    const t = transport()
    const received: unknown[] = []
    await t.connect({ onMessage: () => {}, onStateChange: () => {},
      onCardAction: async action => { received.push(action); return { toast: { type: 'success', content: 'ok' } } },
    })
    const value = { namespace: 'dsh-feishu-gateway', kind: 'approval',
      nonce: 'nonce-1', decision: 'allow' }
    const official = {
      schema: '2.0',
      header: { event_type: 'card.action.trigger' },
      event: { operator: { open_id: 'ou_alice' }, action: { tag: 'button', value } },
      host: 'im_message',
      context: { open_chat_id: 'oc_one', open_message_id: 'om_approval_card' },
    }
    const response = await sdkState.handlers['card.action.trigger']!(official)
    expect(response).toEqual({ toast: { type: 'success', content: 'ok' } })
    expect(received).toEqual([{ botId: 'default', actorOpenId: 'ou_alice',
      chatId: 'oc_one', messageId: 'om_approval_card', value }])
  })

  it('registers card.action.trigger and validates callback principal fields', async () => {
    const t = transport()
    const received: unknown[] = []
    await t.connect({ onMessage: () => {}, onStateChange: () => {},
      onCardAction: async event => { received.push(event); return { toast: { type: 'success', content: 'ok' } } },
    })
    const handler = sdkState.handlers['card.action.trigger']!
    expect(typeof handler).toBe('function')
    const payload = {
      event: { operator: { open_id: 'ou_alice' },
        context: { open_chat_id: 'oc_one', open_message_id: 'om_card' },
        action: { value: { namespace: 'dsh-feishu-gateway', kind: 'approval', nonce: 'x', decision: 'allow' } },
      },
    }
    expect(await handler(payload)).toEqual({ toast: { type: 'success', content: 'ok' } })
    expect(received).toEqual([{ botId: 'default', actorOpenId: 'ou_alice',
      chatId: 'oc_one', messageId: 'om_card', value: payload.event.action.value }])
    const anonymous = await handler({ event: { ...payload.event, operator: { user_id: 'not-an-open-id' } } })
    expect(anonymous).toEqual({ toast: { type: 'warning', content: '无法验证此卡片操作' } })
    expect(received).toHaveLength(1)
  })

  it('sends and updates an interactive approval card via standard IM v1 APIs', async () => {
    const t = transport()
    await t.connect({ onMessage: () => {}, onStateChange: () => {} })
    const card = { schema: '2.0', body: { elements: [] } }
    const handle = await t.sendInteractiveCard({ replyToMessageId: 'om_1' }, card)
    expect(handle.messageId).toBe('om_replied')
    const reply = sdkState.replied[0]!.data as { msg_type: string; content: string }
    expect(reply.msg_type).toBe('interactive')
    expect(JSON.parse(reply.content)).toEqual(card)
    await t.updateInteractiveCard(handle.messageId, card)
    expect(sdkState.patched[0]?.path).toEqual({ message_id: 'om_replied' })
  })

  it('uses CardKit v1: create -> send by card_id -> ordered content -> settings', async () => {
    const t = transport()
    await t.connect({ onMessage: () => {}, onStateChange: () => {} })
    const handle = await t.startStreamCard({ replyToMessageId: 'om_1' }, 'nonce')
    expect(handle).toEqual({ cardId: 'card123', messageId: 'om_replied' })
    const cardReq = sdkState.requests.find(x => x.url === '/open-apis/cardkit/v1/cards')!
    expect(cardReq.url).toBe('/open-apis/cardkit/v1/cards')
    const createdCard = JSON.parse(cardReq.data.data as string)
    expect(createdCard.config.streaming_mode).toBe(true)
    expect(createdCard.body.elements[0].element_id).toBe('task_progress')
    expect(JSON.parse((sdkState.replied[0]!.data as { content: string }).content))
      .toEqual({ type: 'card', data: { card_id: 'card123' } })
    await t.updateStreamCard(handle.cardId!, 'hello', 1)
    await t.finishStreamCard(handle.cardId!, 2)
    const cardRequests = sdkState.requests.filter(x => x.url !== '/open-apis/bot/v3/info')
    expect(cardRequests.map(x => x.method)).toEqual(['POST', 'PUT', 'PATCH'])
    expect(cardRequests[1]?.url).toBe('/open-apis/cardkit/v1/cards/card123/elements/task_progress/content')
    expect(cardRequests[1]?.data).toMatchObject({ content: 'hello', sequence: 1 })
    expect(cardRequests[2]?.url).toBe('/open-apis/cardkit/v1/cards/card123/settings')
    expect(JSON.parse(cardRequests[2]?.data.settings as string).config.streaming_mode).toBe(false)
    expect(cardRequests[2]?.data.sequence).toBe(2)
  })

  it('uses the official full CardKit entity update to remove terminal actions', async () => {
    const t = transport()
    await t.connect({ onMessage: () => {}, onStateChange: () => {} })
    const result = {
      schema: '2.0',
      config: { update_multi: true, streaming_mode: false },
      header: { title: { tag: 'plain_text', content: '已完成' } },
      body: { elements: [{ tag: 'markdown', content: 'answer' }] },
    }
    await t.replaceStreamCard('card123', result, 3)
    const operation = sdkState.requests.find(x => x.url === '/open-apis/cardkit/v1/cards/card123')!
    expect(operation.method).toBe('PUT')
    expect(operation.url).toBe('/open-apis/cardkit/v1/cards/card123')
    expect(operation.data.sequence).toBe(3)
    expect(operation.data.uuid).toEqual(expect.any(String))
    expect(JSON.parse((operation.data.card as { data: string }).data)).toEqual(result)
  })

  it('returns a safe toast instead of bubbling a callback handler error', async () => {
    const t = transport()
    await t.connect({ onMessage: () => {}, onStateChange: () => {},
      onCardAction: async () => { throw new Error('secret_from_internal_handler') },
    })
    const payload = { operator: { open_id: 'ou_alice' },
      context: { open_chat_id: 'oc_one', open_message_id: 'om_approval' },
      action: { value: { kind: 'approval', nonce: 'nonce' } } }
    const response = await sdkState.handlers['card.action.trigger']!(payload) as object
    expect(JSON.stringify(response)).not.toContain('secret_from_internal_handler')
  })
})

describe('network proxy selection (SDK mocked, no real connection)', () => {
  const proxyConfig = (url?: string, overrides: Partial<NetworkProxyConfig> = {}): NetworkProxyConfig => ({
    enabled: true,
    urlEnv: 'FEISHU_TEST_PROXY_URL',
    fallbackDirect: true,
    ...(url ? { url } : {}),
    ...overrides,
  })
  const connect = (t: InstanceType<typeof LarkTransport>) =>
    t.connect({ onMessage: () => {}, onStateChange: () => {} })

  it('builds the agent from the env var when the launcher selected a proxy', async () => {
    setEnv('FEISHU_TEST_PROXY_URL', 'http://env-proxy:3128')
    setEnv('FEISHU_GATEWAY_PROXY_SELECTED', 'proxy')
    const t = transport('feishu', proxyConfig())
    await connect(t)
    expect(sdkState.proxyAgentCalls).toEqual(['http://env-proxy:3128'])
    expect(sdkState.wsParams[0]?.agent).toEqual({ mockedAgentFor: 'http://env-proxy:3128' })
    expect(t.state).toBe('connected')
  })

  it('prefers the in-memory managed URL over the env var', async () => {
    setEnv('FEISHU_TEST_PROXY_URL', 'http://env-proxy:3128')
    setEnv('FEISHU_GATEWAY_PROXY_SELECTED', 'proxy')
    await connect(transport('feishu', proxyConfig('http://managed-proxy:2080')))
    expect(sdkState.proxyAgentCalls).toEqual(['http://managed-proxy:2080'])
    expect(sdkState.wsParams[0]?.agent).toEqual({ mockedAgentFor: 'http://managed-proxy:2080' })
  })

  it('uses the proxy even when no launcher marker is present (standalone plugin)', async () => {
    setEnv('FEISHU_TEST_PROXY_URL', 'http://env-proxy:3128')
    setEnv('FEISHU_GATEWAY_PROXY_SELECTED', undefined)
    await connect(transport('feishu', proxyConfig()))
    expect(sdkState.proxyAgentCalls).toEqual(['http://env-proxy:3128'])
  })

  it('never uses a proxy when the launcher fell back to a direct connection', async () => {
    setEnv('FEISHU_TEST_PROXY_URL', 'http://env-proxy:3128')
    setEnv('FEISHU_GATEWAY_PROXY_SELECTED', 'direct')
    await connect(transport('feishu', proxyConfig()))
    expect(sdkState.proxyAgentCalls).toEqual([])
    expect(sdkState.wsParams[0]).not.toHaveProperty('agent')
  })

  it('never uses a proxy when the feature is disabled', async () => {
    setEnv('FEISHU_TEST_PROXY_URL', 'http://env-proxy:3128')
    setEnv('FEISHU_GATEWAY_PROXY_SELECTED', 'proxy')
    await connect(transport('feishu', proxyConfig(undefined, { enabled: false })))
    expect(sdkState.proxyAgentCalls).toEqual([])
    expect(sdkState.wsParams[0]).not.toHaveProperty('agent')
  })

  it('connects directly when no URL is configured at all', async () => {
    setEnv('FEISHU_TEST_PROXY_URL', undefined)
    setEnv('FEISHU_GATEWAY_PROXY_SELECTED', 'proxy')
    await connect(transport('feishu', proxyConfig()))
    expect(sdkState.proxyAgentCalls).toEqual([])
    expect(sdkState.wsParams[0]).not.toHaveProperty('agent')
  })

  it('falls back to a direct connection and warns without leaking the URL', async () => {
    setEnv('FEISHU_TEST_PROXY_URL', 'user:pass@not-a-valid-proxy')
    setEnv('FEISHU_GATEWAY_PROXY_SELECTED', 'proxy')
    const recorder = recordingLogger()
    const t = transport('feishu', proxyConfig(), recorder.logger)
    await connect(t)
    expect(sdkState.proxyAgentCalls).toEqual([])
    expect(sdkState.wsParams[0]).not.toHaveProperty('agent')
    expect(t.state).toBe('connected')
    expect(recorder.warnings).toHaveLength(1)
    expect(recorder.warnings[0]).toMatch(/direct connection/)
    expect(recorder.warnings[0]).not.toContain('not-a-valid-proxy')
    expect(recorder.warnings[0]).not.toContain('pass')
  })
})

describe('group mention identity', () => {
  it('accepts only this bots structured @mention and strips its placeholder', async () => {
    const t = transport()
    const received: Array<{ mentionedBot?: boolean; text: string; threadId?: string }> = []
    await t.connect({ onMessage: msg => { received.push(msg) }, onStateChange: () => {} })
    await sdkState.handlers['im.message.receive_v1']!(rawEvent({ message: {
      ...rawEvent().message, chat_type: 'group',
      content: JSON.stringify({ text: '@_user_1 test @_user_2' }),
      mentions: [
        { key: '@_user_1', mentioned_type: 'bot', id: { open_id: 'ou_this_bot' } },
        { key: '@_user_2', mentioned_type: 'user', id: { open_id: 'ou_other' } },
      ], thread_id: 'omt_topic_1',
    } }))
    expect(received[0]).toMatchObject({ mentionedBot: true,
      text: 'test @_user_2', threadId: 'omt_topic_1' })
    await sdkState.handlers['im.message.receive_v1']!(rawEvent({ message: {
      ...rawEvent().message, chat_type: 'group',
      content: JSON.stringify({ text: '@_user_1 hi' }),
      mentions: [{ key: '@_user_1', mentioned_type: 'bot', id: { open_id: 'ou_wrong_bot' } }],
    } }))
    expect(received[1]).toMatchObject({ mentionedBot: false, text: '@_user_1 hi' })
    await t.close()
  })
})
