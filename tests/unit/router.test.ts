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
