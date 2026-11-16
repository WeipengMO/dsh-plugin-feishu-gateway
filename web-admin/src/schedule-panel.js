/* Issue #19 — scheduled tasks panel.
 * Pure Web Admin UI: consumes only server-sanitized /schedule DTOs. All writes
 * go through the authenticated `request` helper to /schedule/commands; the
 * panel never talks to DSH native services, never fabricates tasks and never
 * renders raw HTML (React text nodes only, bounded strings).
 * Interaction reference: OpenClaw Automations (list / run-history tabs, status
 * filters, per-row actions, detail view, conflict detection on stale save).
 */
const SCHED_KIND_ORDER = ['once', 'every', 'daily', 'weekly', 'monthly', 'cron']
const SCHED_KIND_LABELS = { once: '一次性', every: '间隔', daily: '每天', weekly: '每周', monthly: '每月', cron: 'Cron' }
const SCHED_NOTIFY_LABELS = { result: '仅结果', failure: '仅失败', both: '结果 + 失败', none: '不通知' }
const SCHED_WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const SCHED_STATUS_FILTERS = [['all', '全部'], ['active', '已启用'], ['paused', '已暂停'], ['ended', '已结束']]
const SCHED_TABS = [['tasks', '任务列表'], ['runs', '运行历史'], ['audit', '操作审计']]
const SCHED_STATE_LABELS = { completed: '已完成', rejected: '已拒绝', 'not-found': '未找到',
  conflict: '冲突', 'schedule_conflict': '冲突', error: '执行错误' }

function schedBound(value, max) {
  const text = value === undefined || value === null ? '' : String(value)
  return text.slice(0, max)
}
function schedDate(value) {
  if (value === undefined || value === null || value === '') return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}
