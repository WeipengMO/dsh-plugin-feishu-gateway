import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * Regression test for the blank "定时任务" panel.
 *
 * The static assertions in client.test.mjs never actually execute the built
 * client bundle. SchedulePanel builds its tab fragments BEFORE the empty-model
 * branch, so a null model on the first render used to throw
 * `Cannot read properties of null (reading 'limits')`, which React surfaced as
 * an entirely blank panel. Execute the real built bundle in a VM and render the
 * component with both a null and a populated model.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = readFileSync(path.join(root, 'lib/client.js'), 'utf8')

function loadPanel() {
  let source = built
  // Expose the component that lives inside the module factory.
  source = source.replace('    module.exports.apply = apply\n',
    '    module.exports.apply = apply\n    module.exports.__diag = { SchedulePanel, Workbench };\n')
  assert.notEqual(source, built, 'factory export marker not found in built client')

  function makeReact(firstValue) {
    let index = 0
    const values = [firstValue]
    return {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (init) => {
        const supplied = values[index]
        const value = supplied !== undefined ? supplied
          : (typeof init === 'function' ? init() : init)
        index += 1
        return [value, () => {}]
      },
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      Fragment: 'FRAGMENT',
    }
  }

  return (modelValue) => {
    const React = makeReact(modelValue)
    let spec
    const sandbox = {
      window: { __ModuleLoader__: { load: (value) => { spec = value } }, confirm: () => false },
      require: (name) => (name === 'react' ? React : {}),
      document: { visibilityState: 'visible', createElement: () => ({}), head: { appendChild() {} } },
      fetch: async () => ({ ok: true, json: async () => ({ ok: true, model: null }) }),
      console, Intl, Date, Math, JSON, String, Number, Array, Object, Promise, Error,
      RegExp, Boolean, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
      setInterval, clearInterval,
    }
    runInNewContext(source, sandbox, { filename: 'built-client.js' })
    assert.ok(spec && typeof spec.factory === 'function')
    const mod = spec.factory(sandbox.require)
    assert.equal(typeof mod.__diag.SchedulePanel, 'function')
    return mod.__diag.SchedulePanel({ state: null, onChanged: () => {} })
  }
}

const render = loadPanel()

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node === 'object' && node.children) {
    for (const child of node.children) collectText(child, out)
  }
  return out
}

test('SchedulePanel renders (does not throw) while the read model is still null', () => {
  let tree
  assert.doesNotThrow(() => { tree = render(null) })
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'fgw-schedule')
  const text = collectText(tree).join(' ')
  assert.match(text, /正在读取定时任务读模型|尚无定时任务读模型|任务列表|运行历史/)
})

test('SchedulePanel renders the task list once the read model is populated', () => {
  const model = {
    version: 1, ts: Date.now(), stale: false, available: true, reason: null,
    limits: { newSessionIntervalSeconds: 60 },
    tasks: [{ id: 'schedule-123', title: '早间新闻简报', status: 'active',
      prompt: 'run', spec: { kind: 'daily', time: '07:30:00', timeZone: 'Asia/Shanghai' },
      timeZone: 'Asia/Shanghai', scheduledAt: '2026-11-17T23:30:00.000Z',
      delivery: { botId: 'default', chatId: 'oc_1', chatType: 'group', notify: 'both' } }],
    deliveries: {}, runs: [], audit: [],
  }
  let tree
  assert.doesNotThrow(() => { tree = render(model) })
  const text = collectText(tree).join(' ')
  assert.match(text, /早间新闻简报/)
  assert.match(text, /新建会话间隔/)
})
