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
  assert.ok(native.includes('/sessions/native/delete/preview'))
  assert.ok(native.includes('/sessions/native/delete'))
  assert.ok(native.includes('FeishuSessionModal'))
  assert.ok(native.includes('aria-modal'))
  assert.ok(!native.includes('window.confirm('))
  assert.ok(!pages.slice(pages.indexOf('function FeishuSessionsInventory()')).includes('window.confirm('))
  assert.ok(css.includes('.fgw-modal-backdrop'))
  assert.ok(css.includes('.fgw-session-modal-ack'))
  assert.ok(workbench.includes("conversations: [['sessions', '会话管理'], ['tasks', '实时任务'], ['messages', '消息投递']]"))
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
  assert.match(workbench, /profileUnsaved\s*&&/)
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
    source: 'managed', configured: true, display: 'http://100.75.51.18:2080',
    envName: 'MY_PROXY', envConfigured: true } })
  assert.equal(managed.available, true)
  assert.equal(managed.source, 'managed')
  assert.equal(managed.configured, true)
  assert.equal(managed.envConfigured, true)
  assert.equal(managed.display, 'http://100.75.51.18:2080')
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
    JSON.stringify({ enabled: true, fallbackDirect: true }))
  assert.equal(JSON.stringify(api.networkProxyPayload({ fallbackDirect: false })),
    JSON.stringify({ enabled: false, fallbackDirect: false }))
  assert.equal(JSON.stringify(api.networkProxyPayload({ url: '  http://127.0.0.1:7890  ' })),
    JSON.stringify({ enabled: false, fallbackDirect: true, url: 'http://127.0.0.1:7890' }))
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
  assert.match(panel, /title: '已上报用量任务'/)
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
  assert.equal(tree.children[0].children[0].children.length, 1)
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
  assert.match(nav, /'conversations', '会话与消息'/)
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
