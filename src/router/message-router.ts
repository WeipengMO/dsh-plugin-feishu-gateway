import type { ChatType, GatewayConfig, InboundMessage, GroupRule } from '../types.js'

export type RejectReason =
  | 'groups-disabled' | 'group-not-allowlisted' | 'group-sender-not-allowlisted'
  | 'mention-required' | 'empty-allowlist' | 'sender-not-allowlisted'
  | 'sender-not-user' | 'unsupported-message-type' | 'empty-text'

export type RouterDecision =
  | { readonly accepted: true; readonly message: InboundMessage }
  | { readonly accepted: false; readonly reason: RejectReason }

/** Pure authorization boundary; all group modes are explicitly opt-in. */
export class MessageRouter {
  private readonly allowlist: ReadonlySet<string>
  private readonly groupSenders: ReadonlySet<string>
  private readonly groups: ReadonlyMap<string, GroupRule>

  constructor(private readonly config: GatewayConfig) {
    this.allowlist = new Set(config.allowlist)
    this.groupSenders = new Set(config.groupSenderAllowlist)
    this.groups = new Map(config.groups.map(g => [g.chatId, g]))
  }

  groupRule(chatId: string): GroupRule | undefined { return this.groups.get(chatId) }

  /** Rechecked on card actions; group permission cannot bypass an actor check. */
  allowedActor(chatType: ChatType, chatId: string, actor: string): boolean {
    if (chatType === 'p2p') return this.allowlist.has(actor)
    const rule = this.groups.get(chatId)
    if (this.config.groupPolicy === 'disabled' || rule?.enabled === false) return false
    if (this.config.groupPolicy === 'allowlist' && !rule) return false
    return this.groupSenders.has(actor) && (!rule?.senderAllowlist || rule.senderAllowlist.includes(actor))
  }

  decide(message: InboundMessage): RouterDecision {
    if (message.senderType !== 'user') return { accepted: false, reason: 'sender-not-user' }
    if (message.chatType === 'group') {
      if (this.config.groupPolicy === 'disabled') return { accepted: false, reason: 'groups-disabled' }
      const rule = this.groups.get(message.chatId)
      if (rule?.enabled === false || (this.config.groupPolicy === 'allowlist' && !rule))
        return { accepted: false, reason: 'group-not-allowlisted' }
      if (!this.groupSenders.has(message.senderId) ||
        (rule?.senderAllowlist && !rule.senderAllowlist.includes(message.senderId)))
        return { accepted: false, reason: 'group-sender-not-allowlisted' }
      if ((rule?.requireMention ?? true) && message.mentionedBot !== true)
        return { accepted: false, reason: 'mention-required' }
    } else {
      if (this.allowlist.size === 0) return { accepted: false, reason: 'empty-allowlist' }
      if (!this.allowlist.has(message.senderId)) return { accepted: false, reason: 'sender-not-allowlisted' }
    }
    if (message.messageType !== 'text' && message.messageType !== 'post')
      return { accepted: false, reason: 'unsupported-message-type' }
    const text = [...message.text.trim()].slice(0, this.config.maxTextLength).join('')
    if (!text) return { accepted: false, reason: 'empty-text' }
    return { accepted: true, message: { ...message, text } }
  }
}
