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
const USAGE_WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
function usageWeekdayName(date) {
  return '周' + USAGE_WEEKDAY_LABELS[(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7]
}
function usageMonthLabel(date, withYear) {
  const [year, month] = date.split('-')
  return withYear || month === '01' ? year + ' 年 ' + Number(month) + ' 月' : Number(month) + ' 月'
}
/* GitHub-style calendar heatmap: month/weekday axes, theme-aware ramp,
 * keyboard focus and one shared tooltip instead of hundreds of native titles. */
function UsageHeatmap({ daily, metricText, today, summary }) {
  const [tip, setTip] = useState(null)
  if (!daily || !daily.length) {
    return h(WbEmpty, { headline: '暂无历史用量',
      description: '所选日期范围内没有可用的用量记录。' })
  }
  const top = Math.max(1, ...daily.map(day => day.value ?? 0))
  const level = day => day.value === null ? 'unknown'
    : day.value === 0 ? '0' : String(Math.min(4, Math.max(1, Math.ceil(day.value / top * 4))))
  const cellLabel = day => day.date + ' ' + usageWeekdayName(day.date) + ' · ' + metricText + ' ' +
    (day.value === null ? '无历史覆盖' : wbCount(day.value)) + ' · 输入 ' + wbValue(day.inputTokens) +
    ' · 输出 ' + wbValue(day.outputTokens) + ' · 有 usage 调用 ' + wbCount(day.calls) +
    ' · 缺失 usage ' + wbCount(day.unknownTurns)
  const showTip = (event, day) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const half = 104
    const below = rect.top < 140
    setTip({ day, below,
      x: Math.min(Math.max(rect.left + rect.width / 2, half),
        Math.max(half, window.innerWidth - half)),
      y: below ? rect.bottom + 8 : rect.top - 8 })
  }
  const hideTip = () => setTip(null)
  const renderCell = (day, key) => day ? h('span', {
    key: day.date,
    className: 'fgw-heat-day fgw-heat-' + level(day) +
      (day.coverage === 'partial' ? ' fgw-heat-partial' : '') +
      (day.date === today ? ' fgw-heat-today' : ''),
    role: 'gridcell', tabIndex: 0, 'aria-label': cellLabel(day),
    onMouseEnter: event => showTip(event, day), onMouseLeave: hideTip,
    onFocus: event => showTip(event, day), onBlur: hideTip,
  }) : h('span', { key, className: 'fgw-heat-day fgw-heat-empty', 'aria-hidden': true })
  const padStart = (new Date(daily[0].date + 'T00:00:00Z').getUTCDay() + 6) % 7
  const cells = [
    ...Array.from({ length: padStart }, (_, i) => renderCell(null, 'pad' + i)),
    ...daily.map(day => renderCell(day)),
  ]
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  const months = []
  let monthSeen = ''
  weeks.forEach((week, index) => {
    const weekStart = usageShiftDay(daily[0].date, index * 7 - padStart)
    const first = weekStart < daily[0].date ? daily[0].date : weekStart
    const month = first.slice(0, 7)
    const label = first <= daily[daily.length - 1].date && month !== monthSeen
      ? usageMonthLabel(first, index === 0) : ''
    if (label) monthSeen = month
    months.push(h('span', { key: 'month' + index, className: 'fgw-heatmap-month' },
      label ? h('i', null, label) : null))
  })
  const activeDays = daily.filter(day => day.value !== null && day.calls > 0).length
  const number = value => value === null || value === undefined ? '—' : wbCount(Math.round(value))
  const stats = [
    [metricText, number(summary?.value)],
    ['活跃天', wbCount(activeDays)],
    ['峰值日', summary?.peakDay || '—'],
    ['日均', number(summary?.averagePerDay)],
  ]
  const legendCell = name => h('span', { key: name, className: 'fgw-heat-day fgw-heat-' + name })
  const sizeClass = weeks.length <= 6 ? ' fgw-heatmap-xl' : weeks.length <= 13 ? ' fgw-heatmap-lg'
    : weeks.length <= 26 ? ' fgw-heatmap-md' : ''
  return h('div', { className: 'fgw-heatmap' + sizeClass },
    h('div', { className: 'fgw-heatmap-stats' }, ...stats.map(([name, value]) =>
      h('span', { key: name }, name + ' ', h('strong', null, value)))),
    h('div', { className: 'fgw-heatmap-scroll' },
      h('div', { className: 'fgw-heatmap-inner' },
        h('div', { className: 'fgw-heatmap-months', 'aria-hidden': true }, ...months),
        h('div', { className: 'fgw-heatmap-main' },
          h('div', { className: 'fgw-heatmap-weekdays', 'aria-hidden': true },
            ...['一', '', '三', '', '五', '', '日'].map((name, index) =>
              h('span', { key: index }, name))),
          h('div', { className: 'fgw-heatmap-grid', role: 'grid',
            'aria-label': '按自然日统计 ' + metricText + ' 用量' },
          ...weeks.map((week, index) =>
            h('div', { key: 'week' + index, className: 'fgw-heatmap-week', role: 'row' }, ...week)))))),
    h('div', { className: 'fgw-heatmap-foot' },
      h('span', { className: 'fgw-heatmap-hint' }, '悬停查看每日明细'),
      h('div', { className: 'fgw-heatmap-legend' },
        h('span', null, '少'), ...[0, 1, 2, 3, 4].map(legendCell), h('span', null, '多'),
        h('span', { className: 'fgw-heatmap-legend-sep' }),
        h('span', { className: 'fgw-heat-day fgw-heat-unknown' }), h('span', null, '无历史覆盖'),
        h('span', { className: 'fgw-heat-day fgw-heat-1 fgw-heat-partial' }), h('span', null, '部分覆盖'))),
    tip && h('div', { className: 'fgw-heat-tip', role: 'tooltip',
      style: { left: tip.x + 'px', top: tip.y + 'px',
        transform: tip.below ? 'translate(-50%,0)' : 'translate(-50%,-100%)' } },
      h('div', { className: 'fgw-heat-tip-date' },
        tip.day.date + ' ' + usageWeekdayName(tip.day.date)),
      h('div', { className: 'fgw-heat-tip-row' }, h('span', null, metricText),
        h('strong', null, tip.day.value === null ? '无历史覆盖' : wbCount(tip.day.value))),
      h('div', { className: 'fgw-heat-tip-row' }, h('span', null, '输入 / 输出'),
        h('strong', null, wbValue(tip.day.inputTokens) + ' / ' + wbValue(tip.day.outputTokens))),
      h('div', { className: 'fgw-heat-tip-row' }, h('span', null, '有 usage 调用'),
        h('strong', null, wbCount(tip.day.calls))),
      tip.day.unknownTurns > 0 && h('div', { className: 'fgw-heat-tip-row' },
        h('span', null, '缺失 usage'), h('strong', null, wbCount(tip.day.unknownTurns))),
      tip.day.coverage === 'unavailable' && h('div', { className: 'fgw-heat-tip-note' },
        '该日期早于历史采集起点'),
      tip.day.coverage === 'partial' && h('div', { className: 'fgw-heat-tip-note' },
        '部分任务未上报 usage')))
}

