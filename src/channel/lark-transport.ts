import { appIdLooksValid } from '../config.js'
// https-proxy-agent >= 9 exposes a named ESM constructor.
import { HttpsProxyAgent } from 'https-proxy-agent'
import { DEFAULT_PROXY_URL_ENV, validateProxyUrl } from '../util/proxy-url.js'
import type {
  BotCredentials,
  CardActionEvent,
  FeishuCardHandle,
  FeishuEventHandlers,
  FeishuTransport,
  GatewayLogger,
  InboundMessage,
  NetworkProxyConfig,
  OutboundTarget,
  SendReceipt,
  TransportState,
} from '../types.js'
import { newId } from '../util/id.js'
import { extractFeishuPostText, feishuMarkdownContent } from './post-content.js'
import { progressCard, PROGRESS_ELEMENT_ID } from './card-content.js'

/** Official SDK, imported lazily so the module stays loadable in offline tests. */
const LARK_MODULE = '@larksuiteoapi/node-sdk'

interface LarkMessageApiResult {
  readonly code?: number
  readonly msg?: string
  readonly data?: { readonly message_id?: string; readonly card_id?: string }
  readonly bot?: { readonly open_id?: string }
}

interface LarkClientLike {
  readonly im: {
    readonly message: {
      patch(payload: { data: { content: string }; path: { message_id: string } }): Promise<LarkMessageApiResult>
      create(payload: {
        data: { receive_id: string; msg_type: string; content: string; uuid?: string }
        params: { receive_id_type: string }
      }): Promise<LarkMessageApiResult>
      reply(payload: {
        data: { content: string; msg_type: string; uuid?: string }
        path: { message_id: string }
      }): Promise<LarkMessageApiResult>
    }
  }
  request(payload: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH'
    url: string
    data: Record<string, unknown>
  }): Promise<LarkMessageApiResult>
}

interface LarkWsLike {
  start(params: { eventDispatcher: unknown }): Promise<void>
  close(params?: { force?: boolean }): void
}

interface LarkModuleLike {
  Client: new (params: Record<string, unknown>) => LarkClientLike
  EventDispatcher: new (params: Record<string, unknown>) => {
    register(handles: Record<string, unknown>): unknown
  }
  WSClient: new (params: Record<string, unknown>) => LarkWsLike
  Domain: { Feishu: number; Lark: number }
}

interface RawCardActionEvent {
  readonly event?: {
    readonly operator?: { readonly open_id?: string }
    readonly context?: { readonly open_chat_id?: string; readonly open_message_id?: string }
    readonly action?: { readonly value?: unknown }
  }
  readonly operator?: { readonly open_id?: string }
  readonly context?: { readonly open_chat_id?: string; readonly open_message_id?: string }
  readonly action?: { readonly value?: unknown }
}

interface RawReceiveEvent {
  readonly sender?: {
    readonly sender_id?: { readonly open_id?: string; readonly user_id?: string; readonly union_id?: string }
    readonly sender_type?: string
  }
  readonly message?: {
    readonly message_id?: string
    readonly chat_id?: string
    readonly chat_type?: string
    readonly message_type?: string
    readonly content?: string
    readonly create_time?: string
    readonly thread_id?: string
    readonly root_id?: string
    readonly mentions?: readonly { readonly key?: string; readonly id?: { readonly open_id?: string }; readonly mentioned_type?: string }[]
  }
  readonly create_time?: string
}

/**
 * One bot == one `WSClient` long connection + one REST `Client`.
 *
 * Uses only public `@larksuiteoapi/node-sdk` APIs: `WSClient.start({eventDispatcher})`,
 * `EventDispatcher.register({'im.message.receive_v1': handler})`,
 * `client.im.message.reply/create`, `WSClient.close`.
 */
