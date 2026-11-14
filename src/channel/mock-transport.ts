import type {
  FeishuEventHandlers,
  FeishuTransport,
  InboundMessage,
  OutboundTarget,
  SendReceipt,
  TransportState,
} from '../types.js'
import { newId } from '../util/id.js'

export interface MockTransportOptions {
  /** Fail the next N sendText calls (exercises outbox retry). */
  readonly failSends?: number
}

/**
 * In-memory Feishu transport. Tests drive inbound traffic with `emitMessage`
 * and inspect `sent`; no socket, no credentials, no network.
 */
export class MockFeishuTransport implements FeishuTransport {
  private stateValue: TransportState = 'idle'
  private handlers: FeishuEventHandlers | undefined
  readonly sent: Array<OutboundTarget & { messageId: string; at: number }> = []
  readonly stateChanges: Array<{ state: TransportState; error?: Error }> = []
  remainingFailures: number

  constructor(readonly botId: string, private readonly options: MockTransportOptions = {}) {
    this.remainingFailures = options.failSends ?? 0
  }

  get state(): TransportState {
    return this.stateValue
  }

  async connect(handlers: FeishuEventHandlers): Promise<void> {
    this.handlers = handlers
    this.transition('connecting')
    this.transition('connected')
  }

  async close(): Promise<void> {
    this.transition('closing')
    this.handlers = undefined
    this.transition('closed')
  }

  async sendText(target: OutboundTarget): Promise<SendReceipt> {
    if (this.stateValue !== 'connected') throw new Error(`bot ${this.botId} is not connected`)
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1
      throw new Error('simulated Feishu send failure')
    }
    const messageId = newId('om')
    this.sent.push({ ...target, messageId, at: Date.now() })
    return { messageId }
  }

  /** Simulate one inbound `im.message.receive_v1` delivery. */
  async emitMessage(partial: Partial<InboundMessage> & { text?: string }): Promise<void> {
    if (!this.handlers) throw new Error('transport is not connected')
    const message: InboundMessage = {
      messageId: partial.messageId ?? newId('om'),
      botId: this.botId,
      chatId: partial.chatId ?? 'oc_mock_chat',
      chatType: partial.chatType ?? 'p2p',
      senderId: partial.senderId ?? 'ou_mock_sender',
      senderType: partial.senderType ?? 'user',
      text: partial.text ?? 'hello',
      createTime: partial.createTime ?? Date.now(),
      messageType: partial.messageType ?? 'text',
    }
    await this.handlers.onMessage(message)
  }

  /** Simulate a disconnect / reconnect cycle. */
  async simulateReconnect(): Promise<void> {
    this.transition('reconnecting')
    this.transition('connected')
  }

  private transition(state: TransportState, error?: Error): void {
    this.stateValue = state
    this.stateChanges.push({ state, ...(error ? { error } : {}) })
    this.handlers?.onStateChange(state, error)
  }
}
