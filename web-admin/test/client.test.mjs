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
