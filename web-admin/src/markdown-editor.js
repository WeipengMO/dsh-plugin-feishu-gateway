/* Dependency-free Markdown editor for the Feishu workbench.
 * Editing remains native textarea for IME, selection, clipboard and undo.
 * Highlight overlay is React text nodes, never HTML or external scripts.
 */
const PROFILE_MD_LINE_HEIGHT = 24
const PROFILE_MD_PAD_TOP = 20
const PROFILE_MD_PAD_LEFT = 22

function profileMarkdownInline(source) {
  const output = []
  const pattern = /(\x60+[^\x60\n]+\x60+|\[[^\]\n]+\]\([^) \n]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<>()]+)/g
  let offset = 0
  let found
  while ((found = pattern.exec(source)) !== null) {
    if (found.index > offset) output.push({ kind: 'plain', text: source.slice(offset, found.index) })
    const text = found[0]
    const kind = text.startsWith('\x60') ? 'inline-code'
      : text.startsWith('[') || text.startsWith('http') ? 'link'
        : text.startsWith('**') || text.startsWith('__') ? 'strong'
          : text.startsWith('~~') ? 'strike' : 'em'
    output.push({ kind, text })
    offset = found.index + text.length
  }
  if (offset < source.length) output.push({ kind: 'plain', text: source.slice(offset) })
  return output
}

