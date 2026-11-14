/**
 * Best-effort text extraction from official DSH Session event payloads.
 *
 * Durable `assistant/message` events carry an `AssistantMessage` whose
 * `content` is an array of text blocks; live `agent/assistant-stream` chunk
 * frames carry `{ type: 'text-delta', text }`. This helper only reads those
 * documented shapes and never invents new event types.
 */
export function extractText(value: unknown): string {
  const out: string[] = []
  const seen = new Set<unknown>()

  const walk = (node: unknown, depth: number): void => {
    if (node === null || node === undefined || depth > 8) return
    if (typeof node === 'string' || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }

    const obj = node as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type : undefined

    if (typeof obj.text === 'string' && (type === 'text' || type === 'output_text' || type === 'text-delta' || type === undefined)) {
      out.push(obj.text)
    }
    if (Array.isArray(obj.content)) {
      walk(obj.content, depth + 1)
    } else if (typeof obj.content === 'string' && type !== 'text') {
      out.push(obj.content)
    }
    for (const key of ['message', 'delta', 'chunk', 'block', 'blocks'] as const) {
      const nested = obj[key]
      if (nested && typeof nested === 'object') walk(nested, depth + 1)
    }
  }

  walk(value, 0)
  return out.join('')
}

/** Guard against returning a huge blob to Feishu. */
export function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text
}
