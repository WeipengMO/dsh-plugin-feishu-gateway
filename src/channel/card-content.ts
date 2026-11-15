/**
 * Feishu Card JSON 2.0 builders. Approval cards deliberately do not expose
 * command arguments, user content, paths, secrets, or arbitrary reasons.
 */
export const CARD_NAMESPACE = 'dsh-feishu-gateway'
export const PROGRESS_ELEMENT_ID = 'task_progress'

function header(title: string, template: 'orange' | 'blue' | 'green' | 'grey') {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
  }
}

function button(label: string, value: Record<string, string>, type: 'primary' | 'danger') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value: { namespace: CARD_NAMESPACE, ...value } }],
  }
}

export function approvalCard(toolName: string, nonce: string): Record<string, unknown> {
  const safeName = /^[A-Za-z0-9_.:/-]{1,96}$/.test(toolName) ? toolName : '受保护工具'
  return {
    ...header('DSH 工具执行审批', 'orange'),
    body: { elements: [
      { tag: 'markdown', content: '**工具：** ' + safeName +
        '\n\n是否允许执行本次调用？\n不会展示命令参数、文件路径或密钥。\n超时、断线或取消均不批准。' },
      { tag: 'column_set', flex_mode: 'none', columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [
          button('仅允许本次', { kind: 'approval', nonce, decision: 'allow' }, 'primary'),
        ] },
        { tag: 'column', width: 'weighted', weight: 1, elements: [
          button('拒绝执行', { kind: 'approval', nonce, decision: 'reject' }, 'danger'),
        ] },
      ] },
    ] },
  }
}

export function approvalResultCard(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'): Record<string, unknown> {
  const approved = outcome === 'allowed-once'
  return {
    ...header(approved ? '已批准本次执行' : '工具执行未获批准', approved ? 'green' : 'grey'),
    body: { elements: [{ tag: 'markdown', content: approved
      ? '仅授权刚才的单次工具调用。'
      : '请求已拒绝、取消或过期；工具不会因此获得执行权限。' }] },
  }
}

export function progressCard(nonce: string): Record<string, unknown> {
  return {
    ...header('DSH 正在执行', 'blue'),
    config: { update_multi: true, streaming_mode: true },
    body: { elements: [
      { tag: 'markdown', element_id: PROGRESS_ELEMENT_ID,
        content: '正在处理请求…\n\n*这是实时进度预览，最终答复将另行发送。*' },
      button('取消当前任务', { kind: 'cancel', nonce }, 'danger'),
    ] },
  }
}
