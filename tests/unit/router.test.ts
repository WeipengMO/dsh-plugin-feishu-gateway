import { describe, expect, it } from 'vitest'
import { MessageRouter } from '../../src/router/message-router.js'
import { resolveConfig } from '../../src/config.js'
import type { InboundMessage } from '../../src/types.js'

const baseMessage: InboundMessage = {
  messageId: 'om_1',
  botId: 'default',
  chatId: 'oc_1',
  chatType: 'p2p',
  senderId: 'ou_alice',
  senderType: 'user',
  text: 'hello',
  createTime: 1,
  messageType: 'text',
}

describe('MessageRouter security policy', () => {
  it('denies everything when the allowlist is empty (fail closed)', () => {
    const router = new MessageRouter(resolveConfig({ allowlist: [] }))
    expect(router.decide(baseMessage)).toEqual({ accepted: false, reason: 'empty-allowlist' })
  })

  it('admits an allowlisted user in a p2p chat', () => {
    const router = new MessageRouter(resolveConfig({ allowlist: ['ou_alice'] }))
    const decision = router.decide(baseMessage)
    expect(decision.accepted).toBe(true)
    if (decision.accepted) expect(decision.message.text).toBe('hello')
  })

  it('rejects a sender that is not on the allowlist', () => {
    const router = new MessageRouter(resolveConfig({ allowlist: ['ou_bob'] }))
    expect(router.decide(baseMessage)).toEqual({ accepted: false, reason: 'sender-not-allowlisted' })
  })

  it('rejects group chats but keeps private chats enabled if allowGroups is true', () => {
    const router = new MessageRouter(resolveConfig({ allowlist: ['ou_alice'], allowGroups: true }))
    expect(router.decide({ ...baseMessage, chatType: 'group' })).toEqual({ accepted: false, reason: 'groups-disabled' })
    expect(router.decide(baseMessage).accepted).toBe(true)
  })

  it('accepts text-only rich post messages but keeps binary messages rejected', () => {
    const router = new MessageRouter(resolveConfig({ allowlist: ['ou_alice'] }))
    expect(router.decide({ ...baseMessage, messageType: 'post', text: '**报告**' }).accepted).toBe(true)
    expect(router.decide({ ...baseMessage, messageType: 'post', text: '' }))
      .toEqual({ accepted: false, reason: 'empty-text' })
  })

  it('rejects non-text messages and bot-originated messages', () => {
    const router = new MessageRouter(resolveConfig({ allowlist: ['ou_alice'] }))
    expect(router.decide({ ...baseMessage, messageType: 'image' })).toEqual({ accepted: false, reason: 'unsupported-message-type' })
    expect(router.decide({ ...baseMessage, senderType: 'app' })).toEqual({ accepted: false, reason: 'sender-not-user' })
  })

  it('rejects empty text', () => {
    const router = new MessageRouter(resolveConfig({ allowlist: ['ou_alice'] }))
    expect(router.decide({ ...baseMessage, text: '   ' })).toEqual({ accepted: false, reason: 'empty-text' })
  })

  it('truncates by code points, not UTF-16 units', () => {
    const router = new MessageRouter(resolveConfig({ allowlist: ['ou_alice'], maxTextLength: 3 }))
    const decision = router.decide({ ...baseMessage, text: '😀😀😀😀' })
    expect(decision.accepted).toBe(true)
    if (decision.accepted) expect([...decision.message.text]).toHaveLength(3)
  })

  it('does not mutate the input message', () => {
    const router = new MessageRouter(resolveConfig({ allowlist: ['ou_alice'] }))
    router.decide(baseMessage)
    expect(baseMessage.text).toBe('hello')
  })
})

describe('group access modes', () => {
  const group = { ...baseMessage, chatType: 'group' as const, chatId: 'oc_group_1' }
  const rule = { chatId: 'oc_group_1', enabled: true, requireMention: true, sessionScope: 'group_sender' as const }

  it('requires explicit opt-in and ignores legacy allowGroups', () => {
    const router = new MessageRouter(resolveConfig({ allowGroups: true, allowlist: ['ou_alice'] }))
    expect(router.decide({ ...group, mentionedBot: true }))
      .toEqual({ accepted: false, reason: 'groups-disabled' })
    expect(router.decide(baseMessage).accepted).toBe(true)
  })

  it('enforces group admission, sender allowlists and structured @bot', () => {
    const router = new MessageRouter(resolveConfig({
      groupPolicy: 'allowlist', groupSenderAllowlist: ['ou_alice'],
      groups: [{ ...rule, senderAllowlist: ['ou_alice'] }],
    }))
    expect(router.decide(group)).toEqual({ accepted: false, reason: 'mention-required' })
    expect(router.decide({ ...group, mentionedBot: true }).accepted).toBe(true)
    expect(router.decide({ ...group, chatId: 'oc_other', mentionedBot: true }))
      .toEqual({ accepted: false, reason: 'group-not-allowlisted' })
    expect(router.decide({ ...group, senderId: 'ou_bob', mentionedBot: true }))
      .toEqual({ accepted: false, reason: 'group-sender-not-allowlisted' })
    expect(router.allowedActor('group', 'oc_group_1', 'ou_bob')).toBe(false)
  })

  it('open mode still protects group senders and honors disabled/per-group restrictions', () => {
    const router = new MessageRouter(resolveConfig({
      groupPolicy: 'open', groupSenderAllowlist: ['ou_alice', 'ou_bob'],
      groups: [{ ...rule, requireMention: false, senderAllowlist: ['ou_alice'] },
        { ...rule, chatId: 'oc_disabled', enabled: false }],
    }))
    expect(router.decide(group).accepted).toBe(true)
    expect(router.decide({ ...group, senderId: 'ou_bob' }))
      .toEqual({ accepted: false, reason: 'group-sender-not-allowlisted' })
    expect(router.decide({ ...group, chatId: 'oc_disabled' }))
      .toEqual({ accepted: false, reason: 'group-not-allowlisted' })
    expect(router.decide({ ...group, chatId: 'oc_other' }))
      .toEqual({ accepted: false, reason: 'mention-required' })
    expect(router.decide({ ...group, chatId: 'oc_other', mentionedBot: true }).accepted).toBe(true)
  })
})
