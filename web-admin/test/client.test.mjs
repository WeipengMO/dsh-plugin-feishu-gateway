import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(root, 'src/client.js'), 'utf8')
const workbench = readFileSync(path.join(root, 'src/workbench.js'), 'utf8')
const built = readFileSync(path.join(root, 'lib/client.js'), 'utf8')

test('admin client registers the same DSH native id for sidebar and main panel', () => {
  assert.match(source, /ctx\.slots\.inject\('main'/)
  assert.match(source, /name: 'main', key: WORKBENCH_PANEL_ID/)
  assert.match(source, /ctx\.slots\.inject\('sidebar\.panellist'/)
  assert.match(source, /name: 'sidebar\.panellist', id: WORKBENCH_PANEL_ID/)
  assert.match(workbench, /WORKBENCH_PANEL_ID = 'feishu-management'/)
  assert.match(source, /ctx\.slots\.inject\('settings\.section'/)
  assert.match(source, /\}, CredentialSettings\)\)/)
  assert.doesNotMatch(built, /__WORKBENCH_CODE__|__CSS_TEXT__/)
  assert.match(built, /function Workbench\(/)
  assert.match(built, /function CredentialSettings\(/)
  assert.match(built, /\.fgw-root/)
})

test('management dashboard uses the existing authenticated read endpoints and no LLM calls', () => {
  assert.match(workbench, /request\('\/state'\)/)
  assert.match(workbench, /request\('\/health'\)/)
  assert.match(workbench, /request\('\/ops'\)/)
  assert.match(workbench, /15000/)
  assert.match(workbench, /document\.visibilityState !== 'visible'/)
  assert.doesNotMatch(workbench, /llm\.|chat\.completions|fetch\(['"]https?:|openai\.com/)
})

test('settings are credential-only and the workbench does not echo secrets', () => {
  assert.match(workbench, /function CredentialSettings\(/)
  assert.match(workbench, /request\('\/credentials', 'PUT', payload\)/)
  assert.match(workbench, /type: 'password'/)
  assert.match(workbench, /setAppId\(''\); setAppSecret\(''\)/)
  assert.match(workbench, /不会在任何管理 API 中回显/)
  assert.doesNotMatch(workbench, /App Secret[^\n]*value:/)
  assert.doesNotMatch(source, /action\('安全保存凭据', saveSecret/)
  assert.match(source, /\}, CredentialSettings\)\)/)
})

test('operations panels display real data and configuration actions', () => {
  const pages = readFileSync(path.join(root, 'src/ops-pages.js'), 'utf8')
  for (const page of ['overview', 'bots', 'tasks', 'messages', 'sessions', 'approvals',
      'agent-profile',
      'usage', 'alerts', 'security', 'diagnostics', 'advanced']) {
    assert.ok(workbench.includes("'" + page + "'"), page)
  }
  assert.match(workbench, /root 'main'/)
  assert.match(workbench, /onConfig/)
  assert.match(workbench, /h\(Panel, \{ key: configTab, initialTab: configTab, onChanged: load \}\)/)
  assert.match(pages, /function OpsPage\(/)
  assert.match(pages, /Token 用量趋势/)
  assert.match(pages, /审批审计/)
  assert.match(pages, /Session 绑定/)
  assert.match(pages, /uncertain/)
  assert.match(built, /function OpsPage\(/)
  assert.match(source, /window\.confirm\(/)
})
