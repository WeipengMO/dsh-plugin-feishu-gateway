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
  const profile = readFileSync(path.join(root, 'src/agent-profile-ui.js'), 'utf8')
  assert.match(profile, /function AgentProfilePanel\(/)
  assert.match(profile, /AGENTS\.local\.md/)
  assert.match(profile, /agent-profile\/restore/)
  assert.match(profile, /agent-profile\/settings/)
  assert.match(profile, /function ProfilePreview\(/)
  assert.doesNotMatch(profile, /dangerouslySetInnerHTML|innerHTML/)
  assert.match(built, /function AgentProfilePanel\(/)
})


test('Agent profile uses one focused editor instead of three persistent content columns', () => {
  const profile = readFileSync(path.join(root, 'src/agent-profile-ui.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(profile, /fgw-profile-shell/)
  assert.match(profile, /fgw-profile-document/)
  assert.match(profile, /fgw-profile-nav/)
  assert.match(profile, /fgw-profile-mobile-files/)
  for (const name of ['编辑', '预览', '版本历史', '加载配置']) {
    assert.ok(profile.includes(name), name)
  }
  assert.match(css, /\.fgw-profile-shell\{display:grid;grid-template-columns:222px minmax\(0,1fr\)/)
  assert.match(css, /@media\(max-width:690px\)/)
  assert.match(css, /\.fgw-profile-textarea\{[^}]*flex:1;[^}]*width:100%/)
  assert.doesNotMatch(css, /\.fgw-profile-columns|\.fgw-profile-right/)
  assert.doesNotMatch(profile, /fgw-profile-title/)
  assert.doesNotMatch(profile, /dangerouslySetInnerHTML|\.innerHTML/)
  assert.match(built, /fgw-profile-document/)
})

test('Agent profile keeps draft safeguards and native backend contracts', () => {
  const profile = readFileSync(path.join(root, 'src/agent-profile-ui.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  for (const route of ['agent-profile/file', 'agent-profile/history',
    'agent-profile/settings', 'agent-profile/restore', 'agent-profile/sync',
    'agent-profile/detach-legacy']) {
    assert.ok(profile.includes(route), route)
  }
  assert.match(profile, /expectedRevision:\s*file\.revision/)
  assert.match(profile, /event\.ctrlKey\s*\|\|\s*event\.metaKey/)
  assert.match(profile, /beforeunload/)
  assert.match(profile, /onDirtyChange/)
  assert.match(workbench, /profileUnsaved\s*&&/)
  assert.match(workbench, /fgw-content-profile/)
  assert.match(css, /fgw-profile-primary/)
  assert.match(css, /fgw-profile-setting-card/)
  assert.match(profile, /AGENTS\.local\.md/)
})
