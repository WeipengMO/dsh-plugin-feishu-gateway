/**
 * Plain-JS mirror of the Gateway's canonical schedule spec validation and
 * preview (`src/schedule/spec.ts`). No DSH imports, no network, no filesystem:
 * the Web Admin form, the preview endpoint and the operator command all share
 * this one shape. Both sides must reject exactly the same inputs.
 *
 * Local wall-clock times are converted to UTC with Intl.DateTimeFormat offset
 * probing (DST-safe, explicit timeZone) -- never with a fixed numeric offset.
 * Candidates are generated day-by-day over a bounded <= 366 day horizon.
 */
'use strict'

// --- Shared constants (also imported by server.mjs / schedule-read.mjs) ---
export const SCHEDULE_KINDS = ['once', 'every', 'daily', 'weekly', 'monthly', 'cron']
export const SCHEDULE_ACTIONS = ['create', 'update', 'pause', 'resume', 'run', 'delete', 'delete-inactive', 'refresh']
export const SCHEDULE_NOTIFY = ['result', 'failure', 'both', 'none']
export const TITLE_MAX = 120
export const PROMPT_MAX = 4000
export const EVERY_SECONDS_MIN = 60
export const PREVIEW_MAX = 10
export const PREVIEW_HORIZON_DAYS = 366
export const SCHEDULE_ACTOR = 'dsh-web-admin'
// Bounded identifiers: task ids are native ids reserved by the Gateway.
export const SCHEDULE_TASK_ID_RE = /^schedule-[a-f0-9-]{36}$/
export const SCHEDULE_UUID_RE = /^[a-f0-9-]{36}$/

const HORIZON_MS = PREVIEW_HORIZON_DAYS * 86400000
const TZ_MAX = 64
const EXPR_MAX = 200
const SPEC_KEYS = {
  once: ['kind', 'at', 'timeZone'],
  every: ['kind', 'everySeconds'],
  daily: ['kind', 'time', 'timeZone'],
  weekly: ['kind', 'time', 'timeZone', 'weekdays'],
  monthly: ['kind', 'time', 'timeZone', 'day'],
  cron: ['kind', 'expression', 'timeZone'],
}
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/
const AT_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/
const AT_ABS_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?Z$/
const TZ_RE = /^(?:UTC|[A-Za-z][A-Za-z0-9_.+/-]{1,63})$/

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function fail(error) { return { ok: false, error } }

// --- DST-safe Intl offset probing ------------------------------------------
const fmtCache = new Map()
function getFormatter(timeZone) {
  let fmt = fmtCache.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    fmtCache.set(timeZone, fmt)
  }
  return fmt
}
function localParts(date, timeZone) {
  const out = {}
  for (const part of getFormatter(timeZone).formatToParts(date)) out[part.type] = part.value
  return out
}
/** Offset (ms) such that localWallAsUTC === utcWholeSecond + offset. */
function offsetMs(utcMs, timeZone) {
  const p = localParts(new Date(utcMs), timeZone)
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUTC - Math.floor(utcMs / 1000) * 1000
}
/** Convert a pretended-UTC wall timestamp to a real UTC instant. */
function zonedTimeToUtc(wallMs, timeZone) {
  let guess = wallMs
  for (let i = 0; i < 4; i++) {
    const next = wallMs - offsetMs(guess, timeZone)
    if (next === guess) break
    guess = next
  }
  return guess
}
function validTimeZone(value) {
  if (typeof value !== 'string' || value.length > TZ_MAX || !TZ_RE.test(value)) return false
  if (value !== 'UTC' && !value.includes('/')) return false
  try { getFormatter(value).format(new Date(0)); return true } catch { return false }
}

// --- Field parsers ---------------------------------------------------------
function fracMs(frac) { return frac ? +frac.padEnd(3, '0') : 0 }
function wallFromMatch(match) {
  const y = +match[1], mo = +match[2], d = +match[3]
  const h = +match[4], mi = +match[5], s = +match[6]
  const ms = fracMs(match[7])
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms)
  const check = new Date(t)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return t
}
/** `at` is either an absolute ...Z instant or a local wall clock. */
function parseAt(value) {
  if (typeof value !== 'string' || value.length > 40) return null
  let match = AT_ABS_RE.exec(value)
  if (match) {
    const wall = wallFromMatch(match)
    return wall === null ? null : { type: 'absolute', ms: wall }
  }
  match = AT_LOCAL_RE.exec(value)
  if (match) {
    const wall = wallFromMatch(match)
    return wall === null ? null : { type: 'local', ms: wall }
  }
  return null
}
function parseTime(value) {
  if (typeof value !== 'string') return null
  const match = TIME_RE.exec(value)
  if (!match) return null
  return { h: +match[1], m: +match[2], s: +match[3], ms: fracMs(match[4]) }
}

