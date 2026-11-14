import { appIdLooksValid } from '../config.js'
import type {
  BotCredentials,
  FeishuEventHandlers,
  FeishuTransport,
  GatewayLogger,
  InboundMessage,
  OutboundTarget,
  SendReceipt,
  TransportState,
} from '../types.js'
import { newId } from '../util/id.js'

/** Official SDK, imported lazily so the module stays loadable in offline tests. */
const LARK_MODULE = '@larksuiteoapi/node-sdk'

interface LarkMessageApiResult {
  readonly code?: number
  readonly msg?: string
  readonly data?: { readonly message_id?: string }
}

interface LarkClientLike {
  readonly im: {
    readonly message: {
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
  private ws: LarkWsLike | undefined
  private handlers: FeishuEventHandlers | undefined

  constructor(
    readonly botId: string,
    private readonly credentials: BotCredentials,
    private readonly logger: GatewayLogger,
  ) {}

  get state(): TransportState {
    return this.stateValue
  }

  async connect(handlers: FeishuEventHandlers): Promise<void> {
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
    const domain = this.credentials.domain === 'lark' ? mod.Domain.Lark : mod.Domain.Feishu
    const common = {
      appId: this.credentials.appId,
      appSecret: this.credentials.appSecret,
      domain,
    }

    this.client = new mod.Client(common)

    const dispatcher = new mod.EventDispatcher({})
    dispatcher.register({
      'im.message.receive_v1': (event: RawReceiveEvent) => this.handleEvent(event),
    })

    this.ws = new mod.WSClient({
      ...common,
      autoReconnect: true,
      onReady: () => this.transition('connected'),
      onReconnecting: () => this.transition('reconnecting'),
      onReconnected: () => this.transition('connected'),
      onError: (error: Error) => {
        this.logger.error('websocket error for bot %s: %s', this.botId, error.message)
        this.transition('failed', error)
      },
    })

    try {
      // WSClient.start() resolves before the handshake completes (and silently
      // no-ops for an invalid appId). Only onReady/onReconnected prove a live
      // connection, so do NOT report `connected` here: a misconfigured bot
      // must stay `connecting`/`failed` instead of being marked healthy.
      await this.ws.start({ eventDispatcher: dispatcher })
    } catch (error) {
      this.transition('failed', error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  async close(): Promise<void> {
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
    this.transition('closed')
  }

  async sendText(target: OutboundTarget): Promise<SendReceipt> {
    if (!this.client) throw new Error(`bot ${this.botId} is not connected`)
    const content = JSON.stringify({ text: target.text })
    if (target.replyToMessageId) {
      const result = await this.client.im.message.reply({
        data: { content, msg_type: 'text', uuid: target.uuid ?? newId('fg') },
        path: { message_id: target.replyToMessageId },
      })
      return unwrap(result, `reply to ${target.replyToMessageId}`)
    }
    if (!target.chatId) throw new Error('sendText requires replyToMessageId or chatId')
    const result = await this.client.im.message.create({
      // Reuse the outbox-persisted UUID so REST retries/reconnect drains are
      // idempotent on the `create` path too (the `reply` path already does).
      data: { receive_id: target.chatId, msg_type: 'text', content, uuid: target.uuid ?? newId('fg') },
      params: { receive_id_type: 'chat_id' },
    })
    return unwrap(result, `send to ${target.chatId}`)
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
    // Never echo bot-originated messages back into a native Session.
    const senderType = event.sender?.sender_type ?? 'user'
    if (senderType !== 'user') return
    // Authorization uses open_id only. Never substitute user_id/union_id.
    const senderId = event.sender?.sender_id?.open_id ?? ''
    if (!senderId) return

    const messageType = message.message_type ?? 'unknown'
    const text = messageType === 'text' ? extractTextContent(message.content) : ''
    const inbound: InboundMessage = {
      messageId: message.message_id,
      botId: this.botId,
      chatId: message.chat_id,
      // Fail closed on unexpected/unknown chat types.
      chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
      senderId,
      senderType,
      text,
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
    const error = new Error(`Feishu ${context} failed: code=${result.code} msg=${result.msg ?? ''}`) as Error & { code?: number }
    error.code = result.code
    throw error
  }
  return { messageId: result?.data?.message_id ?? '' }
}
