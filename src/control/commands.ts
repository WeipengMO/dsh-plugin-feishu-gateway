/** Gateway-owned controls run outside the native Agent's prompt stream. */
export type ControlCommand = 'help' | 'status' | 'cancel' | 'new' | 'model' | 'models' | 'compact' | 'context'

export function parseControlCommand(text: string): ControlCommand | undefined {
  const value = text.trim()
  if (/^\/models(?:\s+[^\r\n]+)?$/i.test(value)) return 'models'
  if (/^\/model(?:\s+[^\r\n]+)?$/i.test(value)) return 'model'
  const match = /^\/(help|status|stop|cancel|new|compact|context)\s*$/i.exec(value)
  const name = match?.[1]?.toLowerCase()
  return (name === 'stop' ? 'cancel' : name) as ControlCommand | undefined
}

export const commandHelp = [
  '飞书 DSH 控制命令',
  '/help — 查看可用命令',
  '/status — 查看当前聊天任务及通道状态',
  '/stop — 停止当前聊天正在运行的任务（不影响其他聊天）',
  '/models — 查看可用模型及当前会话模型',
  '/model provider/model — 切换当前会话模型',
  '/new — 结束当前会话关联，下一条消息开启新上下文',
  '/context — 查看 DSH 原生上下文压缩状态',
  '/compact — 手动压缩当前会话的较早历史（保留最近对话）',
  '普通文本会继续交给 DSH Agent；访问权限遵循当前私聊和群聊策略。',
  '注意：/stop 无法回滚已执行的命令或文件修改。',
].join('\n')