function UsageField({ title, children }) {
  return h('label', { className: 'fgw-usage-field' }, h('span', null, title), children)
}

/* A single, keyboard-accessible date range control. Validation matches the
 * historical usage endpoint (inclusive dates, 1..366 calendar days). */
function UsageDateRange({ from, to, onApply }) {
  const [open, setOpen] = useState(false)
  const [start, setStart] = useState(from)
  const [end, setEnd] = useState(to)
  useEffect(() => {
    if (!open) return
    const onKey = event => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const span = start && end
    ? Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1 : 0
  const valid = span >= 1 && span <= 366
  const toggle = () => {
    if (!open) { setStart(from); setEnd(to) }
    setOpen(value => !value)
  }
  return h('div', { className: 'fgw-usage-range' },
    h('span', { className: 'fgw-usage-field-title' }, '日期范围'),
    h('button', { type: 'button', className: 'fgw-usage-range-trigger',
      'aria-expanded': open, 'aria-label': '选择日期范围',
      onClick: toggle },
      h('span', { className: 'fgw-usage-range-value' }, from + '  —  ' + to),
      h('svg', { className: 'fgw-usage-range-icon', width: 16, height: 16,
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }),
        h('path', { d: 'M7 3v4M17 3v4M3 10h18' }))),
    open && h('div', { className: 'fgw-usage-range-popup', role: 'group',
      'aria-label': '自定义日期范围' },
      h('div', { className: 'fgw-usage-range-dates' },
        h(UsageField, { title: '开始日期' }, h('input', {
          type: 'date', value: start, onChange: e => setStart(e.target.value)
        })),
        h(UsageField, { title: '结束日期' }, h('input', {
          type: 'date', value: end, onChange: e => setEnd(e.target.value)
        }))),
      h('p', { className: 'fgw-usage-range-help' },
        valid ? '共 ' + span + ' 天（含起止日期）' : '请选择有效日期，最多 366 天'),
      h('div', { className: 'fgw-usage-range-actions' },
        h('button', { type: 'button', className: 'fgw-refresh',
          onClick: () => setOpen(false) }, '取消'),
        h('button', { type: 'button', className: 'fgw-refresh fgw-ops-cta',
          disabled: !valid, onClick: () => { onApply(start, end); setOpen(false) } },
          '应用日期'))))
}

/* The server still returns daily records; the chart groups longer ranges
 * automatically without changing the semantics of the exported CSV. */
function usageTrendBuckets(rows) {
  const granularity = rows.length > 100 ? 'month' : rows.length > 35 ? 'week' : 'day'
  const bucketKey = date => {
    if (granularity === 'month') return date.slice(0, 7)
    if (granularity === 'week') {
      const weekday = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7
      return usageShiftDay(date, -weekday)
    }
    return date
  }
  const buckets = []
  let current = null
  for (const row of rows) {
    const key = bucketKey(row.date)
    if (!current || current.key !== key) {
      current = { key, start: row.date, end: row.date, calls: 0, tokens: 0,
        covered: false, partial: false }
      buckets.push(current)
    }
    current.end = row.date
    if (row.value === null || row.coverage === 'unavailable') {
      current.partial = true
    } else {
      current.covered = true
      current.calls += row.calls || 0
      current.tokens += row.value || 0
      if (row.coverage === 'partial') current.partial = true
    }
  }
  return { granularity, rows: buckets.map(bucket => ({
    ...bucket, calls: bucket.covered ? bucket.calls : null,
    tokens: bucket.covered ? bucket.tokens : null,
    label: granularity === 'month' ? bucket.key : bucket.start.slice(5),
  })) }
}
function usageCompact(value) {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1000000) return (value / 1000000).toFixed(value % 1000000 ? 1 : 0) + 'M'
  if (value >= 1000) return (value / 1000).toFixed(value % 1000 ? 1 : 0) + 'k'
  return String(Math.round(value))
}
function UsageTrendChart({ title, value, unit, rows, kind, description, granularity }) {
  const [compact, setCompact] = useState(() => window.innerWidth < 690)
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < 690)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const viewWidth = compact ? 400 : 720
  const left = compact ? 42 : 53
  const right = compact ? 12 : 18
  const top = 22
  const bottom = 222
  const plotWidth = viewWidth - left - right
  const series = rows.map(row => row[kind])
  const known = series.filter(x => x !== null && Number.isFinite(x))
  const max = Math.max(1, ...known) * 1.12
  const y = n => bottom - n / max * (bottom - top)
  const x = index => left + (rows.length <= 1
    ? plotWidth / 2 : plotWidth * index / (rows.length - 1))
  const step = plotWidth / Math.max(1, rows.length)
  const barWidth = Math.max(3, Math.min(28, step * .66))
  const segments = []
  let run = []
  series.forEach((n, index) => {
    if (n === null) {
      if (run.length) segments.push(run)
      run = []
    } else run.push([x(index), y(n)])
  })
  if (run.length) segments.push(run)
  const ticks = [...new Set([0, 1, 2, 3, 4]
    .map(i => Math.round(i * (rows.length - 1) / 4)))]
  const titleFor = (row, amount) => row.start +
    (row.end !== row.start ? ' 至 ' + row.end : '') + ' · ' +
    (amount === null ? '无历史覆盖' : wbCount(amount) + ' ' + unit) +
    (row.partial ? ' · 部分覆盖' : '')
  const hasData = known.length > 0
  return h('section', { className: 'fgw-usage-chart-card' },
    h('div', { className: 'fgw-usage-chart-heading' },
      h('div', null,
        h('h3', null, title),
        h('p', null, description)),
      h('strong', null, wbCount(value))),
    hasData ? h('div', { className: 'fgw-usage-chart-canvas' },
      h('svg', { className: 'fgw-usage-svg fgw-usage-svg-' + kind,
        viewBox: '0 0 ' + viewWidth + ' 262', role: 'img', 'aria-label': title + '趋势图' },
        h('defs', null,
          h('linearGradient', { id: 'fgw-usage-requests-gradient', x1: '0',
            x2: '0', y1: '0', y2: '1' },
            h('stop', { offset: '0%', stopColor: '#489cf5', stopOpacity: .55 }),
            h('stop', { offset: '100%', stopColor: '#489cf5', stopOpacity: .04 }))),
        ...[0, 1, 2, 3].map(n => {
          const value = max * n / 3
          const yy = y(value)
          return h('g', { key: 'axis-' + n },
            h('line', { x1: left, y1: yy, x2: viewWidth - right, y2: yy,
              className: 'fgw-usage-gridline' }),
            h('text', { x: left - 9, y: yy + 4, textAnchor: 'end',
              className: 'fgw-usage-axis' }, usageCompact(value)))
        }),
        kind === 'calls'
          ? segments.map((points, index) => {
            const trace = points.map((point, i) =>
              (i === 0 ? 'M' : 'L') + point[0].toFixed(2) +
              ' ' + point[1].toFixed(2)).join(' ')
            const fill = trace + ' L' + points[points.length - 1][0].toFixed(2) +
              ' ' + bottom + ' L' + points[0][0].toFixed(2) + ' ' + bottom + ' Z'
            return h('g', { key: 'trace-' + index },
              h('path', { d: fill, fill: 'url(#fgw-usage-requests-gradient)' }),
              h('path', { d: trace, className: 'fgw-usage-area-line' }))
          })
          : rows.map((row, index) => {
            const amount = row.tokens
            const height = amount === null ? 0 : Math.max(0, bottom - y(amount))
            return h('rect', { key: row.key,
              x: x(index) - barWidth / 2,
              y: amount === null ? bottom - 4 : bottom - height,
              width: barWidth, height: amount === null ? 4 : Math.max(1, height),
              rx: 2, className: amount === null
                ? 'fgw-usage-token-missing' : 'fgw-usage-token-bar' },
              h('title', null, titleFor(row, amount)))
          }),
        kind === 'calls' && rows.map((row, index) => row.calls !== null &&
          h('circle', { key: row.key, cx: x(index), cy: y(row.calls),
            r: rows.length <= 40 ? 3 : 2,
            className: 'fgw-usage-area-dot' },
            h('title', null, titleFor(row, row.calls)))),
        ...ticks.map(index => h('text', { key: 'tick-' + index,
          x: x(index), y: bottom + 22, textAnchor: 'middle',
          className: 'fgw-usage-axis fgw-usage-x-axis' },
          rows[index]?.label || ''))))
      : h('div', { className: 'fgw-usage-chart-empty' }, '当前时间段尚无可绘制的历史数据'),
    h('div', { className: 'fgw-usage-chart-foot' },
      h('span', null, '按' + ({ day: '日', week: '周', month: '月' }[granularity] || '日') +
        '展示 · 不补零'),
      h('span', null, '历史未覆盖的日期不计入统计')))
}
function UsagePanel() {
  // Use the browser's configured time zone internally, without exposing
  // free-form IANA input in the UI. Both queries share one local-day policy.
  const [zone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const today = usageIsoDate(new Date(), zone)
  const [from, setFrom] = useState(() => usageShiftDay(today, -29))
  const [to, setTo] = useState(today)
  const [preset, setPreset] = useState('30')
  const [metric, setMetric] = useState('total')
  const [model, setModel] = useState('')
  const [botId, setBotId] = useState('')
  const [user, setUser] = useState('')
  const [chat, setChat] = useState('')
  const [session, setSession] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [report, setReport] = useState(null)
  const [yearReport, setYearReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const [yearBusy, setYearBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [yearError, setYearError] = useState('')
  const filterControls = { model, botId, user, chat, session }
  const controls = { from, to, tz: zone, period: 'day', metric, ...filterControls }
  const url = '/ops/usage?' + new URLSearchParams(
    Object.entries(controls).filter(([, val]) => val !== '')
  ).toString()
  const yearFrom = usageShiftDay(today, -364)
  const yearUrl = '/ops/usage?' + new URLSearchParams(
    Object.entries({ from: yearFrom, to: today, tz: zone, period: 'day',
      metric: 'total', ...filterControls }).filter(([, val]) => val !== '')
  ).toString()
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setRevision(current => current + 1)
    }, 30000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    let active = true
    setBusy(true); setError('')
    request(url).then(data => { if (active) setReport(data.report) })
      .catch(e => { if (active) { setReport(null); setError(e.message || String(e)) } })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [url, revision])
  useEffect(() => {
    let active = true
    setYearBusy(true); setYearError('')
    request(yearUrl).then(data => { if (active) setYearReport(data.report) })
      .catch(e => { if (active) { setYearReport(null); setYearError(e.message || String(e)) } })
      .finally(() => { if (active) setYearBusy(false) })
    return () => { active = false }
  }, [yearUrl, revision])
  const presetRange = days => {
    const current = usageIsoDate(new Date(), zone)
    setPreset(days); setTo(current)
    setFrom(days === 'month' ? current.slice(0, 7) + '-01' :
      usageShiftDay(current, 1 - Number(days)))
  }
  const select = (value, change, items, format = x => x) =>
    h('select', { className: 'fgw-usage-select', value,
      onChange: e => change(e.target.value) },
      h('option', { value: '' }, '全部'),
      ...[...new Set([...(value ? [value] : []), ...(items || [])])].map(item =>
        h('option', { key: item, value: item }, format(item))))
  const facets = yearReport?.facets || report?.facets || {}
  const series = report?.series || []
  const totals = report?.summary || {}
  const metricText = { total: '总 Token', input: '输入 Token', output: '输出 Token' }[metric]
  const cols = [
    { key: 'model', title: '模型' }, { key: 'botId', title: '机器人' },
    { key: 'calls', title: '有 usage 调用', render: x => wbCount(x.calls) },
    { key: 'unknownTurns', title: '缺失 usage', render: x => wbCount(x.unknownTurns) },
    { key: 'value', title: metricText, render: x => wbCount(x.value) }
  ]
  const chartData = usageTrendBuckets(series)
  const resetFilters = () => {
    setModel(''); setBotId(''); setUser(''); setChat(''); setSession('')
    setPreset('30'); setFrom(usageShiftDay(today, -29)); setTo(today)
    setMetric('total')
  }
  return h('div', { className: 'fgw-usage fgw-usage-dashboard' },
    h('div', { className: 'fgw-usage-intro' },
      h('div', null,
        h('strong', null, '用量概览'),
        h('p', null, '历史 Token 消耗与请求活动 · 数据来自已上报的原生 usage 事件')),
      h('span', { className: 'fgw-usage-updated' },
        yearBusy || busy ? '数据更新中…' : '仅显示已采集的数据')),
    h(WbBlock, { title: 'Token 日历热图',
      aside: '最近一年 · ' + yearFrom + ' 至 ' + today },
      yearError && h('p', { className: 'fgw-caution', role: 'alert' }, yearError),
      yearReport ? h(UsageHeatmap, { daily: yearReport.daily, metricText: '总 Token',
        today, summary: yearReport.summary })
        : h(WbEmpty, { headline: yearBusy ? '正在读取全年热图…' : '全年热图暂不可用',
          description: '历史数据尚未采集或无法读取。' })),
    h('section', { className: 'fgw-usage-filters', 'aria-label': '统计筛选' },
      h('div', { className: 'fgw-usage-filters-top' },
        h('div', { className: 'fgw-usage-presets' },
          ...[['1', '今天'], ['7', '近 7 天'], ['30', '近 30 天'], ['month', '本月']]
            .map(([n, label]) => h('button', { type: 'button', key: n,
              className: 'fgw-refresh' + (preset === n ? ' fgw-ops-cta' : ''),
              'aria-pressed': preset === n,
              onClick: () => presetRange(n) }, label))),
        h('div', { className: 'fgw-usage-actions' },
          h('button', { className: 'fgw-refresh', type: 'button',
            onClick: () => setRevision(x => x + 1) }, '刷新数据'),
          h('a', { className: 'fgw-refresh fgw-usage-export',
            href: API + url.replace('/ops/usage?', '/ops/usage/export?'),
            download: 'feishu-token-usage.csv' }, '导出 CSV'))),
      h('div', { className: 'fgw-usage-primary-fields' },
        h(UsageDateRange, { from, to, onApply: (a, b) => {
          setPreset('custom'); setFrom(a); setTo(b)
        } }),
        h(UsageField, { title: '统计指标' },
          h('select', { value: metric, onChange: e => setMetric(e.target.value) },
            ...[['total', '总 Token'], ['input', '输入 Token'], ['output', '输出 Token']]
              .map(([v, n]) => h('option', { key: v, value: v }, n)))),
        h('button', { type: 'button',
          className: 'fgw-refresh fgw-usage-more',
          'aria-expanded': showFilters,
          onClick: () => setShowFilters(v => !v) },
          showFilters ? '收起高级筛选' : '更多筛选')),
      h('div', { className: 'fgw-usage-facets' + (showFilters ? ' is-open' : '') },
        h(UsageField, { title: '模型' }, select(model, setModel, facets.models)),
        h(UsageField, { title: '机器人' }, select(botId, setBotId, facets.bots)),
        h(UsageField, { title: '飞书用户（匿名标识）' },
          select(user, setUser, facets.users, x => x.slice(0, 10) + '…')),
        h(UsageField, { title: '群聊 / 会话（匿名标识）' },
          select(chat, setChat, facets.chats, x => x.slice(0, 10) + '…')),
        h(UsageField, { title: 'Session（匿名标识）' },
          select(session, setSession, facets.sessions, x => x.slice(0, 10) + '…'))),
      h('div', { className: 'fgw-usage-filter-foot' },
        h('span', null, '筛选仅影响已采集的数据，不会产生新的模型调用'),
        h('button', { type: 'button', className: 'fgw-usage-clear',
          onClick: resetFilters }, '重置筛选'))),
    error && h('p', { className: 'fgw-caution', role: 'alert' }, error),
    !report ? h(WbEmpty, { headline: busy ? '正在读取历史统计…' : '历史统计不可用',
      description: '请检查用量日志是否已启用，以及日期范围是否有效。' })
      : h(React.Fragment, null,
        h('div', { className: 'fgw-metrics fgw-usage-metrics' },
          h(WbMetric, { title: metricText, value: wbCount(totals.value),
            caption: totals.unknownTurns ? '已知部分 · 存在未上报任务' : '模型已上报用量' }),
          h(WbMetric, { title: '已上报 usage 调用', value: wbCount(totals.calls),
            caption: '尝试任务 ' + wbCount(totals.turns) }),
          h(WbMetric, { title: '缺失 usage 任务', value: wbCount(totals.unknownTurns),
            caption: '失败 ' + wbCount(totals.failedTurns) + ' · 取消 ' +
              wbCount(totals.cancelledTurns) }),
          h(WbMetric, { title: '日均 Token', value: totals.averagePerDay === null ? '—' :
            wbCount(Math.round(totals.averagePerDay)), caption: '基于已覆盖日期' })),
        h('div', { className: 'fgw-usage-chart-grid' },
          h(UsageTrendChart, { title: 'API 请求次数',
            value: totals.calls, kind: 'calls', unit: '次',
            description: '有 usage 的调用次数 · 非 HTTP 请求总数',
            rows: chartData.rows, granularity: chartData.granularity }),
          h(UsageTrendChart, { title: metricText + ' 趋势',
            value: totals.value, kind: 'tokens', unit: 'Token',
            description: '已知用量 · 缺失 usage 不补零',
            rows: chartData.rows })),
        h('div', { className: 'fgw-usage-detail-line' },
          h('span', null, '峰值日 ' + (totals.peakDay || '—') +
            ' · ' + wbCount(totals.peakTokens) + ' ' + metricText),
          h('span', null, '周均 ' + (totals.averagePerWeek === null ? '—' :
            wbCount(Math.round(totals.averagePerWeek))) + ' Token · 仅供参考')),
        h('div', { className: 'fgw-two-column fgw-usage-breakdowns' },
          h(WbBlock, { title: '按模型统计' },
            h(OpsTable, { rows: report.byModel,
              columns: cols.filter(c => c.key !== 'botId') })),
          h(WbBlock, { title: '按机器人统计' },
            h(OpsTable, { rows: report.byBot,
              columns: cols.filter(c => c.key !== 'model') }))),
        h(OpsNote, null, '历史用量仅来自 DSH 原生 usage 事件，不额外调用模型。' +
          ' 未返回 usage 的任务单独计数；采集开始之前的日期不代表零用量。' +
          ' 按浏览器时区归属自然日，重复任务 ID 去重；不读取或导出消息正文。' +
          ' 未配置模型价格，因此不提供费用估算。')))
}