// --- Cron (5-field Vixie, numeric-only: minute hour dom month dow) -------
// Numeric-only on purpose: the Gateway's authoritative validateSpec
// (src/schedule/spec.ts parseCronExpression) accepts no JAN/MON names. Ranges
// are identical: [0,59] [0,23] [1,31] [1,12] [0,7] (0 and 7 = Sunday).
function parseCronValue(token, min, max) {
  if (!/^\d+$/.test(token)) return null
  const n = Number(token)
  return n >= min && n <= max ? n : null
}
/** Returns { set, any } for one cron field, or null when invalid. */
function expandCronField(field, min, max) {
  if (typeof field !== 'string' || field.length === 0 || field.length > EXPR_MAX) return null
  const items = field.split(',')
  if (items.length === 0 || items.length > 60) return null
  const set = new Set()
  for (const raw of items) {
    if (!raw) return null
    let base = raw
    let step = 1
    const slash = raw.indexOf('/')
    if (slash !== -1) {
      if (slash !== raw.lastIndexOf('/') || !/^\d+$/.test(raw.slice(slash + 1))) return null
      step = Number(raw.slice(slash + 1))
      if (!Number.isInteger(step) || step < 1) return null
      base = raw.slice(0, slash)
    }
    let lo, hi
    if (base === '*') { lo = min; hi = max }
    else if (base.includes('-')) {
      const parts = base.split('-')
      if (parts.length !== 2) return null
      lo = parseCronValue(parts[0], min, max)
      hi = parseCronValue(parts[1], min, max)
      if (lo === null || hi === null || lo > hi) return null
    } else {
      lo = parseCronValue(base, min, max)
      if (lo === null) return null
      hi = slash !== -1 ? max : lo
    }
    if (lo < min || hi > max) return null
    for (let value = lo; value <= hi; value += step) set.add(value)
  }
  return { set, any: field === '*' }
}
function parseCron(expression) {
  if (typeof expression !== 'string' || expression.length > EXPR_MAX) return null
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = expandCronField(parts[0], 0, 59)
  const hour = expandCronField(parts[1], 0, 23)
  const dom = expandCronField(parts[2], 1, 31)
  const month = expandCronField(parts[3], 1, 12)
  const dow = expandCronField(parts[4], 0, 7)
  if (!minute || !hour || !dom || !month || !dow) return null
  if (dow.set.has(7)) dow.set.add(0) // 7 and 0 both mean Sunday
  return { minute, hour, dom, month, dow }
}
function cronDayMatches(cron, month, dom, jsDow) {
  if (!cron.month.set.has(month)) return false
  const domOk = cron.dom.set.has(dom)
  const dowOk = cron.dow.set.has(jsDow)
  if (cron.dom.any && cron.dow.any) return true
  if (cron.dom.any) return dowOk
  if (cron.dow.any) return domOk
  return domOk || dowOk // standard Vixie OR semantics
}
function cronTimes(cron) {
  const times = []
  for (const h of [...cron.hour.set].sort((a, b) => a - b)) {
    for (const m of [...cron.minute.set].sort((a, b) => a - b)) times.push({ h, m, s: 0, ms: 0 })
  }
  return times
}

// --- validateSpec ----------------------------------------------------------
function validateSpecInternal(input, now, checkPast) {
  if (!isObject(input)) return fail('spec must be an object')
  const kind = input.kind
  if (typeof kind !== 'string' || !SPEC_KEYS[kind]) return fail('invalid schedule kind')
  for (const key of Object.keys(input)) {
    if (!SPEC_KEYS[kind].includes(key)) return fail('unsupported spec field')
  }
  switch (kind) {
    case 'once': {
      if (!validTimeZone(input.timeZone)) return fail('invalid timeZone')
      const at = parseAt(input.at)
      if (!at) return fail('invalid once at')
      const instant = at.type === 'absolute' ? at.ms : zonedTimeToUtc(at.ms, input.timeZone)
      if (!Number.isFinite(instant)) return fail('invalid once at')
      if (checkPast && instant <= now) return fail('once time must be in the future')
      return { ok: true, spec: { kind: 'once', at: input.at, timeZone: input.timeZone } }
    }
    case 'every': {
      if (!Number.isInteger(input.everySeconds) || input.everySeconds < EVERY_SECONDS_MIN ||
          input.everySeconds > 1e9) return fail('everySeconds must be an integer >= 60')
      return { ok: true, spec: { kind: 'every', everySeconds: input.everySeconds } }
    }
    case 'daily': {
      if (!validTimeZone(input.timeZone)) return fail('invalid timeZone')
      if (!parseTime(input.time)) return fail('invalid time')
      return { ok: true, spec: { kind: 'daily', time: input.time, timeZone: input.timeZone } }
    }
    case 'weekly': {
      if (!validTimeZone(input.timeZone)) return fail('invalid timeZone')
      if (!parseTime(input.time)) return fail('invalid time')
      const weekdays = input.weekdays
      if (!Array.isArray(weekdays) || weekdays.length < 1 || weekdays.length > 7 ||
          weekdays.some(x => !Number.isInteger(x) || x < 1 || x > 7) ||
          new Set(weekdays).size !== weekdays.length) return fail('invalid weekdays')
      return { ok: true, spec: { kind: 'weekly', time: input.time, timeZone: input.timeZone, weekdays: [...weekdays] } }
    }
    case 'monthly': {
      if (!validTimeZone(input.timeZone)) return fail('invalid timeZone')
      if (!parseTime(input.time)) return fail('invalid time')
      if (!Number.isInteger(input.day) || input.day < 1 || input.day > 31) return fail('invalid day')
      return { ok: true, spec: { kind: 'monthly', time: input.time, timeZone: input.timeZone, day: input.day } }
    }
    case 'cron': {
      if (!validTimeZone(input.timeZone)) return fail('invalid timeZone')
      if (typeof input.expression !== 'string' || input.expression.length > EXPR_MAX ||
          !parseCron(input.expression)) return fail('invalid cron expression')
      return { ok: true, spec: { kind: 'cron', expression: input.expression, timeZone: input.timeZone } }
    }
    default: return fail('invalid schedule kind')
  }
}
/** Full validation including "once" must be strictly in the future. */
export function validateSpec(input, now = Date.now()) {
  return validateSpecInternal(input, now, true)
}
/** Shape-only validation for sanitizing stored read-model specs (historic
 *  "once" tasks with a past `at` are legitimate and must not be dropped). */
