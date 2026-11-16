/* Operations panels. Pure UI: consume only server-sanitized /ops DTOs. */
const OPS_KIND_LABELS = {
  message: '消息', task: '任务', approval: '审批',
  transport: '连接', delivery: '投递', system: '系统'
}
function opsDate(ts) {
  return Number.isFinite(ts) ? new Date(ts).toLocaleString() : '—'
}
function OpsNote({ children }) { return h('p', { className: 'fgw-muted fgw-ops-note' }, children) }
function OpsAction({ label, onClick, secondary = false }) {
  return h('button', { type: 'button', className: 'fgw-refresh' + (secondary ? '' : ' fgw-ops-cta'),
    onClick }, label)
}
function OpsUnavailable({ title }) {
  return h(WbEmpty, { headline: title || '管理数据尚不可用',
    description: '当前 Gateway 尚未提供运维遥测，或版本不匹配。请将 feishu-channel Gateway 升级并重启；旧服务不会生成假数据。' })
}
function OpsTable({ columns, rows, empty }) {
  if (!rows?.length) return h(WbEmpty, {
    headline: empty || '暂无记录', description: '只展示已经记录的真实数据；无记录不代表任务执行失败。' })
  return h('div', { className: 'fgw-table-scroll' },
    h('table', { className: 'fgw-table' },
      h('thead', null, h('tr', null, columns.map(c =>
        h('th', { key: c.key, scope: 'col' }, c.title)))),
      h('tbody', null, rows.map((row, i) =>
        h('tr', { key: row.ref || row.ts + ':' + i }, columns.map(c =>
          h('td', { key: c.key, 'data-label': c.title }, c.render ? c.render(row) : wbValue(row[c.key]))))))))
}
const APPROVAL_DECISION_LABELS = {
  requested: '等待审批', 'allowed-once': '允许一次', 'allowed-permanent': '永久允许',
  'auto-allowed': '自动允许', rejected: '已拒绝', 'timed-out': '超时',
  cancelled: '已取消', unavailable: '不可用'
}
const APPROVAL_TONE_LABELS = { ok: ['allowed-once', 'allowed-permanent', 'auto-allowed'],
  bad: ['rejected', 'timed-out', 'unavailable'] }
function approvalDecisionTone(value) {
  if (APPROVAL_TONE_LABELS.ok.includes(value)) return 'ok'
  if (APPROVAL_TONE_LABELS.bad.includes(value)) return 'bad'
  return 'neutral'
}
function approvalPillClass(tone) {
  return tone === 'ok' ? 'fgw-pill fgw-pill-ok' : tone === 'bad' ? 'fgw-pill fgw-pill-bad' : 'fgw-pill'
}
function ApprovalDecisionBadge({ value }) {
  const label = Object.prototype.hasOwnProperty.call(APPROVAL_DECISION_LABELS, value)
    ? APPROVAL_DECISION_LABELS[value] : '未知状态'
  return h('span', { className: approvalPillClass(approvalDecisionTone(value)) },
    h('span', { className: 'fgw-dot' }), label)
}
function approvalCommandSummary(command) {
  if (typeof command !== 'string' || !command) return '—'
  return command.length > 80 ? command.slice(0, 80) + '…' : command
}
function approvalRuleLabel(rule) {
  if (!rule) return '—'
  if (typeof rule.label === 'string' && rule.label) return rule.label.length > 120
    ? rule.label.slice(0, 120) : rule.label
  const root = typeof rule.commandRoot === 'string' && rule.commandRoot ? ' · ' + rule.commandRoot + '*' : ''
  return (rule.tool || '未知工具') + root
}
function approvalCountdownText(remainingMs) {
  const total = Math.max(0, Math.floor(remainingMs / 1000))
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}
/** Live remaining time; never negative and never schedules after unmount. */
function ApprovalCountdown({ expiresAt }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])
  if (!Number.isFinite(expiresAt)) return h('span', { className: 'fgw-muted' }, '—')
  const remaining = expiresAt - now
  if (remaining <= 0) return h('span', { className: 'fgw-pill fgw-pill-bad' },
    h('span', { className: 'fgw-dot' }), '已过期')
  return h('span', { className: 'fgw-muted' }, approvalCountdownText(remaining))
}

