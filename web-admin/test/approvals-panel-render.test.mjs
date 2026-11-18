import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * Render tests for the "审批审计" tab (kind === 'approvals').
 *
 * Like schedule-panel-render.test.mjs this executes the real built client
 * bundle in a VM so the component tree is exercised, not just the source text.
 * The mock React stores elements as plain objects; renderText() below resolves
 * function components so tables, badges and the live countdown are inspected.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = readFileSync(path.join(root, 'lib/client.js'), 'utf8')

function load() {
  const effects = []
  const intervals = []
  const clears = []
  let nextInterval = 1
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: init => {
      const value = typeof init === 'function' ? init() : init
      return [value, () => {}]
    },
    useEffect: fn => { effects.push(fn) },
    useCallback: fn => fn,
    useMemo: fn => fn(),
    Fragment: 'FRAGMENT',
  }
  let spec
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { spec = value } }, confirm: () => false },
    require: name => (name === 'react' ? React : {}),
    document: { visibilityState: 'visible', createElement: () => ({}), head: { appendChild() {} } },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, model: null }) }),
    console, Intl, Date, Math, JSON, String, Number, Array, Object, Promise, Error,
    RegExp, Boolean, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
    setInterval: fn => { const id = nextInterval++; intervals.push({ id, fn }); return id },
    clearInterval: id => clears.push(id),
  }
  const source = built.replace('    module.exports.apply = apply\n',
    '    module.exports.apply = apply\n' +
    '    module.exports.__diag = { ApprovalsPanel, ApprovalCountdown, OpsPage };\n')
  assert.notEqual(source, built, 'factory export marker not found in built client')
  runInNewContext(source, sandbox, { filename: 'built-client.js' })
  assert.ok(spec && typeof spec.factory === 'function')
  const mod = spec.factory(sandbox.require)
  assert.equal(typeof mod.__diag.ApprovalsPanel, 'function')
  assert.equal(typeof mod.__diag.ApprovalCountdown, 'function')
  return { diag: mod.__diag, effects, intervals, clears }
}

/** Flush collected effects (useEffect) and return their cleanup functions. */
function flush(effects) {
  const cleanups = []
  for (const fn of effects) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return cleanups
}

function renderPanel(model) {
  const { diag } = load()
  return diag.ApprovalsPanel({ model, onConfig: () => {}, onRefresh: () => {} })
}

function renderText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderText).join(' ')
  if (typeof node === 'object' && node.type) {
    if (typeof node.type === 'function') {
      const props = { ...node.props }
      if (node.children && node.children.length) {
        props.children = node.children.length === 1 ? node.children[0] : node.children
      }
      return renderText(node.type(props))
    }
    const children = node.children && node.children.length
      ? node.children : (node.props.children === undefined ? [] : [].concat(node.props.children))
    return children.map(renderText).join(' ')
  }
  return ''
}

function mockModel() {
  const now = Date.now()
  return {
    version: 1, ts: now, available: true, reason: null, timeoutMs: 600000,
    pending: [{ ref: 'a'.repeat(16), botId: 'default', chatRef: 'b'.repeat(16),
      tool: 'bash', command: 'lark-cli calendar +agenda',
      requestedAt: now - 1000, expiresAt: now + 65000 }],
    rules: [{ ref: 'c'.repeat(16), tool: 'bash', commandRoot: 'lark-cli',
      label: 'bash · lark-cli*', createdAt: now - 5000, createdByRef: 'd'.repeat(16),
      lastUsedAt: null, uses: 3 }],
    records: [
      { ts: now - 100, tool: 'bash', command: 'lark-cli im +send',
        decision: 'allowed-permanent', botId: 'default', chatRef: 'e'.repeat(16),
        ruleRef: 'c'.repeat(16), elapsedMs: 42 },
      { ts: now - 200, tool: 'bash', command: null, decision: 'rejected',
        botId: 'default', chatRef: 'e'.repeat(16), ruleRef: null, elapsedMs: null },
      { ts: now - 300, tool: 'bash', command: 'lark-cli drive +export',
        decision: 'auto-allowed', botId: 'default', chatRef: 'e'.repeat(16),
        ruleRef: 'c'.repeat(16), elapsedMs: 5 },
      { ts: now - 400, tool: 'bash', command: null, decision: 'timed-out',
        botId: 'default', chatRef: 'e'.repeat(16), ruleRef: null, elapsedMs: null },
    ],
    recordLimit: 200,
  }
}

