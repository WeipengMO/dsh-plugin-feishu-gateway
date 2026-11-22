import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

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

test('all admin dropdowns share one theme-aware control spec', () => {
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(css, /\.fga-root,\s*\.fgw-root\s*\{[^}]*--fgw-control-radius:\s*9px/)
  assert.match(css, /\.fga-root select,\s*\.fgw-root select\s*\{[\s\S]*?appearance:\s*none/)
  assert.match(css, /\.fga-root select:focus-visible,[\s\S]*?box-shadow:\s*0 0 0 2px/)
  assert.match(css, /\.fga-root select option[\s\S]{0,260}--popover/)
  assert.match(css, /\.fga-search-picker-field\s*\{[^}]*--fgw-control-height/)
  assert.match(css, /\.fga-seg-btn\s*\{[^}]*--fgw-control-height/)
  assert.doesNotMatch(css, /\.fga-root select[^{]*\{[^}]*background-image:\s*url\(/)
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
  assert.match(workbench, /WORKBENCH_TABS/)
  assert.match(workbench, /hideTabs: true/)
  assert.match(workbench, /fgw-section-tabs/)
  assert.match(pages, /function OpsPage\(/)
  assert.match(pages, /Token 用量趋势/)
  assert.match(pages, /审批审计/)
  assert.match(pages, /飞书聊天关联/)
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


test('Session center exposes one archive view and safe in-page dialogs', () => {
  const native = readFileSync(path.join(root, 'src/native-session-panel.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  const pages = readFileSync(path.join(root, 'src/ops-pages.js'), 'utf8')
  const workbench = readFileSync(path.join(root, 'src/workbench.js'), 'utf8')
  assert.ok(pages.includes('FeishuSessionCenter'))
  for (const title of ['对话历史','已归档','飞书聊天关联','恢复','删除']) {
    assert.ok(native.includes(title), title)
  }
  assert.ok(native.includes("['archive','已归档']"))
  assert.ok(!native.includes("['recycle','回收站']"))
  assert.ok(!native.includes("['trash','回收站']"))
  assert.ok(native.includes('@michengai/dsh-archive-manager'))
  const server = readFileSync(path.join(root, 'src/server.mjs'), 'utf8')
  assert.ok(server.includes('createArchiveManagerDeleter('))
  assert.ok(!server.includes("ctx.get('sessionAdmin')"))
  for (const label of ['批量归档', '批量恢复', '批量删除', '选择本页', '清空选择']) {
    assert.ok(native.includes(label), label)
  }
  assert.ok(native.includes('fgw-native-session-checkbox'))
  assert.ok(native.includes("['archive','已归档']"))
  assert.ok(native.includes('/sessions/native/batch/preview'))
  assert.ok(native.includes('/sessions/native/batch/execute'))
  const organizer = readFileSync(path.join(root, 'src/session-organizer.mjs'), 'utf8')
  assert.ok(organizer.includes('validateNativeSessionBatch'))
  assert.ok(organizer.includes('executeNativeSessionBatch'))
  assert.ok(css.includes('.fgw-session-selection-toolbar'))
  assert.ok(css.includes('.fgw-native-session-checkbox'))
  assert.ok(native.includes('/sessions/native/batch/preview'))
  assert.ok(native.includes('/sessions/native/batch/execute'))
  const serverSource = readFileSync(path.join(root, 'src/server.mjs'), 'utf8')
  assert.ok(serverSource.includes('/sessions/native/delete/preview'))
  assert.ok(serverSource.includes('/sessions/native/delete'))
  assert.ok(native.includes('FeishuSessionModal'))
  assert.ok(native.includes('aria-modal'))
  assert.ok(!native.includes('window.confirm('))
  assert.ok(!pages.slice(pages.indexOf('function FeishuSessionsInventory()')).includes('window.confirm('))
  assert.ok(css.includes('.fgw-modal-backdrop'))
  assert.ok(css.includes('.fgw-session-modal-ack'))
  assert.ok(workbench.includes("conversations: [['tasks', '实时任务'], ['messages', '消息投递']]"))
  assert.ok(workbench.includes("['sessions', '会话管理'"))
  assert.match(workbench, /selected === 'sessions'/)
  assert.ok(!workbench.includes("onConfig('settings') }, '模型与连接'"))
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
  assert.match(workbench, /selected === 'agent-profile' \? profileUnsaved/)
  assert.match(workbench, /fgw-content-profile/)
  assert.match(css, /fgw-profile-primary/)
  assert.match(css, /fgw-profile-setting-card/)
  assert.match(profile, /AGENTS\.local\.md/)
})

test('every workbench view shares one page-frame spec (no Agent 档案 margin drift)', () => {
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  // One source of truth: gutters, column width and header spacing are tokens on .fgw-content.
  assert.match(css, /\.fgw-content \{[^}]*--fgw-gutter-x:clamp\(18px,4vw,54px\)/)
  assert.match(css, /\.fgw-content \{[^}]*--fgw-page-max:1280px/)
  assert.match(css, /\.fgw-content \{[^}]*--fgw-header-gap:26px/)
  assert.match(css, /padding:var\(--fgw-gutter-top\) var\(--fgw-gutter-x\) var\(--fgw-gutter-bottom\)/)
  assert.match(css, /\.fgw-content > \* \{ max-width:var\(--fgw-page-max,1280px\)/)
  assert.match(css, /margin-bottom:var\(--fgw-header-gap,26px\)/)
  // Responsive frames adjust the tokens only; no duplicated raw padding values.
  assert.ok(css.includes('--fgw-gutter-x:20px'))
  assert.ok(css.includes('--fgw-gutter-x:15px'))
  assert.doesNotMatch(css, /\.fgw-content \{[^}]*padding:\d/)
  // Agent 档案 no longer declares its own gutters, column width or header spacing,
  // neither in source nor in the built client bundle.
  for (const text of [css, built]) {
    assert.doesNotMatch(text, /\.fgw-content-profile\s*\{[^}]*padding:/)
    assert.doesNotMatch(text, /\.fgw-content-profile>\*\{max-width:/)
    assert.doesNotMatch(text, /\.fgw-content-profile \.fgw-topbar\{margin-bottom:/)
    assert.doesNotMatch(text, /1580px|clamp\(16px,2\.6vw,34px\)/)
  }
  // The semantic hook is still applied to the profile view.
  assert.match(workbench, /fgw-content-profile/)
})


test('network proxy panel uses the new admin endpoints and never echoes a saved URL', () => {
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(source, /request\('\/network-proxy\/test', 'POST'/)
  assert.match(source, /request\('\/network-proxy\/import-env', 'POST'/)
  assert.match(source, /request\('\/config', 'PUT'/)
  assert.match(source, /request\('\/restart', 'POST'/)
  assert.match(source, /networkProxyView\(state\)/)
  assert.match(source, /data\.networkProxy/)
  // The proxy address is shown as plain text: no password-style masking and no
  // legacy env-var-name field.
  assert.match(source, /type: 'text'[^}]*name: 'feishu-proxy-url'/)
  assert.doesNotMatch(source, /proxyShow|setProxyShow|proxyEnv|setProxyEnv|fga-secret-toggle|fga-secret-row/)
  assert.ok(!source.includes('代理 URL 环境变量名'))
  assert.ok(!source.includes("type: 'password'"))
  assert.match(source, /placeholder: 'http:\/\/127\.0\.0\.1:7890'/)
  assert.match(source, /value: proxyUrl/)
  for (const label of ['测试连接', '从服务器环境变量导入', '清除已保存地址',
    '保存并重启飞书通道', '启用代理', '代理预检失败则启动时回退直连',
    '当前来源：', '生效地址：', '修改后需重启独立飞书通道']) {
    assert.ok(source.includes(label), label)
  }
  assert.match(source, /window\.confirm\([^)]*重启/)
  // Saved URL is write-only: component state is only reset or set by typing.
  const assignments = [...new Set(source.match(/setProxyUrl\([^)]*\)/g) || [])].sort()
  assert.deepEqual(assignments, ["setProxyUrl('')", 'setProxyUrl(e.target.value)'])
  assert.doesNotMatch(source, /networkProxy\?\.url\b|networkProxy\.url\b/)
  assert.match(source, /networkProxyPayload\(\{/)
  assert.match(source, /proxyCleared/)
  // "已保存" and the clear action only apply to a managed URL (or a corrupt
  // stored file that must stay recoverable from the UI), not an env-only fallback.
  assert.match(source, /proxy\.source === 'managed'/)
  assert.match(source, /\(proxy\.source === 'managed' \|\| proxy\.storedError\) && !proxyCleared/)
  assert.match(source, /proxy\.storedError/)
  assert.match(source, /proxy\.envConfigured && action\('从服务器环境变量导入'/)
  assert.match(css, /\.fga-proxy-status/)
  assert.match(css, /\.fga-proxy-source/)
  assert.doesNotMatch(css, /\.fga-secret-row|\.fga-secret-toggle/)
  assert.match(css, /\.fga-inline-actions/)
  assert.match(built, /network-proxy\/import-env/)
  assert.match(built, /networkProxyPayload/)
})

test('network proxy helpers degrade gracefully on an older backend and keep the URL write-only', async () => {
  const { runInNewContext } = await import('node:vm')
  const block = source.split('/*__PROXY_HELPERS_START__*/')[1].split('/*__PROXY_HELPERS_END__*/')[0]
  assert.ok(block && block.length > 200)
  const api = runInNewContext(block +
    '\n({ networkProxyView, networkProxyPayload, proxySourceLabel, proxySafeMessage, ' +
    'proxyErrorText, proxyRedactUrl })', {})
  // rc.9 backend: /state has no networkProxy field at all.
  const legacy = api.networkProxyView({
    revision: 3, config: { networkProxy: { enabled: true, fallbackDirect: false } },
  })
  assert.equal(legacy.available, false)
  assert.equal(legacy.enabled, true)
  assert.equal(legacy.fallbackDirect, false)
  assert.equal(legacy.source, 'none')
  assert.equal(legacy.configured, false)
  assert.equal(legacy.envConfigured, false)
  assert.equal(legacy.display, '')
  assert.equal(api.networkProxyView(null).source, 'none')
  assert.equal(api.networkProxyView(undefined).available, false)
  assert.equal(api.networkProxyView({}).available, false)
  // Managed state from the new backend.
  const managed = api.networkProxyView({ networkProxy: { enabled: true, fallbackDirect: true,
    source: 'managed', configured: true, display: 'http://192.0.2.18:2080',
    envName: 'MY_PROXY', envConfigured: true } })
  assert.equal(managed.available, true)
  assert.equal(managed.source, 'managed')
  assert.equal(managed.configured, true)
  assert.equal(managed.envConfigured, true)
  assert.equal(managed.display, 'http://192.0.2.18:2080')
  assert.equal('urlEnv' in managed, false)
  // Env-only fallback: configured but not managed, so no "已保存" claim.
  const envOnly = api.networkProxyView({ networkProxy: { source: 'env', configured: true,
    display: 'http://10.0.0.2:3128', envName: 'MY_PROXY', envConfigured: true } })
  assert.equal(envOnly.source, 'env')
  assert.equal(envOnly.configured, true)
  assert.equal(envOnly.envConfigured, true)
  assert.equal(api.proxySourceLabel('managed'), '管理后台')
  assert.equal(api.proxySourceLabel('env'), '服务器环境变量')
  assert.equal(api.proxySourceLabel('none'), '未配置')
  // A corrupt stored file is ignored by the backend and stays recoverable from
  // the UI: the view exposes storedError so the clear action remains available.
  assert.equal(api.networkProxyView({ networkProxy: { source: 'env', configured: true,
    storedError: true, display: 'http://10.0.0.2:3128' } }).storedError, true)
  assert.equal(api.networkProxyView({ networkProxy: { source: 'none' } }).storedError, false)
  // Defensive redaction: userinfo never reaches the DOM even if a display URL has it.
  assert.equal(api.proxyRedactUrl('http://user:secret@10.0.0.2:3128/x'), 'http://10.0.0.2:3128/x')
  assert.equal(api.networkProxyView({ networkProxy: { source: 'env',
    display: 'http://user:secret@10.0.0.2:3128' } }).display, 'http://10.0.0.2:3128')
  // Payload rules: enabled/fallbackDirect always; url only when typed or explicitly cleared.
  // The legacy env-var name is no longer sent (the backend applies its default).
  assert.equal(JSON.stringify(api.networkProxyPayload({ enabled: true })),
    JSON.stringify({ enabled: true, fallbackDirect: true, noProxy: 'localhost,127.0.0.1,::1' }))
  assert.equal(JSON.stringify(api.networkProxyPayload({ fallbackDirect: false })),
    JSON.stringify({ enabled: false, fallbackDirect: false, noProxy: 'localhost,127.0.0.1,::1' }))
  assert.equal(JSON.stringify(api.networkProxyPayload({ url: '  http://127.0.0.1:7890  ' })),
    JSON.stringify({ enabled: false, fallbackDirect: true, noProxy: 'localhost,127.0.0.1,::1', url: 'http://127.0.0.1:7890' }))
  assert.equal(api.networkProxyPayload({ cleared: true }).url, null)
  assert.equal('url' in api.networkProxyPayload({}), false)
  assert.equal('url' in api.networkProxyPayload({ url: '   ' }), false)
  assert.equal(api.networkProxyPayload({ url: 'http://127.0.0.1:7890', cleared: true }).url,
    'http://127.0.0.1:7890')
  // Stable error text only: no URL, no userinfo, no raw driver message.
  assert.match(api.proxySafeMessage('connect ECONNREFUSED http://user:secret@127.0.0.1:9'),
    /^connect ECONNREFUSED \[地址已隐藏\]$/)
  assert.equal(api.proxySafeMessage('ETIMEDOUT'), 'ETIMEDOUT')
  assert.equal(api.proxySafeMessage(undefined), '')
  assert.equal(api.proxySafeMessage(null), '')
  // Stable server messages are mapped to actionable Chinese hints.
  assert.match(api.proxyErrorText('no proxy configured'), /尚未配置代理地址/)
  assert.match(api.proxyErrorText('invalid proxy url'), /代理地址格式无效/)
  assert.match(api.proxyErrorText('invalid networkProxy'), /代理配置无效/)
  assert.match(api.proxyErrorText('proxy url not found in env file'), /没有找到该代理变量/)
  assert.match(api.proxyErrorText('systemd user service unavailable; configure x.service and retry'), /systemd 用户服务不可用/)
  assert.match(api.proxyErrorText('config changed; reload before saving'), /刷新后重试/)
  assert.match(api.proxyErrorText('connect ECONNREFUSED http://127.0.0.1:9'), /^connect ECONNREFUSED \[地址已隐藏\]$/)
  assert.equal(api.proxyErrorText(undefined), '未知错误')
})

test('network proxy save-and-restart saves first, then restarts with confirmation', () => {
  const saveAndRestart = source.split('const saveAndRestart = async () => {')[1]
    .split('const updateBot')[0]
  assert.match(saveAndRestart, /window\.confirm\(/)
  const saveAt = saveAndRestart.indexOf("request('/config', 'PUT'")
  const restartAt = saveAndRestart.indexOf("request('/restart', 'POST'")
  assert.ok(saveAt >= 0 && restartAt > saveAt, 'restart must follow a successful save')
  assert.match(saveAndRestart, /expectedRevision: state\.revision/)
  assert.match(source, /const testProxy = async \(\) => \{/)
  assert.match(source, /const importProxyEnv = async \(\) => \{/)
  assert.match(source, /const clearProxyUrl = \(\) => \{/)
  assert.match(source, /proxyErrorText\(e\?\.message \|\| e\)/)
})

test('model routing offers a unified searchable model picker and editable fallback chips', () => {
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(source, /\/\*__MODEL_ROUTE_HELPERS_START__\*\//)
  assert.doesNotMatch(source, /主模型 Provider/)
  assert.doesNotMatch(source, /Fallback Provider/)
  for (const label of ['模型路由', '主模型', '备用模型', '搜索主模型',
    '搜索备用模型', '添加备用模型', '移除备用模型', 'fga-model-tag-remove']) {
    assert.ok(source.includes(label), label)
  }
  assert.match(source, /flatModelOptions\(directory\.providers\)/)
  assert.match(source, /result\.agent = route/)
  assert.match(source, /modelRoutePayload\(\{/)
  assert.match(css, /\.fga-model-multiselect/)
  assert.match(css, /@media\(max-width:660px\)/)
  assert.match(built, /fga-model-multiselect/)
  assert.match(built, /搜索主模型/)
  assert.match(built, /function flatModelOptions\(/)
})

test('model route helpers aggregate all providers, retain saved routes, and serialize ordered fallback choices', async () => {
  const { runInNewContext } = await import('node:vm')
  const block = source.split('/*__MODEL_ROUTE_HELPERS_START__*/')[1].split('/*__MODEL_ROUTE_HELPERS_END__*/')[0]
  assert.ok(block && block.length > 500)
  const api = runInNewContext(block + '\n({ modelDirectoryView, withRouteOptions, modelsForProvider, ' +
    'flatModelOptions, modelRoutePayload })', {})
  const plain = value => JSON.parse(JSON.stringify(value))
  const empty = api.modelDirectoryView({ config: {} })
  assert.equal(empty.primary, null)
  assert.deepEqual(plain(empty.fallbacks), [])
  assert.equal(empty.providers.length, 0)
  assert.equal(empty.catalogMissing, true)

  const view = api.modelDirectoryView({
    config: {},
    modelCatalog: { ts: 1, incomplete: true, providers: [
      { id: 'magpie', name: 'Magpie', models: [
        { id: 'group/deepseek', name: 'Deepseek' }, { id: 'group/hy4-free' }] },
      { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6', name: 'GPT-6' }] },
    ] },
    agentRoute: { provider: 'magpie', model: 'group/deepseek',
      fallbacks: [{ provider: 'openai', model: 'gpt-6' }, { provider: 'magpie', model: 'group/hy4-free' }] },
    profileDefaultRoute: { provider: 'magpie', model: 'group/deepseek' },
    modelDirectoryStale: true,
  })
  assert.equal(view.providers.length, 2)
  assert.equal(api.flatModelOptions(view.providers).length, 3)
  assert.deepEqual(plain(view.fallbacks), [
    { provider: 'openai', model: 'gpt-6' },
    { provider: 'magpie', model: 'group/hy4-free' },
  ])
  assert.equal(view.primary.source, 'effective')
  assert.equal(view.incomplete, true)
  assert.equal(view.stale, true)

  // Saved routes stay selectable even when an old provider disappears.
  const saved = api.modelDirectoryView({ config: { agent: {
    provider: 'missing', model: 'retired/model',
    fallbacks: [{ provider: 'openai', model: 'gpt-6' }],
  } } })
  assert.equal(saved.primary.source, 'saved')
  assert.equal(saved.providers[0].unlisted, true)
  assert.equal(saved.providers[0].models[0].unlisted, true)
  assert.deepEqual(plain(saved.fallbacks), [{ provider: 'openai', model: 'gpt-6' }])

  // Saved [] explicitly wins over the still-live old fallback.
  const cleared = api.modelDirectoryView({
    config: { agent: { provider: 'magpie', model: 'group/deepseek', fallbacks: [] } },
    agentRoute: { provider: 'magpie', model: 'group/deepseek',
      fallback: { provider: 'magpie', model: 'group/hy4-free' } },
  })
  assert.deepEqual(plain(cleared.fallbacks), [])
  const legacy = api.modelDirectoryView({ agentRoute: {
    provider: 'magpie', model: 'group/deepseek',
    fallback: { provider: 'magpie', model: 'group/hy4-free' },
  } })
  assert.deepEqual(plain(legacy.fallbacks), [{ provider: 'magpie', model: 'group/hy4-free' }])
  const primary = { provider: 'magpie', model: 'group/deepseek' }
  assert.deepEqual(plain(api.modelRoutePayload({
    ...primary, fallbacks: [
      { provider: 'openai', model: 'gpt-6' },
      { provider: 'magpie', model: 'group/hy4-free' },
      { provider: 'openai', model: 'gpt-6' },
      primary,
    ],
  })), { ...primary, fallbacks: [
    { provider: 'openai', model: 'gpt-6' },
    { provider: 'magpie', model: 'group/hy4-free' },
  ] })
  assert.deepEqual(plain(api.modelRoutePayload({ ...primary, fallbacks: [] })),
    { ...primary, fallbacks: [] })
  assert.deepEqual(plain(api.modelRoutePayload({ ...primary,
    fallback: { provider: 'openai', model: 'gpt-6' } })),
  { ...primary, fallbacks: [{ provider: 'openai', model: 'gpt-6' }] })
  assert.equal(api.modelRoutePayload({ provider: 'magpie' }), null)
  assert.equal(api.modelRoutePayload(undefined), null)
  assert.deepEqual(plain(api.modelsForProvider(view.providers, 'missing')), [])
})

test('settings expose the agent preset selector and persist the chosen working mode', () => {
  assert.match(source, /Agent 预设（飞书工作模式）/)
  assert.match(source, /沿用现有设置（继承）/)
  assert.match(source, /使用 DSH 默认组合（不指定预设）/)
  assert.match(source, /还没有获取到预设列表/)
  assert.match(source, /result\.agentPreset = agentPreset/)
  assert.match(source, /setAgentPreset\(/)
  assert.match(source, /const \[agentPreset, setAgentPreset\] = useState\('__inherit__'\)/)
  assert.match(source, /selectedKey: agentPreset, onChoose: setAgentPreset/)
  assert.doesNotMatch(source, /value: presetDirectory\.selected,\s*'aria-label': 'Agent 预设'/)
  assert.match(source, /const presetSelectedVisible = agentPreset === '__inherit__'/)
  assert.match(built, /Agent 预设（飞书工作模式）/)
  assert.match(built, /function agentPresetView\(/)
})

test('agent preset view exposes the sanitized roster and saved selection without inventing a default', () => {
  const block = source.split('/*__MODEL_ROUTE_HELPERS_START__*/')[1].split('/*__MODEL_ROUTE_HELPERS_END__*/')[0]
  const api = runInNewContext(block + '\n({ agentPresetView })', {})
  const plain = value => JSON.parse(JSON.stringify(value))

  const empty = api.agentPresetView({ config: {} })
  assert.deepEqual(plain(empty.presets), [])
  // Absent key means "inherit": the form must not write a value.
  assert.equal(empty.selected, '__inherit__')
  assert.equal(empty.managed, false)
  assert.equal(empty.catalogMissing, true)
  assert.equal(empty.stale, false)
  assert.equal(empty.defaultId, '')
  assert.equal(api.agentPresetView(undefined).catalogMissing, true)
  // A managed empty string is an explicit "no preset", not inherit.
  assert.equal(api.agentPresetView({ config: { agentPreset: '' } }).selected, '')
  assert.equal(api.agentPresetView({ config: { agentPreset: '' } }).managed, true)

  const view = api.agentPresetView({
    agentPresets: { ts: 1, incomplete: false, defaultId: 'planner', presets: [
      { id: 'planner', name: 'Planner', description: 'Plans work', isDefault: true },
      { id: 'coder', isDefault: false, broken: 'missing preset files' },
    ] },
    config: { agentPreset: 'coder' },
    modelDirectoryStale: true,
  })
  assert.deepEqual(plain(view.presets), [
    { id: 'planner', name: 'Planner', description: 'Plans work', isDefault: true, broken: '' },
    { id: 'coder', name: 'coder', description: '', isDefault: false, broken: 'missing preset files' },
  ])
  assert.equal(view.selected, 'coder')
  assert.equal(view.defaultId, 'planner')
  assert.equal(view.catalogMissing, false)
  assert.equal(view.stale, true)
})

test('usage heatmap is a labelled calendar with a theme-aware ramp and one shared tooltip', () => {
  const panel = readFileSync(path.join(root, 'src/usage-panel.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(panel, /function UsageHeatmap/)
  // Calendar axes: month labels, weekday gutter and a week-per-column grid.
  assert.match(panel, /fgw-heatmap-months/)
  assert.match(panel, /fgw-heatmap-weekdays/)
  assert.match(panel, /className: 'fgw-heatmap-week'/)
  assert.match(panel, /role: 'grid'/)
  // One shared tooltip instead of hundreds of native title attributes.
  assert.match(panel, /fgw-heat-tip/)
  assert.match(panel, /aria-label': cellLabel\(day\)/)
  assert.match(panel, /fgw-heat-today/)
  assert.doesNotMatch(panel, /title: tooltip/)
  // Theme-aware ramp and adaptive cell sizes come from CSS variables.
  assert.match(css, /\.fgw-heat-1 \{ background:color-mix\(in srgb,var\(--primary/)
  assert.match(css, /\.fgw-heat-today \{/)
  assert.match(css, /\.fgw-heatmap-scroll \{[^}]*border-radius:11px/)
  assert.match(css, /\.fgw-heat-tip \{[^}]*position:fixed/)
  assert.match(css, /\.fgw-heatmap-xl \{ --fgw-heat-cell:26px; \}/)
  assert.match(built, /fgw-heatmap-foot/)
})

test('Markdown source editor provides line numbers, cursor highlight and safe colors without network dependencies', () => {
  const editor = readFileSync(path.join(root, 'src/markdown-editor.js'), 'utf8')
  const profile = readFileSync(path.join(root, 'src/agent-profile-ui.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(built, /function MarkdownCodeEditor\(/)
  assert.match(built, /profileMarkdownAnalyze/)
  assert.match(profile, /h\(MarkdownCodeEditor,\s*\{/)
  for (const name of ['fgw-md-gutter', 'fgw-md-gutter-line', 'fgw-md-active-line',
    'fgw-md-token-heading', 'fgw-md-token-inline-code', 'fgw-md-token-link',
    'fgw-md-token-fence', 'fgw-md-token-quote', 'fgw-md-input', 'fgw-md-status']) {
    assert.ok(css.includes(name) || editor.includes(name), name)
  }
  assert.match(editor, /onScroll: event => updateViewport/)
  assert.match(editor, /'aria-hidden': true/)
  assert.match(editor, /profileMarkdownCursor/)
  assert.match(editor, /ResizeObserver/)
  assert.doesNotMatch(editor, /dangerouslySetInnerHTML|innerHTML\s*=|https:\/\/.*cdn|document\.write/)
})

test('Markdown highlighting preserves source, fenced blocks and harmless literal HTML', async () => {
  const { runInNewContext } = await import('node:vm')
  const source = readFileSync(path.join(root, 'src/markdown-editor.js'), 'utf8')
  const api = runInNewContext(source + '\n({ profileMarkdownAnalyze, profileMarkdownCursor })', {})
  const sample = [
    '# 大肥鱼 **可靠**',
    '- [x] **已完成** [文档](https://example.org/a)',
    '> 这是 *说明*',
    '~~~js',
    'const key = "<script>alert(1)</script>"',
    '~~~',
    '普通文本',
    ''
  ].join('\n')
  const tokens = api.profileMarkdownAnalyze(sample)
  assert.equal(tokens.length, sample.split('\n').length)
  assert.equal(tokens.map(line => line.map(token => token.text).join('')).join('\n'), sample)
  const all = tokens.flat().map(token => token.kind)
  for (const kind of ['marker', 'heading', 'checkbox', 'strong', 'link', 'quote',
    'em', 'fence', 'language', 'code']) {
    assert.ok(all.includes(kind), kind)
  }
  assert.equal(tokens[4][0].kind, 'code')
  assert.equal(tokens[4][0].text, 'const key = "<script>alert(1)</script>"')
  assert.equal(api.profileMarkdownCursor('a\n中文b', 3).line, 2)
  assert.equal(api.profileMarkdownCursor('a\n中文b', 3).column, 2)
  const edge = ['## 你好 😀', 'a \x60snippet\x60 and ~~strike~~', '- one', '1. two', '', 'end'].join('\n')
  assert.equal(api.profileMarkdownAnalyze(edge).map(line => line.map(t => t.text).join('')).join('\n'), edge)
})


test('usage dashboard prioritizes a 365-day heatmap, separate date inputs and two charts', () => {
  const panel = readFileSync(path.join(root, 'src/usage-panel.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(panel, /function UsageDateRange/)
  assert.match(panel, /aria-label': '开始日期'/)
  assert.match(panel, /aria-label': '结束日期'/)
  assert.doesNotMatch(panel, /fgw-usage-range-popup/)
  assert.match(panel, /span >= 1 && span <= 366/)
  assert.match(panel, /const yearFrom = usageShiftDay\(today, -364\)/)
  assert.match(panel, /const yearUrl =/)
  assert.match(panel, /period: 'day'/)
  assert.match(panel, /title: 'Token 日历热图'/)
  assert.ok(panel.indexOf("title: 'Token 日历热图'") <
    panel.indexOf("className: 'fgw-usage-filters'"))
  assert.doesNotMatch(panel, /title: '时区（IANA）'/)
  assert.doesNotMatch(panel, /title: '按周期聚合'/)
  assert.match(panel, /title: '有用量记录的任务'/)
  assert.match(panel, /kind: 'calls'/)
  assert.match(panel, /kind: 'tokens'/)
  assert.match(panel, /usageTrendBuckets\(series\)/)
  assert.match(css, /@media\(max-width:690px\)[\s\S]*?\.fgw-usage-facets\.is-open \{ display:grid; \}/)
  assert.match(css, /\.fgw-usage-chart-grid \{ display:grid;/)
  assert.match(built, /function UsageTrendChart\(/)
})

test('model usage is a bar chart and the redundant model catalog panel is absent', () => {
  const panel = readFileSync(path.join(root, 'src/usage-panel.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(panel, /function UsageModelBars/)
  assert.match(panel, /h\(UsageModelBars, \{ rows: report.byModel, metricText \}\)/)
  assert.match(panel, /h\(UsageModelBars, \{ rows: report.byBot, metricText, kind: 'bot' \}\)/)
  assert.match(panel, /部分用量未上报或缺少分类明细/)
  assert.doesNotMatch(panel, /title: '飞书通道可用模型'/)
  assert.match(css, /\.fgw-usage-model-track/)
})

test('date fields apply only valid inclusive ranges', () => {
  const panel = readFileSync(path.join(root, 'src/usage-panel.js'), 'utf8')
  const code = panel.slice(panel.indexOf('function UsageDateRange('),
    panel.indexOf('/* The server still returns daily records;'))
  const changes = []
  const create = (type, props, ...children) => ({ type, props: props || {}, children })
  const make = (from, to) => {
    let index = 0
    const values = [from, to]
    const range = runInNewContext(code + '\nUsageDateRange', {
      h: create, React: { Fragment: 'fragment' }, UsageField: 'label',
      useState: () => [values[index++], () => {}], useEffect: () => {}, Date, Math,
    })
    return range({ from, to, onApply: (...args) => changes.push(args) })
  }
  const normal = make('2026-11-01', '2026-11-16')
  assert.equal(normal.children.length, 2)
  const start = normal.children[0].children[0]
  const end = normal.children[1].children[0]
  assert.equal(start.props['aria-label'], '开始日期')
  assert.equal(end.props['aria-label'], '结束日期')
  start.props.onChange({ target: { value: '2026-11-10' } })
  assert.deepEqual(changes, [['2026-11-10', '2026-11-16']])
  end.props.onChange({ target: { value: '2028-01-01' } })
  assert.equal(changes.length, 1)
  start.props.onChange({ target: { value: '2026-11-20' } })
  assert.equal(changes.length, 1)
})

test('model and bot bars scale values and reveal details on hover, touch and focus', () => {
  const panel = readFileSync(path.join(root, 'src/usage-panel.js'), 'utf8')
  const code = panel.slice(panel.indexOf('function UsageModelBars('), panel.indexOf('function UsageField('))
  let tip = null
  const bars = runInNewContext(code + '\nUsageModelBars', {
    h: (type, props, ...children) => ({ type, props: props || {}, children }),
    wbCount: value => String(value), Math, Number, String, Array,
    useState: () => [tip, value => { tip = value }], window: { innerWidth: 1000 },
  })
  const rows = [{ model: 'a', botId: 'bot-a', value: 100, calls: 3, unknownTurns: 0 },
    { model: 'b', botId: 'bot-b', value: 25, calls: 2, unknownTurns: 1 }]
  let tree = bars({ metricText: '总 Token', rows })
  assert.equal(tree.children[0].children[1].children[0].props.style.width, '100%')
  assert.equal(tree.children[1].children[1].children[0].props.style.width, '25%')
  assert.match(tree.children[1].children[2].children[0], /部分用量/)
  assert.equal(tree.children[0].children[0].children.length, 2)
  assert.equal(tree.children[0].children[0].children[1].children[0], '100')
  const event = { currentTarget: { getBoundingClientRect: () => ({ left: 20, width: 100, top: 200, bottom: 220 }) } }
  for (const handler of ['onMouseEnter', 'onTouchStart', 'onFocus']) {
    tip = null
    tree.children[1].props[handler](event)
    assert.equal(tip.row.value, 25)
    const shown = bars({ metricText: '总 Token', rows })
    assert.equal(shown.children.at(-1).props.role, 'tooltip')
    assert.equal(shown.children.at(-1).children[1].children[1].children[0], '25')
  }
  tree.children[1].props.onBlur()
  assert.equal(tip, null)
  const botTree = bars({ metricText: '输入 Token', rows, kind: 'bot' })
  assert.equal(botTree.children[0].children[0].children[0].children[0], 'bot-a')
  assert.equal(botTree.children[0].props.tabIndex, 0)
  assert.match(bars({ metricText: '总 Token', rows: [], kind: 'bot' }).children[0], /没有机器人用量记录/)
})

test('usage chart buckets maintain partial and unavailable coverage', () => {
  const panel = readFileSync(path.join(root, 'src/usage-panel.js'), 'utf8')
  const src = panel.slice(panel.indexOf('function usageTrendBuckets('),
    panel.indexOf('function usageCompact('))
  const buckets = runInNewContext(src + '\nusageTrendBuckets', {
    usageShiftDay: (date, offset) =>
      new Date(Date.parse(date + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10)
  })
  const dayRows = [
    { date: '2026-11-12', calls: 2, value: 100, coverage: 'recorded' },
    { date: '2026-11-13', calls: 0, value: null, coverage: 'unavailable' },
    { date: '2026-11-14', calls: 3, value: 40, coverage: 'partial' }
  ]
  const daily = buckets(dayRows)
  assert.equal(daily.granularity, 'day')
  assert.deepEqual(Array.from(daily.rows, x => x.tokens), [100, null, 40])
  assert.equal(daily.rows[1].calls, null)
  assert.equal(daily.rows[2].partial, true)

  const rows = Array.from({ length: 45 }, (_, i) => ({
    date: new Date(Date.parse('2026-09-01T00:00:00Z') + i * 86400000)
      .toISOString().slice(0, 10),
    calls: 1, value: 20, coverage: 'recorded'
  }))
  const weekly = buckets(rows)
  assert.equal(weekly.granularity, 'week')
  assert.equal(weekly.rows.reduce((sum, row) => sum + row.calls, 0), 45)
  assert.equal(weekly.rows.reduce((sum, row) => sum + row.tokens, 0), 900)
  const months = buckets(Array.from({ length: 120 }, (_, i) => ({
    ...rows[0], date: new Date(Date.parse('2026-01-01T00:00:00Z') +
      i * 86400000).toISOString().slice(0, 10)
  })))
  assert.equal(months.granularity, 'month')
  assert.equal(months.rows.reduce((sum, row) => sum + row.calls, 0), 120)
})

test('gateway workbench groups overlapping features instead of repeating nav entries', () => {
  const nav = workbench.slice(workbench.indexOf('const WORKBENCH_NAV = ['), workbench.indexOf('const WORKBENCH_TABS'))
  assert.match(nav, /'conversations', '任务与消息'/)
  assert.match(nav, /'sessions', '会话管理'/)
  assert.match(nav, /'channels', '接入与权限'/)
  assert.match(nav, /'analytics', '用量与审计'/)
  assert.doesNotMatch(nav, /\['bots',|\['security',|\['messages',|\['approvals',/)
  const tabs = workbench.slice(workbench.indexOf('const WORKBENCH_TABS'), workbench.indexOf('const WORKBENCH_DESCRIPTIONS'))
  for (const section of ['conversations', 'channels', 'analytics', 'operations']) {
    assert.match(tabs, new RegExp(section + ':'))
  }
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(css, /fgw-section-switcher/)
  assert.match(css, /fgw-shortcuts/)
  assert.match(css, /@media\(max-width:600px\)/)
})


test('bot management uses safe source switching, in-page confirmation and live checks', () => {
  assert.match(workbench, /function BotManagementPanel\(/)
  assert.match(workbench, /role: 'dialog', 'aria-modal': 'true'/)
  assert.match(workbench, /确认切换机器人配置来源/)
  assert.match(workbench, /使用 DSH 原有配置/)
  assert.match(workbench, /在此页面管理/)
  assert.match(workbench, /request\('\/health'\)/)
  assert.match(workbench, /未发送测试消息/)
  assert.match(workbench, /credential\?\.appIdMasked/)
  assert.match(workbench, /expectedRevision: state\.revision/)
  assert.match(workbench, /delete config\.bots/)
  assert.match(workbench, /config\.bots = nextBots\.map/)
  assert.doesNotMatch(source, /botsOverride|在此管理机器人（覆盖原 Profile/)
  assert.match(source, /if \(Array\.isArray\(existing\.bots\)\) result\.bots = existing\.bots/)
  assert.doesNotMatch(workbench, /initialTab: 'bots'/)
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(css, /fgw-bot-source-grid/)
  assert.match(css, /fgw-bot-modal-backdrop/)
  assert.match(css, /@media\(max-width:460px\)/)

  const block = workbench.slice(workbench.indexOf('function botListIssue('),
    workbench.indexOf('function BotManagementPanel('))
  const validate = runInNewContext(block + '\nbotListIssue')
  const bot = { id: 'default', domain: 'feishu', enabled: true }
  assert.equal(validate([bot]), '')
  assert.match(validate([]), /空列表/)
  assert.match(validate([{ ...bot, enabled: false }]), /不能全部禁用/)
  assert.match(validate([{ ...bot, id: 'INVALID' }]), /标识/)
  assert.match(validate([{ ...bot, id: 'a-b' }, { ...bot, id: 'a_b' }]), /冲突/)
  assert.match(validate(Array.from({ length: 9 }, (_, i) => ({ ...bot, id: 'b' + i }))), /最多/)
})

test('dashboard cards and settings stay centered as the DSH content column shrinks', () => {
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(css, /\.fgw-content\{container-type:inline-size;overflow-x:hidden\}/)
  assert.match(css, /\.fgw-content > \.fgw-shortcuts,\s*\.fgw-content > \.fgw-approval-metrics\{margin-inline:auto\}/)
  assert.match(css, /@container \(max-width:1000px\)/)
  assert.match(css, /@container \(max-width:650px\)/)
  assert.match(css, /\.fga-model-route-grid\{[\s\S]*?grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
  assert.match(source, /className: 'fga-model-route-grid'/)
  assert.match(source, /className: 'fga-model-card fga-model-primary'/)
  assert.match(source, /fga-model-unsaved/)
})

test('UX regression: schedule retains form until Gateway accepts the command', () => {
  const schedule = readFileSync(path.join(root, 'src/schedule-panel.js'), 'utf8')
  assert.match(schedule, /return true\s*\} catch \(e\) \{\s*setError\(schedErrorText\(e\)\)\s*return false/)
  assert.match(schedule, /void submit\(command\)\.then\(accepted => \{\s*if \(!accepted\) return/)
  assert.match(schedule, /setFormOpen\(false\); setEditing\(null\); setForm\(schedDefaultForm\(\)\)/)
  assert.match(schedule, /fgw-sched-detail-actions/)
})

test('UX regression: analytics responds to workbench width and supports touch selection', () => {
  const usage = readFileSync(path.join(root, 'src/usage-panel.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(usage, /new ResizeObserver\(update\)/)
  assert.match(usage, /root\.getBoundingClientRect\(\)\.width/)
  assert.doesNotMatch(usage, /window\.innerWidth < 690/)
  assert.match(usage, /onClick: event => showTip\(event, day, true\)/)
  assert.match(usage, /fgw-usage-model-value/)
  assert.match(css, /\.fga-model-preset\{grid-column:1\/-1/)
  assert.match(css, /\.fgw-usage-date-range/)
})

test('UX regression: every editable admin view uses a shared leave guard', () => {
  const group = readFileSync(path.join(root, 'src/group-panel.js'), 'utf8')
  const exec = readFileSync(path.join(root, 'src/exec-policy-panel.js'), 'utf8')
  const profile = readFileSync(path.join(root, 'src/agent-profile-ui.js'), 'utf8')
  assert.match(workbench, /const WORKBENCH_GROUPS =/)
  assert.match(workbench, /const dirtyForCurrent =/)
  assert.match(workbench, /const confirmLeave =/)
  assert.match(workbench, /onClick: \(\) => selectSection\(id\)/)
  for (const key of ['BotUnsaved', 'GroupUnsaved', 'ExecUnsaved', 'SettingsUnsaved']) {
    assert.ok(workbench.includes('onDirtyChange: set' + key), key)
  }
  assert.match(group, /onDirtyChange\?\.\(dirty\)/)
  assert.match(exec, /onDirtyChange\?\.\(dirty\)/)
  assert.match(source, /savedSignature/)
  assert.match(profile, /if \(!dirty && !settingsChanged\) return/)
})

test('UX regression: operations wording distinguishes queued actions from completed work', () => {
  const pages = readFileSync(path.join(root, 'src/ops-pages.js'), 'utf8')
  assert.match(pages, /重试发送待发消息/)
  assert.match(pages, /不能保证任务立即停止/)
  assert.match(pages, /飞书审批卡片/)
  assert.match(pages, /wbStateLabel\(item.state\)/)
})

test('UX regression: schedule draft is guarded across workbench navigation', () => {
  const schedule = readFileSync(path.join(root, 'src/schedule-panel.js'), 'utf8')
  assert.match(workbench, /selected === 'automation' \? scheduleUnsaved/)
  assert.match(workbench, /onDirtyChange: setScheduleUnsaved/)
  assert.match(schedule, /const formDirty = formOpen && JSON.stringify\(form\) !== formBaseline/)
  assert.match(schedule, /setFormBaseline\(JSON.stringify\(next\)\)/)
  assert.match(schedule, /onDirtyChange\?\.\(formDirty\)/)
})

test('UX regression: overview is actionable without redundant navigation or process diagrams', () => {
  const area = workbench.slice(workbench.indexOf("if (selected === 'overview')"),
    workbench.indexOf("} else if (selected === 'channels'"))
  assert.match(area, /fgw-overview-metrics/)
  assert.match(area, /需要关注/)
  assert.doesNotMatch(area, /fgw-shortcuts|fgw-flow|消息处理链路/)
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(css, /\.fgw-usage-date-range\s*\{[\s\S]*?border:1px/)
  assert.match(css, /\.fgw-hero\{[\s\S]*?padding:19px/)
})

test('model inputs are searchable comboboxes without duplicate native selectors', () => {
  const settings = source.slice(source.indexOf("tab === 'settings' &&"),
    source.indexOf("tab === 'permissions' &&"))
  assert.match(source, /function ModelPicker\(/)
  assert.match(settings, /h\(ModelPicker, \{ id: 'fga-primary-model'/)
  assert.match(settings, /h\(ModelPicker, \{ id: 'fga-fallback-model'/)
  assert.doesNotMatch(settings, /primarySearch|fallbackSearch|fga-model-add/)
  assert.match(source, /'aria-autocomplete': 'list'/)
  assert.match(source, /event.key === 'ArrowDown'/)
  assert.match(source, /event.key === 'Escape'/)
})

test('usage trends expose real pointer, click and keyboard data inspection', () => {
  const panel = readFileSync(path.join(root, 'src/usage-panel.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  const chart = panel.slice(panel.indexOf('function UsageTrendChart('),
    panel.indexOf('function UsagePanel()'))
  assert.match(chart, /onPointerMove: movePoint/)
  assert.match(chart, /onClick: togglePoint/)
  assert.match(chart, /onKeyDown: onChartKeys/)
  assert.match(chart, /fgw-usage-chart-inspector/)
  assert.match(chart, /fgw-usage-hover-guide/)
  assert.match(chart, /setFocusedIndex\(next\)/)
  assert.match(css, /\.fgw-usage-chart-inspector\{/)
})

test('visual system: session, approvals and security avoid redundant nested outlines', () => {
  const sessions = readFileSync(path.join(root, 'src/native-session-panel.js'), 'utf8')
  const ops = readFileSync(path.join(root, 'src/ops-pages.js'), 'utf8')
  const exec = readFileSync(path.join(root, 'src/exec-policy-panel.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(css, /--fgw-ui-gap-1:8px/)
  assert.match(css, /\.fgw-session-list \.fgw-block-head\{display:none\}/)
  assert.match(css, /\.fgw-approval-view \.fgw-empty\{/)
  assert.match(css, /\.fgw-security-detail-grid\{/)
  assert.doesNotMatch(sessions, /className:'fgw-session-intro'/)
  assert.match(ops, /fgw-approval-meta/)
  assert.match(workbench, /查看当前访问与审批状态/)
  assert.doesNotMatch(exec, /\/\/ Current-state summary chips/)
})

test('unsolicited UX audit: safe group editing, skill templates and compact navigation', () => {
  const groups = readFileSync(path.join(root, 'src/group-panel.js'), 'utf8')
  const skills = readFileSync(path.join(root, 'src/skills-panel.js'), 'utf8')
  const schedule = readFileSync(path.join(root, 'src/schedule-panel.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(groups, /Boolean\(senderDraft.trim\(\)\)/)
  assert.match(groups, /setExpanded\(old => Object.fromEntries/)
  assert.doesNotMatch(groups, /className: 'fgw-group-tag' \}, g.requireMention/)
  assert.match(skills, /newMode === 'import' \? '' : SKILL_TEMPLATE/)
  assert.doesNotMatch(schedule, /本地 2026-11-16T09:00:00/)
  assert.match(css, /\.fgw-session-tabs\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/)
  assert.match(workbench, /管理后台/)
})

test('empty approval lists use a compact row instead of three repeated giant cards', () => {
  const ops = readFileSync(path.join(root, 'src/ops-pages.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(ops, /compactEmpty = false/)
  for (const label of ['当前没有等待中的审批请求', '暂无永久授权规则', '暂无审批记录']) {
    assert.ok(ops.includes("empty: '" + label + "', compactEmpty: true"), label)
  }
  assert.match(css, /\.fgw-approval-view \.fgw-table-empty\{/)
})

test('Agent preset dropdown uses themed accessible options and legacy cwd stays protected', () => {
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(source, /h\(ModelPicker, \{ id: 'fga-agent-preset'/)
  assert.match(source, /key: '__inherit__'/)
  assert.match(source, /key: '', name: '使用 DSH 默认组合/)
  assert.doesNotMatch(source, /field\('原 DSH 工作目录（仅兼容）'/)
  assert.match(source, /if \(typeof existing.workspace === 'string' && existing.workspace.trim\(\)\)/)
  assert.match(css, /\.fga-model-preset \.fga-search-picker/)
})

test('refresh actions and inline desktop date+metric controls share consistent CSS', () => {
  const native = readFileSync(path.join(root, 'src/native-session-panel.js'), 'utf8')
  const usage = readFileSync(path.join(root, 'src/usage-panel.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(native, /fgw-refresh-action/)
  assert.match(usage, /fgw-refresh-action/)
  assert.match(source, /text.includes\('刷新'\)/)
  assert.match(workbench, /fgw-refresh fgw-refresh-action/)
  assert.match(css, /\.fgw-refresh-action::before\{/)
  assert.match(css, /\.fgw-usage-primary-fields > \.fgw-usage-date-range\s*\{\s*grid-column:auto/)
})

test('security editor uses a consistent heading/field rhythm without duplicate hints', () => {
  const editor = readFileSync(path.join(root, 'src/exec-policy-panel.js'), 'utf8')
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(editor, /只在「工作区可写」模式下使用/)
  assert.doesNotMatch(editor, /仅在「工作区可写」模式下生效，留空即不额外开放目录/)
  assert.match(css, /\.fgw-security-field-head\{margin:20px 0 10px/)
  assert.match(css, /\.fga-savebar\{margin-top:24px/)
  assert.match(css, /@container \(max-width:760px\)/)
})

test('group refresh and global workbench refresh cannot silently discard unsaved changes', () => {
  const group = readFileSync(path.join(root, 'src/group-panel.js'), 'utf8')
  assert.match(group, /const refreshWithGuard = \(\) =>/)
  assert.match(group, /dirty && !window.confirm\('群聊设置还有未保存/)
  assert.match(group, /onClick: refreshWithGuard/)
  assert.match(group, /if \(senderDraft.trim\(\)\)/)
  assert.match(group, /setSenderDraft\(''\); setSenderHint\(''\); setExpanded\(\{\}\)/)
  assert.match(workbench, /const refresh = \(\) => \{\s*if \(!confirmLeave\(\)\) return/)
  assert.match(workbench, /const hasLocalRefresh =/)
  assert.match(workbench, /!hasLocalRefresh &&/)
})

test('legacy Feishu chat types surface as unknown instead of guessing private from oc_ ids', () => {
  const service = readFileSync(path.join(root, 'src/session-organizer.mjs'), 'utf8')
  const sessions = readFileSync(path.join(root, 'src/native-session-panel.js'), 'utf8')
  const backend = readFileSync(path.join(root, 'src/server.mjs'), 'utf8')
  assert.match(service, /return 'unknown'/)
  assert.match(service, /'p2p', 'unknown'\]/)
  assert.match(sessions, /\['unknown','类型待确认'\]/)
  assert.match(sessions, /x.type==='p2p'\?'私聊':'类型待确认'/)
  assert.match(backend, /'schedule', 'unknown'\]/)
})

test('same-level navigation shares a segmented style and usage layout has one canonical grid', () => {
  const css = readFileSync(path.join(root, 'src/client.css'), 'utf8')
  assert.match(css, /\.fgw-section-tabs,\.fgw-session-tabs,\.fgw-sched-tabs\{/)
  assert.match(css, /\.fgw-section-tab.is-active,\.fgw-session-tab.is-active,\.fgw-sched-tab.is-active\{/)
  assert.equal((css.match(/\.fgw-usage-primary-fields\s*\{/g) || []).length, 2,
    'one desktop rule plus one container breakpoint; no stale intermediate overrides')
  assert.doesNotMatch(css, /fgw-usage-primary-fields > \.fgw-usage-field:nth-child\(3\)/)
  assert.match(css, /@container \(max-width:730px\)/)
})
