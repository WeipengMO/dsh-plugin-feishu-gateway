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
          h('td', { key: c.key }, c.render ? c.render(row) : wbValue(row[c.key]))))))))
}
function OpsPage({ kind, ops, onConfig, onCommand }) {
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
  if (kind === 'sessions') return h(React.Fragment, null,
    h('div', { className: 'fgw-metrics fgw-metrics-three' },
      h(WbMetric, { title: '已绑定 Session', value: wbCount(sessions.length) }),
      h(WbMetric, { title: '活跃任务', value: wbCount(active.length) }),
      h(WbMetric, { title: '等待审批', value: wbCount(snapshot?.stats?.pendingApprovals) })),
    h(WbBlock, { title: '原生 DSH Session 绑定', aside: '仅展示去标识化引用，不复制会话' },
      h(OpsTable, { rows: sessions, empty: '没有已绑定的 Session',
        columns: [
          { key: 'ref', title: 'Session', render: x => h('code', null, x.ref.slice(0, 10)) },
          { key: 'createdAt', title: '创建', render: x => opsDate(x.createdAt) },
          { key: 'lastActiveAt', title: '最后活动', render: x => opsDate(x.lastActiveAt) },
          { key: 'persisted', title: '持久化', render: x => x.persisted ? '已持久化' : '未确认' },
          { key: 'active', title: '运行状态', render: x =>
            h(WbState, { value: active.some(t => t.session === x.ref) ? 'active' : 'idle' }) },
        ] })),
    h(WbBlock, { title: '最近审批事件', aside: '源自飞书原生 approval/request' },
      h(OpsTimeline, { events: summary.approvals?.slice(0, 30) })),
    h(OpsAction, { label: '配置审批规则', onClick: () => onConfig('settings') }))
  if (kind === 'approvals') return h(React.Fragment, null,
    h(WbBlock, { title: '审批审计', aside: '请求、批准一次、拒绝、取消或不可用' },
      h(OpsTimeline, { events: summary.approvals ?? [] })),
    h(OpsNote, null, '不在后台伪造审批决策或绕过 DSH 原生 ask 策略。审批卡的有效性仍由 bot/chat/actor/nonce 校验。'),
    h(OpsAction, { label: '修改审批卡片设置', onClick: () => onConfig('settings') }))
  if (kind === 'usage') {
    const daily = summary.daily ?? []
    const max = Math.max(1, ...daily.map(x => x.tokens))
    return h(React.Fragment, null,
      h('div', { className: 'fgw-metrics fgw-metrics-three' },
        h(WbMetric, { title: '审计窗口 Token', value: wbCount((summary.usage ?? []).reduce((a,b) => a + b.tokens,0)) }),
        h(WbMetric, { title: '有用量记录的任务', value: wbCount((summary.usage ?? []).reduce((a,b) => a + b.turns,0)) }),
        h(WbMetric, { title: '模型数', value: wbCount(summary.usage?.length) })),
      h(WbBlock, { title: 'Token 用量趋势', aside: '仅上报 usage 的完成任务；不推算成本' },
        daily.length ? h('div', { className: 'fgw-bars' }, daily.map(x =>
          h('div', { className: 'fgw-bar-row', key: x.day },
            h('span', null, x.day),
            h('div', { className: 'fgw-bar-track' }, h('div', { className: 'fgw-bar-fill',
              style: { width: (x.tokens / max * 100) + '%' } })),
            h('strong', null, wbCount(x.tokens))))) : h(WbEmpty, {
              headline: '暂未收到 Token 使用数据', description: '只有原生 DSH 返回 usage 的完成任务才计入。' })),
      h(WbBlock, { title: '按模型统计' },
        h(OpsTable, { rows: summary.usage ?? [], columns: [
          { key: 'model', title: '模型' },
          { key: 'turns', title: '任务数', render: x => wbCount(x.turns) },
          { key: 'tokens', title: 'Token', render: x => wbCount(x.tokens) },
        ] })),
      h(WbBlock, { title: '按机器人统计' },
        h(OpsTable, { rows: summary.byBot ?? [], columns: [
          { key: 'botId', title: '机器人' },
          { key: 'turns', title: '任务数', render: x => wbCount(x.turns) },
          { key: 'tokens', title: 'Token', render: x => wbCount(x.tokens) },
        ] })),
      h(OpsNote, null, '统计依据有限期操作事件，轮转或升级前的历史不在本页；读取数据和渲染图表不产生额外模型 Token。'))
  }
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
