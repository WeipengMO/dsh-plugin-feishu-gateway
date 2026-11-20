/* Channel-scoped MCP server editor. No secret values or arbitrary YAML editor. */
function ExternalToolsPanel({ onDirtyChange }) {
  const [registry, setRegistry] = useState(null)
  const [servers, setServers] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const dirty = !!registry && JSON.stringify(servers) !== JSON.stringify(registry.servers)
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const response = await request('/external-tools')
      setRegistry(response.registry)
      setServers(response.registry.servers.map(item => ({ ...item })))
      setError('')
    } catch (err) { setError(err.message || String(err)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  const update = (index, key, value) => {
    setServers(current => current.map((item, i) => i === index ? { ...item, [key]: value } : item))
  }
  const add = () => {
    if (servers.length >= 24) return
    const taken = new Set(servers.map(item => item.name))
    let i = 1
    while (taken.has('server-' + i)) i++
    setServers(current => [...current, {
      name: 'server-' + i, enabled: false, transport: 'streamable-http', url: '',
    }])
  }
  const save = async () => {
    if (!window.confirm('保存外部工具配置？已启用的 MCP Server 将在飞书通道重启后获得 Agent 工具访问能力。')) return
    setBusy(true); setError(''); setNotice('')
    try {
      const normalized = servers.map(item => item.transport === 'stdio'
        ? { name: item.name.trim(), enabled: item.enabled, transport: 'stdio',
          command: (item.command || '').trim(), args: item.args || [] }
        : { name: item.name.trim(), enabled: item.enabled, transport: 'streamable-http',
          url: (item.url || '').trim(), ...(item.credentialRef ? { credentialRef: item.credentialRef.trim() } : {}) })
      const response = await request('/external-tools', 'PUT',
        { servers: normalized, expectedRevision: registry.revision })
      setRegistry(response.registry)
      setServers(response.registry.servers.map(item => ({ ...item })))
      setNotice('外部工具配置已保存。重启飞书通道后生效，新会话可使用新工具。')
    } catch (err) { setError(err.message || String(err)) }
    finally { setBusy(false) }
  }
  const field = (label, control, hint) => h('label', { className: 'fga-field' },
    h('span', { className: 'fga-label' }, label),
    control,
    hint && h('span', { className: 'fga-hint' }, hint))
  const input = (value, onChange, placeholder) => h('input', {
    className: 'fga-input', value: value || '', placeholder, spellCheck: false,
    onChange: e => onChange(e.target.value),
  })
  return h('section', { className: 'fgw-external-tools fga-section' },
    h('div', { className: 'fga-model-heading' },
      h('div', null, h('h3', null, 'MCP / 外部工具'),
        h('p', { className: 'fga-hint' },
          '为独立飞书 Agent 管理多个本地或远程 MCP Server。每个配置都有自己的名称与连接方式，不修改 DSH 全局 Profile。')),
      h('div', { className: 'fga-inline-actions' },
        h('button', { type: 'button', className: 'fga-button fga-secondary', disabled: busy || dirty,
          onClick: () => void reload() }, '刷新'),
        h('button', { type: 'button', className: 'fga-button fga-secondary',
          disabled: busy || loading || registry?.unmanagedPatch || servers.length >= 24, onClick: add }, '添加 MCP'))),
    registry?.unmanagedPatch && h('p', { className: 'fga-warning' },
      '检测到运维手工管理的 extra-plugins.patch.yml。为避免覆盖现有插件配置，本页面只读；请先在服务器侧迁移该文件。'),
    error && h('p', { className: 'fga-error', role: 'alert' }, error),
    notice && h('p', { className: 'fga-notice', role: 'status' }, notice),
    loading ? h('p', { className: 'fga-hint' }, '正在读取外部工具配置…') :
      !servers.length ? h('p', { className: 'fga-hint' }, '尚未配置 MCP Server。添加后可为浏览器、开发工具或其他远程服务建立连接。') :
        servers.map((server, index) => h('div', { className: 'fgw-mcp-card', key: index },
          h('div', { className: 'fgw-mcp-card-head' },
            h('label', { className: 'fga-check' },
              h('input', { type: 'checkbox', checked: server.enabled,
                onChange: e => update(index, 'enabled', e.target.checked) }), '启用'),
            h('strong', null, server.name || '未命名 Server'),
            h('button', { type: 'button', className: 'fga-button fga-secondary',
              disabled: busy, onClick: () => setServers(current => current.filter((_, i) => i !== index)) }, '移除')),
          h('div', { className: 'fga-route-row' },
            field('Server 名称', input(server.name, value => update(index, 'name', value), 'research-mcp'),
              '1–32 位字母、数字、下划线或连字符，必须唯一。'),
            field('连接方式', h('select', { className: 'fga-input', value: server.transport,
              onChange: e => setServers(current => current.map((item, i) =>
                i === index ? { name: item.name, enabled: item.enabled, transport: e.target.value,
                  ...(e.target.value === 'stdio' ? { command: '', args: [] } : { url: '' }) } : item)) },
              h('option', { value: 'streamable-http' }, 'Streamable HTTP（远程）'),
              h('option', { value: 'stdio' }, 'stdio（本地进程）')))),
          server.transport === 'streamable-http'
            ? h('div', { className: 'fga-section' },
              field('MCP Endpoint', input(server.url, value => update(index, 'url', value),
                'https://service.example.org/mcp'),
                '使用完整 HTTP(S) Endpoint；不支持在 URL 内包含密码、令牌或查询参数。'),
              field('Authorization 凭据引用（可选）',
                input(server.credentialRef, value => update(index, 'credentialRef', value),
                  'MCP_SERVICE_TOKEN'),
                '只输入 DSH credential 引用名，不填写 token。运行时按 credential 模板解析。'))
            : h('div', { className: 'fga-section' },
              field('可执行程序', input(server.command, value => update(index, 'command', value),
                '/usr/local/bin/mcp-server'),
                '本地程序需要已安装；不会通过 shell 执行。'),
              field('参数（每行一个）',
                h('textarea', { className: 'fga-input fga-textarea', rows: 3,
                  value: (server.args || []).join('\n'),
                  onChange: e => update(index, 'args', e.target.value.split('\n').filter(Boolean)) }),
                '按顺序传给程序；每行是一个完整参数。')))),
    h('div', { className: 'fga-model-savebar' },
      h('span', { className: 'fga-hint' },
        dirty ? '有尚未保存的 MCP 配置' : '配置保存在飞书通道独立 stateDir；修改需重启生效。'),
      h('button', { type: 'button', className: 'fga-button',
        disabled: busy || loading || !dirty || registry?.unmanagedPatch, onClick: () => void save() },
        busy ? '保存中…' : '保存外部工具')),
    h('p', { className: 'fga-hint' },
      '使用 DSH 官方 @deepseek-ai/dsh-mcp-client。工具的实际连接、授权及使用权限由 DSH 和目标 MCP Server 控制；本页面不代替安装或连接测试。'))
}
