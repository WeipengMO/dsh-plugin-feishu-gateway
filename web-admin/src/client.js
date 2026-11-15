/* DSH native sidebar management panel + credential-only settings extension. */
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
    /*__PROXY_HELPERS_START__*/
    // Pure helpers for the network-proxy block. No closure state: the built
    // client and the offline tests evaluate this block directly.
    function proxyRedactUrl(value) {
      if (typeof value !== 'string') return ''
      // userinfo is the only secret the admin API may leave in a display URL.
      return value.trim().replace(/\/\/[^/@\s]*@/, '//')
    }
    function proxySafeMessage(message) {
      const text = message === undefined || message === null ? '' : String(message)
      // Server errors are already stable codes, but never echo anything URL-like.
      return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi, '[地址已隐藏]').slice(0, 200)
    }
    function proxyErrorText(message) {
      const text = proxySafeMessage(message)
      if (!text) return '未知错误'
      if (/no proxy configured/i.test(text)) return '尚未配置代理地址，请先输入地址或从服务器环境变量导入'
      if (/invalid proxy url/i.test(text)) return '代理地址格式无效：仅支持 http/https，且不能包含路径、查询参数或片段'
      if (/invalid networkProxy|networkProxy must be an object/i.test(text))
        return '代理配置无效：环境变量名只能包含字母、数字和下划线，且不能以数字开头'
      if (/proxy url not found in env file/i.test(text)) return '服务器环境变量文件中没有找到该代理变量'
      if (/systemd user service unavailable/i.test(text)) return 'systemd 用户服务不可用，请确认独立飞书通道服务已安装'
      if (/config changed; reload before saving/i.test(text)) return '配置已被其他操作修改，请刷新后重试'
      return text
    }
    function proxySourceLabel(source) {
      if (source === 'managed') return '管理后台'
      if (source === 'env') return '服务器环境变量'
      return '未配置'
    }
    function networkProxyView(state) {
      const data = state && typeof state === 'object' ? state : {}
      const reported = data.networkProxy && typeof data.networkProxy === 'object' ? data.networkProxy : null
      const saved = data.config && data.config.networkProxy && typeof data.config.networkProxy === 'object'
        ? data.config.networkProxy : {}
      const enabled = (reported && reported.enabled !== undefined ? reported.enabled : saved.enabled) === true
      const fallbackDirect = (reported && reported.fallbackDirect !== undefined
        ? reported.fallbackDirect : saved.fallbackDirect) !== false
      return {
        available: Boolean(reported),
        enabled,
        fallbackDirect,
        source: reported && (reported.source === 'managed' || reported.source === 'env') ? reported.source : 'none',
        configured: Boolean(reported && reported.configured === true),
        envConfigured: Boolean(reported && reported.envConfigured === true),
        // The stored file exists but is unreadable/invalid: it is ignored, and
        // saving a new URL (or clearing) repairs it without a shell.
        storedError: Boolean(reported && reported.storedError === true),
        display: proxyRedactUrl(reported && reported.display),
      }
    }
    function networkProxyPayload(input) {
      const source = input && typeof input === 'object' ? input : {}
      const payload = {
        enabled: source.enabled === true,
        fallbackDirect: source.fallbackDirect !== false,
      }
      // url is write-only: send a typed address, send null only for an explicit
      // clear, and omit it otherwise so the stored secret is preserved.
      const url = typeof source.url === 'string' ? source.url.trim() : ''
      if (url) payload.url = url
      else if (source.cleared === true) payload.url = null
      return payload
    }
    /*__PROXY_HELPERS_END__*/
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
    function Panel({ initialTab = 'settings', onChanged } = {}) {
      const [state, setState] = useState(null)
      const [health, setHealth] = useState(null)
      const [tab, setTab] = useState(initialTab)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [allowOverride, setAllowOverride] = useState(false)
      const [allowText, setAllowText] = useState('')
      const [botsOverride, setBotsOverride] = useState(false)
      const [bots, setBots] = useState([{ id: 'default', enabled: true, domain: 'feishu' }])
      const [workspace, setWorkspace] = useState('')
      const [agentWorkspace, setAgentWorkspace] = useState('')
      const [provider, setProvider] = useState('')
      const [model, setModel] = useState('')
      const [timeout, setTimeout] = useState('')
      const [proxyEnabled, setProxyEnabled] = useState(false)
      const [proxyFallback, setProxyFallback] = useState(true)
      // The proxy URL itself is write-only: the input never receives a value
      // from /state, only what the operator is currently typing.
      const [proxyUrl, setProxyUrl] = useState('')
      const [proxyCleared, setProxyCleared] = useState(false)
      const [proxyTest, setProxyTest] = useState(null)
      const [retry, setRetry] = useState('')
      const [interval, setIntervalValue] = useState('')
      const [autoConnect, setAutoConnect] = useState('inherit')
      const [replyFormat, setReplyFormat] = useState('inherit')
      const [approvalCards, setApprovalCards] = useState(false)
      const [streamCards, setStreamCards] = useState(false)
      const [approvalTimeout, setApprovalTimeout] = useState('90')
      const [streamInterval, setStreamIntervalValue] = useState('800')
      const populate = useCallback(data => {
        setState(data); setHealth(data.health)
        const c = data.config || {}
        setAllowOverride(Array.isArray(c.allowlist))
        setAllowText(Array.isArray(c.allowlist) ? c.allowlist.join('\n') : '')
        setBotsOverride(Array.isArray(c.bots))
        setBots(c.bots || data.bots || [{ id: 'default', enabled: true, domain: 'feishu' }])
        setWorkspace(c.workspace || '')
        setAgentWorkspace(c.agentWorkspace || '')
        setProvider(c.agent?.provider || '')
        setModel(c.agent?.model || '')
        setTimeout(c.replyTimeoutMs === undefined ? '' : String(c.replyTimeoutMs / 1000))
        setProxyEnabled(c.networkProxy?.enabled === true)
        setProxyFallback(c.networkProxy?.fallbackDirect !== false)
        // Never echo a saved proxy URL back into the DOM.
        setProxyUrl(''); setProxyCleared(false); setProxyTest(null)
        setRetry(c.sendRetries === undefined ? '' : String(c.sendRetries))
        setIntervalValue(c.outboxRetryIntervalMs === undefined ? '' : String(c.outboxRetryIntervalMs / 1000))
        setAutoConnect(c.autoConnect === undefined ? 'inherit' : c.autoConnect ? 'enabled' : 'disabled')
        setReplyFormat(c.replyFormat || 'inherit')
        setApprovalCards(c.approvalCards === true)
        setStreamCards(c.streamCards === true)
        setApprovalTimeout(String((c.approvalTimeoutMs || 90000) / 1000))
        setStreamIntervalValue(String(c.streamIntervalMs || 800))
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
        // Other settings tabs must preserve group access policy on save.
        const existing = state?.config || {}
        for (const key of ['groupPolicy', 'groupSenderAllowlist', 'groups']) {
          if (existing[key] !== undefined) result[key] = existing[key]
        }
        if (allowOverride) {
          result.allowlist = [...new Set(allowText.split(/[\n,]/).map(x => x.trim()).filter(Boolean))]
        }
        if (botsOverride) result.bots = bots.map(b => ({ id: b.id.trim(), domain: b.domain, enabled: b.enabled }))
        if (workspace.trim()) result.workspace = workspace.trim()
        if (agentWorkspace.trim()) result.agentWorkspace = agentWorkspace.trim()
        if (provider.trim() || model.trim()) {
          result.agent = {}
          if (provider.trim()) result.agent.provider = provider.trim()
          if (model.trim()) result.agent.model = model.trim()
        }
        if (timeout.trim()) result.replyTimeoutMs = Number(timeout) * 1000
        result.networkProxy = networkProxyPayload({
          enabled: proxyEnabled, fallbackDirect: proxyFallback,
          url: proxyUrl, cleared: proxyCleared,
        })
        if (retry.trim()) result.sendRetries = Number(retry)
        if (interval.trim()) result.outboxRetryIntervalMs = Number(interval) * 1000
        if (autoConnect !== 'inherit') result.autoConnect = autoConnect === 'enabled'
        if (replyFormat !== 'inherit') result.replyFormat = replyFormat
        result.approvalCards = approvalCards
        result.streamCards = streamCards
        if (approvalCards) result.approvalTimeoutMs = Number(approvalTimeout) * 1000
        if (streamCards) result.streamIntervalMs = Number(streamInterval)
        return result
      }
      async function perform(task, success, mapError) {
        setBusy(true); setError(''); setNotice('')
        try { await task(); setNotice(success); await reload(); onChanged?.() }
        catch (e) { setError(mapError ? mapError(e) : (e.message || String(e))) }
        finally { setBusy(false) }
      }
      const save = () => perform(
        () => request('/config', 'PUT', { expectedRevision: state.revision, config: asConfig() }),
        '配置已安全保存。重启飞书通道后才会生效。', e => proxyErrorText(e?.message || e))
      const restart = () => {
        if (!window.confirm('重启飞书通道会中断正在运行的任务，是否确认继续？')) return
        return perform(() => request('/restart', 'POST', {}),
          'systemd 已接受重启命令。请刷新状态确认网关已重新连接。')
      }
      // Network proxy: test/import/clear/save+restart. The typed URL is only
      // ever sent to the server, never rendered back into the panel.
      const testProxy = async () => {
        const url = proxyUrl.trim()
        setBusy(true); setError(''); setNotice(''); setProxyTest(null)
        try {
          const response = await request('/network-proxy/test', 'POST', url ? { url } : {})
          const result = response.result || {}
          const reachable = result.reachable === true
          const latencyMs = Number.isFinite(result.latencyMs) ? result.latencyMs : null
          setProxyTest({ reachable, latencyMs, error: proxySafeMessage(result.error) })
          if (reachable) setNotice('代理连接测试成功' + (latencyMs === null ? '。' : ' · 耗时 ' + latencyMs + ' ms。'))
          else setError('代理连接测试失败：' + (proxySafeMessage(result.error) || '未知错误'))
        } catch (e) {
          setProxyTest({ reachable: false, latencyMs: null, error: proxySafeMessage(e?.message || e) })
          setError('代理连接测试失败：' + proxyErrorText(e?.message || e))
        } finally { setBusy(false) }
      }
      const importProxyEnv = async () => {
        setBusy(true); setError(''); setNotice('')
        try {
          await request('/network-proxy/import-env', 'POST', {})
          setNotice('已从服务器环境变量导入代理地址。修改后需重启独立飞书通道。')
          await reload(); onChanged?.()
        } catch (e) { setError(proxyErrorText(e?.message || e)) }
        finally { setBusy(false) }
      }
      const clearProxyUrl = () => {
        setProxyUrl(''); setProxyCleared(true); setProxyTest(null); setError('')
        setNotice('已标记清除已保存的代理地址，点击「保存配置」后生效；重启后回退到服务器环境变量或直连。')
      }
      const saveAndRestart = async () => {
        if (!window.confirm('保存配置后将立即重启独立飞书通道，正在运行的任务会中断。是否确认继续？')) return
        setBusy(true); setError(''); setNotice('')
        let saved = false
        try {
          await request('/config', 'PUT', { expectedRevision: state.revision, config: asConfig() })
          saved = true
          await request('/restart', 'POST', {})
          setNotice('配置已保存，systemd 已接受重启命令。请刷新状态确认网关已重新连接。')
          onChanged?.()
        } catch (e) {
          setError(proxyErrorText(e?.message || e))
          if (saved) setNotice('配置已保存，但重启命令未被接受；请手动重启独立飞书通道。')
        } finally {
          setBusy(false)
          // Refresh even when only the restart failed, so the revision is current.
          if (saved) { try { populate(await request('/state')) } catch { /* keep previous state */ } }
        }
      }
      const updateBot = (index, key, value) =>
        setBots(current => current.map((b, i) => i === index ? { ...b, [key]: value } : b))

      const proxy = networkProxyView(state)
      const proxyHint = proxyCleared
        ? '已标记清除已保存地址：点击「保存配置」后删除，重启通道后回退到服务器环境变量或直连。'
        : proxy.storedError
          ? '检测到已保存的代理地址文件损坏，已忽略该文件；可直接输入新地址保存覆盖，或点击「清除已保存地址」。'
          : proxy.source === 'managed'
          ? '已保存：' + (proxy.display || '（地址已脱敏）') + ' · 输入新地址可覆盖，留空保持不变；修改后需重启独立飞书通道。'
          : proxy.envConfigured
            ? '尚未保存地址，当前使用服务器环境变量中的地址；可点击「从服务器环境变量导入」迁移到管理后台。'
            : '尚未保存地址。请输入完整代理地址（http/https，可含认证信息），保存后需重启独立飞书通道。'
      if (loading && !state) return h('div', { className: 'fga-root' }, h('p', null, '正在连接飞书通道管理服务…'))
      return h('div', { className: 'fga-root' },
        h(Header, { health, service: state?.service }),
        error && h('div', { className: 'fga-error', role: 'alert' }, error),
        notice && h('div', { className: 'fga-notice', role: 'status' }, notice),
        h('div', { className: 'fga-tabs' },
          ...[['settings','模型与配置'],['permissions','访问权限'],['bots','机器人设置']]
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
          field('AI 回复格式', h('select', { className: 'fga-input', value: replyFormat,
            onChange: e => setReplyFormat(e.target.value) },
            h('option', { value: 'inherit' }, '继承 Profile（默认普通文本）'),
            h('option', { value: 'text' }, '普通文本（最兼容）'),
            h('option', { value: 'markdown' }, 'Markdown 富文本（post/md）'))),
          field('旧工作目录（兼容）', textInput(workspace, setWorkspace, '原 DSH 项目目录，仅用于迁移/配置对照'),
            '新飞书 Agent 不再从此目录启动；不会复制这里的 SOUL / MEMORY。'),
          field('飞书 Agent 独立工作目录', textInput(agentWorkspace, setAgentWorkspace,
            '留空自动选择独立目录；或填写 /home/ubuntu/.dsh/feishu-agent'),
            '新飞书 Session 的原生 cwd。不可与普通 DSH 项目目录相同或存在父子关系；修改后需重启通道，并在飞书发送 /new。'),
          h('div', { className: 'fga-divider' }),
          h('h3', null, '交互卡片（需要飞书卡片权限与真实租户验收）'),
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: approvalCards,
              onChange: e => setApprovalCards(e.target.checked) }),
            '启用飞书原生工具审批卡片（默认关闭）'),
          approvalCards && field('审批最长等待（秒）',
            textInput(approvalTimeout, setApprovalTimeout, '90', { type: 'number', min: 5, max: 300 }),
            '必须将 DSH 工具审批策略改为 ask；超时或断线会拒绝，不会自动放行。'),
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: streamCards,
              onChange: e => setStreamCards(e.target.checked) }),
            '显示 CardKit 流式任务卡片（默认关闭）'),
          streamCards && field('任务卡片刷新间隔（毫秒）',
            textInput(streamInterval, setStreamIntervalValue, '800', { type: 'number', min: 500, max: 5000 }),
            '增量文本用于预览；终态卡片成功时原卡片显示完整回复，仅卡片失败时 Outbox 兜底。'),
          h('div', { className: 'fga-divider' }),
          h('h3', null, '网络代理（仅飞书独立 Profile）'),
          h('div', { className: 'fga-proxy-status' },
            h('span', { className: 'fga-proxy-source' }, '当前来源：' + proxySourceLabel(proxy.source)),
            h('span', { className: 'fga-hint' },
              '生效地址：' + (proxy.display || (proxy.configured ? '已保存（已脱敏）' : '未配置'))),
            h('span', { className: 'fga-hint' }, proxy.available
              ? '修改后需重启独立飞书通道才会生效；管理端不会在任何 API 或日志中回显地址原文。'
              : '当前管理端未获取到代理状态（后端版本可能较旧）；保存仍会按新格式写入。')),
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: proxyEnabled, onChange: e => setProxyEnabled(e.target.checked) }),
            '启用代理（独立飞书通道启动时使用）'),
          h('div', { className: 'fga-field' },
            h('span', { className: 'fga-label' }, '代理地址'),
            h('input', { className: 'fga-input', type: 'text', name: 'feishu-proxy-url', value: proxyUrl,
              placeholder: 'http://127.0.0.1:7890', spellCheck: false, autoComplete: 'off',
              onChange: e => { setProxyUrl(e.target.value); setProxyCleared(false); setProxyTest(null) } }),
            h('span', { className: 'fga-hint' }, proxyHint)),
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: proxyFallback, onChange: e => setProxyFallback(e.target.checked) }),
            '代理预检失败则启动时回退直连'),
          h('div', { className: 'fga-inline-actions' },
            action('测试连接', testProxy, busy || !state, true),
            proxy.envConfigured && action('从服务器环境变量导入', importProxyEnv, busy || !state, true),
            (proxy.source === 'managed' || proxy.storedError) && !proxyCleared &&
              action('清除已保存地址', clearProxyUrl, busy || !state, true)),
          proxyTest && h('p', { className: 'fga-hint fga-proxy-result', role: 'status' },
            proxyTest.reachable
              ? '测试结果：可达' + (proxyTest.latencyMs === null ? '' : ' · 耗时 ' + proxyTest.latencyMs + ' ms')
              : '测试结果：不可达' + (proxyTest.error ? ' · ' + proxyTest.error : '')),
          h('p', { className: 'fga-hint' },
            '通过 start-feishu-channel.sh 启动时生效；适用于同一 DSH 进程内的 HTTP 请求。' +
            ' WebSocket 使用独立代理 Agent，运行期断线由 SDK 重连；单次请求不自动重放。'),
          h('div', { className: 'fga-fields-row' },
            field('回复超时（秒）', textInput(timeout, setTimeout, '继承 Profile', { type: 'number', min: 5, max: 1800 })),
            field('发送尝试次数', textInput(retry, setRetry, '继承 Profile', { type: 'number', min: 1, max: 10 })),
            field('补发间隔（秒）', textInput(interval, setIntervalValue, '继承 Profile', { type: 'number', min: 1, max: 300 }))),
          field('自动连接',
            h('select', { className: 'fga-input', value: autoConnect,
              onChange: e => setAutoConnect(e.target.value) },
              h('option', { value: 'inherit' }, '继承 Profile 配置'),
              h('option', { value: 'enabled' }, '启用'),
              h('option', { value: 'disabled' }, '停用'))),
          h('div', { className: 'fga-inline-actions' },
            action('保存配置', save, busy || !state),
            action('保存并重启飞书通道', saveAndRestart, busy || !state, true))),
        tab === 'permissions' && h('div', { className: 'fga-section' },
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: allowOverride, onChange: e => setAllowOverride(e.target.checked) }),
            '在此覆盖原 Profile 的 Open ID 白名单'),
          allowOverride ? field('允许私聊的 Feishu open_id',
            h('textarea', { className: 'fga-input fga-textarea', rows: 7, value: allowText,
              onChange: e => setAllowText(e.target.value), placeholder: 'ou_...，每行一条' }),
            '空白名单表示拒绝全部私聊；群聊使用独立配置且默认禁用。')
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
          h('p', { className: 'fga-hint' },
            '飞书 App ID / App Secret 已移至 DSH 设置 → 飞书 Gateway，以免混淆运行管理与凭据编辑。')),
        h('p', { className: 'fga-footer' },
          '管理接口由 DSH Web 身份认证保护 · 通过本机读取健康状态 · 不修改 DSH Core'))
    }
    /*__WORKBENCH_CODE__*/
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.id = 'dsh-feishu-admin-style'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'feishu-admin:styles')
      // Global sidebar panel and root main body share one identifier.
      // Official DSH slots.inject handles late slot declarations and teardown.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: WORKBENCH_PANEL_ID,
      }, Workbench))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: WORKBENCH_PANEL_ID, order: 35,
        label: () => '飞书管理',
      }, FeishuSidebarIcon))
      // Settings remains a separate, credential-only entry.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'feishu-channel', order: 48,
        label: () => '飞书 Gateway',
      }, CredentialSettings))
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon', id: 'feishu-channel',
      }, FeishuSidebarIcon))
    }
    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  }
})
