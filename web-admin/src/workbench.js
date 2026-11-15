/* Browser-only Feishu management workbench.
 * Composed into the DSH official root 'main' and 'sidebar.panellist' slots.
 * No new Agent, LLM client, standalone HTTP port, or credential retrieval.
 */
const WORKBENCH_PANEL_ID = 'feishu-management'
const WORKBENCH_NAV = [
  ['overview', '总览', '▦'],
  ['tasks', '实时任务', '◷'],
  ['messages', '消息投递', '⇄'],
  ['sessions', 'Session 管理', '◇'],
  ['approvals', '审批审计', '✓'],
  ['bots', '机器人', '◉'],
  ['usage', '用量统计', '▥'],
  ['alerts', '告警中心', '!'],
  ['security', '安全与权限', '♧'],
  ['diagnostics', '日志与诊断', '⌁'],
  ['advanced', '高级配置', '⚙'],
]

function FeishuSidebarIcon({ size = 18 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true },
    h('path', { d: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4H13a7 7 0 0 1 7 7.5Z' }),
    h('path', { d: 'M8 11h8M8 14h5' }))
}

function wbStatus(value) {
  if (value === 'connected' || value === 'active' || value === 'ok') return 'ok'
  if (value === 'failed' || value === 'degraded' || value === 'stopped') return 'bad'
  return 'neutral'
}
function wbValue(value) {
  return value === undefined || value === null ? '—' : String(value)
}
function wbCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '—'
}
function wbAge(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  const sec = Math.floor(value / 1000)
  if (sec < 60) return sec + ' 秒'
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟'
  const hours = Math.floor(sec / 3600)
  return hours >= 24 ? Math.floor(hours / 24) + ' 天 ' + (hours % 24) + ' 小时' : hours + ' 小时 ' + Math.floor((sec % 3600) / 60) + ' 分钟'
}
function WbMetric({ title, value, caption, tone }) {
  return h('article', { className: 'fgw-metric' },
    h('div', { className: 'fgw-metric-title' }, title),
    h('strong', { className: 'fgw-metric-number' + (tone ? ' fgw-number-' + tone : '') }, wbValue(value)),
    caption && h('span', { className: 'fgw-muted' }, caption))
}
function WbBlock({ title, aside, children }) {
  return h('section', { className: 'fgw-block' },
    h('div', { className: 'fgw-block-head' }, h('h3', null, title),
      aside && h('span', { className: 'fgw-muted' }, aside)),
    h('div', { className: 'fgw-block-body' }, children))
}
function WbState({ value }) {
  const tone = wbStatus(value)
  return h('span', { className: 'fgw-pill fgw-pill-' + tone },
    h('span', { className: 'fgw-dot' }), wbValue(value))
}
function WbRow({ label, value, trailing }) {
  return h('div', { className: 'fgw-data-row' },
    h('span', { className: 'fgw-muted' }, label),
    h('strong', { className: 'fgw-row-value' }, value),
    trailing)
}
function WbEmpty({ headline, description }) {
  return h('div', { className: 'fgw-empty' },
    h('div', { className: 'fgw-empty-icon', 'aria-hidden': true }, '◎'),
    h('strong', null, headline),
    h('p', null, description))
}

