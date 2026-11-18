/**
 * Official Feishu IM post/content payloads. Only textual nodes are accepted:
 * an image/media/unknown node makes the entire inbound post unsupported
 * rather than silently asking an LLM to act on incomplete information.
 */
type Obj = Record<string, unknown>
function object(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Feishu post message -> text-only prompt, or '' when content is unsupported. */
export function extractFeishuPostText(raw: string | undefined): string {
  if (!raw || Buffer.byteLength(raw, 'utf8') > 128 * 1024) return ''
  let parsed: unknown
  try { parsed = JSON.parse(raw) as unknown } catch { return '' }
  if (!object(parsed)) return ''
  const locale = object(parsed.zh_cn) ? parsed.zh_cn
    : object(parsed.en_us) ? parsed.en_us : parsed
  if (!object(locale) || !Array.isArray(locale.content) || locale.content.length > 256) return ''

  const lines: string[] = []
  if (typeof locale.title === 'string' && locale.title.trim()) lines.push(locale.title.slice(0, 512))
  for (const line of locale.content) {
    if (!Array.isArray(line) || line.length > 128) return ''
    const chunks: string[] = []
    for (const node of line) {
      if (!object(node) || typeof node.tag !== 'string') return ''
      if (node.tag === 'text' || node.tag === 'md') {
        if (typeof node.text !== 'string') return ''
        chunks.push(node.text)
      } else if (node.tag === 'a') {
        if (typeof node.text !== 'string' || typeof node.href !== 'string') return ''
        // Preserve the visible text even for unsafe or unsupported links.
        try {
          const url = new URL(node.href)
          chunks.push(url.protocol === 'https:' || url.protocol === 'http:'
            ? `[${node.text}](${node.href})` : node.text)
        } catch { chunks.push(node.text) }
      } else if (node.tag === 'hr') {
        chunks.push('---')
      } else {
        // Image / @ / video / file / unknown nodes need separate handling and
        // must not be silently dropped as if the model received everything.
        return ''
      }
    }
    lines.push(chunks.join(''))
  }
  return lines.join('\n').trim()
}

/** Feishu post/md replies allow code blocks and GFM tables. Limit payload size. */
export function feishuMarkdownContent(markdown: string): string {
  // Feishu post bodies are limited to 30 KiB. Leave generous JSON overhead.
  const maxTextBytes = 20 * 1024
  let length = 0
  let safe = ''
  for (const point of markdown) {
    const cost = Buffer.byteLength(point, 'utf8')
    if (length + cost > maxTextBytes) break
    safe += point
    length += cost
  }
  if (safe.length !== markdown.length) safe += '\n\n…（回复较长，已截断）'
  return JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: safe }]] } })
}
