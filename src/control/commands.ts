/** Gateway-owned controls run outside the native Agent's prompt stream. */
export type ControlCommand = 'help' | 'status' | 'cancel' | 'new'

export function parseControlCommand(text: string): ControlCommand | undefined {
  const match = /^\/(help|status|cancel|new)\s*$/i.exec(text.trim())
  return match?.[1]?.toLowerCase() as ControlCommand | undefined
}

export const commandHelp = [
  '飞书 DSH 控制命令',
  '/help — 查看可用命令',
  '/status — 查看当前聊天任务及通道状态',
  '/cancel — 取消当前聊天正在运行的任务（不影响其他聊天）',
  '/new — 结束当前会话关联，下一条消息开启新上下文',
  '普通文本会继续交给 DSH Agent；群聊和非白名单用户仍被拒绝。',
  '注意：/cancel 无法回滚已执行的命令或文件修改。',
].join('\n')
