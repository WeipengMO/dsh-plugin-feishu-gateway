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
    // One accessible, searchable combobox for both primary and fallback models.
    function ModelPicker({ options, selectedKey = '', onChoose, placeholder, ariaLabel,
      disabled = false, inline = false, id, compactLabel = false,
      emptyText = '没有匹配的模型' }) {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [active, setActive] = useState(0)
      const selected = options.find(item => item.key === selectedKey)
      const term = query.trim().toLowerCase()
      const matches = options.filter(item => !term ||
        [item.name, item.model, item.providerName, item.provider, item.key]
          .some(value => String(value || '').toLowerCase().includes(term))).slice(0, 150)
      const enabledIndices = matches.flatMap((item, index) => item.disabled ? [] : [index])
      const activeIndex = enabledIndices.includes(active) ? active : (enabledIndices[0] ?? -1)
      const choose = item => {
        if (item.disabled) return
        onChoose(item.key)
        setQuery('')
        setActive(0)
        setOpen(false)
      }
      const keydown = event => {
        if (event.key === 'Escape') { setOpen(false); setQuery(''); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!open) { setOpen(true); setActive(enabledIndices[0] ?? -1) }
          else if (enabledIndices.length) {
            const current = enabledIndices.indexOf(activeIndex)
            const delta = event.key === 'ArrowDown' ? 1 : -1
            setActive(enabledIndices[Math.max(0, Math.min(enabledIndices.length - 1,
              current + delta))])
          }
        }
        if (event.key === 'Enter' && open) {
          event.preventDefault()
          if (activeIndex >= 0) choose(matches[activeIndex])
        }
      }
      return h('div', { className: 'fga-search-picker' + (inline ? ' is-inline' : ''),
        onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false); setQuery('')
        } } },
        h('div', { className: 'fga-search-picker-field',
          onClick: event => {
            if (disabled || event.target?.tagName === 'INPUT') return
            // Make the entire selector including its chevron clickable, even
            // when the input already owns focus.
            const input = event.currentTarget.querySelector?.('input')
            if (open) { setOpen(false); setQuery('') }
            else {
              setOpen(true); setQuery(''); setActive(-1)
              input?.focus()
            }
          } },
          h('input', { className: 'fga-search-picker-input', role: 'combobox',
            'aria-label': ariaLabel, 'aria-autocomplete': 'list',
            'aria-expanded': open, 'aria-controls': id + '-options',
            'aria-activedescendant': open && activeIndex >= 0 ? id + '-option-' + activeIndex : undefined,
            autoComplete: 'off', spellCheck: false, disabled,
            placeholder: placeholder || '搜索模型名称或提供方',
            value: open ? query : (selected ?
              selected.name + (compactLabel ? '' : ' · ' + selected.providerName) : ''),
            onFocus: () => { setOpen(true); setQuery(''); setActive(-1) },
            onChange: event => { setOpen(true); setQuery(event.target.value); setActive(-1) },
            onKeyDown: keydown }),
          h('span', { className: 'fga-search-picker-chevron', 'aria-hidden': true }, '⌄')),
        open && !disabled && h('div', { className: 'fga-search-picker-dropdown',
          id: id + '-options', role: 'listbox', 'aria-label': ariaLabel + '候选项' },
          matches.length ? matches.map((item, index) =>
            h('button', { type: 'button', role: 'option',
              id: id + '-option-' + index, key: item.key,
              className: 'fga-search-picker-option' + (activeIndex === index ? ' is-active' : '') +
                (selectedKey === item.key ? ' is-selected' : ''),
              'aria-selected': selectedKey === item.key,
              'aria-disabled': item.disabled === true,
              disabled: item.disabled === true,
              onMouseEnter: () => { if (!item.disabled) setActive(index) },
              onMouseDown: event => event.preventDefault(),
              onClick: () => choose(item) },
              h('span', { className: 'fga-search-picker-option-name' }, item.name),
              h('small', null, compactLabel ? item.providerName :
                item.providerName + ' · ' + item.key),
              selectedKey === item.key && h('span', { className: 'fga-search-picker-check',
                'aria-hidden': true }, '✓')))
          : h('div', { className: 'fga-search-picker-empty' }, emptyText)))
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
        noProxy: typeof saved.noProxy === 'string' ? saved.noProxy : 'localhost,127.0.0.1,::1',
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
        noProxy: typeof source.noProxy === 'string' ? source.noProxy.trim() : 'localhost,127.0.0.1,::1',
      }
      // url is write-only: send a typed address, send null only for an explicit
      // clear, and omit it otherwise so the stored secret is preserved.
      const url = typeof source.url === 'string' ? source.url.trim() : ''
      if (url) payload.url = url
      else if (source.cleared === true) payload.url = null
      return payload
    }
    /*__PROXY_HELPERS_END__*/
    /*__MODEL_ROUTE_HELPERS_START__*/
    // Pure helpers for the DSH-driven model selectors. They never invent a
    // default route: every option comes from the Gateway Host's DSH catalog
    // snapshot (`/state.modelCatalog`), plus the explicitly saved/effective
    // routes so an unavailable saved value is still visible and replaceable.
    function modelDirectoryView(state) {
      const data = state && typeof state === 'object' ? state : {}
      const catalog = data.modelCatalog && typeof data.modelCatalog === 'object' ? data.modelCatalog : null
      const providers = []
      if (catalog && Array.isArray(catalog.providers)) {
        for (const entry of catalog.providers) {
          if (!entry || typeof entry.id !== 'string' || !entry.id) continue
          const models = (Array.isArray(entry.models) ? entry.models : [])
            .filter(model => model && typeof model.id === 'string' && model.id)
            .map(model => ({ id: model.id,
              name: typeof model.name === 'string' && model.name ? model.name : model.id }))
          if (!models.length) continue
          providers.push({ id: entry.id,
            name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id, models })
        }
      }
      const effective = data.agentRoute && typeof data.agentRoute === 'object' ? data.agentRoute : null
      const profileDefault = data.profileDefaultRoute && typeof data.profileDefaultRoute === 'object'
        ? data.profileDefaultRoute : null
      const savedAgent = data.config && data.config.agent && typeof data.config.agent === 'object'
        ? data.config.agent : null
      const complete = route => route && typeof route.provider === 'string' && route.provider &&
        typeof route.model === 'string' && route.model
      // Precedence: the explicitly managed value (what this form saves and what
      // the next restart applies), then the Host's effective route, then DSH's
      // own Profile default. A blank "inherit" value is never presented.
      const managedHasFallback = savedAgent !== null &&
        Object.prototype.hasOwnProperty.call(savedAgent, 'fallback')
      const primary = complete(savedAgent)
        ? { provider: savedAgent.provider, model: savedAgent.model, source: 'saved' }
        : complete(effective)
          ? { provider: effective.provider, model: effective.model, source: 'effective' }
          : complete(profileDefault)
            ? { provider: profileDefault.provider, model: profileDefault.model, source: 'profile' }
            : null
      // A saved empty array overrides even an older, still-live snapshot.
      const savedHasFallbacks = savedAgent && Object.prototype.hasOwnProperty.call(savedAgent, 'fallbacks')
      const effectiveHasFallbacks = effective && Array.isArray(effective.fallbacks)
      const sourceRoutes = savedHasFallbacks
        ? savedAgent.fallbacks
        : managedHasFallback
          ? (complete(savedAgent.fallback) ? [savedAgent.fallback] : [])
          : effectiveHasFallbacks
            ? effective.fallbacks
            : complete(effective?.fallback) ? [effective.fallback] : []
      const fallbacks = Array.isArray(sourceRoutes) ? sourceRoutes
        .filter(complete).map(item => ({ provider: item.provider, model: item.model })) : []
      const withRoutes = withRouteOptions(providers, [primary, ...fallbacks, profileDefault])
      return {
        // A route is selectable when DSH advertises a directory or when an
        // explicit saved/effective route exists; never a fabricated default.
        providers: withRoutes,
        primary,
        fallback: fallbacks[0] || null, // legacy read-model helper compatibility
        fallbacks,
        profileDefault,
        incomplete: Boolean(catalog && catalog.incomplete),
        catalogMissing: !catalog || !Array.isArray(catalog.providers) || catalog.providers.length === 0,
        stale: data.modelDirectoryStale === true,
      }
    }
    // Pure read-model for the DSH Agent preset roster (`/state.agentPresets`).
    // Never invents a default: an empty catalogue simply hides all presets so
    // the "inherit / unspecified" choice stays explicit.
    function agentPresetView(state) {
      const data = state && typeof state === 'object' ? state : {}
      const catalog = data.agentPresets && typeof data.agentPresets === 'object' ? data.agentPresets : null
      const presets = []
      if (catalog && Array.isArray(catalog.presets)) {
        for (const entry of catalog.presets) {
          if (!entry || typeof entry.id !== 'string' || !entry.id) continue
          presets.push({
            id: entry.id,
            name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
            description: typeof entry.description === 'string' ? entry.description : '',
            isDefault: entry.isDefault === true,
            broken: typeof entry.broken === 'string' && entry.broken ? entry.broken : '',
          })
        }
      }
      const config = data.config && typeof data.config === 'object' ? data.config : {}
      // Distinguish "managed but empty" (explicitly no preset) from "absent"
      // (inherit the Profile value). Selecting inherit must NOT write a value.
      const hasManaged = Object.prototype.hasOwnProperty.call(config, 'agentPreset')
      const saved = config.agentPreset
      return {
        presets,
        selected: hasManaged ? (typeof saved === 'string' ? saved : '') : '__inherit__',
        managed: hasManaged,
        catalogMissing: presets.length === 0,
        stale: data.modelDirectoryStale === true,
        defaultId: catalog && typeof catalog.defaultId === 'string' ? catalog.defaultId : '',
      }
    }
    function withRouteOptions(providers, routes) {
      const list = providers.map(provider => ({ ...provider, models: [...provider.models] }))
      for (const route of routes) {
        if (!route || typeof route.provider !== 'string' || !route.provider ||
            typeof route.model !== 'string' || !route.model) continue
        let provider = list.find(entry => entry.id === route.provider)
        if (!provider) {
          // Saved values are shown verbatim, never silently dropped: a select
          // whose value is absent from its options would render blank.
          provider = { id: route.provider, name: route.provider, models: [], unlisted: true }
          list.push(provider)
        }
        if (!provider.models.some(model => model.id === route.model)) {
          provider.models.push({ id: route.model, name: route.model, unlisted: true })
        }
      }
      return list
    }
    function modelsForProvider(providers, providerId) {
      const provider = (providers || []).find(entry => entry.id === providerId)
      return provider ? provider.models : []
    }
    function firstModelForProvider(providers, providerId) {
      const models = modelsForProvider(providers, providerId)
      return models.length ? models[0].id : ''
    }
    function defaultFallbackSelection(providers, primaryProvider, primaryModel) {
      for (const provider of providers || []) {
        for (const model of provider.models || []) {
          if (provider.id === primaryProvider && model.id === primaryModel) continue
          return { provider: provider.id, model: model.id }
        }
      }
      return null
    }
    function flatModelOptions(providers) {
      return (providers || []).flatMap(provider => (provider.models || []).map(model => ({
        key: provider.id + '/' + model.id,
        provider: provider.id, model: model.id, providerName: provider.name || provider.id,
        name: model.name || model.id, unlisted: Boolean(model.unlisted || provider.unlisted),
      })))
    }
    function modelRoutePayload(input) {
      const value = input && typeof input === 'object' ? input : {}
      if (!value.provider || !value.model) return null
      const selected = Array.isArray(value.fallbacks) ? value.fallbacks
        : value.fallback ? [value.fallback] : []
      const seen = new Set()
      const fallbacks = selected.filter(item => {
        if (!item || !item.provider || !item.model ||
          (item.provider === value.provider && item.model === value.model)) return false
        const key = item.provider + '/' + item.model
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, 8).map(item => ({ provider: item.provider, model: item.model }))
      // [] is an explicit clear: never resurrect the Profile's old fallback.
      return { provider: value.provider, model: value.model, fallbacks }
    }
    /*__MODEL_ROUTE_HELPERS_END__*/
    function action(text, callback, busy, secondary = false) {
      return h('button', { type: 'button',
        className: 'fga-button' + (secondary ? ' fga-secondary' : '') +
          (text.includes('刷新') ? ' fgw-refresh-action' : ''),
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
    function Panel({ initialTab = 'settings', onChanged, onDirtyChange, hideTabs = false } = {}) {
      const [state, setState] = useState(null)
      const [health, setHealth] = useState(null)
      const [tab, setTab] = useState(initialTab)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [allowOverride, setAllowOverride] = useState(false)
      const [allowText, setAllowText] = useState('')
      const [agentWorkspace, setAgentWorkspace] = useState('')
      const [primaryProvider, setPrimaryProvider] = useState('')
      const [primaryModel, setPrimaryModel] = useState('')
      const [fallbacks, setFallbacks] = useState([])
      const [agentPreset, setAgentPreset] = useState('__inherit__')
      const [timeout, setTimeout] = useState('')
      const [proxyEnabled, setProxyEnabled] = useState(false)
      const [proxyFallback, setProxyFallback] = useState(true)
      const [proxyBypass, setProxyBypass] = useState('localhost,127.0.0.1,::1')
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
      const [approvalTimeout, setApprovalTimeout] = useState('600')
      const [streamInterval, setStreamIntervalValue] = useState('800')
      // Only field changes count: polling and search input edits do not.
      const [savedSignature, setSavedSignature] = useState(null)
      const draftSignature = JSON.stringify([
        allowOverride, allowText, agentWorkspace, primaryProvider,
        primaryModel, fallbacks, agentPreset, timeout, proxyEnabled, proxyFallback, proxyBypass,
        proxyUrl, proxyCleared, retry, interval, autoConnect, replyFormat,
        approvalCards, streamCards, approvalTimeout, streamInterval,
      ])
      const dirty = !!state && savedSignature !== null && draftSignature !== savedSignature
      useEffect(() => {
        if (state) setSavedSignature(draftSignature)
      }, [state?.revision])
      useEffect(() => {
        onDirtyChange?.(dirty)
        return () => onDirtyChange?.(false)
      }, [dirty, onDirtyChange])
      const populate = useCallback(data => {
        setState(data); setHealth(data.health)
        const c = data.config || {}
        setAllowOverride(Array.isArray(c.allowlist))
        setAllowText(Array.isArray(c.allowlist) ? c.allowlist.join('\n') : '')
        setAgentWorkspace(c.agentWorkspace || '')
        // Current route comes from the Gateway Host's DSH snapshot, never from
        // a blank "inherit Profile" placeholder. Saved values win when the Host
        // is offline; otherwise DSH's effective/default route is shown.
        const directory = modelDirectoryView(data)
        setPrimaryProvider(directory.primary?.provider || '')
        setPrimaryModel(directory.primary?.model || '')
        setFallbacks(directory.fallbacks)
        setAgentPreset(agentPresetView(data).selected)
        setTimeout(c.replyTimeoutMs === undefined ? '' : String(c.replyTimeoutMs / 1000))
        setProxyEnabled(c.networkProxy?.enabled === true)
        setProxyFallback(c.networkProxy?.fallbackDirect !== false)
        setProxyBypass(typeof c.networkProxy?.noProxy === 'string' ? c.networkProxy.noProxy : 'localhost,127.0.0.1,::1')
        // Never echo a saved proxy URL back into the DOM.
        setProxyUrl(''); setProxyCleared(false); setProxyTest(null)
        setRetry(c.sendRetries === undefined ? '' : String(c.sendRetries))
        setIntervalValue(c.outboxRetryIntervalMs === undefined ? '' : String(c.outboxRetryIntervalMs / 1000))
        setAutoConnect(c.autoConnect === undefined ? 'inherit' : c.autoConnect ? 'enabled' : 'disabled')
        setReplyFormat(c.replyFormat || 'inherit')
        setApprovalCards(c.approvalCards === true)
        setStreamCards(c.streamCards === true)
        setApprovalTimeout(String((c.approvalTimeoutMs || 600000) / 1000))
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
        // Bot source is managed exclusively in the dedicated robot panel.
        // Other settings must never silently remove or overwrite this list.
        if (Array.isArray(existing.bots)) result.bots = existing.bots
        // Legacy/shared workspace is still the isolation boundary for the
        // Feishu Agent. Hide it from day-to-day UI, but preserve any managed
        // value so saving other settings cannot accidentally reset the guard.
        if (typeof existing.workspace === 'string' && existing.workspace.trim()) {
          result.workspace = existing.workspace
        }
        if (agentWorkspace.trim()) result.agentWorkspace = agentWorkspace.trim()
        const route = modelRoutePayload({
          provider: primaryProvider.trim(), model: primaryModel.trim(),
          fallbacks,
        })
        if (route) result.agent = route
        // '__inherit__' omits the key entirely (Profile value stays in force);
        // any other value is persisted, where '' is an explicit "no preset".
        if (agentPreset !== '__inherit__') result.agentPreset = agentPreset
        if (timeout.trim()) result.replyTimeoutMs = Number(timeout) * 1000
        result.networkProxy = networkProxyPayload({
          enabled: proxyEnabled, fallbackDirect: proxyFallback, noProxy: proxyBypass,
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

      const proxy = networkProxyView(state)
      const directory = modelDirectoryView(state)
      const presetDirectory = agentPresetView(state)
      const presetSelectedVisible = agentPreset === '__inherit__' ||
        !agentPreset ||
        presetDirectory.presets.some(preset => preset.id === agentPreset)
      const allModels = flatModelOptions(directory.providers)
      const primaryKey = primaryProvider && primaryModel ? primaryProvider + '/' + primaryModel : ''
      const primaryChoices = allModels
      const fallbackChoices = allModels.filter(item =>
        item.key !== primaryKey &&
        !fallbacks.some(route => route.provider === item.provider && route.model === item.model))
      const fallbackSelectionInvalid = fallbacks.length > 8 || fallbacks.some(route =>
        (route.provider === primaryProvider && route.model === primaryModel) ||
        fallbacks.filter(other => other.provider === route.provider && other.model === route.model).length > 1)
      const selectPrimary = key => {
        const choice = allModels.find(item => item.key === key)
        if (!choice) return
        setPrimaryProvider(choice.provider)
        setPrimaryModel(choice.model)
        setFallbacks(current => current.filter(route =>
          !(route.provider === choice.provider && route.model === choice.model)))
      }
      const addFallback = key => {
        const choice = allModels.find(item => item.key === key)
        if (!choice || choice.key === primaryKey) return
        setFallbacks(current => current.length >= 8 ||
          current.some(route => route.provider === choice.provider && route.model === choice.model)
          ? current : [...current, { provider: choice.provider, model: choice.model }])
      }
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
        !hideTabs && h('div', { className: 'fga-tabs' },
          ...[['settings','模型与连接'],['permissions','私聊白名单']]
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
          h('div', { className: 'fga-model-heading' },
            h('div', null,
              h('h3', null, '模型路由'),
              h('p', { className: 'fga-hint' }, '选择默认模型，并按优先级添加备用模型。更改将在重启通道后生效。')),
            h('span', { className: 'fga-model-count' },
              directory.catalogMissing ? '目录尚未加载' : allModels.filter(item => !item.unlisted).length + ' 个模型 · ' + directory.providers.filter(item => !item.unlisted).length + ' 个提供方')),
          directory.incomplete && h('p', { className: 'fga-model-note' }, '部分提供方暂时无法读取，当前列表可能不完整。'),
          directory.stale && h('p', { className: 'fga-model-note' }, '模型目录来自最近一次运行记录；建议刷新后确认。'),
          directory.catalogMissing && h('div', { className: 'fga-warning' },
            '还没有获取到模型列表。请确认飞书通道正在运行，然后刷新页面。'),
          h('div', { className: 'fga-model-route-grid' },
            h('div', { className: 'fga-model-card fga-model-primary' },
            h('div', { className: 'fga-model-card-head' },
              h('strong', null, '主模型'),
              h('span', { className: 'fga-hint' }, '正常情况下优先使用')),
            h(ModelPicker, { id: 'fga-primary-model', options: primaryChoices,
              selectedKey: primaryKey, onChoose: selectPrimary,
              ariaLabel: '搜索主模型', placeholder: '选择或搜索主模型',
              disabled: busy || !state || !allModels.length }),
            h('p', { className: 'fga-hint' },
              directory.primary?.source === 'profile' ? '当前继承 DSH Profile 的默认模型。'
              : directory.primary?.source === 'saved' ? '已保存的模型配置。'
              : directory.primary?.source === 'effective' ? '当前通道正在使用的模型。'
              : '从上方目录选择一个模型。')),
          h('div', { className: 'fga-model-card fga-model-fallback' },
            h('div', { className: 'fga-model-card-head' },
              h('strong', null, '备用模型'),
              h('span', { className: 'fga-hint' }, fallbacks.length + ' / 8')),
            h('p', { className: 'fga-hint' }, '主模型失败时按添加顺序依次尝试。仅当本轮尚未执行任何工具时重试。'),
            h('div', { className: 'fga-model-multiselect' },
              ...fallbacks.map((route, index) => {
                const item = allModels.find(choice => choice.provider === route.provider && choice.model === route.model)
                return h('span', { className: 'fga-model-tag', key: route.provider + '/' + route.model },
                  h('span', { className: 'fga-model-tag-index' }, String(index + 1)),
                  h('span', { className: 'fga-model-tag-label', title: route.provider + '/' + route.model },
                    (item?.providerName || route.provider) + ' · ' + (item?.name || route.model)),
                  h('button', { type: 'button', className: 'fga-model-tag-remove',
                    'aria-label': '移除备用模型 ' + route.provider + '/' + route.model,
                    disabled: busy || !state,
                    onClick: () => setFallbacks(current => current.filter(other =>
                      !(other.provider === route.provider && other.model === route.model))) }, '×'))
              }),
              h(ModelPicker, { id: 'fga-fallback-model', options: fallbackChoices,
                onChoose: addFallback, ariaLabel: '搜索备用模型',
                placeholder: fallbacks.length ? '继续搜索并添加备用模型…' : '搜索并添加备用模型',
                disabled: busy || !state || !fallbackChoices.length || fallbacks.length >= 8,
                inline: true })),
            fallbackSelectionInvalid && h('p', { className: 'fga-error', role: 'alert' },
              '备用模型不能重复或与主模型相同，最多添加 8 个。'))),
          h('div', { className: 'fga-model-card fga-model-preset' },
            h('div', { className: 'fga-model-card-head' },
              h('strong', null, 'Agent 预设（飞书工作模式）'),
              h('span', { className: 'fga-hint' },
                presetDirectory.catalogMissing ? '目录尚未加载' : presetDirectory.presets.length + ' 个预设')),
            presetDirectory.stale && h('p', { className: 'fga-model-note' },
              '预设列表来自最近一次运行记录；建议刷新后确认。'),
            presetDirectory.catalogMissing && h('div', { className: 'fga-warning' },
              '还没有获取到预设列表，请确认飞书通道正在运行，然后刷新页面。'),
            h(ModelPicker, { id: 'fga-agent-preset',
              ariaLabel: 'Agent 预设', placeholder: '搜索或选择工作模式',
              selectedKey: agentPreset, onChoose: setAgentPreset,
              compactLabel: true, emptyText: '没有匹配的工作模式',
              disabled: busy || !state,
              options: [
                { key: '__inherit__', name: '沿用现有设置（继承）',
                  providerName: '保留 DSH Profile 已配置的预设' },
                { key: '', name: '使用 DSH 默认组合（不指定预设）',
                  providerName: '明确不使用 Profile 中的预设' },
                ...(!presetSelectedVisible ? [{ key: agentPreset,
                  name: agentPreset + '（当前目录不可用）',
                  providerName: '此前保存的预设，可切换到其他模式' }] : []),
                ...presetDirectory.presets.map(preset => ({
                  key: preset.id,
                  name: (preset.name || preset.id) +
                    (preset.isDefault ? '（默认）' : '') +
                    (preset.broken ? '（不可用）' : ''),
                  providerName: preset.broken || preset.description || 'DSH 预设',
                  disabled: Boolean(preset.broken),
                })),
              ] }),
            agentPreset !== presetDirectory.selected && h('p', {
              className: 'fga-model-unsaved', role: 'status' },
              '预设有未保存的修改；点击下方「仅保存」或「保存并重启」。'),
            h('p', { className: 'fga-hint' },
              '新会话按所选预设工作；已存在会话保持原模式；保存后需重启飞书通道并对新会话生效（旧会话可 /new 切换）。')),
          h('div', { className: 'fga-divider' }),
          h('h3', { className: 'fga-settings-group' }, '回复与 Agent 工作目录'),
          field('回复格式', h('select', { className: 'fga-input', value: replyFormat,
            onChange: e => setReplyFormat(e.target.value) },
            h('option', { value: 'inherit' }, '继承 Profile（默认普通文本）'),
            h('option', { value: 'text' }, '普通文本（最兼容）'),
            h('option', { value: 'markdown' }, 'Markdown 富文本（post/md）'))),
          field('飞书 Agent 专属工作目录', textInput(agentWorkspace, setAgentWorkspace,
            '留空自动创建隔离目录；或输入服务器上的绝对路径'),
            '新飞书 Session 的原生 cwd。不可与普通 DSH 项目目录相同或存在父子关系；修改后需重启通道，并在飞书发送 /new。'),
          h('div', { className: 'fga-divider' }),
          h('h3', { className: 'fga-settings-group' }, '消息与工具卡片'),
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: approvalCards,
              onChange: e => setApprovalCards(e.target.checked) }),
            '启用工具审批卡片'),
          approvalCards && field('审批最长等待（秒）',
            textInput(approvalTimeout, setApprovalTimeout, '600', { type: 'number', min: 5, max: 1800 }),
            '必须将 DSH 工具审批策略改为 ask；超时或断线会拒绝，不会自动放行。'),
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: streamCards,
              onChange: e => setStreamCards(e.target.checked) }),
            '显示任务进度卡片'),
          streamCards && field('任务卡片刷新间隔（毫秒）',
            textInput(streamInterval, setStreamIntervalValue, '800', { type: 'number', min: 500, max: 5000 }),
            '增量文本用于预览；终态卡片成功时原卡片显示完整回复，仅卡片失败时 Outbox 兜底。'),
          h('div', { className: 'fga-divider' }),
          h('h3', { className: 'fga-settings-group' }, '网络与重试'),
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
          h('div', { className: 'fga-field' },
            h('span', { className: 'fga-label' }, '直连例外（NO_PROXY）'),
            h('textarea', { className: 'fga-input fga-textarea', name: 'feishu-no-proxy',
              rows: 3, spellCheck: false, value: proxyBypass,
              placeholder: 'localhost,127.0.0.1,::1,*.internal',
              onChange: e => setProxyBypass(e.target.value) }),
            h('span', { className: 'fga-hint' },
              '逗号、空格或换行分隔主机、IP、域名后缀或 CIDR。保留本机地址默认值；已有系统 NO_PROXY 会合并。' +
              'CIDR 在 WebSocket 路由中可识别，Node 原生 HTTP 环境代理对 CIDR 的支持可能不同，建议为 HTTP MCP 目标填明确切主机/IP。')),
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
          h('div', { className: 'fga-model-savebar' },
            h('span', { className: dirty ? 'fgw-dirty-hint' : 'fga-hint', role: 'status' },
              dirty ? '有尚未保存的修改' :
                state?.pendingRestart ? '已保存，重启通道后生效' : '当前没有未保存的修改'),
            h('div', { className: 'fga-inline-actions' },
              action('仅保存', save, busy || !state || !primaryKey || fallbackSelectionInvalid || !dirty),
              action('保存并重启飞书通道', saveAndRestart,
                busy || !state || !primaryKey || fallbackSelectionInvalid || !dirty, true)))),
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
