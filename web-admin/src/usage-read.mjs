/**
 * Historical, privacy-limited token analytics. Reads only the dedicated usage
 * ledger; never touches messages, session files, or raw provider responses.
 * Query dates are calendar dates in an explicit IANA time zone.
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const REF = /^[a-f0-9]{16}$/
const BOT = /^[a-z][a-z0-9_-]{0,31}$/
const MODEL = /^[a-zA-Z0-9_.:/-]{1,96}$/
const METRICS = new Set(['total', 'input', 'output'])
const PERIODS = new Set(['day', 'week', 'month'])
const STATUS = new Set(['done', 'failed', 'cancelled', 'timeout', 'uncertain'])
const FIELDS = ['from', 'to', 'tz', 'period', 'metric', 'model', 'botId', 'user', 'chat', 'session']
const finite = n => Number.isSafeInteger(n) && n >= 0 && n <= 1e13
const bad = message => Object.assign(new Error(message), { status: 400 })
const utcDay = ms => new Date(ms).toISOString().slice(0, 10)
const shiftDay = (day, offset) => utcDay(Date.parse(day + 'T00:00:00Z') + offset * 86400000)

export function parseUsageQuery(params, now = Date.now()) {
  for (const key of params.keys()) if (!FIELDS.includes(key)) throw bad('unsupported usage filter')
  const tz = params.get('tz') || 'UTC'
  if (tz.length > 80) throw bad('invalid time zone')
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(now)) }
  catch { throw bad('invalid time zone') }
  const end = params.get('to') || dayInZone(now, tz)
  const from = params.get('from') || shiftDay(end, -29)
  for (const day of [from, end]) {
    if (!DAY.test(day) || utcDay(Date.parse(day + 'T00:00:00Z')) !== day)
      throw bad('invalid date')
  }
  const span = Math.round((Date.parse(end) - Date.parse(from)) / 86400000) + 1
  if (span < 1 || span > 366) throw bad('date range must be 1..366 days')
  const period = params.get('period') || 'day'
  const metric = params.get('metric') || 'total'
  if (!PERIODS.has(period) || !METRICS.has(metric)) throw bad('invalid aggregation')
  const filters = {}
  for (const key of ['model', 'botId', 'user', 'chat', 'session']) {
    const value = params.get(key)
    if (value !== null && value !== '') {
      const pattern = key === 'model' ? MODEL : key === 'botId' ? BOT : REF
      if (!pattern.test(value)) throw bad('invalid usage filter: ' + key)
      filters[key] = value
    }
  }
  return { from, to: end, tz, period, metric, filters }
}

export function dayInZone(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ts))
  const get = type => parts.find(part => part.type === type)?.value
  return [get('year'), get('month'), get('day')].join('-')
}
function bucketDay(day, period) {
  if (period === 'month') return day.slice(0, 7)
  if (period === 'week') {
    const weekday = new Date(day + 'T00:00:00Z').getUTCDay()
    return shiftDay(day, -(weekday + 6) % 7)
  }
  return day
}
function blank(day) {
  return { date: day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, totalTokens: 0, calls: 0, turns: 0,
    unknownTurns: 0, failedTurns: 0, cancelledTurns: 0 }
}
function tally(target, row) {
  target.turns++
  if (row.status === 'failed' || row.status === 'timeout' || row.status === 'uncertain') target.failedTurns++
  if (row.status === 'cancelled') target.cancelledTurns++
  if (row.totalOnly) {
    target.calls++
    target.unknownTurns++
    target.totalTokens += row.totalTokens
  } else if (row.usage) {
    target.calls++
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
      target[key] += row[key] ?? 0
    target.totalTokens += row.inputTokens + row.outputTokens +
      (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0)
  } else target.unknownTurns++
}
function metricValue(row, metric) {
  return row[metric === 'total' ? 'totalTokens' : metric + 'Tokens']
}
function validRecord(x) {
  if (!x || x.version !== 1 || !finite(x.ts) || !REF.test(x.ref) ||
    !BOT.test(x.botId) || !STATUS.has(x.status)) return null
  const item = { version: 1, ts: x.ts, ref: x.ref, botId: x.botId, status: x.status }
  for (const key of ['session', 'user', 'chat']) {
    if (typeof x[key] === 'string' && REF.test(x[key])) item[key] = x[key]
  }
  if (x.source === 'schedule') item.source = 'schedule'
  if (typeof x.model === 'string' && MODEL.test(x.model)) item.model = x.model
  if (finite(x.inputTokens) && finite(x.outputTokens)) {
    item.inputTokens = x.inputTokens
    item.outputTokens = x.outputTokens
    for (const key of ['cacheReadTokens', 'cacheWriteTokens'])
      if (finite(x[key])) item[key] = x[key]
    item.usage = true
  } else item.usage = false
  return item
}
async function usageFiles(stateDir) {
  const st = await fs.lstat(stateDir).catch(e => { if (e.code === 'ENOENT') return null; throw e })
  if (!st) return []
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('unsafe usage state directory')
  const dir = path.join(stateDir, 'ops-usage')
  const folder = await fs.lstat(dir).catch(e => { if (e.code === 'ENOENT') return null; throw e })
  if (!folder) return []
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw Error('unsafe usage history directory')
  return (await fs.readdir(dir)).filter(n => DAY.test(n.slice(0, 10)) &&
    n === n.slice(0, 10) + '.jsonl' &&
    !Number.isNaN(Date.parse(n.slice(0, 10) + 'T00:00:00Z')) &&
    utcDay(Date.parse(n.slice(0, 10) + 'T00:00:00Z')) === n.slice(0, 10)).sort()
}
async function readUsageFile(stateDir, name) {
  const file = path.join(stateDir, 'ops-usage', name)
  const st = await fs.lstat(file)
  if (!st.isFile() || st.isSymbolicLink() || st.size > 16 * 1024 * 1024)
    throw Error('unsafe or oversized usage history file')
  return fs.readFile(file, 'utf8')
}
async function firstTrackedDay(stateDir, names, tz) {
  // The exact first *local* day matters: UTC filenames can be a different
  // calendar date in the selected time zone. No pre-collection zeroes.
  for (const name of names) {
    let earliest = null
    for (const line of (await readUsageFile(stateDir, name)).split('\n')) {
      if (!line || line.length > 4096) continue
      let row
      try { row = validRecord(JSON.parse(line)) } catch { continue }
      if (row && (earliest === null || row.ts < earliest)) earliest = row.ts
    }
    if (earliest !== null) return dayInZone(earliest, tz)
  }
  return null
}
/** Recover only the bounded totals retained by old Gateway schedule runs.
 * Older records do not contain component usage, so coverage remains partial.
 * Full ledger rows always supersede these summaries by the same message ref.
 */
