/* Browser-only Feishu management workbench.
 * Composed into the DSH official root 'main' and 'sidebar.panellist' slots.
 * No new Agent, LLM client, standalone HTTP port, or credential retrieval.
 */
const WORKBENCH_PANEL_ID = 'feishu-management'
const WORKBENCH_NAV = [
  ['overview', '总览', '▦'],
  ['sessions', '会话管理', '▤'],
  ['conversations', '任务与消息', '⇄'],
  ['automation', '定时任务', '◷'],
  ['channels', '接入与权限', '◉'],
  ['agent-profile', 'Agent 档案', '▤'],
  ['skills', 'Skills 技能', '◇'],
  ['analytics', '用量与审计', '▥'],
  ['operations', '运维与诊断', '⌁'],
  ['advanced', '模型与连接', '⚙'],
]
const WORKBENCH_GROUPS = [
  { label: '日常管理', ids: ['overview', 'sessions', 'conversations', 'automation'] },
  { label: '机器人与 Agent', ids: ['channels', 'agent-profile', 'skills', 'advanced'] },
  { label: '统计与诊断', ids: ['analytics', 'operations'] },
]
const WORKBENCH_TABS = {
  conversations: [['tasks', '实时任务'], ['messages', '消息投递']],
  channels: [['bots', '机器人'], ['groups', '群聊管理'], ['security', '安全与权限']],
  analytics: [['usage', 'Token 用量'], ['approvals', '审批审计']],
  operations: [['alerts', '告警中心'], ['diagnostics', '连接与日志']],
}
const WORKBENCH_DESCRIPTIONS = {
  sessions: '整理对话历史、已归档记录和飞书聊天关联。',
  conversations: '查看正在执行的任务和飞书消息投递情况。',
  automation: '管理 DSH 原生定时任务、运行记录和飞书通知。',
  channels: '统一管理机器人、群聊、白名单与工具执行权限。',
  'agent-profile': '管理飞书 Agent 的独立工作区身份和记忆。',
  skills: '为飞书 Agent 管理独立的 SKILL.md 技能，不影响 DSH 全局配置。',
  analytics: '查看 Token 消耗与工具审批审计。',
  operations: '检查告警、连接状态和运行日志。',
  advanced: '配置模型、代理、卡片和重试策略。',
}

function FeishuSidebarIcon({ size = 18 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true },
    h('path', { d: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4H13a7 7 0 0 1 7 7.5Z' }),
    h('path', { d: 'M8 11h8M8 14h5' }))
}

function wbStatus(value) {
  if (value === 'connected' || value === 'active' || value === 'ok') return 'ok'
  if (value === 'failed' || value === 'degraded' || value === 'stopped' || value === 'error') return 'bad'
  return 'neutral'
}
const WORKBENCH_STATE_LABELS = {
  ok: '正常', connected: '已连接', active: '运行中', running: '执行中',
  done: '已完成', completed: '已完成', queued: '等待执行',
  pending: '等待中', idle: '空闲', paused: '已暂停',
  failed: '失败', degraded: '异常', stopped: '已停止',
  error: '错误', disabled: '已停用', unavailable: '不可用',
  unknown: '未知', rejected: '已拒绝', retrying: '正在重试',
  delivered: '已送达', sent: '已发送', uncertain: '结果待确认',
  skipped: '已跳过', cancelled: '已取消', canceled: '已取消',
}
function wbStateLabel(value) {
  return WORKBENCH_STATE_LABELS[value] || wbValue(value)
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
    h('span', { className: 'fgw-dot' }), wbStateLabel(value))
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


function botListIssue(list) {
  if (!Array.isArray(list) || list.length === 0) return '至少需要保留一个机器人，不能保存空列表。'
  if (list.length > 8) return '最多只能配置 8 个机器人。'
  const seen = new Set()
  for (const bot of list) {
    const id = typeof bot.id === 'string' ? bot.id.trim() : ''
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id))
      return '机器人标识需以小写字母开头，只能包含小写字母、数字、下划线或连字符（最多 32 位）。'
    const envKey = id.toUpperCase().replace(/-/g, '_')
    if (seen.has(envKey)) return '机器人标识冲突：连字符和下划线会映射到同一组凭据环境变量。'
    seen.add(envKey)
  }
  if (!list.some(bot => bot.enabled !== false)) return '至少需要启用一个机器人，不能全部禁用。'
  return ''
}