function OpsPage({ kind, ops, approvals, onConfig, onCommand, onApprovalsRefresh }) {
  if (kind === 'sessions') return h(FeishuSessionCenter, {})
  // Historical token metrics remain available when the Gateway is offline.
  if (kind === 'usage') return h(UsagePanel, {})
  // Approvals are published in their own authoritative Gateway file; keep the
  // tab usable even when legacy /ops telemetry is missing or stale.
  if (kind === 'approvals') return h(ApprovalsPanel, { model: approvals,
    onConfig, onRefresh: onApprovalsRefresh })
  if (!ops?.telemetryAvailable) return h(OpsUnavailable, {})
  const snapshot = ops.snapshot
  const summary = ops.summary ?? {}
  const events = ops.events ?? []
  const active = snapshot?.stale ? [] : snapshot?.tasks ?? []
  const sessions = snapshot?.sessions ?? []
  if (kind === 'tasks') return h(React.Fragment, null,
    h('div', { className: 'fgw-metrics fgw-metrics-three' },
      h(WbMetric, { title: '当前任务', value: wbCount(active.length), caption: '来自 Gateway 运行时快照' }),
      h(WbMetric, { title: '执行完成', value: wbCount(events.filter(x => x.kind === 'task' && x.state === 'done').length), caption: '有限期审计窗口' }),
      h(WbMetric, { title: '任务异常', value: wbCount(events.filter(x => x.kind === 'task' && x.state === 'failed').length), caption: '有限期审计窗口' })),
    h(WbBlock, { title: '执行中任务', aside: '每 15 秒同步' },
      h(OpsTable, { rows: active, empty: '当前没有活跃任务',
        columns: [
          { key: 'ref', title: '任务', render: x => h('code', null, x.ref.slice(0, 10)) },
          { key: 'botId', title: '机器人' },
          { key: 'session', title: 'Session', render: x => x.session ? h('code', null, x.session.slice(0, 10)) : '—' },
          { key: 'phase', title: '阶段', render: x => h(WbState, { value: x.phase }) },
          { key: 'elapsedMs', title: '已用时', render: x => wbAge(x.elapsedMs) },
          { key: 'action', title: '操作',
            render: x => x.phase === 'running' ? h(OpsAction, { label: '取消任务',
              onClick: () => onCommand('cancel-task', x.ref) }) : '正在收尾' },
        ] })),
    h(WbBlock, { title: '最近任务事件', aside: '仅记录状态，不保存聊天内容' },
      h(OpsTimeline, { events: events.filter(x => x.kind === 'task').slice(0, 30) })),
    h(OpsNote, null, '运行中任务取消仍通过原生飞书 /cancel 或任务卡片完成；跨会话后台取消需要单独授权与审计，未开放不安全的直接终止接口。'))
  if (kind === 'messages') return h(React.Fragment, null,
    h('div', { className: 'fgw-metrics fgw-metrics-three' },
      h(WbMetric, { title: '近期消息', value: wbCount(summary.messages?.length), caption: '脱敏事件汇总' }),
      h(WbMetric, { title: '入站等待', value: wbCount(snapshot?.stats?.inboxPending) }),
      h(WbMetric, { title: '出站等待', value: wbCount(snapshot?.stats?.outboxPending) })),
    h(WbBlock, { title: '消息生命周期', aside: '最多最近 100 条；不展示私聊正文' },
      h(OpsTable, { rows: summary.messages, empty: '没有可用的生命周期事件',
        columns: [
          { key: 'ref', title: '事件引用', render: x => h('code', null, x.ref.slice(0, 10)) },
          { key: 'botId', title: '机器人' },
          { key: 'state', title: '任务状态', render: x => h(WbState, { value: x.state || 'unknown' }) },
          { key: 'delivery', title: '投递状态', render: x => h(WbState, { value: x.delivery || 'unknown' }) },
          { key: 'lastAt', title: '最后更新', render: x => opsDate(x.lastAt) },
          { key: 'elapsedMs', title: '任务耗时', render: x => x.elapsedMs === undefined ? '—' : wbAge(x.elapsedMs) },
        ] })),
    h(OpsNote, null, 'uncertain 状态可能涉及已执行的工具副作用，禁止自动重放。Outbox 原有 UUID 去重机制仍然有效。'),
    snapshot?.stats?.outboxPending > 0 && h(OpsAction, {
      label: '触发 Outbox 安全补发', onClick: () => onCommand('retry-outbox'),
    }),
    h(OpsNote, null, '仅针对已经入队的 Outbox 消息触发发送检查，不会再次执行 Agent，不会覆盖永久性失败的跳过规则。'))
  // Token 用量趋势和历史贡献热图从独立的历史数据源加载。
  if (kind === 'alerts') return h(React.Fragment, null,
    h(WbBlock, { title: '当前健康告警', aside: '本地规则计算，非 AI 推断' },
      (summary.alerts ?? []).length ?
        h('div', { className: 'fgw-ops-alerts' }, summary.alerts.map((x,i) =>
          h('div', { key: x.code + ':' + (x.botId || i), className: 'fgw-caution' },
            h('strong', null, x.message), x.botId && h('span', null, ' · ', x.botId)))) :
        h(WbEmpty, { headline: '暂无规则告警', description: '当前没有达到已配置阈值的运行状态。' })),
    h(OpsNote, null, '这是管理页本地规则告警，不会主动向飞书发送通知。跨进程告警推送需要显式通知目标和授权设置。'),
    (ops.commands ?? []).length > 0 && h(WbBlock, { title: '最近后台操作结果' },
      h(OpsTable, { rows: ops.commands, columns: [
        { key: 'type', title: '操作' },
        { key: 'state', title: '执行结果', render: x => h(WbState, { value: x.state }) },
        { key: 'ts', title: '结束时间', render: x => opsDate(x.ts) },
      ] })),
    h(OpsAction, { label: '调整连接和重试配置', onClick: () => onConfig('settings') }))
  if (kind === 'diagnostics') return h(React.Fragment, null,
    h(WbBlock, { title: 'WebSocket 连接诊断', aside: '连接故障与重连计数' },
      h(OpsTable, {
        rows: Object.entries(snapshot?.transport ?? {}).map(([botId,v]) => ({ botId, ...v })),
        columns: [
          { key: 'botId', title: '机器人' },
          { key: 'state', title: '当前连接', render: x => h(WbState, { value: x.state }) },
          { key: 'reconnects', title: '重连次数', render: x => wbCount(x.reconnects) },
          { key: 'failures', title: '失败次数', render: x => wbCount(x.failures) },
          { key: 'lastConnectedAt', title: '上次连接', render: x => opsDate(x.lastConnectedAt) },
        ],
      })),
    h(WbBlock, { title: '结构化运行日志', aside: '最多最近 200 条；不含原始异常和正文' },
      h(OpsTimeline, { events: events.slice(0, 100) })),
    h(OpsNote, null, '该事件审计不等同于完整 systemd journal；完整调试日志可能含敏感数据，应由服务器授权运维人员检查。'))
  return h(OpsUnavailable, {})
}

