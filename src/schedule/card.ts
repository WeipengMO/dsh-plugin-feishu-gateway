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
  // A digest may separate individual items with blank lines inside one topic
  // (e.g. research papers). Fold item-only blocks back into the previous block
  // so the topic stays ONE section and produces only ONE divider. An item block
  // starts with bold text (the paper title); topic labels and status lines do not.
  const blocks: string[] = []
  for (const block of rawBlocks) {
    if (/^\*\*/.test(block) && blocks.length > 0) {
      blocks[blocks.length - 1] += '\n\n' + block
    } else {
      blocks.push(block)
    }
  }
  const firstLines = first.split('\n').map((line) => line.trim()).filter(Boolean)
  const rawTitle = firstLines.shift() ?? '定时任务结果'
  const title = rawTitle.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').slice(0, CARD_TITLE_MAX) ||
    '定时任务结果'
  const sections = [
    ...(firstLines.length ? [firstLines.join('\n')] : []),
    ...blocks,
  ].slice(0, CARD_SECTION_MAX)

  const elements: Record<string, unknown>[] = []
  for (const section of sections) {
    // Keep blank lines INSIDE a section: they give visual spacing between items
    // without becoming new sections/dividers.
    const rawLines = section.split('\n').map((line) => line.trim())
    const nonEmpty = rawLines.filter(Boolean)
    if (!nonEmpty.length) continue
    const firstIndex = rawLines.findIndex((line) => line.length > 0)
    const heading = nonEmpty.length > 1 && !nonEmpty[0]!.startsWith('- ')
      ? `**${nonEmpty[0]}**` : undefined
    // With a heading, skip it; without one (single-line status, or a list-only
    // section) keep the first non-empty line in the body.
    const body = rawLines.slice(heading ? firstIndex + 1 : firstIndex)
    const content = [heading, ...body].filter((part) => part !== undefined)
      .join('\n').slice(0, CARD_DIV_MAX)
    elements.push({ tag: 'div', text: { tag: 'lark_md', content } })
    elements.push({ tag: 'hr' })
  }
  if (elements.length > 0) elements.pop() // no trailing divider before the note
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
