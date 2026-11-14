import type { GatewayConfig, InboundMessage } from '../types.js'

export type RejectReason =
  | 'groups-disabled'
  | 'empty-allowlist'
  | 'sender-not-allowlisted'
  | 'sender-not-user'
  | 'unsupported-message-type'
  | 'empty-text'

export type RouterDecision =
  | { readonly accepted: true; readonly message: InboundMessage }
  | { readonly accepted: false; readonly reason: RejectReason }

/**
 * Security boundary for inbound messages. Defaults fail closed:
 *   - group chats are OFF (v0.1.0 hard rule, config flag cannot enable them)
 *   - an empty allowlist denies everyone
 *   - only `open_id`s on the allowlist are admitted
 *   - only text messages are accepted
 *
 * The router is pure (no I/O), so dedup, persistence and Session dispatch stay
 * in the gateway and are independently testable.
 */
export class MessageRouter {
  private readonly allowlist: ReadonlySet<string>

  constructor(private readonly config: GatewayConfig) {
    this.allowlist = new Set(config.allowlist)
  }

  decide(message: InboundMessage): RouterDecision {
    if (message.chatType !== 'p2p') {
      // v0.1.0 deliberately does not implement group policy, mention parsing,
      // or per-group isolation. The legacy flag must never disable DMs.
      return { accepted: false, reason: 'groups-disabled' }
    }
    if (this.allowlist.size === 0) {
      return { accepted: false, reason: 'empty-allowlist' }
    }
    if (!this.allowlist.has(message.senderId)) {
      return { accepted: false, reason: 'sender-not-allowlisted' }
    }
    if (message.senderType !== 'user') {
      return { accepted: false, reason: 'sender-not-user' }
    }
    if (message.messageType !== 'text') {
      return { accepted: false, reason: 'unsupported-message-type' }
    }
    const text = truncateCodePoints(message.text.trim(), this.config.maxTextLength)
    if (text.length === 0) {
      return { accepted: false, reason: 'empty-text' }
    }
    return {
      accepted: true,
      message: { ...message, text },
    }
  }
}

function truncateCodePoints(text: string, limit: number): string {
  const points = [...text]
  return points.length > limit ? points.slice(0, limit).join('') : text
}