/* Permanent tool authorizations + approval audit.
 * Read-only model from the Gateway; the only write is a bounded revoke request
 * queued in the operator mailbox. This component never decides or fabricates
 * an approval, and it never echoes raw exception text. */
function ApprovalsPanel({ model, onConfig, onRefresh }) {
  const [busyRef, setBusyRef] = useState('')
  const [notice, setNotice] = useState('')
  const [revokeError, setRevokeError] = useState('')
  const refresh = () => { if (typeof onRefresh === 'function') onRefresh() }
  const revoke = async rule => {
    const label = approvalRuleLabel(rule)
    const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm('确认撤销永久授权「' + label + '」？\n撤销请求会写入 Gateway 邮箱队列，仅在 Gateway 处理后才会真正生效。')
      : false
    if (!confirmed) return
    setBusyRef(rule.ref)
    setNotice('')
    setRevokeError('')
    try {
      await request('/approvals/revoke', 'POST', { ref: rule.ref })
      setNotice('撤销请求已入队。只有在 Gateway 处理该请求后授权才会失效，请稍后刷新核对。')
      refresh()
    } catch {
      // Never echo raw exception text; report one stable, actionable outcome.
      setRevokeError('撤销请求未提交：管理接口拒绝了该操作，请刷新后确认授权状态。')
    } finally {
      setBusyRef('')
    }
  }
  if (!model) return h(React.Fragment, null,
    h(WbBlock, { title: '审批审计', aside: '请求、批准、永久授权与拒绝的真实记录' },
      h(WbEmpty, { headline: '尚无审批读模型',
        description: 'Gateway 尚未发布 ops-approvals.json。请确认独立飞书通道已启动并启用工具审批；管理后台不会显示伪造的审批或授权。' })),
    h(OpsNote, null, '数据只来自 Gateway 发布的只读审批模型；本页不会伪造审批决策，也不会绕过 DSH 原生 ask 策略。'),
    h(OpsAction, { label: '修改审批卡片设置', onClick: () => onConfig('settings') }))
  const available = model.available !== false
  const pending = Array.isArray(model.pending) ? model.pending : []
  const rules = Array.isArray(model.rules) ? model.rules : []
  const records = Array.isArray(model.records) ? model.records : []
  const timeoutMs = Number.isFinite(model.timeoutMs) ? model.timeoutMs : null
  const waitMinutes = timeoutMs === null ? null : Math.max(0, Math.round(timeoutMs / 60000))
  const recordLimit = Number.isFinite(model.recordLimit) ? model.recordLimit : 200
  const reason = typeof model.reason === 'string' ? model.reason.slice(0, 200) : ''
  const counted = list => available ? wbCount(list.length) : '—'
  return h(React.Fragment, null,
    h('div', { className: 'fgw-metrics fgw-approval-metrics' },
      h(WbMetric, { title: '待审批数量', value: counted(pending), caption: '来自 Gateway 审批读模型' }),
      h(WbMetric, { title: '永久授权数量', value: counted(rules), caption: '可由下方操作撤销' }),
      h(WbMetric, { title: '审批等待时长（分钟）',
        value: waitMinutes === null ? '—' : waitMinutes + ' 分钟',
        caption: '由 Gateway 配置，本页只读展示' }),
      h(WbMetric, { title: '最近审批条数', value: counted(records),
        caption: '最多保留 ' + wbValue(recordLimit) + ' 条' })),
    !available && h('div', { className: 'fgw-caution', role: 'status' },
      '审批读模型当前不可用：', reason || 'Gateway 未提供原因', '。页面不会显示或推断任何审批状态。'),
    h(WbBlock, { title: '待审批', aside: '剩余时间每秒刷新；超时由 Gateway 判定，Web 端不做决策' },
      h(OpsTable, { rows: pending, empty: '当前没有等待中的审批请求',
        columns: [
          { key: 'tool', title: '工具', render: x => h('code', null, x.tool) },
          { key: 'command', title: '命令摘要', render: x => approvalCommandSummary(x.command) },
          { key: 'expiresAt', title: '剩余时间',
            render: x => h(ApprovalCountdown, { expiresAt: x.expiresAt }) },
        ] })),
    h(WbBlock, { title: '永久授权', aside: '按工具 / 命令可执行根授权；撤销仅为向 Gateway 入队的请求' },
      h(OpsTable, { rows: rules, empty: '暂无永久授权规则',
        columns: [
          { key: 'label', title: '范围', render: x => approvalRuleLabel(x) },
          { key: 'createdByRef', title: '创建者',
            render: x => x.createdByRef ? h('code', null, x.createdByRef) : '—' },
          { key: 'lastUsedAt', title: '最近使用',
            render: x => Number.isFinite(x.lastUsedAt) ? opsDate(x.lastUsedAt) : '尚未使用' },
          { key: 'uses', title: '次数', render: x => wbCount(x.uses) },
          { key: 'actions', title: '操作', render: x => h('button', { type: 'button',
            className: 'fgw-refresh', disabled: Boolean(busyRef) || !available,
            onClick: () => void revoke(x) }, busyRef === x.ref ? '提交中…' : '撤销') },
        ] }),
      busyRef && h('div', { className: 'fgw-caution', role: 'status' }, '正在提交撤销请求…'),
      notice && h('div', { className: 'fgw-caution', role: 'status' }, notice),
      revokeError && h('div', { className: 'fgw-alert', role: 'alert' }, revokeError)),
    h(WbBlock, { title: '最近审批', aside: 'Gateway 记录的最新决策，最多展示 100 条' },
      h(OpsTable, { rows: records.slice(0, 100), empty: '暂无审批记录',
        columns: [
          { key: 'ts', title: '时间', render: x => opsDate(x.ts) },
          { key: 'tool', title: '工具', render: x => h('code', null, x.tool) },
          { key: 'command', title: '命令摘要', render: x => approvalCommandSummary(x.command) },
          { key: 'decision', title: '决策',
            render: x => h(ApprovalDecisionBadge, { value: x.decision }) },
          { key: 'elapsedMs', title: '耗时',
            render: x => Number.isFinite(x.elapsedMs) ? wbAge(x.elapsedMs) : '—' },
        ] })),
    h(OpsNote, null, '撤销操作只是向 Gateway 运营商邮箱入队一条 approval-revoke 请求；只有在 Gateway 处理该请求后永久授权才真正失效，刷新前显示的仍是上一次发布的只读模型。'),
    h(OpsNote, null, '本页不会在后台伪造审批决策或绕过 DSH 原生 ask 策略；审批卡的有效性仍由 bot / chat / actor / nonce 校验。'),
    h('div', { className: 'fga-inline-actions' },
      h(OpsAction, { label: '刷新审批数据', onClick: refresh, secondary: true }),
      h(OpsAction, { label: '修改审批卡片设置', onClick: () => onConfig('settings') })))
}
function OpsTimeline({ events }) {
  if (!events?.length) return h(WbEmpty, { headline: '暂无事件', description: '当前没有已记录的操作事件。' })
  return h('div', { className: 'fgw-ops-timeline' }, events.map((item,i) =>
    h('div', { className: 'fgw-ops-event', key: item.ts + ':' + item.kind + ':' + i },
      h('span', { className: 'fgw-ops-event-dot' }),
      h('div', { className: 'fgw-ops-event-main' },
        h('strong', null, (OPS_KIND_LABELS[item.kind] || item.kind) + ' · ' + item.state),
        h('div', { className: 'fgw-muted' },
          item.botId || 'Gateway', item.ref ? ' · ' + item.ref.slice(0, 10) : '',
          item.session ? ' · Session ' + item.session.slice(0, 10) : '',
          item.tokens !== undefined ? ' · ' + wbCount(item.tokens) + ' Token' : '')),
      h('time', { className: 'fgw-muted' }, opsDate(item.ts)))))
}