test('approvals tab renders a safe fallback when the read model is missing', () => {
  let tree
  assert.doesNotThrow(() => { tree = renderPanel(null) })
  const text = renderText(tree)
  assert.match(text, /尚无审批读模型/)
  assert.match(text, /ops-approvals\.json/)
  assert.match(text, /不会显示伪造的审批或授权/)
  assert.match(text, /修改审批卡片设置/)
})

test('approvals tab renders pending, permanent rules and recent decisions', () => {
  let tree
  assert.doesNotThrow(() => { tree = renderPanel(mockModel()) })
  const text = renderText(tree)
  // Metrics: counts, wait ceiling and bounded record window.
  for (const label of ['待审批数量', '永久授权数量', '审批等待时长（分钟）', '最近审批条数']) {
    assert.ok(text.includes(label), label)
  }
  assert.match(text, /待审批数量 1 /)
  assert.match(text, /永久授权数量 1 /)
  assert.match(text, /最近审批条数\s+4/)
  assert.match(text, /10 分钟/)
  assert.match(text, /最多保留\s+200\s+条/)
  // Pending row: tool + command summary + live countdown.
  assert.match(text, /lark-cli calendar \+agenda/)
  assert.match(text, /\b\d+:\d{2}\b/)
  // Permanent rule row: label, creator ref, usage count and the revoke action.
  assert.match(text, /bash · lark-cli\*/)
  assert.ok(text.includes('d'.repeat(16)))
  assert.match(text, /尚未使用/)
  assert.match(text, /撤销/)
  // Recent decisions: badge labels for allowlisted decisions.
  assert.match(text, /永久允许/)
  assert.match(text, /已拒绝/)
  assert.match(text, /自动允许/)
  assert.match(text, /超时/)
  assert.match(text, /lark-cli im \+send/)
  // The page must state that revoke is only authoritative after the Gateway acts.
  assert.match(text, /撤销申请需要由飞书通道处理/)
  assert.match(text, /原授权仍可能有效/)
})

test('approvals tab renders an unavailable model without fabricating rows', () => {
  const tree = renderPanel({
    version: 1, ts: Date.now(), available: false,
    reason: 'DSH native approval service is not mounted in this profile',
    timeoutMs: 600000, pending: [], rules: [], records: [], recordLimit: 200,
  })
  const text = renderText(tree)
  assert.match(text, /审批读模型当前不可用/)
  assert.match(text, /native approval service is not mounted/)
  assert.match(text, /当前没有等待中的审批请求/)
  assert.match(text, /暂无永久授权规则/)
  assert.match(text, /暂无审批记录/)
  // Unavailable counts are reported as unknown, never as a fabricated zero.
  assert.match(text, /待审批数量 —/)
  assert.match(text, /永久授权数量 —/)
})

test('approvals tab tolerates malformed arrays, hostile fields and expired pending rows', () => {
  const tree = renderPanel({
    available: true, timeoutMs: 'not-a-number', recordLimit: 'nope',
    pending: [{ ref: 'a'.repeat(16), tool: 'bash',
      command: 'x\nrm -rf /tmp/y', requestedAt: Date.now(),
      expiresAt: Date.now() - 1000 }],
    rules: 'not-an-array',
    records: null,
  })
  const text = renderText(tree)
  assert.match(text, /已过期/) // countdown clamps at 0
  assert.match(text, /当前没有等待中的审批请求|暂无永久授权规则|暂无审批记录/)
  assert.match(text, /审批等待时长（分钟）\s+—/) // non-numeric timeout is unknown
  assert.match(text, /最多保留\s+200\s+条/) // bounded fallback
})

test('ApprovalCountdown ticks once per second and clears its interval on unmount', () => {
  const { diag, effects, intervals, clears } = load()
  const future = Date.now() + 65000
  const tree = diag.ApprovalCountdown({ expiresAt: future })
  assert.match(renderText(tree), /^\d+:\d{2}$/)
  const cleanups = flush(effects)
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].id, 1)
  assert.equal(cleanups.length, 1)
  cleanups[0]()
  assert.deepEqual(clears, [1])

  const expired = renderPanel({
    version: 1, ts: Date.now(), available: true, timeoutMs: 600000,
    pending: [{ ref: 'a'.repeat(16), tool: 'bash', command: null,
      requestedAt: Date.now() - 2000, expiresAt: Date.now() - 1000 }],
    rules: [], records: [], recordLimit: 200,
  })
  assert.match(renderText(expired), /已过期/)
})