async function historicalScheduleRows(stateDir) {
  const file = path.join(stateDir, 'schedule-runs.json')
  const st = await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e })
  if (!st) return []
  if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024)
    throw Error('unsafe schedule usage history')
  let doc
  try { doc = JSON.parse(await fs.readFile(file, 'utf8')) } catch { return [] }
  if (!doc || doc.version !== 1 || !Array.isArray(doc.runs)) return []
  return doc.runs.slice(-200).flatMap(run => {
    if (!run || !finite(run.ts) || typeof run.messageId !== 'string' ||
        !run.messageId || run.messageId.length > 256) return []
    const ref = createHash('sha256').update('schedule:' + run.messageId).digest('hex').slice(0, 16)
    const status = run.status === 'failed' ? 'failed' : run.status === 'timeout' ? 'timeout' : 'done'
    return [{ version: 1, ts: run.ts, ref, source: 'schedule', botId: 'schedule', status,
      ...(typeof run.model === 'string' && MODEL.test(run.model) ? { model: run.model } : {}),
      ...(typeof run.sessionRef === 'string' && REF.test(run.sessionRef) ? { session: run.sessionRef } : {}),
      ...(finite(run.tokens) ? { totalOnly: true, totalTokens: run.tokens } : { usage: false }) }]
  })
}

