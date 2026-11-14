import { randomUUID } from 'node:crypto'

export function newId(prefix = ''): string {
  return prefix ? `${prefix}-${randomUUID()}` : randomUUID()
}

/**
 * Stable, filesystem- and DSH-friendly Session identity for one chat.
 * A chat maps to exactly one native DSH Session; the mapping is persisted in
 * the session registry so it survives restarts.
 */
export function sessionIdFor(botId: string, chatId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return `feishu-${safe(botId)}-${safe(chatId)}`
}

export function chatKey(botId: string, chatId: string): string {
  return `${botId}:${chatId}`
}