/* This inventory uses only the read-only /sessions endpoint; no raw DSH
 * Session contents, Feishu chat IDs or credentials are exposed in the DOM. */
function FeishuSessionsInventory() {
  const [filters, setFilters] = useState({ from: '', to: '', bot: '', chat: '', session: '', status: 'all', sort: 'lastActiveAt' })
  const [applied, setApplied] = useState({ page: 1, pageSize: 25 })
  const [report, setReport] = useState(null)
  const [nativeNames, setNativeNames] = useState({})
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [selected, setSelected] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const update = (key, value) => setFilters(prev => ({ ...prev, [key]: value }))
  const load = useCallback(async () => {
    setBusy(true)
    try {
      const args = new URLSearchParams()
      Object.entries(applied).forEach(([key, value]) => {
        if (value !== '' && value !== 'all') args.set(key, String(value))
      })
      const [response, native] = await Promise.all([
        request('/sessions?' + args.toString()),
        request('/sessions/ledger?pageSize=100&reveal=0').catch(() => null)
      ])
      setReport(response.report)
      const nameMap = {}
      for (const row of native?.report?.items || []) nameMap[row.sessionRef] = row
      setNativeNames(nameMap)
      setError('')
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }, [applied])
  useEffect(() => { setSelected([]); void load() }, [load])
  const apply = () => setApplied({ ...filters, page: 1, pageSize: 25 })
  const storage = report?.storage
  const bytes = n => Number.isFinite(n) ? (n < 1024 ? n + ' B' :
    n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(2) + ' MiB') : '—'
  const kinds = { inbox: '收到的消息', outbox: '待发送的消息', bindings: '聊天关联',
    events: '操作记录', runtime: '运行状态', dedup: '防重复记录', usage: 'Token 用量', commands: '管理操作' }
  const pages = report ? Math.ceil(report.total / report.pageSize) : 0
  const manage = async (type, item) => {
    setNotice('')
    setBusy(true)
    try {
      const response = await request('/sessions/preview', 'POST', {
        type, ref: item.sessionRef, expectedLastActiveAt: item.lastActiveAt,
      })
      const preview = response.preview
      const action = type === 'archive-session' ? '隐藏关联' : '解除聊天关联'
      const details = '操作：' + action + '\n机器人：' + preview.botId +
        '\nSession 引用：' + preview.sessionRef +
        '\n聊天引用：' + preview.chatRef +
        '\n绑定记录估算：' + bytes(preview.estimatedBindingBytes) +
        '\nDSH 对话历史：仍然保留，不会删除' +
        '\n\n请再次确认。'
      if (!window.confirm(details)) {
        setNotice('已取消，未提交任何操作。')
        return
      }
      const result = await request('/sessions/commands', 'POST', { token: preview.token })
      setNotice('已提交操作 ' + result.command.id + '。这仅代表已入队；执行结果请在「告警中心」核对。')
      void load()
    } catch (e) { setNotice('操作未提交：' + (e.message || String(e))) }
    finally { setBusy(false) }
  }
  const keyOf = item => item.botId + ':' + item.chatRef + ':' + item.sessionRef
  const toggle = item => setSelected(old => old.some(x => keyOf(x) === keyOf(item))
    ? old.filter(x => keyOf(x) !== keyOf(item))
    : old.length >= 20 ? old : [...old, item])
  const bulk = async action => {
    if (!selected.length || busy) return
    setBusy(true)
    setNotice('')
    try {
      const items = selected.map(row => ({
        ref: row.sessionRef, chatRef: row.chatRef,
        botId: row.botId, expectedLastActiveAt: row.lastActiveAt,
      }))
      const result = await request('/sessions/batch/preview', 'POST', { action, items })
      const preview = result.preview
      const verb = action === 'archive' ? '批量隐藏关联' : '批量解除绑定'
      const confirmed = window.confirm(verb + ' ' + preview.count + ' 条？' +
        '\\n涉及绑定记录约 ' + bytes(preview.estimatedBindingBytes) +
        '（非实际可回收空间）' +
        '\\n不会删除任何 DSH 原生 Session 历史。' +
        '\\nGateway 执行时会逐条检查，变化的绑定将跳过。')
      if (!confirmed) { setNotice('操作已取消。'); return }
      const queued = await request('/sessions/commands', 'POST', { token: preview.token })
      setNotice('已排队：' + queued.command.id + '（最多 ' + preview.count +
        ' 条）。具体完成/跳过数量请到「运维与诊断 → 告警中心」查看。')
      setSelected([])
      void load()
    } catch (e) { setNotice('批量操作未提交：' + (e.message || String(e))) }
    finally { setBusy(false) }
  }
  return h(React.Fragment, null,
    h('div',{className:'fgw-session-mini-summary'},
      h('strong',null,report?wbCount(report.total)+' 条聊天关联':'正在读取聊天关联…'),
      h('span',null,report?.runtimeFresh?'飞书通道已连接':'通道状态尚未确认；暂不可修改关联')),
    h(WbBlock, { title: '查找聊天关联', aside: '可以按最后使用时间筛选；不读取聊天正文' },
      h('form', { className: 'fgw-session-filters fgw-binding-filters', 'data-expanded':showAdvanced?'yes':'no', onSubmit: e => { e.preventDefault(); apply() } },
        [['from','开始日期','date'], ['to','结束日期','date'], ['bot','机器人 ID','text'],
          ['chat','聊天引用','text'], ['session','会话引用','text']].map(([key, label, type]) =>
          h('label', { key, className: 'fgw-session-filter'+(['bot','chat','session'].includes(key)?' fgw-binding-extra':'') },
            h('span', null, label),
            h('input', { type, className: 'fga-input', value: filters[key],
              onChange: e => update(key, e.target.value), placeholder: label, maxLength: type === 'text' ? 128 : undefined }))),
        h('label', { className: 'fgw-session-filter' }, h('span', null, '状态'),
          h('select', { className: 'fga-input', value: filters.status, onChange: e => update('status', e.target.value) },
            [['all','全部'], ['active','运行中'], ['idle','空闲'], ['archived','已归档']].map(([v,t]) => h('option', { key: v, value: v }, t)))),
        h('label', { className: 'fgw-session-filter' }, h('span', null, '排序'),
          h('select', { className: 'fga-input', value: filters.sort, onChange: e => update('sort', e.target.value) },
            h('option', { value: 'lastActiveAt' }, '最后活动'), h('option', { value: 'createdAt' }, '创建时间'))),
        h('button', { className: 'fgw-refresh fgw-ops-cta', type: 'submit', disabled: busy }, busy ? '筛选中…' : '应用筛选'),
        h('button', { className: 'fgw-refresh', type: 'button', onClick: () => { setFilters({ from: '', to: '', bot: '', chat: '', session: '', status: 'all', sort: 'lastActiveAt' }); setApplied({ page: 1, pageSize: 25, direction: 'desc' }) } }, '重置筛选'))),
    error && h('div', { className: 'fgw-caution', role: 'alert' }, '读取失败：' + error),
    notice && h('div', { className: 'fgw-caution', role: 'status' }, notice),
    h(WbBlock, { title: '飞书聊天关联', aside: '显示飞书聊天当前指向的对话；不会修改对话正文' },
      h('details',{className:'fgw-session-details fgw-session-bulk'},
        h('summary',null,'批量管理（一次最多 20 条）'),
        h('div', { className: 'fgw-session-actions' },
        h('span', null, '已选 ' + selected.length + '/20 条（仅本页，跳过运行中的绑定）'),
        h('button', { className: 'fgw-refresh', type: 'button', disabled: busy || !report?.runtimeFresh,
          onClick: () => setSelected((report?.items || []).filter(x => x.status !== 'active').slice(0, 20)) }, '选择本页'),
        h('button', { className: 'fgw-refresh', type: 'button', disabled: busy || !selected.length,
          onClick: () => setSelected([]) }, '清空选择'),
        h('button', { className: 'fgw-refresh', type: 'button',
          disabled: busy || !report?.runtimeFresh || !selected.length || selected.some(x => x.status === 'archived'),
          onClick: () => void bulk('archive') }, '批量隐藏关联'),
        h('button', { className: 'fgw-refresh', type: 'button',
          disabled: busy || !report?.runtimeFresh || !selected.length,
          onClick: () => void bulk('unlink') }, '批量解除关联'))),
      h(OpsTable, { rows: report?.items ?? [], empty: busy ? '正在载入…' : '没有匹配的 Session',
        columns: [
          {key:'selection',title:'选择',render:x=>
            h('input',{type:'checkbox','aria-label':'选择会话关联 '+x.sessionRef,
              disabled:busy||!report?.runtimeFresh||x.status==='active',
              checked:selected.some(item=>keyOf(item)===keyOf(x)),onChange:()=>toggle(x)})},
          {key:'conversation',title:'飞书关联的对话',render:x=>h('div',null,
            h('strong',null,nativeNames[x.sessionRef]?.sessionTitle||
              nativeNames[x.sessionRef]?.scheduleTitle||'飞书聊天'),
            h('div',{className:'fgw-muted'},'机器人：'+x.botId),
            h('details',{className:'fgw-session-tech'},
              h('summary',null,'查看技术信息'),
              h('div',null,'会话引用：',h('code',null,x.sessionRef)),
              h('div',null,'聊天引用：',h('code',null,x.chatRef)),
              h('div',null,'创建时间：',opsDate(x.createdAt))))},
          {key:'lastActiveAt',title:'最近使用',render:x=>opsDate(x.lastActiveAt)},
          {key:'status',title:'状态',render:x=>h('span',{className:'fgw-pill'},
            ({active:'正在处理',idle:'空闲',archived:'关联已隐藏'})[x.status]||'未知')},
          {key:'actions',title:'操作',render:x=>h('div',{className:'fgw-session-actions'},
            h('button',{type:'button',className:'fgw-refresh',
              disabled:busy||!report?.runtimeFresh||x.status==='active'||x.status==='archived',
              onClick:()=>void manage('archive-session',x)},'隐藏关联'),
            h('button',{type:'button',className:'fgw-refresh',
              disabled:busy||!report?.runtimeFresh||x.status==='active',
              onClick:()=>void manage('unbind-session',x)},'解除关联'))}
        ] }),
      report && h('div', { className: 'fgw-session-pages' },
        h('span', null, '共 ' + wbCount(report.total) + ' 条 · 第 ' + report.page + '/' + (pages || 1) + ' 页'),
        h('button', { type: 'button', className: 'fgw-refresh', disabled: busy || applied.page <= 1,
          onClick: () => setApplied(x => ({ ...x, page: x.page - 1 })) }, '上一页'),
        h('button', { type: 'button', className: 'fgw-refresh', disabled: busy || applied.page >= pages,
          onClick: () => setApplied(x => ({ ...x, page: x.page + 1 })) }, '下一页'))),
    h('details',{className:'fgw-session-details fgw-session-storage-details'},
      h('summary',null,'查看飞书插件的数据占用（不含 DSH 对话历史）'),
      h('div', { className: 'fgw-session-storage' },
        (storage?.categories ?? []).map(x => h('div', { key: x.key, className: 'fgw-data-row' },
          h('span', null, kinds[x.key] || x.key), h('strong', null, bytes(x.bytes)))))),
    h(OpsNote, null, '这里的隐藏关联与解除关联只影响飞书聊天的关联信息。真正删除 DSH 对话历史和定期清理功能尚未开放。'))
}