function Workbench() {
  const [state, setState] = useState(null)
  const [live, setLive] = useState(undefined)
  const [ops, setOps] = useState(null)
  const [configTab, setConfigTab] = useState('settings')
  const [operatorNotice, setOperatorNotice] = useState('')
  const [selected, setSelected] = useState('overview')
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)
  const load = useCallback(async () => {
    setUpdating(true)
    try {
      const [data, operations] = await Promise.all([
        request('/state'), request('/ops').catch(() => null),
      ])
      setState(data)
      setOps(operations)
      setLive(data.health?.health ?? null)
      setUpdatedAt(new Date())
      setError('')
    } catch (e) {
      setLive(null)
      setError(e.message || String(e))
    } finally { setLoading(false); setUpdating(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    // Monitoring reads the already-running Gateway's health; no model requests.
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      Promise.all([
        request('/health').catch(() => null),
        request('/ops').catch(() => null),
      ]).then(([data, operations]) => {
        setLive(data?.health?.health ?? null)
        setOps(operations)
        setUpdatedAt(new Date())
      })
    }, 15000)
    return () => clearInterval(timer)
  }, [])
  const health = live === undefined ? (state?.health?.health ?? null) : live
  const bots = state?.bots ?? []
  const flags = state?.config ?? {}
  const rejected = health?.rejected && typeof health.rejected === 'object'
    ? Object.values(health.rejected).reduce((sum, value) =>
      sum + (Number.isSafeInteger(value) && value >= 0 ? value : 0), 0)
    : undefined
  const online = health?.status === 'ok'
  const refresh = () => { void load() }
  const onConfig = tab => { setConfigTab(tab || 'settings'); setSelected('advanced') }
  const onCommand = async (type, ref) => {
    const warning = type === 'cancel-task'
      ? '确认取消这个正在运行的任务？已经执行的外部操作不会自动回滚。'
      : '确认检查并补发 Outbox 中尚未投递且允许重试的消息？不会重复执行 Agent。'
    if (!window.confirm(warning)) return
    setOperatorNotice('')
    try {
      const payload = type === 'cancel-task' ? { type, ref } : { type }
      await request('/ops/commands', 'POST', payload)
      setOperatorNotice('操作已提交到 Gateway 队列，尚不代表已执行成功。请稍后刷新「告警中心」查看结果。')
      void load()
    } catch (e) { setOperatorNotice('操作提交失败：' + (e.message || String(e))) }
  }

  let body
  if (selected === 'overview') {
    body = h(React.Fragment, null,
      h('div', { className: 'fgw-metrics' },
        h(WbMetric, { title: '网关健康', value: health?.status || '未知', caption: '实时 Gateway 诊断', tone: online ? 'good' : '' }),
        h(WbMetric, { title: '已处理消息', value: wbCount(health?.processed), caption: '进程内累计' }),
        h(WbMetric, { title: '活跃任务', value: wbCount(health?.activeTurns), caption: '正在处理的 Agent turn' }),
        h(WbMetric, { title: '待发消息', value: wbCount(health?.outbox?.pending), caption: '持久化 Outbox 队列' }),
        h(WbMetric, { title: '已绑定会话', value: wbCount(health?.boundSessions), caption: 'DSH 原生 Session 绑定' }),
        h(WbMetric, { title: '错误数', value: wbCount(health?.errors), caption: '进程内累计', tone: health?.errors ? 'warn' : '' })),
      ops?.telemetryAvailable && h(WbBlock, { title: '需要关注', aside: '当前规则告警' },
        (ops.summary?.alerts ?? []).length ?
          h('div', { className: 'fgw-ops-alerts' },
            ops.summary.alerts.slice(0, 5).map((alert, i) =>
              h('div', { className: 'fgw-caution', key: alert.code + i }, alert.message,
                alert.botId ? ' · ' + alert.botId : ''))) :
          h('p', { className: 'fgw-muted' }, '暂无当前规则告警。')),
      ops?.telemetryAvailable && h(WbBlock, { title: '实时任务', aside: '来自 Gateway 快照' },
        h(OpsTable, { rows: ops.snapshot?.stale ? [] : ops.snapshot?.tasks,
          empty: '当前没有活跃任务',
          columns: [
            { key: 'ref', title: '任务', render: x => h('code', null, x.ref.slice(0, 10)) },
            { key: 'botId', title: '机器人' },
            { key: 'phase', title: '阶段', render: x => h(WbState, { value: x.phase }) },
            { key: 'elapsedMs', title: '已用时', render: x => wbAge(x.elapsedMs) },
          ] })),
      h('div', { className: 'fgw-two-column' },
        h(WbBlock, { title: '机器人连接', aside: bots.length + ' 个已配置' },
          bots.map(bot => h('div', { className: 'fgw-bot-line', key: bot.id },
            h('span', { className: 'fgw-avatar', 'aria-hidden': true }, '飞'),
            h('span', { className: 'fgw-bot-detail' }, h('strong', null, bot.id),
              h('span', { className: 'fgw-muted' }, bot.domain === 'lark' ? 'Lark 国际版' : '飞书中国版')),
            h(WbState, { value: health?.transports?.[bot.id] || (bot.enabled === false ? 'disabled' : 'unavailable') }))),
          bots.length === 0 && h(WbEmpty, { headline: '暂无机器人', description: '请先在设置页配置 Gateway 凭据。' })),
        h(WbBlock, { title: '运行状态', aside: '当前服务实例' },
          h(WbRow, { label: 'systemd', value: h(WbState, { value: state?.service }) }),
          h(WbRow, { label: 'DSH Session Bridge', value: health?.sessionBridge?.available ? '可用' : '未就绪' }),
          h(WbRow, { label: '运行时长', value: wbAge(health?.uptimeMs) }),
          h(WbRow, { label: '待审批', value: wbCount(health?.pendingApprovals) }),
          state?.pendingRestart && h('div', { className: 'fgw-caution' }, '配置已更新，尚待重启 Gateway 生效。'))),
      h(WbBlock, { title: '消息处理链路', aside: '从已有网关诊断读取；不分析聊天内容' },
        h('div', { className: 'fgw-flow' },
          h('div', null, h('span', null, '01'), h('strong', null, '飞书入站'), h('small', null, 'Inbox')),
          h('div', null, h('span', null, '02'), h('strong', null, '原生会话'), h('small', null, 'DSH Session')),
          h('div', null, h('span', null, '03'), h('strong', null, '回复投递'), h('small', null, 'CardKit / Outbox'))),
        h('div', { className: 'fgw-row-inline' },
          h('span', { className: 'fgw-muted' }, '入站等待：', wbCount(health?.inbox?.pending)),
          h('span', { className: 'fgw-muted' }, '投递等待：', wbCount(health?.outbox?.pending)),
          h('span', { className: 'fgw-muted' }, '去重记录：', wbCount(health?.dedupEntries)))))
  } else if (selected === 'bots') {
    body = h('div', { className: 'fgw-grid-cards' },
      bots.map(bot => h('article', { className: 'fgw-detail-card', key: bot.id },
        h('div', { className: 'fgw-detail-top' }, h('span', { className: 'fgw-avatar fgw-avatar-large' }, '飞'),
          h(WbState, { value: health?.transports?.[bot.id] || (bot.enabled === false ? 'disabled' : 'unavailable') })),
        h('h3', null, bot.id),
        h('p', { className: 'fgw-muted' }, bot.domain === 'lark' ? 'Lark · 国际' : 'Feishu · 中国'),
        h(WbRow, { label: '通道开关', value: bot.enabled === false ? '禁用' : '启用' }),
        h(WbRow, { label: '凭据状态', value: state?.credentials?.find(x => x.id === bot.id)?.configured ? '已配置' : '未检测到完整凭据' }),
        h('p', { className: 'fgw-muted' }, '修改机器人标识和启用状态：高级管理；更新 App ID / Secret：设置 → 飞书 Gateway。'))),
      bots.length === 0 && h(WbEmpty, { headline: '尚无机器人', description: '配置凭据后，机器人状态会自动显示在这里。' }))
  } else if (selected === 'security') {
    body = h(React.Fragment, null,
      h('div', { className: 'fgw-two-column' },
        h(WbBlock, { title: '访问权限' },
          h(WbRow, { label: '白名单', value: Array.isArray(flags.allowlist) ? flags.allowlist.length + ' 位允许用户' : '继承原 Profile' }),
          h(WbRow, { label: 'DSH Web 授权', value: '原生浏览器会话' }),
          h(WbRow, { label: '消息正文', value: '运维接口不返回' }),
          h(WbRow, { label: '凭据回显', value: '禁止' })),
        h(WbBlock, { title: '审批边界' },
          h(WbRow, { label: '审批卡片', value: flags.approvalCards ? '已开启' : '继承 / 关闭' }),
          h(WbRow, { label: '当前等待审批', value: wbCount(health?.pendingApprovals) }),
          h(WbRow, { label: '配置生效', value: state?.pendingRestart ? '待重启' : '无待生效修改' }),
          h(OpsNote, null, '不会绕过 DSH 原生审批流程。'))),
      h(OpsAction, { label: '编辑白名单与安全设置', onClick: () => onConfig('permissions') }),
      ops?.telemetryAvailable && h(WbBlock, { title: '最近审批安全事件' },
        h(OpsTimeline, { events: ops.summary?.approvals?.slice(0, 20) })))
  } else if (selected === 'advanced') {
    body = h('div', { className: 'fgw-advanced' },
      h('p', { className: 'fgw-muted' },
        '此页面可修改模型、机器人、白名单、卡片、重试策略和连接设置。凭据仍在 DSH 设置 → 飞书 Gateway。重启前确认没有在途任务。'),
      h(Panel, { key: configTab, initialTab: configTab, onChanged: load }))
  } else {
    body = h(OpsPage, { kind: selected, ops, onConfig, onCommand })
  }

  return h('div', { className: 'fgw-root' },
    h('aside', { className: 'fgw-subnav', 'aria-label': '飞书管理页面导航' },
      h('div', { className: 'fgw-subnav-brand' },
        h('span', { className: 'fgw-brandmark', 'aria-hidden': true }, h(FeishuSidebarIcon, { size: 20 })),
        h('div', null, h('strong', null, '飞书管理'), h('small', null, 'CONTROL CENTER'))),
      h('nav', { className: 'fgw-subnav-list', 'aria-label': '管理功能' },
        WORKBENCH_NAV.map(([id, title, symbol]) =>
          h('button', { key: id, type: 'button', className: 'fgw-nav-item' + (selected === id ? ' is-active' : ''),
            'aria-current': selected === id ? 'page' : undefined, onClick: () => setSelected(id) },
            h('span', { className: 'fgw-nav-symbol', 'aria-hidden': true }, symbol), title))),
      h('div', { className: 'fgw-subnav-foot' },
        h(WbState, { value: health?.status ?? 'unknown' }),
        h('p', null, '只读监控不产生额外模型调用'))),
    h('main', { className: 'fgw-content' },
      h('div', { className: 'fgw-topbar' },
        h('div', null, h('div', { className: 'fgw-eyebrow' }, 'DSH / FEISHU GATEWAY'),
          h('h1', null, WORKBENCH_NAV.find(x => x[0] === selected)?.[1] || '飞书管理')),
        h('div', { className: 'fgw-top-actions' },
          h('span', { className: 'fgw-muted' }, updatedAt ? '更新 ' + updatedAt.toLocaleTimeString() : '尚未更新'),
          selected !== 'advanced' && h('button', { className: 'fgw-refresh fgw-ops-cta', type: 'button',
            onClick: () => onConfig(selected === 'bots' ? 'bots' : selected === 'security' ? 'permissions' : 'settings') }, '配置管理'),
          h('button', { className: 'fgw-refresh', type: 'button', disabled: updating,
            onClick: refresh }, updating ? '刷新中…' : '↻ 刷新'))),
      selected === 'overview' && h('div', { className: 'fgw-hero' },
        h('div', null, h('div', { className: 'fgw-hero-kicker' }, 'GATEWAY OPERATIONS'),
          h('h2', null, '你的飞书 Agent，运行状态一目了然。'),
          h('p', null, '与 DSH 原生 Session 同步，集中监控机器人、投递、审批和服务健康。')),
        h('div', { className: 'fgw-hero-status' }, h(WbState, { value: health?.status || 'unknown' }),
          h('span', null, state?.service ?? '服务状态未知'))),
      loading && !state && h('div', { className: 'fgw-caution' }, '正在读取管理服务…'),
      error && h('div', { className: 'fgw-alert', role: 'alert' }, '管理服务暂不可用：', error),
      operatorNotice && h('div', { className: 'fgw-caution', role: 'status' }, operatorNotice),
      state && body,
      !state && !loading && h(WbEmpty, { headline: '无法获取管理数据', description: '请检查 DSH Web 的飞书管理插件是否已加载，以及 feishu-channel 服务是否运行。' }),
      h('footer', { className: 'fgw-footnote' }, 'DSH 原生插件扩展 · 仅使用现有认证 API · 15 秒可见页轻量刷新')))
}

