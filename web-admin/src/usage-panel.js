/* Historical usage dashboard. Uses only the authenticated, read-only usage DTO. */
function usageIsoDate(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date)
  const part = type => parts.find(x => x.type === type)?.value
  return [part('year'), part('month'), part('day')].join('-')
}
function usageShiftDay(day, offset) {
  return new Date(Date.parse(day + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10)
}
function UsageField({ title, children }) {
  return h('label', { className: 'fgw-usage-field' }, h('span', null, title), children)
}
function UsagePanel() {
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const today = usageIsoDate(new Date(), zone)
  const [from, setFrom] = useState(() => usageShiftDay(today, -29))
  const [to, setTo] = useState(today)
  const [preset, setPreset] = useState('30')
  const [period, setPeriod] = useState('day')
  const [metric, setMetric] = useState('total')
  const [chart, setChart] = useState('bar')
  const [model, setModel] = useState('')
  const [botId, setBotId] = useState('')
  const [user, setUser] = useState('')
  const [chat, setChat] = useState('')
  const [session, setSession] = useState('')
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controls = { from, to, tz: zone, period, metric, model, botId, user, chat, session }
  const url = '/ops/usage?' + new URLSearchParams(
    Object.entries(controls).filter(([, value]) => value !== '')
  ).toString()
  useEffect(() => {
    let active = true
    setBusy(true); setError('')
    request(url).then(data => { if (active) setReport(data.report) })
      .catch(e => { if (active) { setReport(null); setError(e.message || String(e)) } })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [url])
  const presetRange = days => {
    const current = usageIsoDate(new Date(), zone)
    setPreset(days)
    setTo(current)
    setFrom(days === 'month' ? current.slice(0, 7) + '-01' :
      usageShiftDay(current, 1 - Number(days)))
  }
  const setDate = (setter, value) => { setPreset('custom'); setter(value) }
  const select = (value, change, items, format = x => x) =>
    h('select', { className: 'fgw-usage-select', value, onChange: e => change(e.target.value) },
      h('option', { value: '' }, '全部'),
      ...[...new Set([...(value ? [value] : []), ...(items || [])])].map(x =>
        h('option', { key: x, value: x }, format(x))))
  const facets = report?.facets || {}
  const daily = report?.daily || []
  const series = report?.series || []
  const top = Math.max(1, ...daily.map(x => x.value ?? 0))
  const totals = report?.summary || {}
  const metricText = { total: '总 Token', input: '输入 Token', output: '输出 Token' }[metric]
  const cols = [
    { key: 'model', title: '模型' }, { key: 'botId', title: '机器人' },
    { key: 'calls', title: '有 usage 调用', render: x => wbCount(x.calls) },
    { key: 'unknownTurns', title: '缺失 usage', render: x => wbCount(x.unknownTurns) },
    { key: 'value', title: metricText, render: x => wbCount(x.value) }
  ]
  const squares = daily.length ? [
    ...Array.from({ length: (new Date(daily[0].date + 'T00:00:00Z').getUTCDay() + 6) % 7 },
      (_, i) => h('span', { key: 'empty' + i, 'aria-hidden': true })),
    ...daily.map(day => {
      const level = day.value === null ? 'unknown' : day.value === 0 ? '0'
        : String(Math.min(4, Math.max(1, Math.ceil(day.value / top * 4))))
      const tooltip = day.date + ' · 输入 ' + (day.inputTokens ?? '未知') +
        ' · 输出 ' + (day.outputTokens ?? '未知') + ' · 总量 ' +
        (day.totalTokens ?? '未知') + ' · 有记录调用 ' + day.calls +
        ' · 缺失 usage ' + day.unknownTurns +
        (day.coverage === 'unavailable' ? ' · 尚无历史采集' : '')
      return h('span', { key: day.date, className: 'fgw-heat-day fgw-heat-' + level +
        (day.coverage === 'partial' ? ' fgw-heat-partial' : ''),
        title: tooltip, 'aria-label': tooltip, tabIndex: 0 })
    })
  ] : []
  const max = Math.max(1, ...series.map(x => x.value ?? 0))
  const recent = series.slice(-60)
  const lines = []
  let chain = []
  series.forEach((entry, i) => {
    if (entry.value === null) {
      if (chain.length) lines.push(chain)
      chain = []
    } else {
      chain.push((18 + i * (680 / Math.max(1, series.length - 1))).toFixed(1) + ',' +
        (145 - entry.value / max * 126).toFixed(1))
    }
  })
  if (chain.length) lines.push(chain)
  return h('div', { className: 'fgw-usage' },
    h('div', { className: 'fgw-usage-presets' },
      ...[['1', '今天'], ['7', '近 7 天'], ['30', '近 30 天'], ['month', '本月']]
        .map(([n, label]) => h('button', { type: 'button', key: n,
          className: 'fgw-refresh' + (preset === n ? ' fgw-ops-cta' : ''),
          onClick: () => presetRange(n) }, label)),
      h('span', { className: 'fgw-muted' }, busy ? '统计更新中…' : '仅统计已上报数据')),
    h('div', { className: 'fgw-usage-controls' },
      h(UsageField, { title: '起始日期' }, h('input', { type: 'date', value: from,
        onChange: e => setDate(setFrom, e.target.value) })),
      h(UsageField, { title: '结束日期' }, h('input', { type: 'date', value: to,
        onChange: e => setDate(setTo, e.target.value) })),
      h(UsageField, { title: '时区（IANA）' }, h('input', { value: zone, maxLength: 80,
        onChange: e => setZone(e.target.value), placeholder: 'Asia/Shanghai' })),
      h(UsageField, { title: '按周期聚合' },
        h('select', { value: period, onChange: e => setPeriod(e.target.value) },
          ...[['day', '按日'], ['week', '按周'], ['month', '按月']].map(([v, n]) =>
            h('option', { value: v, key: v }, n)))),
      h(UsageField, { title: '统计指标' },
        h('select', { value: metric, onChange: e => setMetric(e.target.value) },
          ...[['total', '总 Token'], ['input', '输入 Token'], ['output', '输出 Token']]
            .map(([v, n]) => h('option', { key: v, value: v }, n)))),
      h(UsageField, { title: '模型' }, select(model, setModel, facets.models)),
      h(UsageField, { title: '机器人' }, select(botId, setBotId, facets.bots)),
      h(UsageField, { title: '飞书用户（匿名标识）' }, select(user, setUser, facets.users,
        x => x.slice(0, 10) + '…')),
      h(UsageField, { title: '群聊 / 会话（匿名标识）' }, select(chat, setChat, facets.chats,
        x => x.slice(0, 10) + '…')),
      h(UsageField, { title: 'Session（匿名标识）' }, select(session, setSession, facets.sessions,
        x => x.slice(0, 10) + '…'))),
    h('div', { className: 'fgw-usage-presets' },
      h('a', { className: 'fgw-refresh fgw-ops-cta fgw-usage-export',
        href: API + url.replace('/ops/usage?', '/ops/usage/export?'), download: 'feishu-token-usage.csv' },
        '导出当前筛选 CSV'),
      h('button', { className: 'fgw-refresh', type: 'button', onClick: () => {
        setModel(''); setBotId(''); setUser(''); setChat(''); setSession('')
      } }, '清除筛选')),
    error && h('p', { className: 'fgw-caution', role: 'alert' }, error),
    !report ? h(WbEmpty, { headline: busy ? '正在读取历史统计…' : '历史统计不可用',
      description: '请确认 Gateway 已启用新的用量日志，并检查日期和时区设置。' })
      : h(React.Fragment, null,
        h('div', { className: 'fgw-metrics fgw-metrics-three' },
          h(WbMetric, { title: metricText, value: wbCount(totals.value),
            caption: totals.unknownTurns ? '存在缺失 usage，显示已知部分' : '模型实际上报部分' }),
          h(WbMetric, { title: '有 usage 调用', value: wbCount(totals.calls),
            caption: '尝试任务数：' + wbCount(totals.turns) }),
          h(WbMetric, { title: '缺失 usage 任务', value: wbCount(totals.unknownTurns),
            caption: '失败：' + wbCount(totals.failedTurns) +
              ' · 取消：' + wbCount(totals.cancelledTurns) }),
          h(WbMetric, { title: '峰值日', value: totals.peakDay || '—',
            caption: totals.peakTokens === null ? '暂无记录' : wbCount(totals.peakTokens) + ' ' + metricText }),
          h(WbMetric, { title: '日均总用量', value: totals.averagePerDay === null ? '—' :
            wbCount(Math.round(totals.averagePerDay)), caption: '采集覆盖期 · 已知部分' }),
          h(WbMetric, { title: '周均总用量', value: totals.averagePerWeek === null ? '—' :
            wbCount(Math.round(totals.averagePerWeek)), caption: '按日均 × 7；不足整周仅作参考' })),
        h(WbBlock, { title: 'Token 日历热图', aside: from + ' 至 ' + to + ' · ' + zone },
          h('div', { className: 'fgw-heatmap-scroll' },
            h('div', { className: 'fgw-heatmap-grid', role: 'group', 'aria-label': '按自然日统计 Token 用量' },
              ...squares)),
          h('div', { className: 'fgw-heat-legend' }, '少', ...[0, 1, 2, 3, 4].map(i =>
            h('span', { key: i, className: 'fgw-heat-day fgw-heat-' + i })), '多',
            h('span', { className: 'fgw-heat-day fgw-heat-unknown' }), '无历史覆盖')),
        h(WbBlock, { title: 'Token 用量趋势', aside: '缺失 usage 的任务不计入 Token 累计' },
          h('div', { className: 'fgw-usage-presets' },
            ...[['bar', '柱状图'], ['line', '折线图']].map(([v, n]) =>
              h('button', { key: v, type: 'button', className: 'fgw-refresh' +
                (chart === v ? ' fgw-ops-cta' : ''), onClick: () => setChart(v) }, n))),
          chart === 'line'
            ? h('div', { className: 'fgw-usage-line' }, h('svg', {
              viewBox: '0 0 720 170', role: 'img', 'aria-label': '用量趋势折线图'
            }, h('path', { d: 'M18 145 H700', fill: 'none', stroke: 'currentColor',
              opacity: '.22' }),
            ...lines.map((points, i) => h('polyline', { key: i, points: points.join(' '),
              stroke: 'currentColor', strokeWidth: 2, fill: 'none',
              strokeLinejoin: 'round', strokeLinecap: 'round' }))))
            : h('div', { className: 'fgw-usage-bars' },
              recent.map(row => h('div', { key: row.date, className: 'fgw-bar-row' },
                h('span', null, row.date),
                h('div', { className: 'fgw-bar-track' },
                  h('div', { className: 'fgw-bar-fill',
                    style: { width: ((row.value ?? 0) / max * 100) + '%' } })),
                h('strong', null, row.value === null ? '未知' : wbCount(row.value)))),
              series.length > 60 && h('p', { className: 'fgw-muted' },
                '柱状图展示最近 60 个周期；CSV 包含筛选范围内全部周期。'))),
        h('div', { className: 'fgw-two-column' },
          h(WbBlock, { title: '按模型统计' },
            h(OpsTable, { rows: report.byModel, columns: cols.filter(c => c.key !== 'botId') })),
          h(WbBlock, { title: '按机器人统计' },
            h(OpsTable, { rows: report.byBot, columns: cols.filter(c => c.key !== 'model') }))),
        h(OpsNote, null, '历史统计仅从 DSH 原生用量事件采集，不额外调用模型。' +
          ' 未返回 usage 的任务单独计数；历史采集开始之前的日期不代表零用量。' +
          ' 时区以自然日归属，重复任务 ID 去重；不会读取或导出消息正文。' +
          ' 未配置模型价格，因此不展示费用估算。')))
}