export async function queryUsage(stateDir, query, now = Date.now()) {
  const filenames = await usageFiles(stateDir)
  const ledgerEarliest = await firstTrackedDay(stateDir, filenames, query.tz)
  const oldSchedule = await historicalScheduleRows(stateDir)
  const scheduleEarliest = oldSchedule.length ? dayInZone(Math.min(...oldSchedule.map(r => r.ts)), query.tz) : null
  const earliest = [ledgerEarliest, scheduleEarliest].filter(Boolean).sort()[0] ?? null
  const scanned = new Map()
  const facets = { models: new Set(), bots: new Set(), users: new Set(),
    chats: new Set(), sessions: new Set() }
  for (const name of filenames) {
    const date = name.slice(0, 10)
    if (date < shiftDay(query.from, -1) || date > shiftDay(query.to, 1)) continue
    const contents = await readUsageFile(stateDir, name)
    for (const line of contents.split('\n')) {
      if (!line || line.length > 4096) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      const row = validRecord(parsed)
      if (!row) continue
      const localDay = dayInZone(row.ts, query.tz)
      if (localDay < query.from || localDay > query.to) continue
      row.day = localDay
      // Stable inbound task ID: dedupe duplicate terminal/retry events, even
      // when a task was repeated across a process restart.
      const key = row.source === 'schedule' ? 'schedule:' + row.ref : row.botId + ':' + row.ref
      const old = scanned.get(key)
      if (!old || (!old.usage && row.usage) || (old.usage === row.usage && row.ts >= old.ts))
        scanned.set(key, row)
    }
  }
  for (const row of oldSchedule) {
    const localDay = dayInZone(row.ts, query.tz)
    if (localDay < query.from || localDay > query.to) continue
    const key = 'schedule:' + row.ref
    if (!scanned.has(key)) scanned.set(key, { ...row, day: localDay })
  }
  const dailyMap = new Map()
  for (let day = query.from; day <= query.to; day = shiftDay(day, 1)) dailyMap.set(day, blank(day))
  const models = new Map()
  const bots = new Map()
  for (const row of scanned.values()) {
    if (row.model) facets.models.add(row.model)
    facets.bots.add(row.botId)
    if (row.user) facets.users.add(row.user)
    if (row.chat) facets.chats.add(row.chat)
    if (row.session) facets.sessions.add(row.session)
    if (Object.entries(query.filters).some(([key, value]) => row[key] !== value)) continue
    tally(dailyMap.get(row.day), row)
    for (const [table, key] of [[models, row.model || 'unknown'], [bots, row.botId]]) {
      const prev = table.get(key) || blank(key)
      tally(prev, row)
      table.set(key, prev)
    }
  }
  const daily = [...dailyMap.values()].map(row =>
    earliest === null || row.date < earliest
      ? { ...row, totalTokens: null, inputTokens: null, outputTokens: null, coverage: 'unavailable' }
      : { ...row, coverage: row.unknownTurns ? 'partial' : 'recorded' })
  const total = blank('total')
  for (const row of daily) {
    total.turns += row.turns
    total.calls += row.calls
    total.unknownTurns += row.unknownTurns
    total.failedTurns += row.failedTurns
    total.cancelledTurns += row.cancelledTurns
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'])
      total[key] += row[key] ?? 0
  }
  const grouped = new Map()
  for (const row of daily) {
    const key = bucketDay(row.date, query.period)
    const group = grouped.get(key) ?? { ...blank(key), coverage: 'recorded' }
    for (const field of ['turns', 'calls', 'unknownTurns', 'failedTurns', 'cancelledTurns',
      'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'])
      group[field] += row[field] ?? 0
    if (row.coverage === 'unavailable') group.coverage = 'unavailable'
    else if (row.coverage === 'partial' && group.coverage !== 'unavailable') group.coverage = 'partial'
    grouped.set(key, group)
  }
  const series = [...grouped.values()].map(row => ({
    ...row, value: row.coverage === 'unavailable' ? null : metricValue(row, query.metric)
  }))
  const candidates = rows => [...rows.values()].sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 30).map(row => ({ ...row, value: metricValue(row, query.metric) }))
  const observedDays = daily.filter(row => row.coverage !== 'unavailable')
  const peak = observedDays.filter(row => row.calls > 0)
    .sort((a, b) => (metricValue(b, query.metric) ?? 0) - (metricValue(a, query.metric) ?? 0))[0]
  const perDay = observedDays.length ? total.totalTokens / observedDays.length : null
  return {
    query: { ...query, filters: query.filters },
    coverage: { earliestDay: earliest, available: earliest !== null, partial: total.unknownTurns > 0 },
    summary: { ...total, value: earliest === null ? null : metricValue(total, query.metric),
      peakDay: peak?.date ?? null, peakTokens: peak ? metricValue(peak, query.metric) : null,
      averagePerDay: perDay, averagePerWeek: perDay === null ? null : perDay * 7 },
    daily: daily.map(row => ({ ...row, value: row.coverage === 'unavailable' ? null : metricValue(row, query.metric) })),
    series, byModel: candidates(models).map(({ date, ...row }) => ({ model: date, ...row })),
    byBot: candidates(bots).map(({ date, ...row }) => ({ botId: date, ...row })),
    facets: Object.fromEntries(Object.entries(facets).map(([k, set]) => [k, [...set].sort().slice(0, 200)]))
  }
}
export function usageCsv(report) {
  const cols = ['date', 'coverage', 'turns', 'calls', 'unknownTurns', 'failedTurns', 'cancelledTurns',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']
  return '\ufeff' + [cols.join(','), ...report.series.map(row =>
    cols.map(key => row[key] ?? '').join(','))].join('\r\n') + '\r\n'
}