function CredentialSettings() {
  const [state, setState] = useState(null)
  const [botId, setBotId] = useState('default')
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const data = await request('/state')
      setState(data)
      setBotId(current => data.bots.some(b => b.id === current) ? current : (data.bots[0]?.id || 'default'))
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])
  const save = async () => {
    setBusy(true); setError(''); setMessage('')
    try {
      const payload = { botId }
      if (appId.trim()) payload.appId = appId.trim()
      if (appSecret.trim()) payload.appSecret = appSecret.trim()
      if (!payload.appId && !payload.appSecret) throw Error('请输入新的 App ID 或 App Secret')
      await request('/credentials', 'PUT', payload)
      setAppId(''); setAppSecret('')
      setMessage('凭据已保存到受限文件；重启飞书通道后生效。')
      await load()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  return h('div', { className: 'fga-root fgw-credential-settings' },
    h('div', { className: 'fga-header' }, h('div', null,
      h('h2', null, '飞书 Gateway 凭据'),
      h('p', null, '此页面只负责飞书应用连接凭证；运行状态和任务监控请使用左侧栏「飞书管理」。'))),
    error && h('div', { className: 'fga-error', role: 'alert' }, error),
    message && h('div', { className: 'fga-notice', role: 'status' }, message),
    h('section', { className: 'fgw-credential-card' },
      h('h3', null, '应用凭据'),
      field('机器人', h('select', { className: 'fga-input', value: botId, disabled: busy,
        onChange: e => { setBotId(e.target.value); setAppId(''); setAppSecret('') } },
        ...(state?.bots ?? [{ id: 'default' }]).map(bot => h('option', { key: bot.id, value: bot.id }, bot.id)))),
      h('div', { className: 'fgw-credential-indicator' },
        '当前状态：', state?.credentials?.find(x => x.id === botId)?.configured ? '已配置' : '未配置完整凭据'),
      field('App ID', textInput(appId, setAppId, 'cli_…（留空表示保持不变）', { disabled: busy })),
      field('App Secret', textInput(appSecret, setAppSecret, '填写新密钥（留空保持不变）', {
        type: 'password', autoComplete: 'new-password', disabled: busy })),
      h('p', { className: 'fga-hint' }, 'App Secret 只写入服务器上的受限文件，不会在任何管理 API 中回显。'),
      action(busy ? '正在保存…' : '安全保存凭据', save, busy || !state)),
    h('p', { className: 'fga-footer' },
      '机器人列表、访问策略、运行诊断与高级配置现已集中在左侧栏「飞书管理」。'))
}
