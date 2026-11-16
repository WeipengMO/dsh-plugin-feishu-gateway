import { describe, expect, it } from 'vitest'
import { approvalCommand, FeishuApprovalManager } from '../../src/channel/approval-manager.js'
import { MockFeishuTransport } from '../../src/channel/mock-transport.js'
import { silentLogger } from '../../src/util/logger.js'
import { CARD_NAMESPACE } from '../../src/channel/card-content.js'

const owner = {
  botId: 'default', chatId: 'oc_one', senderId: 'ou_alice', replyToMessageId: 'om_original',
}
function setup(timeoutMs = 200) {
  const transport = new MockFeishuTransport('default')
  const manager = new FeishuApprovalManager(
    timeoutMs, new Set(['ou_alice']),
    id => id === 's_1' ? owner : undefined,
    botId => botId === 'default' ? transport : undefined,
    silentLogger,
  )
  const untilPending = async () => {
    for (let i = 0; i < 100 && manager.size !== 1; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(manager.size).toBe(1)
  }
  const ask = (signal?: AbortSignal) => manager.answer({
    agent: { id: 's_1' }, toolName: 'bash', signal,
  }, async () => 'rejected')
  const action = (decision: string) => {
    const sent = transport.interactiveCards[0]!
    const card = sent.card as any
    const btn = card.body.elements.find((e: any) => e.tag === 'column_set').columns[decision === 'allow' ? 0 : 1].elements[0]
    return {
      botId: owner.botId,
      chatId: owner.chatId,
      actorOpenId: owner.senderId,
      messageId: sent.messageId,
      value: btn.behaviors[0].value as { namespace: string; kind: string; nonce: string; decision: string },
    }
  }
  return { manager, transport, ask, action, untilPending }
}

describe('fail-closed native approval card manager', () => {

  it('shows the exact correlated bash command and localized approval reason', async () => {
    const t = setup()
    const command = 'printf hello\ncat /tmp/example'
    const waiting = t.manager.answer({
      agent: { id: 's_1', session: { deriveMessages: () => [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'other', name: 'bash', arguments: JSON.stringify({ command: 'wrong' }) },
          { type: 'tool-call', id: 'wanted', name: 'bash', arguments: JSON.stringify({ command }) },
        ] },
      ] } },
      toolName: 'bash', callId: 'wanted', reason: 'fallback',
      displayReason: { en: 'English', zh: '允许提升沙箱权限' },
    }, async () => 'unavailable')
    await t.untilPending()
    const elements = (t.transport.interactiveCards[0]!.card as any).body.elements
    expect(elements.some((e: any) => e.tag === 'markdown' && e.content === '    ' + command.replace(/\n/g, '\n    '))).toBe(true)
    expect(elements.some((e: any) => e.text?.content === '授权原因：允许提升沙箱权限')).toBe(true)
    expect(JSON.stringify(elements)).not.toContain('wrong')
    t.manager.consume(t.action('allow'))
    expect(await waiting).toBe('allowed-once')
    t.manager.stop()
  })

  it('keeps embedded markdown fences and mentions inside the command code block', async () => {
    const t = setup()
    const command = 'echo first\n' + String.fromCharCode(96).repeat(3) + '\n<at id=all></at>\n  echo last'
    const waiting = t.manager.answer({
      agent: { id: 's_1', session: { deriveMessages: () => [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'c', name: 'bash', arguments: JSON.stringify({ command }) },
        ] },
      ] } },
      toolName: 'bash', callId: 'c',
    }, async () => 'unavailable')
    await t.untilPending()
    const elements = (t.transport.interactiveCards[0]!.card as any).body.elements
    const code = elements.find((e: any) => e.tag === 'markdown' && e.content.startsWith('    echo first'))
    expect(code.content).toBe('    ' + command.replace(/\n/g, '\n    '))
    expect(elements.findIndex((e: any) => e === code)).toBeLessThan(elements.findIndex((e: any) => e.tag === 'column_set'))
    t.manager.consume(t.action('reject'))
    expect(await waiting).toBe('rejected')
    t.manager.stop()
  })

  it('warns when bash command cannot be displayed, while preserving the user decision', async () => {
    const t = setup()
    const waiting = t.ask()
    await t.untilPending()
    expect(JSON.stringify(t.transport.interactiveCards[0]!.card)).toContain('无法可靠获取或完整展示命令')
    t.manager.consume(t.action('allow'))
    expect(await waiting).toBe('allowed-once')
    t.manager.stop()
  })

  it('never substitutes a different, malformed, duplicate, or oversized command', () => {
    const call = (id: string, args: string) => ({ type: 'tool-call', id, name: 'bash', arguments: args })
    const request = (blocks: unknown[]) => ({
      toolName: 'bash', callId: 'wanted',
      agent: { session: { deriveMessages: () => [{ role: 'assistant', content: blocks }] } },
    })
    expect(approvalCommand(request([call('other', '{"command":"wrong"}')]))).toBeUndefined()
    expect(approvalCommand(request([call('wanted', 'invalid')]))).toBeUndefined()
    expect(approvalCommand(request([call('wanted', '{"command":"a"}'), call('wanted', '{"command":"b"}')]))).toBeUndefined()
    expect(approvalCommand(request([call('wanted', JSON.stringify({ command: 'a'.repeat(3501) }))]))).toBeUndefined()
    expect(approvalCommand(request([call('wanted', JSON.stringify({ command: 'a\u0000b' }))]))).toBeUndefined()
  })


  it('does not capture unrelated DSH approval requests', async () => {
    const { manager, transport } = setup()
    const result = await manager.answer({
      agent: { id: 'non-feishu-agent' }, toolName: 'bash',
    }, async () => 'rejected')
    expect(result).toBe('rejected')
    expect(transport.interactiveCards).toHaveLength(0)
    manager.stop()
  })

  it('grants only once to the exact allowlisted sender, bot, chat and card', async () => {
    const t = setup()
    const awaiting = t.ask()
    await t.untilPending()
    expect(t.transport.interactiveCards).toHaveLength(1)
    const sent = t.transport.interactiveCards[0]!
    expect(JSON.stringify(sent.card)).not.toContain('om_original')
    expect(JSON.stringify(sent.card)).not.toContain('SECRET_VALUE')
    const original = t.action('allow')

    for (const bad of [
      { actorOpenId: 'ou_mallory' }, { botId: 'other' }, { chatId: 'oc_other' },
      { messageId: 'om_forged' }, { value: { ...original.value, nonce: 'wrong' } },
    ]) {
      const decision = t.manager.consume({ ...original, ...bad })
      expect(decision?.toast.type).toBe('warning')
      expect(t.manager.size).toBe(1)
    }

    expect(t.manager.consume(original)?.toast.type).toBe('success')
    expect(await awaiting).toBe('allowed-once')
    expect(t.manager.consume(original)?.toast.type).toBe('warning')
    await Promise.resolve()
    expect(t.transport.patchedCards).toHaveLength(1)
    t.manager.stop()
  })

  it('supports explicit deny, rejects malformed action and hides arbitrary tool descriptions', async () => {
    const t = setup()
    const waiting = t.manager.answer({ agent: { id: 's_1' },
      toolName: 'bash; TOKEN=private' }, async () => 'unavailable')
    await t.untilPending()
    expect(JSON.stringify(t.transport.interactiveCards[0]?.card)).not.toContain('private')
    const bad = t.action('reject')
    expect(t.manager.consume({ ...bad, value: { ...bad.value, decision: 'maybe' } })?.toast.type).toBe('warning')
    expect(t.manager.consume(bad)?.toast.type).toBe('info')
    expect(await waiting).toBe('rejected')
    t.manager.stop()
  })

  it('expires without granting and makes stale card callbacks inert', async () => {
    const t = setup(25)
    const waiting = t.ask()
    await t.untilPending()
    const click = t.action('allow')
    expect(await waiting).toBe('unavailable')
    expect(t.manager.consume(click)?.toast.type).toBe('warning')
    t.manager.stop()
  })

  it('aborts on the DSH signal and shutdown before any later user click', async () => {
    const t = setup()
    const controller = new AbortController()
    const waiting = t.ask(controller.signal)
    await t.untilPending()
    const click = t.action('allow')
    controller.abort()
    expect(await waiting).toBe('cancelled')
    expect(t.manager.consume(click)?.toast.type).toBe('warning')
    const second = t.ask()
    await t.untilPending()
    t.manager.stop()
    expect(await second).toBe('cancelled')
  })

  it('revokes pending approvals on a transport disconnect without granting', async () => {
    const t = setup()
    const waiting = t.ask()
    await t.untilPending()
    const click = t.action('allow')
    t.manager.cancelBot('unrelated')
    expect(t.manager.size).toBe(1)
    t.manager.cancelBot('default')
    expect(await waiting).toBe('unavailable')
    expect(t.manager.consume(click)?.toast.type).toBe('warning')
    t.manager.stop()
  })

  it('rejects card delivery completed after the bot disconnected', async () => {
    const t = setup()
    let resolveDelivery!: () => void
    const pendingDelivery = new Promise<void>(resolve => { resolveDelivery = resolve })
    t.transport.sendInteractiveCard = async () => {
      await pendingDelivery
      return { messageId: 'om_late_card' }
    }
    const waiting = t.ask()
    t.manager.cancelBot('default')
    resolveDelivery()
    expect(await waiting).toBe('unavailable')
    expect(t.manager.size).toBe(0)
    t.manager.stop()
  })

  it('does not grant if sending the approval card fails', async () => {
    const t = setup()
    t.transport.sendInteractiveCard = async () => { throw new Error('disconnected') }
    expect(await t.ask()).toBe('unavailable')
    expect(t.manager.size).toBe(0)
    t.manager.stop()
  })

  it('rejects untrusted callbacks from outside this action namespace', () => {
    const t = setup()
    expect(t.manager.consume({
      botId: 'default', chatId: 'oc_one', actorOpenId: 'ou_alice', messageId: 'om_none',
      value: { namespace: CARD_NAMESPACE, kind: 'unrelated', nonce: 'n' },
    })).toBeUndefined()
    t.manager.stop()
  })
})