export function validateSpecShape(input) {
  return validateSpecInternal(input, 0, false)
}

// --- previewOccurrences ----------------------------------------------------
/** First `count` strictly-future UTC ISO instants, over a bounded horizon. */
export function previewOccurrences(spec, count, fromMs = Date.now()) {
  if (!Number.isInteger(count) || count < 1 || count > PREVIEW_MAX) return []
  if (!Number.isFinite(fromMs)) return []
  const shaped = validateSpecShape(spec)
  if (!shaped.ok) return []
  const s = shaped.spec
  const horizonEnd = fromMs + HORIZON_MS
  const cap = count + 24 // margin for DST duplicates / reordered instants
  const candidates = []
  const push = ms => { if (Number.isFinite(ms) && ms > fromMs && ms <= horizonEnd) candidates.push(ms) }
  try {
    if (s.kind === 'every') {
      const step = s.everySeconds * 1000
      for (let k = 1; k <= count && fromMs + step * k <= horizonEnd; k++) push(fromMs + step * k)
    } else if (s.kind === 'once') {
      const at = parseAt(s.at)
      if (at) push(at.type === 'absolute' ? at.ms : zonedTimeToUtc(at.ms, s.timeZone))
    } else {
      if (!validTimeZone(s.timeZone)) return []
      const cron = s.kind === 'cron' ? parseCron(s.expression) : null
      let times
      if (s.kind === 'cron') times = cronTimes(cron)
      else {
        const t = parseTime(s.time)
        if (!t) return []
        times = [t]
      }
      const start = localParts(new Date(fromMs), s.timeZone)
      const dayWall = Date.UTC(+start.year, +start.month - 1, +start.day, 0, 0, 0, 0)
      for (let day = 0; day <= PREVIEW_HORIZON_DAYS && candidates.length < cap; day++) {
        const wall = dayWall + day * 86400000
        const date = new Date(wall)
        const y = date.getUTCFullYear(), mo = date.getUTCMonth() + 1, dom = date.getUTCDate()
        const jsDow = date.getUTCDay()
        const isoDow = jsDow === 0 ? 7 : jsDow
        let matches = true
        if (s.kind === 'weekly') matches = s.weekdays.includes(isoDow)
        else if (s.kind === 'monthly') matches = s.day === dom
        else if (s.kind === 'cron') matches = cronDayMatches(cron, mo, dom, jsDow)
        if (!matches) continue
        for (const t of times) {
          const candidateWall = Date.UTC(y, mo - 1, dom, t.h, t.m, t.s, t.ms)
          push(zonedTimeToUtc(candidateWall, s.timeZone))
          if (candidates.length >= cap) break
        }
      }
    }
  } catch { return [] }
  const unique = [...new Set(candidates)].sort((a, b) => a - b)
  return unique.slice(0, count).map(ms => new Date(ms).toISOString())
}

// --- specSummary -----------------------------------------------------------
/** Bounded, human-readable summary; only validated fields are used. */
export function specSummary(spec) {
  if (!isObject(spec)) return 'unknown'
  const tz = typeof spec.timeZone === 'string' ? spec.timeZone : 'UTC'
  let summary
  switch (spec.kind) {
    case 'once': summary = 'once ' + String(spec.at ?? '').slice(0, 40) + ' ' + tz; break
    case 'every': summary = 'every ' + spec.everySeconds + 's'; break
    case 'daily': summary = 'daily ' + String(spec.time ?? '') + ' ' + tz; break
    case 'weekly': summary = 'weekly ' + String(spec.time ?? '') + ' ' + tz +
      ' [' + (Array.isArray(spec.weekdays) ? spec.weekdays.join(',') : '') + ']'; break
    case 'monthly': summary = 'monthly day ' + spec.day + ' ' + String(spec.time ?? '') + ' ' + tz; break
    case 'cron': summary = 'cron ' + String(spec.expression ?? '') + ' ' + tz; break
    default: summary = 'unknown'
  }
  return summary.slice(0, 200)
}

// Exported so schedule-read.mjs can validate a stored timeZone cheaply.
export { validTimeZone }