export class LarkTransport implements FeishuTransport {
  private stateValue: TransportState = 'idle'
  private client: LarkClientLike | undefined
  private readonly nameCache = new Map<string, { value?: string; until: number }>()
  private ws: LarkWsLike | undefined
  private handlers: FeishuEventHandlers | undefined
  private botOpenId: string | undefined
  private stopped = false
  private wsGeneration = 0
  private initialFailures = 0
  private everConnected = false
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  private async lookupDisplayName(
    key: string, url: string, pick: (response: LarkMessageApiResult) => unknown,
  ): Promise<string | undefined> {
    const now = Date.now()
    const cached = this.nameCache.get(key)
    if (cached && cached.until > now) return cached.value
    if (!this.client) return undefined
    let value: string | undefined
    try {
      // A rejected API permission must never stop a Session from being created.
      const response = await Promise.race([
        this.client.request({ method: 'GET', url, data: {} }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('name lookup timeout')), 2000)
          timer.unref?.()
        }),
      ])
      const name = (response.code === undefined || response.code === 0) ? pick(response) : undefined
      if (typeof name === 'string' && name.trim()) value = name.trim().slice(0, 100)
    } catch { /* optional Feishu contact/chat read scope */ }
    this.nameCache.set(key, { value, until: now + (value ? 3600_000 : 60_000) })
    if (this.nameCache.size > 512) this.nameCache.delete(this.nameCache.keys().next().value!)
    return value
  }

  async lookupChatName(chatId: string): Promise<string | undefined> {
    if (!/^oc_[A-Za-z0-9_-]{2,128}$/.test(chatId)) return undefined
    return this.lookupDisplayName('chat:' + chatId,
      '/open-apis/im/v1/chats/' + encodeURIComponent(chatId),
      response => (response.data as { name?: unknown } | undefined)?.name)
  }

  async lookupUserName(openId: string): Promise<string | undefined> {
    if (!/^ou_[A-Za-z0-9_-]{2,128}$/.test(openId)) return undefined
    return this.lookupDisplayName('user:' + openId,
      '/open-apis/contact/v3/users/' + encodeURIComponent(openId) + '?user_id_type=open_id',
      response => (response.data as { user?: { name?: unknown; en_name?: unknown } } | undefined)?.user?.name ??
        (response.data as { user?: { en_name?: unknown } } | undefined)?.user?.en_name)
  }

  private clearStartupTimers(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.handshakeTimer = undefined
    this.retryTimer = undefined
  }

  /** SDK autoReconnect does not guarantee recovery before the first onReady. */
  private retryInitial(generation: number): void {
    if (this.stopped || this.everConnected || generation !== this.wsGeneration || this.retryTimer) return
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    try { this.ws?.close({ force: true }) } catch { /* a broken handshake is expected */ }
    this.ws = undefined
    this.transition('reconnecting')
    this.initialFailures += 1
    const backoff = Math.min(30_000, 1000 * 2 ** Math.min(this.initialFailures - 1, 5))
    const delay = Math.round(backoff * (0.8 + Math.random() * 0.4))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.stopped || !this.handlers) return
      void this.connect(this.handlers).catch(() => this.logger.warn('Feishu initial connection retry failed'))
    }, delay)
    this.retryTimer.unref?.()
  }

  constructor(
    readonly botId: string,
    private readonly credentials: BotCredentials,
    private readonly logger: GatewayLogger,
    private readonly networkProxy?: NetworkProxyConfig,
  ) {}

  get state(): TransportState {
    return this.stateValue
  }

  async connect(handlers: FeishuEventHandlers): Promise<void> {
    this.stopped = false
    this.clearStartupTimers()
    const generation = ++this.wsGeneration
    this.handlers = handlers
    this.stateValue = 'connecting'
    handlers.onStateChange('connecting')

    if (!appIdLooksValid(this.credentials.appId)) {
      this.logger.warn(
        'bot %s app id does not look like a self-built app id (cli_ + 16 hex); long connection may be refused',
        this.botId,
      )
    }
    const mod = (await import(LARK_MODULE)) as unknown as LarkModuleLike
    if (this.stopped || generation !== this.wsGeneration) return
    const domain = this.credentials.domain === 'lark' ? mod.Domain.Lark : mod.Domain.Feishu
    const common = {
      appId: this.credentials.appId,
      appSecret: this.credentials.appSecret,
      domain,
    }

    this.client = new mod.Client(common)
    // Verify @mentions against this bot's own open_id, never against names,
    // arbitrary @users or @all. If identity lookup fails, fail closed.
    this.botOpenId = undefined
    try {
      const info = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info', data: {} })
      if ((info.code === undefined || info.code === 0) && /^ou_[A-Za-z0-9_-]+$/.test(info.bot?.open_id ?? '')) {
        this.botOpenId = info.bot!.open_id
      }
    } catch {
      this.logger.warn('bot %s identity lookup unavailable; mention-only group messages will be denied', this.botId)
    }

    const dispatcher = new mod.EventDispatcher({})
    dispatcher.register({
      'im.message.receive_v1': (event: RawReceiveEvent) => this.handleEvent(event),
      // The official Feishu WS dispatcher handles callbacks (not HTTP webhooks)
      // and expects a toast response within three seconds.
      'card.action.trigger': async (event: RawCardActionEvent) => {
        const value = event.event ?? event
        const data = value.action?.value
        const action = data && typeof data === 'object' && !Array.isArray(data)
          ? data as CardActionEvent['value'] : undefined
        // Feishu Card JSON 2.0 callback: operator/action live in event,
        // but context (chat/message identifiers) lives at the ROOT. Accept
        // both forms because SDK dispatchers may unwrap event for plugins.
        const actorOpenId = value.operator?.open_id ?? event.operator?.open_id
        const chatId = event.context?.open_chat_id ?? value.context?.open_chat_id
        const messageId = event.context?.open_message_id ?? value.context?.open_message_id
        if (!this.handlers?.onCardAction || !actorOpenId || !chatId || !messageId || !action) {
          return { toast: { type: 'warning', content: '无法验证此卡片操作' } }
        }
        try {
          return await this.handlers.onCardAction({
            botId: this.botId, actorOpenId, chatId, messageId, value: action,
          })
        } catch {
          // Never stringify callback or exception: may contain secret values.
          return { toast: { type: 'error', content: '操作失败或已过期' } }
        }
      },
    })

    // The effective proxy is chosen by the launcher preflight and/or the admin
    // UI. It is resolved here as: in-memory resolved URL (managed file) first,
    // then the legacy env var. Never embed proxy URLs in profile config, logs
    // or source. REST uses Axios' HTTPS_PROXY support; WS needs an explicit agent.
    const envName = this.networkProxy?.urlEnv ?? DEFAULT_PROXY_URL_ENV
    const candidate = this.networkProxy?.enabled && process.env.FEISHU_GATEWAY_PROXY_SELECTED !== 'direct'
      ? this.networkProxy?.url ?? process.env[envName]
      : undefined
    let wsAgent: InstanceType<typeof HttpsProxyAgent> | undefined
    if (candidate) {
      try {
        // Modern versions expose a constructor, not the v5 callable factory.
        wsAgent = new HttpsProxyAgent(validateProxyUrl(candidate))
      } catch {
        // Neither the URL nor the parser message may be logged (userinfo!).
        this.logger.warn('bot %s proxy is unusable; continuing with a direct connection', this.botId)
        wsAgent = undefined
      }
    }
    this.ws = new mod.WSClient({
      ...common,
      ...(wsAgent ? { agent: wsAgent } : {}),
      autoReconnect: true,
      onReady: () => {
        if (this.stopped || generation !== this.wsGeneration) return
        this.everConnected = true
        this.initialFailures = 0
        this.clearStartupTimers()
        this.transition('connected')
      },
      onReconnecting: () => {
        if (!this.stopped && generation === this.wsGeneration) this.transition('reconnecting')
      },
      onReconnected: () => {
        if (this.stopped || generation !== this.wsGeneration) return
        this.everConnected = true
        this.initialFailures = 0
        this.clearStartupTimers()
        this.transition('connected')
      },
      onError: (error: Error) => {
        if (this.stopped || generation !== this.wsGeneration) return
        this.logger.warn('websocket error for bot %s (details redacted)', this.botId)
        this.transition('failed', error)
        if (!this.everConnected) this.retryInitial(generation)
      },
    })

    try {
      // WSClient.start() resolves before the handshake completes (and silently
      // no-ops for an invalid appId). Only onReady/onReconnected prove a live
      // connection, so do NOT report `connected` here: a misconfigured bot
      // must stay `connecting`/`failed` instead of being marked healthy.
      await this.ws.start({ eventDispatcher: dispatcher })
      if (!this.stopped && generation === this.wsGeneration && !this.everConnected) {
        this.handshakeTimer = setTimeout(() => {
          if (generation !== this.wsGeneration || this.stopped || this.everConnected) return
          this.logger.warn('bot %s initial handshake deadline exceeded; reconnecting', this.botId)
          this.retryInitial(generation)
        }, 20_000)
        this.handshakeTimer.unref?.()
      }
    } catch {
      if (!this.stopped && generation === this.wsGeneration) {
        this.transition('failed')
        this.retryInitial(generation)
      }
    }
  }

  async close(): Promise<void> {
    this.stopped = true
    ++this.wsGeneration
    this.clearStartupTimers()
    this.stateValue = 'closing'
    this.handlers?.onStateChange('closing')
    try {
      this.ws?.close({ force: true })
    } catch (error) {
      this.logger.warn('websocket close failed for bot %s: %s', this.botId, String(error))
    }
    this.ws = undefined
    this.client = undefined
    this.handlers = undefined
    this.botOpenId = undefined
    this.transition('closed')
  }

  async sendText(target: OutboundTarget): Promise<SendReceipt> {
    if (!this.client) throw new Error(`bot ${this.botId} is not connected`)
    // A scheduled task result may carry a durable Feishu interactive card.
    // It goes through the same Outbox path (same UUID, same retries), so card
    // pushes are just as idempotent as plain text replies.
    const interactive = target.card !== undefined
    const rich = target.format === 'markdown' && !interactive
    const content = interactive ? JSON.stringify(target.card)
      : rich ? feishuMarkdownContent(target.text) : JSON.stringify({ text: target.text })
    const msgType = interactive ? 'interactive' : rich ? 'post' : 'text'
    if (target.replyToMessageId) {
      const result = await this.client.im.message.reply({
        data: { content, msg_type: msgType, uuid: target.uuid ?? newId('fg') },
        path: { message_id: target.replyToMessageId },
      })
      return unwrap(result, `reply to ${target.replyToMessageId}`)
    }
    if (!target.chatId) throw new Error('sendText requires replyToMessageId or chatId')
    const result = await this.client.im.message.create({
      // Reuse the outbox-persisted UUID so REST retries/reconnect drains are
      // idempotent on the `create` path too (the `reply` path already does).
      data: { receive_id: target.chatId, msg_type: msgType, content, uuid: target.uuid ?? newId('fg') },
      // Scheduled reminders may target a user open_id (p2p) instead of a chat.
      params: { receive_id_type: target.receiveIdType ?? 'chat_id' },
    })
    return unwrap(result, `send to ${target.chatId}`)
  }

  /** A short-lived, non-durable card. Failure to send an approval card DENIES approval. */
  async sendInteractiveCard(
    target: { replyToMessageId: string }, card: Record<string, unknown>,
  ): Promise<FeishuCardHandle> {
    if (!this.client) throw new Error('Feishu transport is not connected')
    const result = await this.client.im.message.reply({
      path: { message_id: target.replyToMessageId },
      data: { msg_type: 'interactive', content: JSON.stringify(card), uuid: newId('card') },
    })
    const receipt = unwrap(result, 'send interactive card')
    if (!receipt.messageId) throw new Error('Feishu card response has no message id')
    return { messageId: receipt.messageId }
  }

  async updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (!this.client) throw new Error('Feishu transport is not connected')
    const result = await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })
    unwrap(result, 'patch interactive card')
  }

  /** Native CardKit card entity; v1 REST endpoints support schema 2.0. */
  async startStreamCard(target: { replyToMessageId: string }, nonce: string): Promise<FeishuCardHandle> {
    if (!this.client) throw new Error('Feishu transport is not connected')
    const response = await this.client.request({
      method: 'POST',
      url: '/open-apis/cardkit/v1/cards',
      data: { type: 'card_json', data: JSON.stringify(progressCard(nonce)) },
    })
    unwrap(response, 'create CardKit entity')
    const cardId = response.data?.card_id
    if (!cardId || !/^[A-Za-z0-9_-]{1,20}$/.test(cardId)) {
      throw new Error('CardKit create returned no valid card id')
    }
    const send = await this.client.im.message.reply({
      path: { message_id: target.replyToMessageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        uuid: newId('card'),
      },
    })
    const receipt = unwrap(send, 'send CardKit card')
    if (!receipt.messageId) throw new Error('Feishu stream card response has no message id')
    return { cardId, messageId: receipt.messageId }
  }

  async updateStreamCard(cardId: string, text: string, sequence: number): Promise<void> {
    if (!this.client) throw new Error('Feishu transport is not connected')
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(cardId)) throw new Error('invalid CardKit card id')
    const response = await this.client.request({
      method: 'PUT',
      url: `/open-apis/cardkit/v1/cards/${cardId}/elements/${PROGRESS_ELEMENT_ID}/content`,
      data: { content: text, sequence, uuid: newId('update') },
    })
    unwrap(response, 'update CardKit stream')
  }

  /** Replace the entire CardKit entity so terminal cards have no cancel button. */
  async replaceStreamCard(cardId: string, card: Record<string, unknown>, sequence: number): Promise<void> {
    if (!this.client) throw new Error('Feishu transport is not connected')
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(cardId)) throw new Error('invalid CardKit card id')
    const result = await this.client.request({
      method: 'PUT',
      url: `/open-apis/cardkit/v1/cards/${cardId}`,
      data: { card: { type: 'card_json', data: JSON.stringify(card) }, sequence, uuid: newId('final') },
    })
    unwrap(result, 'replace CardKit entity')
  }

  async finishStreamCard(cardId: string, sequence: number): Promise<void> {
    if (!this.client) throw new Error('Feishu transport is not connected')
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(cardId)) throw new Error('invalid CardKit card id')
    const response = await this.client.request({
      method: 'PATCH',
      url: `/open-apis/cardkit/v1/cards/${cardId}/settings`,
      data: {
        settings: JSON.stringify({ config: { streaming_mode: false } }),
        sequence,
        uuid: newId('finish'),
      },
    })
    unwrap(response, 'finish CardKit stream')
  }

  private transition(state: TransportState, error?: Error): void {
    this.stateValue = state
    try {
      this.handlers?.onStateChange(state, error)
    } catch (listenerError) {
      this.logger.warn('state listener failed: %s', String(listenerError))
    }
  }

  private async handleEvent(event: RawReceiveEvent): Promise<void> {
    const message = event.message
    if (!message?.message_id || !message.chat_id) return
    // Unknown chat types must not inherit the group access policy.
    if (message.chat_type !== 'p2p' && message.chat_type !== 'group') return
    // Never echo bot-originated messages back into a native Session.
    const senderType = event.sender?.sender_type ?? 'user'
    if (senderType !== 'user') return
    // Authorization uses open_id only. Never substitute user_id/union_id.
    const senderId = event.sender?.sender_id?.open_id ?? ''
    if (!senderId) return

    const messageType = message.message_type ?? 'unknown'
    const text = messageType === 'text' ? extractTextContent(message.content)
      : messageType === 'post' ? extractFeishuPostText(message.content) : ''
    const botKeys = message.mentions?.filter(m => m.mentioned_type === 'bot' &&
      Boolean(this.botOpenId) && m.id?.open_id === this.botOpenId &&
      typeof m.key === 'string' && /^@_user_\d+$/.test(m.key))?.map(m => m.key!) ?? []
    const cleaned = botKeys.reduce((value, key) => value.replaceAll(key, ''), text).trim()
    const inbound: InboundMessage = {
      messageId: message.message_id,
      botId: this.botId,
      chatId: message.chat_id,
      // Fail closed on unexpected/unknown chat types.
      chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
      senderId,
      senderType,
      text: cleaned,
      mentionedBot: botKeys.length > 0,
      ...(typeof message.thread_id === 'string' ? { threadId: message.thread_id } : {}),
      ...(typeof message.root_id === 'string' ? { rootId: message.root_id } : {}),
      createTime: Number(event.create_time ?? message.create_time ?? Date.now()),
      messageType,
    }
    // ACK only after Inbox admission is durable. Model execution is queued
    // separately, so we never await the potentially long Agent turn here.
    // Re-throw admission failures so the dispatcher can treat the event as
    // unsuccessful instead of silently acknowledging a lost message.
    try {
      await this.handlers?.onMessage(inbound)
    } catch (error) {
      this.logger.error('inbound persistence failed: %s', String(error))
      throw error
    }
  }
}

function extractTextContent(content: string | undefined): string {
  if (!content) return ''
  try {
    const parsed = JSON.parse(content) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    return ''
  }
}

function unwrap(result: LarkMessageApiResult, context: string): SendReceipt {
  if (result?.code !== undefined && result.code !== 0) {
    // Do not conflate Feishu business codes with numeric HTTP status codes.
    // Also avoid echoing server-provided msg text into operation logs.
    const error = new Error(`Feishu ${context} failed: code=${result.code}`) as Error & { feishuCode?: number }
    error.feishuCode = result.code
    throw error
  }
  return { messageId: result?.data?.message_id ?? '' }
}
