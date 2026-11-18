import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const admin = readFileSync(path.join(root, 'src/client.js'), 'utf8')
const usage = readFileSync(path.join(root, 'src/usage-panel.js'), 'utf8')
const h = (type, props, ...children) => ({ type, props: props || {}, children })

function createStateHarness() {
  const values = []
  let cursor = 0
  return {
    useState: initial => {
      const slot = cursor++
      if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial
      return [values[slot], next => { values[slot] =
        typeof next === 'function' ? next(values[slot]) : next }]
    },
    render: (component, props) => { cursor = 0; return component(props) },
  }
}

test('model picker searches, selects and responds to keyboard without native dropdown', () => {
  const src = admin.slice(admin.indexOf('function ModelPicker('),
    admin.indexOf('/*__PROXY_HELPERS_START__*/'))
  assert.ok(src.startsWith('function ModelPicker('))
  const hooks = createStateHarness()
  const ModelPicker = runInNewContext(src + '\nModelPicker', {
    h, useState: hooks.useState, Math, String, Array,
  })
  let choice = ''
  const props = {
    id: 'model-picker-test', options: [
      { key: 'deepseek/model', name: 'DeepSeek-V4', model: 'model',
        provider: 'deepseek', providerName: 'DeepSeek Account' },
      { key: 'magpie/hy4', name: 'Hy4 flash', model: 'hy4',
        provider: 'magpie', providerName: 'routing group' },
    ], selectedKey: '', onChoose: key => { choice = key; props.selectedKey = key },
    ariaLabel: '搜索主模型',
  }
  let tree = hooks.render(ModelPicker, props)
  assert.equal(tree.children[1], false)
  tree.children[0].children[0].props.onFocus()
  tree = hooks.render(ModelPicker, props)
  assert.equal(tree.children[1].props.role, 'listbox')
  assert.equal(tree.children[1].children[0].length, 2)

  tree.children[0].children[0].props.onChange({ target: { value: 'deep' } })
  tree = hooks.render(ModelPicker, props)
  const options = tree.children[1].children[0]
  assert.equal(options.length, 1)
  assert.equal(options[0].props.role, 'option')
  options[0].props.onClick()
  assert.equal(choice, 'deepseek/model')
  tree = hooks.render(ModelPicker, props)
  assert.equal(tree.children[1], false)
  assert.match(tree.children[0].children[0].props.value, /DeepSeek-V4/)

  tree.children[0].children[0].props.onFocus()
  tree = hooks.render(ModelPicker, props)
  tree.children[0].children[0].props.onKeyDown({ key: 'Escape' })
  tree = hooks.render(ModelPicker, props)
  assert.equal(tree.children[1], false)
})

test('usage chart responds to pointer inspection, click pin and keyboard navigation', () => {
  const src = usage.slice(usage.indexOf('function UsageTrendChart('),
    usage.indexOf('function UsagePanel()'))
  assert.ok(src.startsWith('function UsageTrendChart('))
  const hooks = createStateHarness()
  const UsageTrendChart = runInNewContext(src + '\nUsageTrendChart', {
    h, React: { useRef: () => ({ current: null }), Fragment: 'fragment' },
    useState: hooks.useState, useEffect: () => {},
    Math, Number, String, Array, Set,
    wbCount: value => String(value), usageCompact: value => String(Math.round(value)),
  })
  const rows = [
    { key: 'd1', label: 'Mon', start: '2026-11-16', end: '2026-11-16',
      calls: 3, tokens: 30, partial: false },
    { key: 'd2', label: 'Tue', start: '2026-11-17', end: '2026-11-17',
      calls: 7, tokens: 50, partial: false },
    { key: 'd3', label: 'Wed', start: '2026-11-18', end: '2026-11-18',
      calls: 2, tokens: 10, partial: true },
  ]
  const props = { title: '有用量记录的任务', rows, kind: 'calls',
    value: 12, unit: '次', description: '历史任务', granularity: 'day' }
  let tree = hooks.render(UsageTrendChart, props)
  let svg = tree.children[1].children[0]
  const point = (key, pos) => ({
    key, clientX: pos,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 720 }) },
    preventDefault() {},
  })
  svg.props.onPointerMove(point('pointermove', 370))
  tree = hooks.render(UsageTrendChart, props)
  assert.match(JSON.stringify(tree.children[2]), /2026-11-17/)
  assert.match(JSON.stringify(tree.children[2]), /7/)
  svg = tree.children[1].children[0]
  svg.props.onClick(point('click', 370))
  tree = hooks.render(UsageTrendChart, props)
  assert.match(JSON.stringify(tree.children[2]), /清除选择/)
  tree.children[1].children[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  tree = hooks.render(UsageTrendChart, props)
  assert.match(JSON.stringify(tree.children[2]), /2026-11-18/)
  tree.children[1].children[0].props.onKeyDown({ key: 'Escape', preventDefault() {} })
  tree = hooks.render(UsageTrendChart, props)
  assert.doesNotMatch(JSON.stringify(tree.children[2]), /清除选择/)
})
