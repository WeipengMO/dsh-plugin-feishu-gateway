import { describe, expect, it } from 'vitest'
import { buildScheduleCard, CARD_TEXT_MAX } from '../../src/schedule/card.js'

const NEWS = [
  '📰 早间新闻简报 2026-11-16',
  '',
  '💰 财经要闻',
  '- [本周15股南向资金持股量环比增长超10%](https://36kr.com/x) — 港股回撤…',
  '- [住院病人去哪儿了？](https://m.thepaper.cn/y) — 记者调查…',
  '',
  '🚀 科技前沿',
  '- [AI 项目坟场](https://techcrunch.com/z) — 失败项目名单…',
  '',
  '共 3 条 · RSS 聚合去重',
].join('\n')

const MARKET = [
  '📈 A股收盘简报 2026-11-16',
  '概况：上证指数 🟢-0.59%；深证成指 🟢-2.05%',
  '行业：🔥 广播+4.11% ｜ ❄️ 林业-6.31%',
  '宽度：755涨/4472跌 · 成交16557亿',
  '数据状态：正常',
].join('\n')

describe('buildScheduleCard', () => {
  it('renders a news digest as a wide blue interactive card with sections', () => {
    const card = buildScheduleCard(NEWS) as {
      config: { wide_screen_mode: boolean }
      header: { title: { tag: string; content: string }; template: string }
      elements: Array<Record<string, unknown>>
    }
    expect(card.config.wide_screen_mode).toBe(true)
    expect(card.header.title).toMatchObject({ tag: 'plain_text', content: '📰 早间新闻简报 2026-11-16' })
    expect(card.header.template).toBe('blue')
    const divs = card.elements.filter((element) => element.tag === 'div')
    expect(divs).toHaveLength(3)
    expect((divs[0]!.text as { tag: string; content: string }).tag).toBe('lark_md')
    expect((divs[0]!.text as { content: string }).content).toContain('**💰 财经要闻**')
    expect((divs[0]!.text as { content: string }).content).toContain('https://36kr.com/x')
    expect((divs[1]!.text as { content: string }).content).toContain('**🚀 科技前沿**')
    expect((divs[2]!.text as { content: string }).content).toContain('共 3 条 · RSS 聚合去重')
    // Dividers between sections, but never a trailing one before the note.
    expect(card.elements.filter((element) => element.tag === 'hr')).toHaveLength(2)
    expect(card.elements.at(-1)).toMatchObject({ tag: 'note' })
    expect(card.elements.at(-2)!.tag).not.toBe('hr')
  })

  it('keeps a single-block brief as one content div', () => {
    const card = buildScheduleCard(MARKET) as {
      header: { title: { content: string } }; elements: Array<Record<string, unknown>>
    }
    expect(card.header.title.content).toBe('📈 A股收盘简报 2026-11-16')
    const divs = card.elements.filter((element) => element.tag === 'div')
    expect(divs).toHaveLength(1)
    expect((divs[0]!.text as { content: string }).content).toContain('概况：')
    expect((divs[0]!.text as { content: string }).content).toContain('数据状态：正常')
    expect(card.elements.some((element) => element.tag === 'hr')).toBe(false)
  })

  it('keeps blank lines between papers inside one topic section', () => {
    const RESEARCH = [
      '## 🔬 每日科研进展 2026-11-18',
      '',
      '📊 单细胞/空间转录组',
      '**Paper A**',
      'Nature · A · 2026-11-16',
      '研究亮点：A 🔗 [DOI](https://doi.org/10.1/a)',
      '',
      '**Paper B**',
      'Cell · B · 2026-11-15',
      '研究亮点：B 🔗 [DOI](https://doi.org/10.1/b)',
      '',
      '🧬 肿瘤生物学',
      '**Paper C**',
      'Science · C · 2026-11-14',
      '研究亮点：C 🔗 [DOI](https://doi.org/10.1/c)',
      '',
      '数据状态：正常',
    ].join('\n')
    const card = buildScheduleCard(RESEARCH) as {
      elements: Array<Record<string, unknown>>
    }
    const divs = card.elements.filter((element) => element.tag === 'div')
    expect(divs).toHaveLength(3)
    const first = (divs[0]!.text as { content: string }).content
    expect(first).toContain('**📊 单细胞/空间转录组**')
    expect(first).toContain('**Paper A**')
    expect(first).toContain('**Paper B**')
    expect(first).toContain('研究亮点：A 🔗 [DOI](https://doi.org/10.1/a)\n\n**Paper B**')
    // one divider per topic, never one per paper
    expect(card.elements.filter((element) => element.tag === 'hr')).toHaveLength(2)
    // the single-line status block must not be lost
    const last = (divs.at(-1)!.text as { content: string }).content
    expect(last).toContain('数据状态：正常')
  })


  it('keeps every article in a long topic even when one card div reaches its size limit', () => {
    const titles = ['Paper A', 'Paper B', 'Paper C', 'Paper D']
    const research = ['## 科研摘要', '', '📊 单细胞组学', ...titles.map((title, index) =>
      `**${title}**\nNature · 2026-11-18\n研究亮点：${'A'.repeat(600)} 文章终止标记${index}`)]
      .join('\n\n')
    const card = buildScheduleCard(research) as {
      elements: Array<{ tag: string; text?: { content: string } }>
    }
    const divs = card.elements.filter(item => item.tag === 'div')
    expect(divs.length).toBeGreaterThan(1)
    expect(card.elements.filter(item => item.tag === 'hr')).toHaveLength(0)
    expect(divs.every(item => (item.text?.content?.length ?? 0) <= 2000)).toBe(true)
    const combined = divs.map(item => item.text?.content).join('\n')
    for (const [index, title] of titles.entries()) {
      expect(combined).toContain(title)
      expect(combined).toContain('文章终止标记' + index)
    }
  })

  it('does not merge independent bold section headings or wrap their emphasis twice', () => {
    const card = buildScheduleCard('任务结果\n\n**任务状态**\n正常\n\n**关键结果**\n执行成功') as {
      elements: Array<{ tag: string; text?: { content: string } }>
    }
    const divs = card.elements.filter(item => item.tag === 'div')
    expect(divs).toHaveLength(2)
    expect(card.elements.filter(item => item.tag === 'hr')).toHaveLength(1)
    expect(divs[0]?.text?.content).toContain('**任务状态**')
    expect(divs[1]?.text?.content).toContain('**关键结果**')
    expect(JSON.stringify(divs)).not.toContain('****')
  })

  it('is safe for empty text, unknown templates and oversized/control input', () => {
    const empty = buildScheduleCard('') as { elements: Array<Record<string, unknown>> }
    expect((empty.elements[0]!.text as { content: string }).content).toBe('定时任务已完成')

    const orange = buildScheduleCard('标题\n\n正文', { template: 'orange' }) as {
      header: { template: string }; elements: Array<Record<string, unknown>>
    }
    expect(orange.header.template).toBe('orange')
    expect(buildScheduleCard('x', { template: 'not-a-colour' })).toHaveProperty(
      'header.template', 'blue')

    const dirty = `标题\u0007\n\n${'- 正文\n'.repeat(400)}`
    const card = buildScheduleCard(dirty) as { elements: Array<Record<string, unknown>> }
    const all = JSON.stringify(card)
    expect(all).not.toContain('\u0007')
    expect(all.length).toBeLessThan(CARD_TEXT_MAX * 4)
    expect(card.elements.filter((element) => element.tag === 'div').length).toBeLessThanOrEqual(12)
  })

  it('uses the supplied footer note', () => {
    const card = buildScheduleCard('标题\n\n正文', { footer: '自定义页脚' }) as {
      elements: Array<{ tag: string; elements?: Array<{ content: string }> }>
    }
    const note = card.elements.find((element) => element.tag === 'note')
    expect(note?.elements?.[0]?.content).toBe('自定义页脚')
  })
})