/** Every character of the original string appears in token.text in order. */
function profileMarkdownAnalyze(source) {
  const lines = source.split('\n')
  const result = []
  let fence = null
  for (const line of lines) {
    const boundary = /^(\s*)(\x60{3,}|~{3,})([^\n]*)$/.exec(line)
    if (boundary) {
      const mark = boundary[2]
      const close = fence && fence.char === mark[0] &&
        mark.length >= fence.count && boundary[3].trim() === ''
      if (!fence || close) {
        result.push([
          ...(boundary[1] ? [{ kind: 'plain', text: boundary[1] }] : []),
          { kind: 'fence', text: mark },
          ...(boundary[3] ? [{ kind: 'language', text: boundary[3] }] : []),
        ])
        fence = close ? null : { char: mark[0], count: mark.length }
        continue
      }
    }
    if (fence) {
      result.push(line ? [{ kind: 'code', text: line }] : [])
      continue
    }
    const heading = /^(\s*)(#{1,6})(\s+)(.*)$/.exec(line)
    if (heading) {
      result.push([
        ...(heading[1] ? [{ kind: 'plain', text: heading[1] }] : []),
        { kind: 'marker', text: heading[2] },
        { kind: 'plain', text: heading[3] },
        ...(heading[4] ? [{ kind: 'heading', text: heading[4] }] : []),
      ])
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      result.push([{ kind: 'marker', text: line }]); continue
    }
    const quote = /^(\s*)(>+)(\s*)(.*)$/.exec(line)
    if (quote) {
      result.push([
        ...(quote[1] ? [{ kind: 'plain', text: quote[1] }] : []),
        { kind: 'marker', text: quote[2] },
        ...(quote[3] ? [{ kind: 'plain', text: quote[3] }] : []),
        ...profileMarkdownInline(quote[4]).map(token =>
          token.kind === 'plain' ? { kind: 'quote', text: token.text } : token),
      ])
      continue
    }
    const task = /^(\s*)([-*+])(\s+)(\[[ xX]\])(\s*)(.*)$/.exec(line)
    if (task) {
      result.push([
        ...(task[1] ? [{ kind: 'plain', text: task[1] }] : []),
        { kind: 'marker', text: task[2] },
        { kind: 'plain', text: task[3] },
        { kind: 'checkbox', text: task[4] },
        ...(task[5] ? [{ kind: 'plain', text: task[5] }] : []),
        ...profileMarkdownInline(task[6]),
      ])
      continue
    }
    const list = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/.exec(line)
    if (list) {
      result.push([
        ...(list[1] ? [{ kind: 'plain', text: list[1] }] : []),
        { kind: 'marker', text: list[2] },
        { kind: 'plain', text: list[3] },
        ...profileMarkdownInline(list[4]),
      ])
      continue
    }
    result.push(profileMarkdownInline(line))
  }
  return result
}

function profileMarkdownCursor(value, position) {
  const safe = Math.min(value.length, Math.max(0, position))
  const prefix = value.slice(0, safe)
  const last = prefix.lastIndexOf('\n')
  return { line: prefix.split('\n').length, column: safe - last }
}

/** Only visible lines get DOM nodes, even for a 24 KiB file of blank rows. */
function MarkdownCodeEditor({ value, onChange, disabled, fileName }) {
  const inputRef = React.useRef(null)
  const [viewport, setViewport] = React.useState({ top: 0, left: 0, height: 620 })
  const [cursor, setCursor] = React.useState({ line: 1, column: 1 })
  const [lineNumbers, setLineNumbers] = React.useState(true)
  const tokens = React.useMemo(() => profileMarkdownAnalyze(value), [value])
  const start = Math.max(0, Math.floor((viewport.top - PROFILE_MD_PAD_TOP) / PROFILE_MD_LINE_HEIGHT) - 8)
  const end = Math.min(tokens.length,
    Math.ceil((viewport.top + viewport.height) / PROFILE_MD_LINE_HEIGHT) + 8)
  const visible = tokens.slice(start, end)
  const numberWidth = Math.max(46, String(tokens.length).length * 9 + 20)
  const offsetTop = PROFILE_MD_PAD_TOP + start * PROFILE_MD_LINE_HEIGHT - viewport.top
  const updateCursor = input => setCursor(profileMarkdownCursor(input.value, input.selectionStart))
  const updateViewport = input => setViewport(previous => {
    const next = { top: input.scrollTop, left: input.scrollLeft, height: input.clientHeight }
    return previous.top === next.top && previous.left === next.left && previous.height === next.height
      ? previous : next
  })
  React.useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const update = () => updateViewport(input)
    update()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(update)
      observer.observe(input)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const onKeyDown = event => {
    if (event.key !== 'Tab' || event.shiftKey || disabled) return
    event.preventDefault()
    const input = event.currentTarget
    input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end')
    onChange(input.value)
    updateCursor(input)
  }
  return h('div', { className: 'fgw-md-editor' },
    h('div', { className: 'fgw-md-toolbar' },
      h('div', { className: 'fgw-md-toolbar-label' },
        h('span', { className: 'fgw-md-language-badge' }, 'M↓'),
        h('span', null, 'Markdown'),
        h('span', { className: 'fgw-md-muted' }, '语法高亮')),
      h('button', { type: 'button', className: 'fgw-md-lines-toggle' + (lineNumbers ? ' is-active' : ''),
        'aria-pressed': lineNumbers, onClick: () => setLineNumbers(v => !v) }, '行号')),
    h('div', { className: 'fgw-md-editor-surface' },
      lineNumbers && h('div', { className: 'fgw-md-gutter', 'aria-hidden': true,
        style: { width: numberWidth } },
        h('div', { className: 'fgw-md-gutter-lines', style: { top: offsetTop } },
          visible.map((_, index) => h('div', { key: start + index,
            className: 'fgw-md-gutter-line' + (cursor.line === start + index + 1 ? ' is-active' : '') },
            start + index + 1)))),
      h('div', { className: 'fgw-md-viewport' },
        h('div', { className: 'fgw-md-active-line', 'aria-hidden': true,
          style: { top: PROFILE_MD_PAD_TOP + (cursor.line - 1) * PROFILE_MD_LINE_HEIGHT - viewport.top } }),
        h('div', { className: 'fgw-md-ink', 'aria-hidden': true,
          style: { transform: 'translate3d(' + (-viewport.left) + 'px,' + (-viewport.top) + 'px,0)' } },
          h('div', { className: 'fgw-md-ink-lines',
            style: { paddingTop: PROFILE_MD_PAD_TOP + start * PROFILE_MD_LINE_HEIGHT,
              paddingLeft: PROFILE_MD_PAD_LEFT } },
            visible.map((line, index) =>
              h('div', { key: start + index, className: 'fgw-md-line' },
                line.map((token, i) => h('span',
                  { key: i, className: 'fgw-md-token-' + token.kind }, token.text)),
                line.length === 0 ? '\u200b' : null)))),
        h('textarea', { ref: inputRef, className: 'fgw-md-input', value, disabled,
          onChange: event => { onChange(event.target.value); updateCursor(event.target) },
          onScroll: event => updateViewport(event.currentTarget),
          onSelect: event => updateCursor(event.currentTarget),
          onKeyUp: event => updateCursor(event.currentTarget),
          onKeyDown, spellCheck: false, autoCorrect: 'off', autoCapitalize: 'off',
          'aria-label': fileName + ' Markdown 编辑器',
          placeholder: '# ' + fileName + '\n\n在这里编写 Markdown…',
          wrap: 'off' }))),
    h('div', { className: 'fgw-md-status' },
      h('span', null, 'Ln ', cursor.line, ', Col ', cursor.column),
      h('span', null, tokens.length, ' 行'),
      h('span', null, 'UTF-8 · 空格缩进')))
}
