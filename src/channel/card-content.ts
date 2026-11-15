/**
 * Feishu Card JSON 2.0 builders. NEVER interpolate raw tool arguments, working
 * directory, or untrusted markdown into an approval card.
 */
const NS = 'dsh-feishu-gateway'
export const CARD_NAMESPACE = NS
export const PROGRESS_ELEMENT_ID = 'task_progress'

function heading(title: string, template: 'orange'|'blue'|'green'|'grey') {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements: [] as Record<string, unknown>[] },
  }
}

function button(label: string, value: Record<string, string>, type: 'primary'|'danger'|'default') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value: { namespace: NS, ...value } }],
  }
}

function safeToolName(name: string): string {
  return /^[A-Za-z0-9_.:/-]{1,96}$/.test(name) ? name : '受保护工具'
}

export function approvalCard(toolName: string, nonce: string): Record<string, unknown> {
  const card = heading('DSH 工具执行审批', 'orange')
  card.body.elements.push(
    { tag: 'markdown',
      content: \`**操作：** \${safeToolName(toolName)}\\n\\n请求一次性执行权限。\\n不会显示命令参数、文件路径或密钥。\\n超时或无人响应默认拒绝。\` },
    {
      tag: 'column_set', flex_mode: 'none',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [
          button('允许本次', { kind: 'approval', nonce, decision: 'allow' }, 'primary'),
        ] },
        { tag: 'column', width: 'weighted', weight: 1, elements: [
          button('拒绝', { kind: 'approval', nonce, decision: 'reject' }, 'danger'),
        ] },
      ],
    },
  )
  return card
}

export function approvalResultCard(outcome: 'allowed-once'|'rejected'|'cancelled'|'unavailable'): Record<string, unknown> {
  const approved = outcome === 'allowed-once'
  const card = heading(approved ? '已批准本次执行' : '工具执行未获批准', approved ? 'green' : 'grey')
  card.body.elements.push({ tag: 'markdown',
    content: approved ? '此批准只适用于刚才的单次工具调用。' : '请求已拒绝、取消或过期。工具不会因此获得执行权限。' })
  return card
}

export function progressCard(nonce: string): Record<string, unknown> {
  const card = heading('DSH 正在执行', 'blue')
  card.config = { update_multi: true, streaming_mode: true } as typeof card.config
  card.body.elements.push(
    { tag: 'markdown', element_id: PROGRESS_ELEMENT_ID,
      content: '正在处理请求…\\n\\n*这是实时进度预览，最终回答会单独发送。*' },
    button('取消当前任务', { kind: 'cancel', nonce }, 'danger'),
  )
  return card
}
