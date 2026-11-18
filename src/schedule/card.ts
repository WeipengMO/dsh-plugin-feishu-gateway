/**
 * Feishu interactive card rendering for native scheduled-task results.
 *
 * The digest scripts emit compact Markdown; this module turns that text into a
 * standard `msg_type:'interactive'` card (blue header + Markdown sections +
 * a note footer) without any extra LLM call. The card travels through the
 * durable Outbox, so retries and reconnect drains stay idempotent.
 */

/** Bound the card source so a misbehaving script cannot build an oversized card. */
export const CARD_TEXT_MAX = 4000
const CARD_TITLE_MAX = 80
const CARD_SECTION_MAX = 12
const CARD_DIV_MAX = 2000
const TEMPLATES = new Set([
  'blue', 'green', 'red', 'orange', 'purple', 'indigo', 'grey',
  'wathet', 'turquoise', 'yellow', 'violet', 'carmine',
])

export interface ScheduleCardOptions {
  /** Header template colour; unknown values fall back to `blue`. */
  readonly template?: string
  /** Small grey footer note. */
  readonly footer?: string
}

function sanitize(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim()
}

/**
 * Build a Feishu interactive card from a scheduled digest.
 *
 * The first line becomes the header. Blank-line separated blocks become
 * `lark_md` sections (their first line is emphasised when followed by items),
 * separated by dividers. A `note` footer marks the message as an automatic
 * DSH native scheduled-task push.
 */
export function buildScheduleCard(
  text: string,
  options: ScheduleCardOptions = {},
): Record<string, unknown> {
  const source = sanitize(text).slice(0, CARD_TEXT_MAX)
  const rawBlocks = source.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
  const first = rawBlocks.shift() ?? '定时任务结果'
  // Only fold bold article-like items into a preceding, identifiable topic.
  // Two independent bold sections must not collapse into a single topic.
  // No headings or article text are discarded here; long topics are split into
  // multiple card divs below WITHOUT adding an extra divider inside the topic.
  const groups: Array<{ text: string; topic: boolean }> = []
  for (const block of rawBlocks) {
    const firstLine = block.split('\n', 1)[0] ?? ''
    const boldItem = /^\*\*[^\n]+\*\*(?:\n|$)/.test(firstLine)
    const hasDetails = block.includes('\n')
    const previous = groups.at(-1)
    if (boldItem && hasDetails && previous?.topic) {
      previous.text += '\n\n' + block
    } else {
      const looksLikeHeading = !boldItem && !/^[-*]\s/.test(firstLine) &&
        !/^[^\n]+[：:]\s*\S/.test(firstLine)
      groups.push({ text: block, topic: looksLikeHeading })
    }
  }
  const firstLines = first.split('\n').map((line) => line.trim()).filter(Boolean)
  const rawTitle = firstLines.shift() ?? '定时任务结果'
  const title = rawTitle.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').slice(0, CARD_TITLE_MAX) ||
    '定时任务结果'
  const sections = [
    ...(firstLines.length ? [{ text: firstLines.join('\n'), topic: false }] : []),
    ...groups,
  ]
  const visibleSections = sections.slice(0, CARD_SECTION_MAX)
  const elements: Record<string, unknown>[] = []
  for (const [sectionIndex, section] of visibleSections.entries()) {
    // Keep blank lines within a topic. Add emphasis to a plain-text heading,
    // but never double-wrap an already-bold heading.
    const rawLines = section.text.split('\n').map(line => line.trim())
    const nonEmpty = rawLines.filter(Boolean)
    if (!nonEmpty.length) continue
    const firstIndex = rawLines.findIndex(line => line.length > 0)
    const firstLine = nonEmpty[0]!
    const heading = nonEmpty.length > 1 && !firstLine.startsWith('- ') &&
      !/^\*\*/.test(firstLine)
      ? `**${firstLine.replace(/^#{1,6}\s+/, '')}**` : undefined
    const body = rawLines.slice(heading ? firstIndex + 1 : firstIndex)
    let remaining = [heading, ...body].filter(part => part !== undefined).join('\n')
    // Feishu's per-div bound must not silently truncate a whole topic. Prefer
    // splitting at a newline; extremely long unbroken lines use a hard bound.
    while (remaining.length > CARD_DIV_MAX) {
      const lineEnd = remaining.lastIndexOf('\n', CARD_DIV_MAX)
      const cut = lineEnd >= CARD_DIV_MAX / 2 ? lineEnd + 1 : CARD_DIV_MAX
      const chunk = remaining.slice(0, cut).trimEnd()
      if (chunk) elements.push({ tag: 'div', text: { tag: 'lark_md', content: chunk } })
      remaining = remaining.slice(cut).replace(/^\n+/, '')
    }
    if (remaining) elements.push({ tag: 'div', text: { tag: 'lark_md', content: remaining } })
    // Dividers separate TOPICS, never articles (or continued chunks of one topic).
    if (sectionIndex < visibleSections.length - 1) elements.push({ tag: 'hr' })
  }
  if (sections.length > CARD_SECTION_MAX) {
    elements.push({ tag: 'div', text: { tag: 'lark_md',
      content: '部分章节超过卡片显示数量上限，已省略。' } })
  }
  if (elements.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md',
      content: source.slice(0, CARD_DIV_MAX) || '定时任务已完成' } })
  }
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: options.footer ?? '原生定时任务 · 自动推送' }],
  })

  const template = options.template && TEMPLATES.has(options.template) ? options.template : 'blue'
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements,
  }
}
