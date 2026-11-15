import { describe, expect, it } from 'vitest'
import { extractFeishuPostText, feishuMarkdownContent } from '../../src/channel/post-content.js'

describe('Feishu post parsing', () => {
  it('accepts text-only post with multiple paragraphs, Markdown and links', () => {
    const raw = JSON.stringify({ zh_cn: { title: '报告', content: [
      [{ tag: 'text', text: '请阅读：' }, { tag: 'a', text: '文档', href: 'https://example.org/path' }],
      [{ tag: 'md', text: '**重点** 和表格' }],
      [{ tag: 'hr' }],
    ] } })
    expect(extractFeishuPostText(raw)).toBe('报告\n请阅读：[文档](https://example.org/path)\n**重点** 和表格\n---')
  })
  it('accepts the flat locale shape Feishu may send', () => {
    expect(extractFeishuPostText(JSON.stringify({ title: 'Hi',
      content: [[{ tag: 'text', text: 'hello' }]] }))).toBe('Hi\nhello')
  })
  it('refuses images, mentions, files and unknown nodes instead of silently dropping them', () => {
    for (const tag of ['img', 'at', 'media', 'file', 'unknown']) {
      expect(extractFeishuPostText(JSON.stringify({ zh_cn: {
        content: [[{ tag: 'text', text: 'inspect this' }, { tag, image_key: 'img_abc' }]],
      } }))).toBe('')
    }
  })
  it('rejects malformed and oversized post payloads', () => {
    expect(extractFeishuPostText('{invalid')).toBe('')
    expect(extractFeishuPostText(JSON.stringify({ zh_cn: { content: 'bad' } }))).toBe('')
    expect(extractFeishuPostText('a'.repeat(150_000))).toBe('')
  })
  it('retains link text but not a javascript: URL', () => {
    const raw = JSON.stringify({ en_us: { content: [[{ tag: 'a', text: 'click', href: 'javascript:alert(1)' }]] } })
    expect(extractFeishuPostText(raw)).toBe('click')
  })
})

describe('Feishu Markdown post generation', () => {
  it('renders GFM syntax using official post/md content', () => {
    const doc = JSON.parse(feishuMarkdownContent('# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |')) as any
    expect(doc.zh_cn.content[0][0]).toEqual({ tag: 'md', text: expect.stringContaining('| A | B |') })
  })
  it('truncates long UTF-8 replies under the Feishu 30KiB request limit', () => {
    const content = feishuMarkdownContent('汉'.repeat(12_000))
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(30 * 1024)
    const doc = JSON.parse(content) as any
    expect(doc.zh_cn.content[0][0].text).toContain('已截断')
  })
})
