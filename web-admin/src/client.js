/* DSH official settings.section client extension; no changes to DSH Core. */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-feishu-admin',
  factory: require => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback } = React
    const CSS = __CSS_TEXT__
    const API = '/api/feishu-admin'
    function request(endpoint, method = 'GET', payload) {
      const headers = method === 'GET' ? {} : {
        'content-type': 'application/json', 'x-dsh-feishu-admin': '1'
      }
      return fetch(API + endpoint, { method, headers, credentials: 'same-origin', cache: 'no-store',
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
        .then(async response => {
          const result = await response.json().catch(() => ({}))
          if (!response.ok || !result.ok) throw Error(result.error || ('HTTP ' + response.status))
          return result
        })
    }
    function textInput(value, set, placeholder, options = {}) {
      return h('input', { className: 'fga-input', value, placeholder, onChange: e => set(e.target.value),
        spellCheck: false, autoComplete: 'off', ...options })
    }
    function field(label, child, desc) {
      return h('label', { className: 'fga-field' }, h('span', { className: 'fga-label' }, label), child,
        desc && h('span', { className: 'fga-hint' }, desc))
    }
    function action(text, callback, busy, secondary = false) {
      return h('button', { type: 'button', className: 'fga-button' + (secondary ? ' fga-secondary' : ''),
        onClick: callback, disabled: busy }, text)
    }
    function Stat({ name, value, help }) {
      return h('div', { className: 'fga-stat' },
        h('span', { className: 'fga-hint' }, name),
        h('strong', { className: 'fga-stat-value' }, String(value ?? '—')),
        help && h('span', { className: 'fga-hint' }, help))
    }
    function Header({ health, service }) {
      const status = health?.health?.status
      const online = status === 'ok'
      return h('div', { className: 'fga-header' },
        h('div', null, h('h2', null, '飞书通道管理'),
          h('p', null, '独立运行的 DSH Feishu Channel · 不影响现有 Web 会话')),
        h('span', { className: 'fga-status ' + (online ? 'fga-online' : '') },
          online ? '网关正常' : '未确认在线', ' · systemd: ', service || '未知'))
    }
    function Panel() {
      const [state, setState] = useState(null)
      const [health, setHealth] = useState(null)
      const [tab, setTab] = useState('overview')
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [allowOverride, setAllowOverride] = useState(false)
      const [allowText, setAllowText] = useState('')
      const [botsOverride, setBotsOverride] = useState(false)
      const [bots, setBots] = useState([{ id: 'default', enabled: true, domain: 'feishu' }])
      const [workspace, setWorkspace] = useState('')
      const [provider, setProvider] = useState('')
      const [model, setModel] = useState('')
      const [timeout, setTimeout] = useState('')
      const [retry, setRetry] = useState('')
      const [interval, setIntervalValue] = useState('')
      const [autoConnect, setAutoConnect] = useState(true)
      const [botId, setBotId] = useState('default')
      const [appId, setAppId] = useState('')
      const [appSecret, setAppSecret] = useState('')

      const populate = useCallback(data => {
        setState(data); setHealth(data.health)
        const c = data.config || {}
        setAllowOverride(Array.isArray(c.allowlist))
        setAllowText(Array.isArray(c.allowlist) ? c.allowlist.join('\n') : '')
        setBotsOverride(Array.isArray(c.bots))
        setBots(c.bots || data.bots || [{ id: 'default', enabled: true, domain: 'feishu' }])
        setWorkspace(c.workspace || '')
        setProvider(c.agent?.provider || '')
        setModel(c.agent?.model || '')
        setTimeout(c.replyTimeoutMs === undefined ? '' : String(c.replyTimeoutMs / 1000))
        setRetry(c.sendRetries === undefined ? '' : String(c.sendRetries))
        setIntervalValue(c.outboxRetryIntervalMs === undefined ? '' : String(c.outboxRetryIntervalMs / 1000))
        setAutoConnect(c.autoConnect !== false)
        setBotId(current => (data.bots || []).some(b => b.id === current) ? current : (data.bots?.[0]?.id || 'default'))
      }, [])
      const reload = useCallback(async () => {
        setLoading(true); setError('')
        try { populate(await request('/state')) }
        catch (e) { setError(e.message || String(e)) }
        finally { setLoading(false) }
      }, [populate])
      useEffect(() => { void reload() }, [reload])
      useEffect(() => {
        const timer = setInterval(() => {
          request('/health').then(r => setHealth(r.health)).catch(() => setHealth(null))
        }, 12000)
        return () => clearInterval(timer)
      }, [])

      function asConfig() {
        const result = {}
        if (allowOverride) {
          result.allowlist = [...new Set(allowText.split(/[\n,]/).map(x => x.trim()).filter(Boolean))]
        }
        if (botsOverride) result.bots = bots.map(b => ({ id: b.id.trim(), domain: b.domain, enabled: b.enabled }))
        if (workspace.trim()) result.workspace = workspace.trim()
        if (provider.trim() || model.trim()) {
          result.agent = {}
          if (provider.trim()) result.agent.provider = provider.trim()
          if (model.trim()) result.agent.model = model.trim()
        }
        if (timeout.trim()) result.replyTimeoutMs = Number(timeout) * 1000
        if (retry.trim()) result.sendRetries = Number(retry)
        if (interval.trim()) result.outboxRetryIntervalMs = Number(interval) * 1000
        if (!autoConnect) result.autoConnect = false
        return result
      }
      async function perform(task, success) {
        setBusy(true); setError(''); setNotice('')
        try { await task(); setNotice(success); await reload() }
        catch (e) { setError(e.message || String(e)) }
        finally { setBusy(false) }
      }
      const save = () => perform(
        () => request('/config', 'PUT', { expectedRevision: state.revision, config: asConfig() }),
        '配置已安全保存。重启飞书通道后才会生效。')
      const saveSecret = () => perform(async () => {
        const payload = { botId }
        if (appId.trim()) payload.appId = appId.trim()
        if (appSecret.trim()) payload.appSecret = appSecret.trim()
        if (!payload.appId && !payload.appSecret) throw Error('请填写 App ID 或 App Secret')
        await request('/credentials', 'PUT', payload)
        setAppId(''); setAppSecret('')
      }, '飞书凭据已写入服务器受限文件，页面不会显示原文；重启后生效。')
      const restart = () => perform(
        () => request('/restart', 'POST', {}),
        'systemd 已接受重启命令。请刷新状态确认网关已重新连接。')
      const updateBot = (index, key, value) =>
        setBots(current => current.map((b, i) => i === index ? { ...b, [key]: value } : b))

      if (loading && !state) return h('div', { className: 'fga-root' }, h('p', null, '正在连接飞书通道管理服务…'))
      return h('div', { className: 'fga-root' },
        h(Header, { health, service: state?.service }),
        error && h('div', { className: 'fga-error', role: 'alert' }, error),
        notice && h('div', { className: 'fga-notice', role: 'status' }, notice),
        h('div', { className: 'fga-tabs' },
          ...[['overview','运行状态'],['settings','模型与配置'],['permissions','访问权限'],['bots','机器人与凭据']]
            .map(([id,label]) => h('button', { type: 'button', key: id, className: tab === id ? 'fga-tab fga-selected' : 'fga-tab',
              onClick: () => setTab(id) }, label))),
        tab === 'overview' && h('div', { className: 'fga-section' },
          h('div', { className: 'fga-cards' },
            h(Stat, { name: '飞书连接', value: health?.health?.transports?.default || '不可用' }),
            h(Stat, { name: 'DSH Session', value: health?.health?.sessionBridge?.available ? 'Available' : 'Unavailable' }),
            h(Stat, { name: '已处理消息', value: health?.health?.processed }),
            h(Stat, { name: '异常数', value: health?.health?.errors }),
            h(Stat, { name: '待发消息', value: health?.health?.outbox?.pending }),
            h(Stat, { name: 'Session 数', value: health?.health?.boundSessions })),
          state?.source === 'profile' && h('p', { className: 'fga-hint' },
            '当前未创建托管配置，实际参数继承原 feishu-channel Profile。'),
          state?.pendingRestart && h('div', { className: 'fga-warning' }, '存在尚未应用的配置修改，请重启通道。'),
          h('div', { className: 'fga-toolbar' },
            action(loading ? '刷新中…' : '刷新状态', reload, loading || busy, true),
            action('重启飞书通道', restart, loading || busy))),
        tab === 'settings' && h('div', { className: 'fga-section' },
          h('p', { className: 'fga-hint' }, '留空代表继承原 Profile 配置。设置仅在飞书通道重启后生效。'),
          field('模型 Provider', textInput(provider, setProvider, '继承 Profile，例如 magpie')),
          field('模型 Model', textInput(model, setModel, '继承 Profile，例如 group/deepseek')),
          field('DSH 工作目录', textInput(workspace, setWorkspace, '继承 Profile，例如 /home/ubuntu/dsh-workspace')),
          h('div', { className: 'fga-fields-row' },
            field('回复超时（秒）', textInput(timeout, setTimeout, '继承 Profile', { type: 'number', min: 5, max: 1800 })),
            field('发送尝试次数', textInput(retry, setRetry, '继承 Profile', { type: 'number', min: 1, max: 10 })),
            field('补发间隔（秒）', textInput(interval, setIntervalValue, '继承 Profile', { type: 'number', min: 1, max: 300 }))),
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: autoConnect, onChange: e => setAutoConnect(e.target.checked) }),
            '随飞书通道启动自动连接'),
          action('保存配置', save, busy || !state)),
        tab === 'permissions' && h('div', { className: 'fga-section' },
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: allowOverride, onChange: e => setAllowOverride(e.target.checked) }),
            '在此覆盖原 Profile 的 Open ID 白名单'),
          allowOverride ? field('允许私聊的 Feishu open_id',
            h('textarea', { className: 'fga-input fga-textarea', rows: 7, value: allowText,
              onChange: e => setAllowText(e.target.value), placeholder: 'ou_...，每行一条' }),
            '空白名单表示拒绝全部消息；本版本仍默认拒绝群聊。')
            : h('p', { className: 'fga-hint' }, '白名单仍由原 Profile 控制，未在后台覆盖。'),
          h('div', { className: 'fga-warning' }, '飞书聊天中的 Agent 可能拥有工作区写权限。仅将可信任人员加入白名单。'),
          action('保存权限', save, busy || !state)),
        tab === 'bots' && h('div', { className: 'fga-section' },
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: botsOverride, onChange: e => setBotsOverride(e.target.checked) }),
            '在此管理机器人（覆盖原 Profile 中的 bots 列表）'),
          botsOverride && h('div', { className: 'fga-bots' },
            ...bots.map((bot, i) => h('div', { className: 'fga-bot', key: bot.id + ':' + i },
              field('机器人标识', textInput(bot.id, v => updateBot(i, 'id', v), '如 default')),
              field('应用区域', h('select', { className: 'fga-input', value: bot.domain,
                onChange: e => updateBot(i, 'domain', e.target.value) },
                h('option', { value: 'feishu' }, '飞书（中国）'), h('option', { value: 'lark' }, 'Lark（国际）'))),
              h('label', { className: 'fga-check' }, h('input', { type: 'checkbox', checked: bot.enabled,
                onChange: e => updateBot(i, 'enabled', e.target.checked) }), '启用机器人'),
              action('删除此机器人', () => setBots(list => list.filter((_, j) => i !== j)), busy, true))),
            bots.length < 8 && action('新增机器人', () => setBots(list => [...list, { id: '', domain: 'feishu', enabled: false }]), busy, true),
            action('保存机器人列表', save, busy || !state)),
          h('div', { className: 'fga-divider' }),
          h('h3', null, '凭据设置（仅写入，不回显）'),
          field('选择机器人', h('select', { className: 'fga-input', value: botId,
            onChange: e => { setBotId(e.target.value); setAppId(''); setAppSecret('') } },
            ...(state?.bots || []).map(b => h('option', { key: b.id, value: b.id }, b.id)))),
          h('p', { className: 'fga-hint' }, '当前凭据：', state?.credentials?.find(c => c.id === botId)?.configured ? '已配置' : '未检测到完整凭据'),
          field('新的 App ID', textInput(appId, setAppId, 'cli_…（留空则不改变）')),
          field('新的 App Secret', textInput(appSecret, setAppSecret, '留空则不改变', { type: 'password', autoComplete: 'new-password' })),
          h('p', { className: 'fga-hint' }, '凭据写入 ~/.dsh/feishu-channel.env（0600），不会经接口读取原值。'),
          action('安全保存凭据', saveSecret, busy || !state)),
        h('p', { className: 'fga-footer' },
          '管理接口由 DSH Web 身份认证保护 · 通过本机读取健康状态 · 不修改 DSH Core'))
    }
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.id = 'dsh-feishu-admin-style'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'feishu-admin:styles')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'feishu-channel', order: 48,
        label: () => '飞书通道',
      }, Panel))
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon', id: 'feishu-channel',
      }, ({ size = 16 }) => h('span', { style: { fontSize: size - 1 } }, '✉')))
    }
    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  }
})