function BotManagementPanel({ state, health, onChanged, onDirtyChange }) {
  const bots = Array.isArray(state?.bots) ? state.bots : []
  const managed = Array.isArray(state?.config?.bots)
  const [draft, setDraft] = useState(() => bots.map(bot => ({ ...bot })))
  const [confirmSource, setConfirmSource] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState('')
  const [checks, setChecks] = useState({})
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    const effective = Array.isArray(state?.config?.bots) ? state.config.bots : (state?.bots || [])
    setDraft(effective.map(bot => ({ ...bot })))
    setConfirmSource(null)
  }, [state?.revision])
  const issue = botListIssue(draft)
  const effectiveBots = Array.isArray(state?.config?.bots) ? state.config.bots : bots
  const botSignature = rows => JSON.stringify(rows.map(bot =>
    ({ id: bot.id, domain: bot.domain, enabled: bot.enabled !== false })))
  const dirty = managed && botSignature(draft) !== botSignature(effectiveBots)
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  const changeBot = (index, key, value) => setDraft(current =>
    current.map((bot, i) => i === index ? { ...bot, [key]: value } : bot))

  async function saveBots(nextBots, success) {
    const validation = nextBots === null ? '' : botListIssue(nextBots)
    if (validation) { setError(validation); return false }
    setSaving(true); setNotice(''); setError('')
    try {
      // Only change the bots key. Preserve model routing, proxy, permissions and
      // the rest of the managed configuration; revision prevents stale writes.
      const config = { ...(state?.config || {}) }
      if (nextBots === null) delete config.bots
      else config.bots = nextBots.map(bot => ({
        id: bot.id.trim(), domain: bot.domain, enabled: bot.enabled !== false,
      }))
      await request('/config', 'PUT', { expectedRevision: state.revision, config })
      await onChanged?.()
      setNotice(success + ' 新配置需要重启飞书通道后才会生效；本次没有自动重启。')
      return true
    } catch (e) {
      setError(e?.message === 'config changed; reload before saving'
        ? '配置已被其他操作更新，请刷新后重新操作。' : (e?.message || String(e)))
      return false
    } finally { setSaving(false) }
  }

  async function confirmChange() {
    if (!confirmSource) return
    const target = confirmSource
    const ok = await saveBots(target === 'managed' ? draft : null,
      target === 'managed' ? '已切换为在此页面管理机器人。' : '已恢复使用 DSH 原有机器人配置。')
    if (ok) setConfirmSource(null)
  }

  async function testConnection(bot) {
    setTesting(bot.id)
    setChecks(current => ({ ...current, [bot.id]: null }))
    try {
      // Read actual Gateway transport health: no dummy Feishu message or
      // unverified "connected" result is generated on the client.
      const response = await request('/health')
      const status = response.health?.health?.transports?.[bot.id]
      const message = bot.enabled === false
        ? '此机器人已禁用，无法检测活动连接。'
        : status === 'connected' ? 'Gateway 长连接正常（未发送测试消息）。'
        : status ? '当前连接状态：' + status + '（未发送测试消息）。'
        : '网关尚未报告此机器人的连接状态，请检查服务日志。'
      setChecks(current => ({ ...current, [bot.id]: { ok: status === 'connected', message } }))
    } catch (e) {
      setChecks(current => ({ ...current, [bot.id]: {
        ok: false, message: '连接检测失败：' + (e?.message || String(e)),
      } }))
    } finally { setTesting('') }
  }

  return h(React.Fragment, null,
    h('div', { className: 'fgw-bot-grid' },
      bots.map(bot => {
        const credential = state?.credentials?.find(item => item.id === bot.id)
        const check = checks[bot.id]
        return h('article', { className: 'fgw-detail-card fgw-bot-card', key: bot.id },
          h('div', { className: 'fgw-detail-top' },
            h('span', { className: 'fgw-avatar fgw-avatar-large', 'aria-hidden': true }, '飞'),
            h(WbState, { value: health?.transports?.[bot.id] ||
              (bot.enabled === false ? 'disabled' : 'unavailable') })),
          h('div', { className: 'fgw-bot-card-heading' },
            h('h3', null, bot.id),
            h('span', { className: 'fgw-muted' }, '机器人标识')),
          h('p', { className: 'fgw-muted' },
            bot.domain === 'lark' ? 'Lark · 国际' : '飞书 · 中国'),
          h(WbRow, { label: '通道', value: bot.enabled === false ? '已禁用' : '已启用' }),
          h(WbRow, { label: 'App ID', value: credential?.appIdMasked || '未检测到' }),
          h(WbRow, { label: '凭据', value: credential?.configured ? '已配置' : '未检测到完整凭据' }),
          h('div', { className: 'fgw-bot-card-actions' },
            h('button', { className: 'fga-button fga-secondary', type: 'button',
              disabled: Boolean(testing) || saving || bot.enabled === false,
              onClick: () => testConnection(bot) },
              testing === bot.id ? '检测中…' : '检查连接状态')),
          check && h('p', { className: 'fgw-bot-check' + (check.ok ? ' is-ok' : ''),
            role: 'status' }, check.message))
      }),
      bots.length === 0 && h(WbEmpty, {
        headline: '尚无机器人',
        description: '请先在 DSH 设置中配置机器人及凭据。',
      })),
    state?.pendingRestart && h('div', { className: 'fgw-caution' },
      '存在尚未应用的设置修改，重启飞书通道后才会生效。'),
    h(WbBlock, { title: '配置来源', aside: managed ? '当前由此页面管理' : '当前使用 DSH 原有配置' },
      h('p', { className: 'fgw-bot-help' },
        '默认沿用 DSH 原有机器人列表。只有需要在此添加或调整机器人时，才切换到页面管理。'),
      h('div', { className: 'fgw-bot-source-grid' },
        h('button', { className: 'fgw-bot-source' + (!managed ? ' is-active' : ''),
          type: 'button', 'aria-pressed': !managed, disabled: saving || !managed,
          onClick: () => setConfirmSource('profile') },
          h('strong', null, '使用 DSH 原有配置'),
          h('span', null, '不覆盖原有机器人列表；适合已经正常运行的连接。'),
          h('small', null, !managed ? '当前使用' : '切换至此')),
        h('button', { className: 'fgw-bot-source' + (managed ? ' is-active' : ''),
          type: 'button', 'aria-pressed': managed, disabled: saving || managed || Boolean(issue),
          onClick: () => setConfirmSource('managed') },
          h('strong', null, '在此页面管理'),
          h('span', null, '编辑机器人标识、区域和启用状态；最多 8 个。'),
          h('small', null, managed ? '当前使用' : '切换至此'))),
      !managed && issue && h('p', { className: 'fgw-bot-help', role: 'status' },
        '暂不能切换：' + issue),
      h('p', { className: 'fgw-bot-help' },
        'App ID / App Secret 请到 DSH 设置 → 飞书 Gateway 修改。这里的「检查连接状态」只读取现有连接，不会发送测试消息。')),
    managed && h(WbBlock, { title: '编辑机器人', aside: '保存后需要重启飞书通道' },
      h('div', { className: 'fgw-bot-edit-list' },
        draft.map((bot, index) =>
          h('div', { className: 'fgw-bot-edit-row', key: index },
            h('label', { className: 'fga-field' },
              h('span', { className: 'fga-label' }, '机器人标识'),
              h('input', { className: 'fga-input', value: bot.id,
                onChange: e => changeBot(index, 'id', e.target.value),
                placeholder: '例如 default', spellCheck: false })),
            h('label', { className: 'fga-field' },
              h('span', { className: 'fga-label' }, '接入区域'),
              h('select', { className: 'fga-input', value: bot.domain,
                onChange: e => changeBot(index, 'domain', e.target.value) },
                h('option', { value: 'feishu' }, '飞书（中国）'),
                h('option', { value: 'lark' }, 'Lark（国际）'))),
            h('label', { className: 'fga-check fgw-bot-enabled' },
              h('input', { type: 'checkbox', checked: bot.enabled !== false,
                onChange: e => changeBot(index, 'enabled', e.target.checked) }),
              '启用'),
            h('button', { type: 'button', className: 'fga-button fga-secondary',
              disabled: saving || draft.length <= 1,
              onClick: () => setDraft(list => list.filter((_, i) => i !== index)) },
              '移除')))),
      issue && h('p', { className: 'fga-error', role: 'alert' }, issue),
      h('div', { className: 'fgw-bot-edit-actions' },
        h('button', { type: 'button', className: 'fga-button fga-secondary',
          disabled: saving || draft.length >= 8,
          onClick: () => setDraft(list => [...list, { id: '', domain: 'feishu', enabled: false }]) },
          '添加机器人'),
        h('button', { type: 'button', className: 'fga-button',
          disabled: saving || Boolean(issue),
          onClick: () => saveBots(draft, '机器人列表已保存。') },
          saving ? '保存中…' : '保存机器人配置'))),
    error && h('div', { className: 'fga-error', role: 'alert' }, error),
    notice && h('div', { className: 'fga-notice', role: 'status' }, notice),
    confirmSource && h('div', { className: 'fgw-bot-modal-backdrop' },
      h('div', { className: 'fgw-bot-modal', role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'fgw-bot-modal-title' },
        h('h3', { id: 'fgw-bot-modal-title' }, '确认切换机器人配置来源'),
        h('p', null, confirmSource === 'managed'
          ? '将使用本页面列出的机器人覆盖 DSH 原有机器人列表。'
          : '将停止覆盖机器人列表，并恢复从 DSH 原有配置读取。'),
        h('p', { className: 'fgw-bot-help' },
          '切换不会删除 App ID / Secret，但可能改变实际接入的机器人。保存后需要手动重启通道，正在运行的任务可能受到影响。'),
        confirmSource === 'managed' && h('p', { className: 'fgw-bot-help' },
          '将启用 ' + draft.filter(bot => bot.enabled !== false).length + ' 个机器人。'),
        h('div', { className: 'fgw-bot-modal-actions' },
          h('button', { type: 'button', className: 'fga-button fga-secondary',
            disabled: saving, onClick: () => setConfirmSource(null) }, '取消'),
          h('button', { type: 'button', className: 'fga-button',
            disabled: saving || (confirmSource === 'managed' && Boolean(issue)),
            onClick: confirmChange }, saving ? '保存中…' : '确认切换')))))
}

