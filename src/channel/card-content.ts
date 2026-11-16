import type { CardCompletionStats } from '../types.js'

/**
 * Feishu Card JSON 2.0 builders. Approval details are displayed in the
 * originating authorized chat; commands may contain sensitive data.
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

export function approvalCard(toolName: string, nonce: string, command?: string, reason?: string): Record<string, unknown> {
  const safeName = /^[A-Za-z0-9_.:/-]{1,96}$/.test(toolName) ? toolName : '受保护工具'
  // Indented Markdown code blocks preserve backticks in the command without
  // allowing a crafted fence to terminate the block and alter the card.
  const commandBlock = command === undefined ? undefined
    : '    ' + command.replace(/\n/g, '\n    ')
  return {
    ...header('工具执行审批', 'orange'),
    body: { elements: [
      { tag: 'markdown', content: '**工具：** ' + safeName +
        (toolName === 'bash' && command === undefined ? '\n\n⚠️ 无法可靠获取或完整展示命令，请谨慎决定。' : '') },
      ...(reason ? [{ tag: 'div', text: { tag: 'plain_text', content: '授权原因：' + reason } }] : []),
      ...(commandBlock !== undefined ? [
        { tag: 'markdown', content: '**待执行命令**' },
        { tag: 'markdown', content: commandBlock },
      ] : []),
      { tag: 'markdown', content: '是否允许执行本次调用？超时、断线或取消均不批准。' },
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
    ...header('正在执行', 'blue'),
    config: { update_multi: true, streaming_mode: true },
    body: { elements: [
      { tag: 'markdown', element_id: PROGRESS_ELEMENT_ID,
        content: '正在处理请求…' },
      button('取消当前任务', { kind: 'cancel', nonce }, 'danger'),
    ] },
  }
}

function statsFooter(stats: CardCompletionStats | undefined): string {
  if (!stats) return ''
  const parts: string[] = []
  // Only provider/model identifiers are shown, not request headers or keys.
  const safeModel = stats.model && /^[A-Za-z0-9._:/-]{1,96}$/.test(stats.model)
    ? stats.model : undefined
  if (safeModel) parts.push('模型：' + safeModel)
  const usage = stats.usage
  if (usage) {
    const total = usage.inputTokens + usage.outputTokens +
      (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    parts.push('Token 用量：' + total.toLocaleString('en-US'))
    // The model does not report "tokens per second" as a standalone metric.
    // Derive the average only when DSH observed the model stream duration;
    // never substitute whole-turn time (which includes tools/approval).
    if (usage.outputTokens > 0 && stats.generationMs && stats.generationMs > 0) {
      const speed = usage.outputTokens / (stats.generationMs / 1000)
      if (Number.isFinite(speed)) parts.push('速度：' + speed.toFixed(1) + ' tok/s')
    }
  }
  if (stats.toolCalls !== undefined) {
    parts.push('工具调用：' + stats.toolCalls + ' 次' +
      (stats.toolFailures ? '（失败 ' + stats.toolFailures + ' 次）' : ''))
  }
  if (Number.isFinite(stats.elapsedMs) && stats.elapsedMs >= 0) {
    parts.push('用时：' + (stats.elapsedMs / 1000).toFixed(1) + 's')
  }
  // Markdown hard line breaks keep each item on its own line in CardKit.
  // Feishu CardKit supports grey inline font color. Keep each line in its
  // own font span so markdown line breaks remain distinct and predictable.
  return parts.map(part => "<font color='grey'>" + part + '</font>').join('  \n')
}

/**
 * One full CardKit entity replacement is the terminal delivery.
 * Replacing the body also removes the live cancel button atomically.
 */
export function completedProgressCard(
  status: 'done' | 'cancelled' | 'failed',
  text: string,
  stats?: CardCompletionStats,
): Record<string, unknown> {
  const labels = {
    done: ['已完成', 'green'],
    cancelled: ['已取消', 'grey'],
    failed: ['执行异常', 'grey'],
  } as const
  const [title, template] = labels[status]
  const footer = statsFooter(stats)
  return {
    ...header(title, template),
    config: { update_multi: true, streaming_mode: false },
    body: { elements: [
      { tag: 'markdown', element_id: PROGRESS_ELEMENT_ID, content: text },
      ...(footer ? [
        { tag: 'hr' },
        { tag: 'markdown', text_size: 'notation', content: footer },
      ] : []),
    ] },
  }
}