/** Display one UTC instant in the task's explicit IANA timezone (fallback UTC). */
function schedLocalDate(value, timeZone) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const zone = timeZone || 'UTC'
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date) + ' (' + zone + ')'
  } catch { return date.toLocaleString() }
}
function schedErrorText(error) {
  const message = error && error.message ? error.message : (error === undefined || error === null ? '' : String(error))
  return schedBound(message, 200) || '未知错误'
}
/** OpenClaw-style conflict detection: a stale edit must be reloaded, not overwritten. */
function schedResultMessage(state, detail) {
  if (state === 'conflict' || state === 'schedule_conflict')
    return '任务已被其他操作修改，请刷新后重试'
  const label = SCHED_STATE_LABELS[state] || schedBound(state || '未知状态', 32)
  const suffix = detail ? ' · ' + schedBound(detail, 200) : ''
  return ('命令执行结果：' + label + suffix).slice(0, 260)
}
function schedSpecText(spec) {
  if (!spec || typeof spec !== 'object') return '—'
  const zone = spec.timeZone || 'UTC'
  switch (spec.kind) {
    case 'once': return '一次性 · ' + schedBound(spec.at, 40) + ' · ' + zone
    case 'every': return '间隔 · 每 ' + spec.everySeconds + ' 秒'
    case 'daily': return '每天 · ' + schedBound(spec.time, 12) + ' · ' + zone
    case 'weekly': return '每周 · ' + schedBound(spec.time, 12) + ' · 周' +
      (Array.isArray(spec.weekdays) ? spec.weekdays.join(',') : '') + ' · ' + zone
    case 'monthly': return '每月 · ' + spec.day + ' 日 ' + schedBound(spec.time, 12) + ' · ' + zone
    case 'cron': return 'Cron · ' + schedBound(spec.expression, 120) + ' · ' + zone
    default: return '未知'
  }
}
function schedDeliveryConfigText(delivery, groups = []) {
  const group = delivery.chatType === 'group' ? groups.find(item => item.chatId === delivery.chatId) : undefined
  const target = group && group.name ? schedBound(group.name, 80) : schedBound(delivery.chatId, 128)
  return (schedBound(delivery.botId, 32) + ' → ' +
    (delivery.chatType === 'group' ? '群聊 ' : '私聊 ') + target +
    (delivery.notify ? ' · ' + (SCHED_NOTIFY_LABELS[delivery.notify] || delivery.notify) : '')).slice(0, 240)
}
function schedUuid() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID() } catch { /* fallback */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const value = Math.floor(Math.random() * 16)
    return (c === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}
function schedTomorrowAt() {
  const date = new Date(Date.now() + 86400000)
  const pad = value => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T09:00:00'
}
function schedDefaultForm() {
  return {
    title: '', prompt: '', kind: 'daily', timeZone: 'Asia/Shanghai',
    time: '09:00:00', weekdays: [1], day: '1', expression: '0 9 * * *',
    everySeconds: '3600', at: schedTomorrowAt(), notify: 'both',
    deliveryEnabled: false, botId: 'default', chatType: 'p2p',
    chatId: '', senderId: '',
  }
}
function schedFormFromTask(task) {
  const base = schedDefaultForm()
  const spec = task.spec || {}
  const form = {
    ...base,
    title: task.title || '', prompt: task.prompt || '',
    kind: SCHED_KIND_ORDER.includes(spec.kind) ? spec.kind : 'daily',
    timeZone: spec.timeZone || task.timeZone || 'Asia/Shanghai',
    time: spec.time || base.time,
    weekdays: Array.isArray(spec.weekdays) && spec.weekdays.length ? [...spec.weekdays] : base.weekdays,
    day: spec.day !== undefined ? String(spec.day) : base.day,
    expression: spec.expression || base.expression,
    everySeconds: spec.everySeconds !== undefined ? String(spec.everySeconds) : base.everySeconds,
    at: spec.at || base.at,
    notify: task.delivery && task.delivery.notify ? task.delivery.notify : 'both',
  }
  if (task.delivery) {
    form.deliveryEnabled = true
    form.botId = task.delivery.botId || 'default'
    form.chatType = task.delivery.chatType || 'p2p'
    form.chatId = task.delivery.chatId || ''
    form.senderId = task.delivery.senderId || ''
  }
  return form
}
function schedFormToSpec(form) {
  const zone = form.timeZone || 'Asia/Shanghai'
  switch (form.kind) {
    case 'once': return { kind: 'once', at: form.at || schedTomorrowAt(), timeZone: zone }
    case 'every': return { kind: 'every', everySeconds: Number(form.everySeconds) || 60 }
    case 'daily': return { kind: 'daily', time: form.time || '09:00:00', timeZone: zone }
    case 'weekly': return { kind: 'weekly', time: form.time || '09:00:00', timeZone: zone,
      weekdays: form.weekdays.length ? form.weekdays : [1] }
    case 'monthly': return { kind: 'monthly', time: form.time || '09:00:00', timeZone: zone, day: Number(form.day) || 1 }
    case 'cron': return { kind: 'cron', expression: form.expression || '0 9 * * *', timeZone: zone }
    default: return { kind: 'daily', time: '09:00:00', timeZone: zone }
  }
}
function schedBuildDelivery(form) {
  if (!form.deliveryEnabled) return null
  const delivery = { botId: form.botId || 'default', chatId: form.chatId.trim(), chatType: form.chatType }
  if (form.senderId.trim()) delivery.senderId = form.senderId.trim()
  return delivery
}
function schedDeliveryPreviewText(form) {
  if (!form.deliveryEnabled) return '未启用飞书投递：结果仅保留在 DSH 原生 Session，不发送任何消息。'
  return ('机器人 ' + schedBound(form.botId || 'default', 32) + ' → ' +
    (form.chatType === 'group' ? '群聊 ' : '私聊 ') + schedBound(form.chatId || '（未选择）', 128) +
    ' · 通知：' + (SCHED_NOTIFY_LABELS[form.notify] || form.notify)).slice(0, 240)
}
function schedSelect(value, onChange, options, props) {
  return h('select', { className: 'fga-input', value, onChange: event => onChange(event.target.value), ...(props || {}) },
    ...options.map(([id, label]) => h('option', { key: id, value: id }, label)))
}
function SchedStatusPill({ value }) {
  const status = value === undefined || value === null || value === '' ? '—' : String(value)
  const tone = ['active', 'success', 'completed', 'ok', 'native'].includes(status) ? 'ok'
    : ['failed', 'error', 'timeout', 'conflict', 'schedule_conflict', 'rejected'].includes(status) ? 'bad' : 'neutral'
  const labels = { active: '已启用', paused: '已暂停', ended: '已结束', success: '成功',
    failed: '失败', error: '错误', timeout: '超时', skipped: '已跳过', completed: '已完成',
    rejected: '已拒绝', conflict: '冲突', 'not-found': '未找到', native: '原生' }
  return h('span', { className: 'fgw-pill fgw-pill-' + tone },
    h('span', { className: 'fgw-dot' }), labels[status] || schedBound(status, 32))
}

function SchedulePanel({ state, onChanged }) {
  const [model, setModel] = useState(null)
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState('tasks')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [pendingId, setPendingId] = useState(null)
  const [form, setForm] = useState(schedDefaultForm())
  const [editing, setEditing] = useState(null)
  const [formOpen, setFormOpen] = useState(false)
  const [preview, setPreview] = useState(null)
  const [runTask, setRunTask] = useState('all')
  const [runDate, setRunDate] = useState('')

  const loadModel = useCallback(async () => {
    setLoading(true)
    try {
      const [schedule, commandResults] = await Promise.all([
        request('/schedule'),
        request('/schedule/results').catch(() => ({ commands: [] })),
      ])
      setModel(schedule.model ?? null)
      setResults(Array.isArray(commandResults.commands) ? commandResults.commands : [])
      setError('')
    } catch (e) { setError(schedErrorText(e)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void loadModel() }, [loadModel])
  // The workbench already refreshes on a 15s timer; the panel keeps its own
  // light refresh so command outcomes show up without leaving the page.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible' || pendingId) return
      void loadModel()
    }, 15000)
    return () => clearInterval(timer)
  }, [loadModel, pendingId])

  const submit = useCallback(async schedule => {
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await request('/schedule/commands', 'POST', { type: 'schedule', schedule })
      setNotice('已入队（' + schedBound(response.command && response.command.id, 8) +
        '）：仅代表已提交到 Gateway 队列，正在等待执行结果。')
      setPendingId(response.command && response.command.id ? response.command.id : null)
      setConfirmDelete(null)
      if (onChanged) onChanged()
    } catch (e) { setError(schedErrorText(e)) }
    finally { setBusy(false) }
  }, [onChanged])
  // Poll /schedule/results until the enqueued command has an outcome.
  useEffect(() => {
    if (!pendingId) return
    let attempts = 0
    const timer = setInterval(async () => {
      attempts += 1
      try {
        const response = await request('/schedule/results')
        const list = Array.isArray(response.commands) ? response.commands : []
        setResults(list)
        const hit = list.find(item => item.id === pendingId)
        if (hit) {
          setNotice(schedResultMessage(hit.state, hit.detail))
          setPendingId(null)
          void loadModel()
        }
      } catch { /* transient read failure: keep polling */ }
      if (attempts >= 12) setPendingId(null)
    }, 2000)
    return () => clearInterval(timer)
  }, [pendingId, loadModel])

  // Debounced, server-side preview of the next triggers (no filesystem writes).
  useEffect(() => {
    if (!formOpen) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const response = await request('/schedule/preview', 'POST',
          { spec: schedFormToSpec(form), count: 5 })
        if (!cancelled) setPreview({ occurrences: Array.isArray(response.occurrences) ? response.occurrences : [],
          summary: schedBound(response.summary, 200), error: '' })
      } catch (e) {
        if (!cancelled) setPreview({ occurrences: [], summary: '', error: schedErrorText(e) })
      }
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [form, formOpen])

  // Constrained delivery targets from GET /state (no arbitrary chat ids).
  const bots = Array.isArray(state && state.bots) && state.bots.length
    ? state.bots.filter(bot => bot && typeof bot.id === 'string') : [{ id: 'default' }]
  const flags = state && state.config && typeof state.config === 'object' ? state.config : {}
  const groupPolicy = flags.groupPolicy || 'disabled'
  const allowedUsers = Array.isArray(flags.allowlist) ? flags.allowlist : []
  const allowedGroups = (Array.isArray(flags.groups) ? flags.groups : [])
    .filter(group => group && group.enabled !== false && groupPolicy !== 'disabled' && typeof group.chatId === 'string')
  const setF = (key, value) => setForm(previous => ({ ...previous, [key]: value }))

  const openCreate = () => {
    setEditing(null); setForm(schedDefaultForm()); setFormOpen(true)
    setTab('tasks'); setExpanded(null); setPreview(null)
  }
  const openEdit = task => {
    setEditing(task); setForm(schedFormFromTask(task)); setFormOpen(true)
    setTab('tasks'); setExpanded(null); setPreview(null)
  }
  const openClone = task => {
    const copy = schedFormFromTask(task)
    setEditing(null); setForm({ ...copy, title: (copy.title + '（副本）').slice(0, 120) })
    setFormOpen(true); setTab('tasks'); setExpanded(null); setPreview(null)
  }
  const save = () => {
    if (!form.title.trim()) { setError('请输入任务标题'); return }
    if (!form.prompt.trim()) { setError('请输入执行提示词'); return }
    if (form.deliveryEnabled && !form.chatId.trim()) { setError('请选择飞书投递目标'); return }
    if (form.deliveryEnabled && form.chatType === 'group' &&
      (groupPolicy === 'disabled' || !allowedGroups.some(group => group.chatId === form.chatId))) {
      setError('当前群聊策略不允许该群投递目标，请刷新配置或选择已启用的群'); return
    }
    if (form.deliveryEnabled && form.chatType === 'p2p' && allowedUsers.length &&
      !allowedUsers.includes(form.chatId)) {
      setError('投递目标必须在已配置的白名单用户内'); return
    }
    const common = { title: form.title.trim(), prompt: form.prompt.trim(),
      spec: schedFormToSpec(form), notify: form.notify, delivery: schedBuildDelivery(form) }
    void submit(editing
      ? { action: 'update', taskId: editing.id, ...common, expectedUpdatedAt: editing.updatedAt || null }
      : { action: 'create', clientRef: schedUuid(), ...common })
    setFormOpen(false); setEditing(null); setForm(schedDefaultForm()); setPreview(null)
  }

  // Tabs are constructed eagerly, before the `content` branch below.
  // A null model (first render or a failed /schedule read) must therefore
  // never be dereferenced; otherwise React throws and the whole panel is blank.
  const safeModel = model || {}
  const tasks = Array.isArray(safeModel.tasks) ? safeModel.tasks : []
  const visibleTasks = tasks.filter(task => {
    if (statusFilter !== 'all' && task.status !== statusFilter) return false
    if (search.trim() && !(task.title || '').includes(search.trim()) &&
      !(task.id || '').includes(search.trim())) return false
    return true
  })
  const runRows = [
    ...(Array.isArray(safeModel.runs) ? safeModel.runs : []).map(run => ({
      kind: 'run', taskId: run.taskId, ts: run.ts, status: run.status,
      elapsedMs: run.elapsedMs, tokens: run.tokens, model: run.model,
      sessionRef: run.sessionRef, delivered: run.delivered, error: run.error,
    })),
    ...Object.entries(safeModel.deliveries && typeof safeModel.deliveries === 'object' ? safeModel.deliveries : {})
      .flatMap(([taskId, list]) => (Array.isArray(list) ? list : []).map(delivery => ({
        kind: 'native', taskId, ts: Date.parse(delivery.deliveredAt || delivery.scheduledAt) || 0,
        status: 'native', sessionRef: delivery.targetSessionId, delivered: true,
      }))),
  ].filter(row => runTask === 'all' || row.taskId === runTask)
    .filter(row => !runDate || (Number.isFinite(row.ts) && new Date(row.ts).toISOString().slice(0, 10) === runDate))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60)

  const targetField = () => {
    if (form.chatType === 'group') {
      if (!allowedGroups.length) return h('div', { className: 'fgw-caution' },
        '当前群聊策略不允许群投递（groupPolicy=' + schedBound(groupPolicy, 32) +
        ' 或没有启用群）。请先在「群聊管理 / 权限」中启用群，再回来选择。')
      return schedSelect(form.chatId, value => setF('chatId', value),
        [['', '请选择群'], ...allowedGroups.map(group => [group.chatId,
          schedBound(group.name || group.chatId, 60)])])
    }
    if (allowedUsers.length) {
      return schedSelect(form.chatId, value => setF('chatId', value),
        [['', '请选择用户'], ...allowedUsers.map(user => [user, user])])
    }
    return h(React.Fragment, null,
      textInput(form.chatId, value => setF('chatId', value),
        'ou_…（白名单由 Profile 继承，需手动填写）', { maxLength: 128 }),
      h('span', { className: 'fgw-muted' }, '白名单由原 Profile 继承，未在后台列出；请填写 ou_ 开头的 open_id。'))
  }
  const specFields = () => {
    if (form.kind === 'once') return field('执行时间', textInput(form.at, value => setF('at', value),
      '本地 2026-11-16T09:00:00 或绝对 2026-11-16T01:00:00Z', { maxLength: 40 }),
      '本地时间按上面的时区解释；必须为未来时刻。')
    if (form.kind === 'every') return field('间隔秒数（≥ 60）', textInput(form.everySeconds,
      value => setF('everySeconds', value), '3600', { type: 'number', min: 60 }))
    if (form.kind === 'cron') return field('Cron 表达式（5 段）', textInput(form.expression,
      value => setF('expression', value), '0 9 * * 1-5', { maxLength: 200 }),
      '5 个数字段：分 时 日 月 周；仅数字，范围 0-59 / 0-23 / 1-31 / 1-12 / 0-7，支持 * , - / 与步长。')
    const timeField = field('本地时间 HH:mm:ss', textInput(form.time, value => setF('time', value),
      '09:00:00', { maxLength: 12 }))
    if (form.kind === 'weekly') return h(React.Fragment, null, timeField,
      field('星期（ISO 1=周一）', h('div', { className: 'fgw-sched-weekdays' },
        SCHED_WEEK_LABELS.map((label, index) => {
          const day = index + 1
          const on = form.weekdays.includes(day)
          return h('label', { key: day, className: 'fgw-sched-weekday' + (on ? ' is-on' : '') },
            h('input', { type: 'checkbox', checked: on,
              onChange: () => setF('weekdays', on ? form.weekdays.filter(x => x !== day)
                : [...form.weekdays, day].sort((a, b) => a - b)) }), label)
        }))))
    if (form.kind === 'monthly') return h(React.Fragment, null, timeField,
      field('每月日期（1..31）', textInput(form.day, value => setF('day', value), '1',
        { type: 'number', min: 1, max: 31 }), '没有该日的月份会被跳过。'))
    return timeField
  }
  const formView = h('section', { className: 'fgw-block fgw-sched-form' },
    h('div', { className: 'fgw-block-head' },
      h('h3', null, editing ? '编辑定时任务' : '新建定时任务'),
      h('span', { className: 'fgw-muted' }, '预览与校验由服务端执行；保存仅代表入队')),
    h('div', { className: 'fgw-block-body' },
      h('div', { className: 'fgw-sched-form-grid' },
        field('任务标题（1..120）', textInput(form.title, value => setF('title', value),
          '例如 每日新闻简报', { maxLength: 120 })),
        field('调度类型', schedSelect(form.kind, value => { setF('kind', value); setPreview(null) },
          SCHED_KIND_ORDER.map(kind => [kind, SCHED_KIND_LABELS[kind]]))),
        field('时区（IANA，必填）', h('input', { className: 'fga-input', value: form.timeZone,
          onChange: event => setF('timeZone', event.target.value), placeholder: 'Asia/Shanghai',
          maxLength: 64, spellCheck: false, autoComplete: 'off' }),
          '每个任务独立时区；列表、详情与预览均按此时区显示。'),
        specFields(),
        field('通知策略', schedSelect(form.notify, value => setF('notify', value),
          Object.entries(SCHED_NOTIFY_LABELS)))),
      field('执行提示词（1..4000）', h('textarea', { className: 'fga-input fga-textarea fgw-sched-prompt-input',
        rows: 5, value: form.prompt, maxLength: 4000, spellCheck: false,
        onChange: event => setF('prompt', event.target.value), placeholder: '要交给 Agent 执行的指令' })),
      h('label', { className: 'fga-check' },
        h('input', { type: 'checkbox', checked: form.deliveryEnabled,
          onChange: event => setF('deliveryEnabled', event.target.checked) }),
        '启用飞书结果投递（未启用时结果仅保留在 DSH 原生 Session）'),
      form.deliveryEnabled && h('div', { className: 'fgw-sched-form-grid' },
        field('机器人', schedSelect(form.botId, value => setF('botId', value),
          bots.map(bot => [bot.id, bot.id]))),
        field('目标类型', schedSelect(form.chatType, value => { setF('chatType', value); setF('chatId', '') },
          [['p2p', '私聊用户'], ['group', '群聊']])),
        field('投递目标', targetField()),
        field('发送者 open_id（可选）', textInput(form.senderId, value => setF('senderId', value),
          'ou_…', { maxLength: 128 }))),
      form.deliveryEnabled && h('div', { className: 'fgw-sched-delivery-preview' },
        h('strong', null, '投递预览（不会发送任何消息）'),
        h('span', null, schedDeliveryPreviewText(form))),
      h('div', { className: 'fgw-sched-preview' },
        h('div', { className: 'fgw-sched-preview-head' },
          h('strong', null, '预览接下来 5 次触发'),
          h('span', { className: 'fgw-muted' }, schedBound(form.timeZone || 'UTC', 64))),
        preview && preview.summary ? h('p', { className: 'fgw-muted' }, '调度摘要：',
          schedBound(preview.summary, 200)) : null,
        preview && preview.error ? h('div', { className: 'fgw-caution' }, '预览不可用：',
          schedBound(preview.error, 200)) : null,
        preview && preview.occurrences && preview.occurrences.length
          ? h('ol', { className: 'fgw-sched-occ' }, preview.occurrences.map((instant, index) =>
            h('li', { key: instant + ':' + index }, schedLocalDate(instant, form.timeZone))))
          : (!preview || !preview.error) ? h('p', { className: 'fgw-muted' },
            '计算中…或该调度在 366 天内没有未来触发。') : null),
      h('div', { className: 'fga-inline-actions' },
        action(editing ? '保存修改' : '创建任务', save, busy || Boolean(pendingId)),
        action('取消', () => { setFormOpen(false); setEditing(null); setForm(schedDefaultForm()); setPreview(null) },
          false, true)),
      editing && h('p', { className: 'fgw-muted' },
        '保存携带 expectedUpdatedAt；若任务已被其他操作修改，Gateway 返回冲突，请刷新后重试。')))

  const taskCard = task => h('article', { className: 'fgw-sched-task', key: task.id },
    h('div', { className: 'fgw-sched-task-main' },
      h('div', { className: 'fgw-sched-task-title' },
        h('strong', null, schedBound(task.title, 120) || '(无标题)'),
        h(SchedStatusPill, { value: task.status })),
      task.executionActive && h('span', { className: 'fgw-sched-active' }, '正在执行'),
      h('div', { className: 'fgw-sched-task-facts' },
        h('div', { className: 'fgw-sched-fact' }, h('span', null, '执行计划'),
          h('strong', null, task.spec ? schedSpecText(task.spec) : (task.timingKind || '未知'))),
        h('div', { className: 'fgw-sched-fact' }, h('span', null, '下次触发'),
          h('strong', null, schedLocalDate(task.scheduledAt, task.timeZone))),
        h('div', { className: 'fgw-sched-fact' }, h('span', null, '上次投递'),
          h('strong', null, schedLocalDate(task.lastDelivery &&
            (task.lastDelivery.deliveredAt || task.lastDelivery.scheduledAt), task.timeZone))),
        h('div', { className: 'fgw-sched-fact' }, h('span', null, '飞书投递'),
          h('strong', null, task.delivery ? schedDeliveryConfigText(task.delivery, allowedGroups)
            : '未配置 · 结果保留在 DSH Session')))),
    h('div', { className: 'fgw-sched-task-actions' },
      action(task.status === 'paused' ? '恢复' : '暂停',
        () => void submit({ action: task.status === 'paused' ? 'resume' : 'pause', taskId: task.id }),
        busy || Boolean(pendingId), true),
      action('立即运行', () => void submit({ action: 'run', taskId: task.id }),
        busy || Boolean(pendingId), true),
      action('编辑', () => openEdit(task), busy, true),
      action('克隆', () => openClone(task), busy, true),
      action('删除', () => setConfirmDelete(confirmDelete === task.id ? null : task.id), busy, true),
      action(expanded === task.id ? '收起' : '详情',
        () => setExpanded(expanded === task.id ? null : task.id), false, true)),
    confirmDelete === task.id && h('div', { className: 'fgw-sched-confirm', role: 'alert' },
      h('span', null, '确认删除任务「', schedBound(task.title, 60), '」？此操作不可撤销。'),
      action('确认删除', () => void submit({ action: 'delete', taskId: task.id }), busy),
      action('取消', () => setConfirmDelete(null), false, true)),
    expanded === task.id && h('div', { className: 'fgw-sched-detail' },
      h('div', { className: 'fgw-data-row' }, h('span', { className: 'fgw-muted' }, '任务 ID'),
        h('strong', { className: 'fgw-row-value' }, schedBound(task.id, 64))),
      h('div', { className: 'fgw-data-row' }, h('span', { className: 'fgw-muted' }, '调度 / 时区'),
        h('strong', { className: 'fgw-row-value' }, schedSpecText(task.spec))),
      h('div', { className: 'fgw-data-row' }, h('span', { className: 'fgw-muted' }, '创建 / 更新'),
        h('strong', { className: 'fgw-row-value' }, schedDate(task.createdAt), ' / ', schedDate(task.updatedAt))),
      h('div', { className: 'fgw-data-row' }, h('span', { className: 'fgw-muted' }, '目标 Session'),
        h('strong', { className: 'fgw-row-value' }, schedBound(task.target && task.target.sessionId, 128) || '—')),
      h('div', { className: 'fgw-data-row' }, h('span', { className: 'fgw-muted' }, '原生投递记录数'),
        h('strong', { className: 'fgw-row-value' }, String(
          Array.isArray(safeModel.deliveries && safeModel.deliveries[task.id])
            ? safeModel.deliveries[task.id].length : 0))),
      h('div', { className: 'fgw-data-row' }, h('span', { className: 'fgw-muted' }, '飞书投递配置'),
        h('strong', { className: 'fgw-row-value' }, task.delivery ? schedDeliveryConfigText(task.delivery, allowedGroups) : '未配置')),
      h('h4', { className: 'fgw-sched-prompt-title' }, '执行提示词'),
      h('pre', { className: 'fgw-sched-prompt' }, schedBound(task.prompt, 4000) || '（空）')))

  const tasksTab = h(React.Fragment, null,
    h('div', { className: 'fgw-metrics fgw-metrics-three' },
      h(WbMetric, { title: '任务总数', value: wbCount(tasks.length), caption: '所有已登记的任务' }),
      h(WbMetric, { title: '已启用', value: wbCount(tasks.filter(task => task.status === 'active').length),
        caption: '其中正在执行 ' + wbCount(tasks.filter(task => task.executionActive).length) + ' 项' }),
      h(WbMetric, { title: '已暂停', value: wbCount(tasks.filter(task => task.status === 'paused').length),
        caption: '暂停后不会按计划触发' })),
    h('div', { className: 'fgw-sched-filters fgw-sched-task-filters' },
      h('label', { className: 'fgw-sched-filter' }, h('span', null, '状态'),
        schedSelect(statusFilter, setStatusFilter, SCHED_STATUS_FILTERS)),
      h('label', { className: 'fgw-sched-filter' }, h('span', null, '搜索'),
        textInput(search, setSearch, '标题或任务 ID', { maxLength: 64 }))),
    formOpen && formView,
    visibleTasks.length
      ? h('div', { className: 'fgw-sched-list' }, visibleTasks.map(taskCard))
      : h(WbEmpty, { headline: '没有匹配的定时任务',
        description: '仅展示 Gateway 读模型中的真实任务；调整筛选条件或新建任务。' }),
    h('div', { className: 'fgw-sched-footbar' },
      action('刷新原生状态', () => void submit({ action: 'refresh' }), busy || Boolean(pendingId), true),
      action('清理已结束任务', () => {
        if (window.confirm('确认删除此 DSH Host 上所有已结束的定时任务？此操作不可撤销，不包括已暂停任务。'))
          void submit({ action: 'delete-inactive' })
      }, busy || Boolean(pendingId), true),
      h('span', { className: 'fgw-muted' },
        '新建会话间隔：', String(safeModel.limits && safeModel.limits.newSessionIntervalSeconds !== undefined
          ? safeModel.limits.newSessionIntervalSeconds : 60), ' 秒')))

  const runsTab = h(React.Fragment, null,
    h('div', { className: 'fgw-sched-filters' },
      h('label', { className: 'fgw-sched-filter' }, h('span', null, '任务'),
        schedSelect(runTask, setRunTask, [['all', '全部任务'],
          ...tasks.map(task => [task.id, schedBound(task.title, 40) || task.id.slice(0, 18)])])),
      h('label', { className: 'fgw-sched-filter' }, h('span', null, 'UTC 日期'),
        h('input', { className: 'fga-input', type: 'date', value: runDate,
          onChange: event => setRunDate(event.target.value) })),
      h('span', { className: 'fgw-muted' }, '合并 Gateway 运行账本与原生投递回执')),
    h(WbBlock, { title: '运行历史', aside: '最多 60 条 · 不展示聊天正文' },
      h(OpsTable, { rows: runRows, empty: '暂无运行记录', columns: [
        { key: 'kind', title: '来源', render: row => row.kind === 'run' ? 'Gateway 运行' : '原生投递' },
        { key: 'taskId', title: '任务', render: row => h('code', null, schedBound(row.taskId, 18) || '—') },
        { key: 'ts', title: '时间', render: row => schedDate(row.ts) },
        { key: 'status', title: '状态', render: row => h(SchedStatusPill, { value: row.status || 'unknown' }) },
        { key: 'elapsedMs', title: '耗时', render: row => row.elapsedMs === undefined ? '—' : row.elapsedMs + ' ms' },
        { key: 'tokens', title: 'Tokens', render: row => row.tokens === undefined ? '—' : wbValue(row.tokens) },
        { key: 'model', title: '模型', render: row => schedBound(row.model, 96) || '—' },
        { key: 'sessionRef', title: 'Session', render: row => row.sessionRef
          ? h('code', null, schedBound(row.sessionRef, 10)) : '—' },
        { key: 'delivered', title: '已投递', render: row => row.delivered === undefined ? '—'
          : (row.delivered ? '是' : '否') },
        { key: 'error', title: '错误', render: row => schedBound(row.error, 200) || '—' },
      ] })))

  const auditTab = h(WbBlock, { title: '操作审计', aside: '仅记录操作摘要，不保存提示词' },
    h(OpsTable, { rows: Array.isArray(safeModel.audit) ? safeModel.audit : [],
      empty: '暂无审计记录', columns: [
        { key: 'ts', title: '时间', render: row => schedDate(row.ts) },
        { key: 'action', title: '操作', render: row => schedBound(row.action, 32) || '—' },
        { key: 'state', title: '结果', render: row => h(SchedStatusPill, { value: row.state || 'unknown' }) },
        { key: 'actor', title: '操作者', render: row => schedBound(row.actor, 64) || '—' },
        { key: 'taskId', title: '任务', render: row => row.taskId
          ? h('code', null, schedBound(row.taskId, 18)) : '—' },
        { key: 'summary', title: '摘要', render: row => schedBound(row.summary, 200) || '—' },
      ] }))

  let content
  if (!model && loading) content = h('div', { className: 'fgw-caution' }, '正在读取定时任务读模型…')
  else if (!model) content = h(WbEmpty, { headline: '尚无定时任务读模型',
    description: 'Gateway 尚未发布 ops-schedule.json。请确认独立飞书通道已启动并装载 DSH 原生 schedule 服务后刷新；管理后台不会显示伪造任务。' })
  else if (safeModel.available === false) content = h('div', { className: 'fgw-sched-unavailable' },
    h('div', { className: 'fgw-empty-icon', 'aria-hidden': true }, '⏱'),
    h('strong', null, '原生定时任务服务不可用'),
    h('p', null, schedBound(safeModel.reason, 200) || 'DSH native schedule service is not mounted in this profile'),
    h('p', { className: 'fgw-muted' },
      '管理后台不会创建替代调度器，也不会显示伪造的任务。请确认该 Profile 已装载 DSH 原生 schedule 服务后刷新。'))
  else content = h(React.Fragment, null,
    tab === 'tasks' ? tasksTab : tab === 'runs' ? runsTab : auditTab)

  return h('div', { className: 'fgw-schedule' },
    h('div', { className: 'fgw-sched-toolbar' },
      h('div', { className: 'fgw-sched-tabs' }, SCHED_TABS.map(([id, label]) =>
        h('button', { key: id, type: 'button', className: 'fgw-sched-tab' + (tab === id ? ' is-active' : ''),
          'aria-current': tab === id ? 'page' : undefined, onClick: () => setTab(id) }, label))),
      h('div', { className: 'fga-inline-actions' },
        action(loading ? '刷新中…' : '↻ 刷新', () => void loadModel(), loading || busy, true),
        model && safeModel.available !== false && action('+ 新建任务', openCreate, busy))),
    error && h('div', { className: 'fgw-alert', role: 'alert' }, schedBound(error, 200)),
    notice && h('div', { className: 'fgw-caution', role: 'status' }, schedBound(notice, 260)),
    pendingId && h('div', { className: 'fgw-caution' },
      '命令已入队（', schedBound(pendingId, 8), '），正在轮询执行结果…'),
    safeModel.stale && h('div', { className: 'fgw-caution' }, '读模型可能已过期，请点击「↻ 刷新」。'),
    content,
    h('p', { className: 'fgw-footnote' },
      '任务由 DSH 原生调度服务执行；提交操作后，请留意页面中的执行结果。'))
}