function Workbench() {
  const [state, setState] = useState(null)
  const [live, setLive] = useState(undefined)
  const [ops, setOps] = useState(null)
  // Permanent tool authorizations + approval audit come from their own
  // authoritative Gateway read model (never inferred from /ops events).
  const [approvals, setApprovals] = useState(null)
  const [sectionTab, setSectionTab] = useState({
    conversations: 'tasks', channels: 'bots', analytics: 'usage', operations: 'alerts',
  })
  const [operatorNotice, setOperatorNotice] = useState('')
  const [selected, setSelected] = useState('overview')
  const [profileUnsaved, setProfileUnsaved] = useState(false)
  const [skillsUnsaved, setSkillsUnsaved] = useState(false)
  const [groupUnsaved, setGroupUnsaved] = useState(false)
  const [botUnsaved, setBotUnsaved] = useState(false)
  const [execUnsaved, setExecUnsaved] = useState(false)
  const [settingsUnsaved, setSettingsUnsaved] = useState(false)
  const [scheduleUnsaved, setScheduleUnsaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)
  const load = useCallback(async () => {
    setUpdating(true)
    try {
      const [data, operations, approvalRead] = await Promise.all([
        request('/state'), request('/ops').catch(() => null),
        request('/approvals').catch(() => null),
      ])
      setState(data)
      setOps(operations)
      setApprovals(approvalRead?.model ?? null)
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
        request('/approvals').catch(() => null),
      ]).then(([data, operations, approvalRead]) => {
        setLive(data?.health?.health ?? null)
        setOps(operations)
        setApprovals(approvalRead?.model ?? null)
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
  const dirtyForCurrent = selected === 'automation' ? scheduleUnsaved
    : selected === 'agent-profile' ? profileUnsaved
    : selected === 'skills' ? skillsUnsaved
    : selected === 'advanced' ? settingsUnsaved
    : selected === 'channels' ? sectionTab.channels === 'bots' ? botUnsaved
      : sectionTab.channels === 'groups' ? groupUnsaved
      : execUnsaved || settingsUnsaved
    : false
  const confirmLeave = () => !dirtyForCurrent ||
    window.confirm('此页面还有未保存的修改。离开会放弃这些修改，确定继续？')
  useEffect(() => {
    if (!dirtyForCurrent) return
    const guard = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirtyForCurrent])
  const selectSection = id => {
    if (id === selected || !confirmLeave()) return
    setSelected(id)
  }
  const onConfig = tab => {
    if (!confirmLeave()) return
    if (tab === 'bots' || tab === 'permissions') {
      setSectionTab(current => ({ ...current, channels: tab === 'bots' ? 'bots' : 'security' }))
      setSelected('channels')
    } else setSelected('advanced')
  }
  const tabs = WORKBENCH_TABS[selected] || []
  const changeTab = id => {
    if (sectionTab[selected] === id || !confirmLeave()) return
    setSectionTab(current => ({ ...current, [selected]: id }))
  }
  const onCommand = async (type, ref) => {
    const warning = type === 'cancel-task'
      ? '确认取消这个正在运行的任务？已经执行的外部操作不会自动回滚。'
      : '确认检查并补发 Outbox 中尚未投递且允许重试的消息？不会重复执行 Agent。'
    if (!window.confirm(warning)) return
    setOperatorNotice('')
    try {
      const payload = type === 'cancel-task' ? { type, ref } : { type }
      await request('/ops/commands', 'POST', payload)
      setOperatorNotice('操作已提交到 Gateway 队列，尚不代表已执行成功。请稍后在「运维与诊断 → 告警中心」查看结果。')
      void load()
    } catch (e) { setOperatorNotice('操作提交失败：' + (e.message || String(e))) }
  }

  let body
  if (selected === 'overview') {
    body = h(React.Fragment, null,
      h('div', { className: 'fgw-metrics fgw-overview-metrics' },
        h(WbMetric, { title: '服务状态', value: wbStateLabel(health?.status || 'unknown'), caption: '飞书消息接入状态', tone: online ? 'good' : 'warn' }),
        h(WbMetric, { title: '已处理消息', value: wbCount(health?.processed), caption: '进程内累计' }),
        h(WbMetric, { title: '正在处理', value: wbCount(health?.activeTurns), caption: '执行中的任务' }),
        h(WbMetric, { title: '待发消息', value: wbCount(health?.outbox?.pending), caption: '等待发送到飞书' }),
        h(WbMetric, { title: '已绑定会话', value: wbCount(health?.boundSessions), caption: '正在使用的飞书对话' }),
        h(WbMetric, { title: '运行错误', value: wbCount(health?.errors), caption: '本次服务运行期间', tone: health?.errors ? 'warn' : '' })),
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
      h('p', { className: 'fgw-overview-footnote' },
        '投递明细和去重记录请在「会话与消息 → 消息投递」中查看。'))
  } else if (selected === 'channels' && sectionTab.channels === 'bots') {
    body = h(BotManagementPanel, { state, health, onChanged: load, onDirtyChange: setBotUnsaved })
  } else if (selected === 'channels' && sectionTab.channels === 'groups') {
    body = h(GroupManagementPanel, { onChanged: load, onDirtyChange: setGroupUnsaved })
  } else if (selected === 'agent-profile') {
    body = h(AgentProfilePanel, { onDirtyChange: setProfileUnsaved })
  } else if (selected === 'skills') {
    body = h(SkillsPanel, { onDirtyChange: setSkillsUnsaved })
  } else if (selected === 'channels' && sectionTab.channels === 'security') {
    body = h(React.Fragment, null,
      h(ExecPolicyPanel, { onDirtyChange: setExecUnsaved }),
      h('details', { className: 'fgw-security-details' },
        h('summary', null, '查看当前访问与审批状态'),
        h('div', { className: 'fgw-security-detail-grid' },
          h(WbRow, { label: '群聊访问', value:
            ({ disabled: '未开放', allowlist: '仅允许名单内群聊', open: '允许群聊' })[flags.groupPolicy] || '继承配置' }),
          h(WbRow, { label: '已配置群聊', value: wbCount(flags.groups?.length || 0) }),
          h(WbRow, { label: '私聊访问',
            value: Array.isArray(flags.allowlist) ? flags.allowlist.length + ' 位允许用户' : '继承原有配置' }),
          h(WbRow, { label: '审批卡片', value: flags.approvalCards ? '已启用' : '未启用' }),
          h(WbRow, { label: '等待审批', value: wbCount(health?.pendingApprovals) }),
          h(WbRow, { label: '配置状态', value: state?.pendingRestart ? '重启后生效' : '已同步' }))),
      ops?.telemetryAvailable && (ops.summary?.approvals?.length > 0) &&
        h('details', { className: 'fgw-security-details' },
          h('summary', null, '最近审批安全事件（' + ops.summary.approvals.length + '）'),
          h(OpsTimeline, { events: ops.summary.approvals.slice(0, 20) })))
  } else if (selected === 'advanced') {
    body = h('div', { className: 'fgw-advanced' },
      h('p', { className: 'fgw-muted' },
        '配置仅用于飞书通道。保存后重启生效；重启会中断正在执行的任务。'),
      h(Panel, { key: 'settings', initialTab: 'settings', hideTabs: true,
        onChanged: load, onDirtyChange: setSettingsUnsaved }))
  } else if (selected === 'automation') {
    // SchedulePanel fetches /schedule, /schedule/preview, /schedule/commands and
    // /schedule/results itself via the shared authenticated `request` helper.
    // `/state` is passed through so the delivery target select is constrained
    // to configured bots, allowlist users and enabled groups without a second
    // round trip. Rendered only when the workbench has a valid state.
    body = h(SchedulePanel, { state, onChanged: load, onDirtyChange: setScheduleUnsaved })
  } else if (selected === 'sessions') {
    // Native DSH session management has its own filters and refresh; keeping
    // it a first-level page avoids three redundant nested navigation layers.
    body = h(FeishuSessionCenter, {
      compaction: ops?.snapshot?.compaction,
      compactionStale: ops?.snapshot?.stale === true,
    })
  } else if (selected === 'conversations' || selected === 'analytics' || selected === 'operations') {
    body = h(OpsPage, { kind: sectionTab[selected], ops, approvals, onConfig, onCommand,
      onApprovalsRefresh: load })
  } else {
    body = h(WbEmpty, { headline: '未知页面', description: '请选择左侧的管理功能。' })
  }
  // Settings share the section with their Gateway capability.
  if (selected === 'channels' && sectionTab.channels === 'security') {
    body = h(React.Fragment, null, body,
      h(WbBlock, { title: '私聊访问控制', aside: '设置谁可以通过私聊使用机器人' },
        h('div', { className: 'fgw-advanced' },
          h(Panel, { key: 'permissions', initialTab: 'permissions', hideTabs: true,
            onChanged: load, onDirtyChange: setSettingsUnsaved }))))
  }

  return h('div', { className: 'fgw-root' },
    h('aside', { className: 'fgw-subnav', 'aria-label': '飞书管理页面导航' },
      h('div', { className: 'fgw-subnav-brand' },
        h('span', { className: 'fgw-brandmark', 'aria-hidden': true }, h(FeishuSidebarIcon, { size: 20 })),
        h('div', null, h('strong', null, '飞书管理'), h('small', null, '管理后台'))),
      h('nav', { className: 'fgw-subnav-list', 'aria-label': '管理功能' },
        WORKBENCH_GROUPS.map(group => h('div', { key: group.label, className: 'fgw-nav-group' },
          h('div', { className: 'fgw-nav-group-title' }, group.label),
          group.ids.map(id => {
            const item = WORKBENCH_NAV.find(value => value[0] === id)
            const [key, title, symbol] = item
            return h('button', { key, type: 'button',
              className: 'fgw-nav-item' + (selected === id ? ' is-active' : ''),
              'aria-current': selected === id ? 'page' : undefined,
              onClick: () => selectSection(id) },
              h('span', { className: 'fgw-nav-symbol', 'aria-hidden': true }, symbol), title)
          })))),
      h('div', { className: 'fgw-subnav-foot' },
        h(WbState, { value: health?.status ?? 'unknown' }),
        h('p', null, '只读监控不产生额外模型调用'))),
    h('main', { className: 'fgw-content' + ((selected === 'agent-profile' || selected === 'skills') ? ' fgw-content-profile' : '') },
      h('div', { className: 'fgw-topbar' },
        h('div', null, h('div', { className: 'fgw-eyebrow' }, '飞书 Gateway'),
          h('h1', null, WORKBENCH_NAV.find(x => x[0] === selected)?.[1] || '飞书管理'),
          !tabs.length && h('p', { className: 'fgw-section-description' }, WORKBENCH_DESCRIPTIONS[selected])),
        h('div', { className: 'fgw-top-actions' },
          selected !== 'agent-profile' && selected !== 'skills' && h('span', { className: 'fgw-muted' }, updatedAt ? '更新 ' + updatedAt.toLocaleTimeString() : '尚未更新'),
          selected !== 'agent-profile' && selected !== 'skills' && selected !== 'automation' && selected !== 'sessions' &&
            h('button', { className: 'fgw-refresh fgw-refresh-action', type: 'button', disabled: updating,
              onClick: refresh }, updating ? '刷新中…' : '刷新'))),
      selected === 'overview' && h('div', { className: 'fgw-hero' },
        h('div', null, h('div', { className: 'fgw-hero-kicker' }, '服务运行概览'),
          h('h2', null, online ? '飞书机器人运行正常' : '请检查飞书通道状态'),
          h('p', null, online ? '消息收发服务正常。下方可查看待发消息和最近告警。' : '若机器人无法回复，请先查看告警中心和连接诊断。')),
        h('div', { className: 'fgw-hero-status' }, h(WbState, { value: health?.status || 'unknown' }),
          h('span', null, state?.service ?? '服务状态未知'))),
      tabs.length > 0 && h('div', { className: 'fgw-section-switcher' },
        h('p', { className: 'fgw-section-description' }, WORKBENCH_DESCRIPTIONS[selected]),
        h('div', { className: 'fgw-section-tabs', role: 'tablist', 'aria-label': WORKBENCH_NAV.find(item => item[0] === selected)?.[1] },
          tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', key: id,
            className: 'fgw-section-tab' + (sectionTab[selected] === id ? ' is-active' : ''),
            'aria-selected': sectionTab[selected] === id, onClick: () => changeTab(id) }, label)))),
      loading && !state && h('div', { className: 'fgw-caution' }, '正在读取管理服务…'),
      error && h('div', { className: 'fgw-alert', role: 'alert' }, '管理服务暂不可用：', error),
      operatorNotice && h('div', { className: 'fgw-caution', role: 'status' }, operatorNotice),
      state && body,
      !state && !loading && h(WbEmpty, { headline: '无法获取管理数据', description: '请检查 DSH Web 的飞书管理插件是否已加载，以及 feishu-channel 服务是否运行。' }),
      selected !== 'agent-profile' && selected !== 'skills' && h('footer', { className: 'fgw-footnote' }, 'DSH 原生插件扩展 · 仅使用现有认证 API · 15 秒可见页轻量刷新')))
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
