/**
 * Canonical schedule specification, validation, native timing conversion and
 * DST-safe occurrence preview.
 *
 * This module is intentionally pure: it imports no DSH runtime, no network and
 * no other plugin module. `web-admin/src/schedule-spec.mjs` mirrors the same
 * rules in plain JavaScript; both sides must reject the same inputs.
 *
 * See docs/SCHEDULE-API-CONTRACT.md §1 for the authoritative shape.
 */
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Public constants (shared with the manager and the Web Admin mirror)
// ---------------------------------------------------------------------------

export const MAX_TITLE_LENGTH = 120
export const MAX_PROMPT_LENGTH = 4000
export const MIN_EVERY_SECONDS = 60
export const MIN_WEEKDAY = 1
export const MAX_WEEKDAY = 7
export const MIN_MONTH_DAY = 1
export const MAX_MONTH_DAY = 31
export const MIN_PREVIEW_COUNT = 1
export const MAX_PREVIEW_COUNT = 10
/** Upper bound of the preview search horizon, in days. */
export const PREVIEW_HORIZON_DAYS = 366
export const MAX_ACTOR_LENGTH = 64
export const MAX_SUMMARY_LENGTH = 200

// ---------------------------------------------------------------------------
// Canonical spec
// ---------------------------------------------------------------------------

export type ScheduleSpec =
  | { readonly kind: 'once'; readonly at: string; readonly timeZone: string }
  | { readonly kind: 'every'; readonly everySeconds: number }
  | { readonly kind: 'daily'; readonly time: string; readonly timeZone: string }
  | { readonly kind: 'weekly'; readonly time: string; readonly timeZone: string; readonly weekdays: number[] }
  | { readonly kind: 'monthly'; readonly time: string; readonly timeZone: string; readonly day: number }
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string }

export type SpecValidationResult =
  | { readonly ok: true; readonly spec: ScheduleSpec }
  | { readonly ok: false; readonly error: string }

/** Native `ScheduleTiming` shape (exact snake_case fields from the installed .d.ts). */
export type NativeTiming =
  | { readonly kind: 'after'; readonly after_seconds: number }
  | { readonly kind: 'at'; readonly at: string | { readonly date: string; readonly time: string; readonly time_zone: string } }
  | { readonly kind: 'every'; readonly every_seconds: number }
  | { readonly kind: 'daily'; readonly daily: { readonly time: string; readonly time_zone: string } }
  | { readonly kind: 'weekly'; readonly weekly: { readonly time: string; readonly time_zone: string; readonly weekdays: number[] } }
  | { readonly kind: 'cron'; readonly cron: { readonly expression: string; readonly time_zone: string } }
  | { readonly kind: 'rrule'; readonly rrule: string }

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require exactly the named keys: every expected key present, no extras. */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const present = Object.keys(value)
  if (present.length !== expected.length) return false
  const set = new Set(expected)
  return present.every((key) => set.has(key))
}

function ok(spec: ScheduleSpec): SpecValidationResult {
  return { ok: true, spec }
}
function err(error: string): SpecValidationResult {
  return { ok: false, error }
}

/** Trim a bounded, non-empty text field. Returns undefined when invalid. */
export function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > max) return undefined
  return trimmed
}

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function boundedNumber(value: unknown, min: number, max: number, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback
}

/** SHA-256 prefix correlation handle; never an authorization token. */
export function sessionRef(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Time zone validation (explicit `UTC` or an IANA Area/Location name)
// ---------------------------------------------------------------------------

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z][A-Za-z0-9_+.-]*)+$/

export function isValidTimeZone(value: string): boolean {
  if (value === 'UTC') return true
  if (!ZONE_NAME.test(value)) return false
  try {
    // Constructing the formatter throws RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// DST-safe local wall-clock -> UTC conversion via Intl offset probing
// ---------------------------------------------------------------------------

interface WallParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone)
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timeZone, cached)
  }
  return cached
}

function partsToObject(parts: Intl.DateTimeFormatPart[]): WallParts {
  const out: Record<string, number> = {}
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  }
}

/** Wall-clock parts (local to `timeZone`) of one UTC instant. */
function wallParts(utcMs: number, timeZone: string): WallParts {
  return partsToObject(formatter(timeZone).formatToParts(new Date(utcMs)))
}

/**
 * The zone's offset (local wall clock minus UTC) at a candidate instant, in ms.
 * Derived with Intl probing, never a fixed numeric offset.
 */
function zoneOffset(utcGuessMs: number, timeZone: string): number {
  const p = wallParts(utcGuessMs, timeZone)
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const guessSeconds = Math.floor(utcGuessMs / 1000) * 1000
  return wallAsUtc - guessSeconds
}

/**
 * Convert an explicit local wall-clock time in `timeZone` to a UTC epoch ms.
 * Two offset probes converge across DST transitions; overlaps resolve to the
 * earlier instant (matching the native Host's "overlaps use the earlier instant").
 */
function localWallToUtc(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number, ms: number,
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const off1 = zoneOffset(wallAsUtc, timeZone)
  let utc = wallAsUtc - off1
  const off2 = zoneOffset(utc, timeZone)
  if (off2 !== off1) utc = wallAsUtc - off2
  return utc
}

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

interface TimeParts { hour: number; minute: number; second: number; ms: number }

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/

/** Validate a local `HH:mm:ss[.SSS]` clock time; keep the trimmed spelling. */
function normalizeTime(value: string): string | undefined {
  return TIME_RE.test(value) ? value : undefined
}

function parseTime(value: string): TimeParts | undefined {
  const m = TIME_RE.exec(value)
  if (!m) return undefined
  return {
    hour: Number(m[1]),
    minute: Number(m[2]),
    second: Number(m[3]),
    ms: m[4] ? Number(m[4].padEnd(3, '0')) : 0,
  }
}

const LOCAL_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
const ABSOLUTE_AT_RE = /(?:Z|[+-]\d{2}:\d{2})$/i

type AtClassification = 'absolute' | 'local' | undefined

function classifyAt(value: string): AtClassification {
  if (ABSOLUTE_AT_RE.test(value)) {
    return Number.isFinite(Date.parse(value)) ? 'absolute' : undefined
  }
  return LOCAL_AT_RE.test(value) ? 'local' : undefined
}

/** Resolve a local `YYYY-MM-DDTHH:mm:ss[.SSS]` wall clock to UTC epoch ms. */
function localAtToUtc(value: string, timeZone: string): number {
  const m = LOCAL_AT_RE.exec(value)
  if (!m) return Number.NaN
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6])
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  if (month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) return Number.NaN
  return localWallToUtc(year, month, day, hour, minute, second, ms, timeZone)
}

function absoluteAtToUtc(value: string): number {
  return Date.parse(value)
}

// ---------------------------------------------------------------------------
// Cron parsing (exactly 5 Vixie fields, each within its valid range)
// ---------------------------------------------------------------------------

interface CronField { values: number[]; wildcard: boolean }

interface CronParsed {
  minute: CronField
  hour: CronField
  dom: CronField
  month: CronField
  dow: CronField
}

const CRON_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 7],   // day of week (0 and 7 are Sunday)
]

/** Expand one comma-separated cron field into a sorted unique value set. */
function expandField(raw: string, min: number, max: number): number[] | undefined {
  const values = new Set<number>()
  const parts = raw.split(',')
  if (parts.length === 0) return undefined
  for (const part of parts) {
    const segments = part.split('/')
    if (segments.length > 2 || segments[0] === undefined) return undefined
    const rangePart = segments[0]
    let step = 1
    if (segments.length === 2) {
      const stepPart = segments[1]
      if (stepPart === undefined || !/^\d+$/.test(stepPart)) return undefined
      step = Number(stepPart)
      if (step < 1) return undefined
    }
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (/^\d+$/.test(rangePart)) {
      lo = Number(rangePart)
      // `n/step` means "from n to max, stepping".
      hi = segments.length === 2 ? max : lo
    } else {
      const range = /^(\d+)-(\d+)$/.exec(rangePart)
      if (!range) return undefined
      lo = Number(range[1])
      hi = Number(range[2])
    }
    if (lo < min || hi > max || lo > hi) return undefined
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  if (values.size === 0) return undefined
  return [...values].sort((a, b) => a - b)
}

function cronField(raw: string, min: number, max: number): CronField | undefined {
  const values = expandField(raw, min, max)
  if (!values) return undefined
  return { values, wildcard: raw === '*' }
}

function parseCronExpression(expression: string): CronParsed | undefined {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const parsed = fields.map((field, i) => {
    const range = CRON_RANGES[i]
    return range ? cronField(field, range[0], range[1]) : undefined
  })
  if (parsed.some((field) => field === undefined)) return undefined
  return {
    minute: parsed[0] as CronField,
    hour: parsed[1] as CronField,
    dom: parsed[2] as CronField,
    month: parsed[3] as CronField,
    dow: parsed[4] as CronField,
  }
}

// ---------------------------------------------------------------------------
// validateSpec
// ---------------------------------------------------------------------------

function normalizeWeekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const set = new Set<number>()
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) ||
        item < MIN_WEEKDAY || item > MAX_WEEKDAY) return undefined
    set.add(item)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * Authoritatively validate an untrusted spec and return a normalized copy or a
 * stable error string (never the raw input). `nowMs` is the exclusive lower
 * bound for a one-shot instant; it defaults to the current wall clock.
 */
export function validateSpec(spec: unknown, nowMs: number = Date.now()): SpecValidationResult {
  if (!isRecord(spec)) return err('invalid_spec')
  const kind = spec.kind
  if (typeof kind !== 'string') return err('invalid_kind')

  switch (kind) {
    case 'once': {
      if (!hasExactKeys(spec, ['kind', 'at', 'timeZone'])) return err('unknown_key')
      if (typeof spec.at !== 'string' || typeof spec.timeZone !== 'string') return err('invalid_field')
      const at = spec.at.trim()
      const timeZone = spec.timeZone.trim()
      if (!isValidTimeZone(timeZone)) return err('invalid_time_zone')
      const classification = classifyAt(at)
      if (!classification) return err('invalid_at')
      const instant = classification === 'absolute' ? absoluteAtToUtc(at) : localAtToUtc(at, timeZone)
      if (!Number.isFinite(instant)) return err('invalid_at')
      if (instant <= nowMs) return err('not_future')
      const normalizedAt = classification === 'absolute' ? new Date(instant).toISOString() : at
      return ok({ kind: 'once', at: normalizedAt, timeZone })
    }
    case 'every': {
      if (!hasExactKeys(spec, ['kind', 'everySeconds'])) return err('unknown_key')
      const v = spec.everySeconds
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < MIN_EVERY_SECONDS) return err('invalid_interval')
      return ok({ kind: 'every', everySeconds: v })
    }
    case 'daily': {
      if (!hasExactKeys(spec, ['kind', 'time', 'timeZone'])) return err('unknown_key')
      if (typeof spec.time !== 'string' || typeof spec.timeZone !== 'string') return err('invalid_field')
      const time = spec.time.trim()
      const timeZone = spec.timeZone.trim()
      if (!normalizeTime(time)) return err('invalid_time')
      if (!isValidTimeZone(timeZone)) return err('invalid_time_zone')
      return ok({ kind: 'daily', time, timeZone })
    }
    case 'weekly': {
      if (!hasExactKeys(spec, ['kind', 'time', 'timeZone', 'weekdays'])) return err('unknown_key')
      if (typeof spec.time !== 'string' || typeof spec.timeZone !== 'string') return err('invalid_field')
      const time = spec.time.trim()
      const timeZone = spec.timeZone.trim()
      if (!normalizeTime(time)) return err('invalid_time')
      if (!isValidTimeZone(timeZone)) return err('invalid_time_zone')
      const weekdays = normalizeWeekdays(spec.weekdays)
      if (!weekdays) return err('invalid_weekdays')
      return ok({ kind: 'weekly', time, timeZone, weekdays })
    }
    case 'monthly': {
      if (!hasExactKeys(spec, ['kind', 'time', 'timeZone', 'day'])) return err('unknown_key')
      if (typeof spec.time !== 'string' || typeof spec.timeZone !== 'string') return err('invalid_field')
      const time = spec.time.trim()
      const timeZone = spec.timeZone.trim()
      if (!normalizeTime(time)) return err('invalid_time')
      if (!isValidTimeZone(timeZone)) return err('invalid_time_zone')
      const day = spec.day
      if (typeof day !== 'number' || !Number.isInteger(day) ||
          day < MIN_MONTH_DAY || day > MAX_MONTH_DAY) return err('invalid_day')
      return ok({ kind: 'monthly', time, timeZone, day })
    }
    case 'cron': {
      if (!hasExactKeys(spec, ['kind', 'expression', 'timeZone'])) return err('unknown_key')
      if (typeof spec.expression !== 'string' || typeof spec.timeZone !== 'string') return err('invalid_field')
      const expression = spec.expression.trim()
      const timeZone = spec.timeZone.trim()
      if (!isValidTimeZone(timeZone)) return err('invalid_time_zone')
      if (!parseCronExpression(expression)) return err('invalid_cron')
      return ok({ kind: 'cron', expression: expression.split(/\s+/).join(' '), timeZone })
    }
    default:
      return err('invalid_kind')
  }
}

// ---------------------------------------------------------------------------
// toNativeTiming
// ---------------------------------------------------------------------------

/** Build the native `ScheduleTiming` for one (already validated) canonical spec. */
export function toNativeTiming(spec: ScheduleSpec): NativeTiming {
  switch (spec.kind) {
    case 'once': {
      const classification = classifyAt(spec.at) ?? 'local'
      if (classification === 'absolute') {
        const parsed = absoluteAtToUtc(spec.at)
        return { kind: 'at', at: Number.isFinite(parsed) ? new Date(parsed).toISOString() : spec.at }
      }
      return {
        kind: 'at',
        at: {
          date: spec.at.slice(0, 10),
          time: spec.at.slice(11),
          time_zone: spec.timeZone,
        },
      }
    }
    case 'every':
      return { kind: 'every', every_seconds: spec.everySeconds }
    case 'daily':
      return { kind: 'daily', daily: { time: spec.time, time_zone: spec.timeZone } }
    case 'weekly':
      return { kind: 'weekly', weekly: { time: spec.time, time_zone: spec.timeZone, weekdays: spec.weekdays } }
    case 'monthly': {
      const parts = parseTime(spec.time)
      const minute = parts?.minute ?? 0
      const hour = parts?.hour ?? 0
      return {
        kind: 'cron',
        cron: { expression: `${minute} ${hour} ${spec.day} * *`, time_zone: spec.timeZone },
      }
    }
    case 'cron':
      return { kind: 'cron', cron: { expression: spec.expression, time_zone: spec.timeZone } }
  }
}

// ---------------------------------------------------------------------------
// previewOccurrences
// ---------------------------------------------------------------------------

function clampCount(count: number): number {
  if (!Number.isFinite(count)) return MIN_PREVIEW_COUNT
  return Math.min(MAX_PREVIEW_COUNT, Math.max(MIN_PREVIEW_COUNT, Math.trunc(count)))
}

interface WallSlot { hour: number; minute: number; second: number; ms: number }

function timeSlot(time: string): WallSlot {
  const parts = parseTime(time)
  return {
    hour: parts?.hour ?? 0,
    minute: parts?.minute ?? 0,
    second: parts?.second ?? 0,
    ms: parts?.ms ?? 0,
  }
}

/** Wall-clock slots on one local calendar date for a calendar-based spec. */
function slotsForDate(
  spec: ScheduleSpec,
  year: number, month: number, day: number,
): WallSlot[] {
  const isoWeekday = (() => {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    return dow === 0 ? 7 : dow
  })()
  switch (spec.kind) {
    case 'daily':
      return [timeSlot(spec.time)]
    case 'weekly':
      return spec.weekdays.includes(isoWeekday) ? [timeSlot(spec.time)] : []
    case 'monthly':
      return day === spec.day ? [timeSlot(spec.time)] : []
    case 'cron': {
      const parsed = parseCronExpression(spec.expression)
      if (!parsed) return []
      const jsDow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
      const domMatch = parsed.dom.wildcard ? true : parsed.dom.values.includes(day)
      const dowMatch = parsed.dow.wildcard ? true
        : parsed.dow.values.includes(jsDow) || (jsDow === 0 && parsed.dow.values.includes(7))
      const dayMatch = (!parsed.dom.wildcard && !parsed.dow.wildcard)
        ? (domMatch || dowMatch)
        : (domMatch && dowMatch)
      if (!parsed.month.values.includes(month) || !dayMatch) return []
      const slots: WallSlot[] = []
      for (const hour of parsed.hour.values) {
        for (const minute of parsed.minute.values) {
          slots.push({ hour, minute, second: 0, ms: 0 })
        }
      }
      return slots
    }
    default:
      return []
  }
}

function previewOnce(spec: Extract<ScheduleSpec, { kind: 'once' }>, count: number, fromMs: number, horizonMs: number): string[] {
  const classification = classifyAt(spec.at) ?? 'local'
  const instant = classification === 'absolute'
    ? absoluteAtToUtc(spec.at)
    : localAtToUtc(spec.at, spec.timeZone)
  if (!Number.isFinite(instant) || instant <= fromMs || instant > horizonMs) return []
  return [new Date(instant).toISOString()].slice(0, count)
}

function previewEvery(spec: Extract<ScheduleSpec, { kind: 'every' }>, count: number, fromMs: number, horizonMs: number): string[] {
  const out: string[] = []
  const interval = spec.everySeconds * 1000
  for (let k = 1; k <= count; k += 1) {
    const instant = fromMs + k * interval
    if (instant > horizonMs) break
    out.push(new Date(instant).toISOString())
  }
  return out
}

function previewCalendar(spec: ScheduleSpec, count: number, fromMs: number, horizonMs: number): string[] {
  if (!('timeZone' in spec)) return []
  const timeZone = spec.timeZone
  let start: WallParts
  try {
    start = wallParts(fromMs, timeZone)
  } catch {
    return []
  }
  const cursor = Date.UTC(start.year, start.month - 1, start.day)
  const results: number[] = []
  for (let offset = 0; offset <= PREVIEW_HORIZON_DAYS && results.length < count; offset += 1) {
    const date = new Date(cursor + offset * 86400000)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    for (const slot of slotsForDate(spec, year, month, day)) {
      const instant = localWallToUtc(year, month, day, slot.hour, slot.minute, slot.second, slot.ms, timeZone)
      if (instant > fromMs && instant <= horizonMs) {
        results.push(instant)
        if (results.length >= count) break
      }
    }
  }
  results.sort((a, b) => a - b)
  return results.slice(0, count).map((ms) => new Date(ms).toISOString())
}

/**
 * Return the first `count` strictly-future UTC ISO instants, generated
 * day-by-day over a bounded <= 366 day horizon with DST-safe Intl offset
 * probing. Never uses a fixed numeric offset. Bad input yields an empty list.
 */
export function previewOccurrences(spec: ScheduleSpec, count: number, fromMs: number): string[] {
  const n = clampCount(count)
  if (!Number.isFinite(fromMs)) return []
  const horizonMs = fromMs + PREVIEW_HORIZON_DAYS * 86400000
  try {
    switch (spec.kind) {
      case 'once':
        return previewOnce(spec, n, fromMs, horizonMs)
      case 'every':
        return previewEvery(spec, n, fromMs, horizonMs)
      default:
        return previewCalendar(spec, n, fromMs, horizonMs)
    }
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// nativeRecordToSpec
// ---------------------------------------------------------------------------

const MONTHLY_CRON_RE = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/

/**
 * Map a native ScheduleRecord / catalog entry back to a canonical spec for the
 * edit form. Returns undefined for unsupported shapes (rrule, malformed fields,
 * invalid zones/cron). Never re-validates against "now" (a stored one-shot may
 * already have fired).
 */
export function nativeRecordToSpec(record: unknown): ScheduleSpec | undefined {
  if (!isRecord(record)) return undefined
  const kind = record.kind
  if (typeof kind !== 'string') return undefined
  const timeZone = typeof record.timeZone === 'string' ? record.timeZone : undefined

  switch (kind) {
    case 'at':
    case 'after': {
      const scheduledAt = record.scheduledAt
      if (typeof scheduledAt !== 'string') return undefined
      const parsed = Date.parse(scheduledAt)
      if (!Number.isFinite(parsed)) return undefined
      return { kind: 'once', at: new Date(parsed).toISOString(), timeZone: 'UTC' }
    }
    case 'every': {
      const everySeconds = record.everySeconds
      if (typeof everySeconds !== 'number' || !Number.isSafeInteger(everySeconds) ||
          everySeconds < MIN_EVERY_SECONDS) return undefined
      return { kind: 'every', everySeconds }
    }
    case 'daily': {
      const time = record.time
      if (typeof time !== 'string' || !normalizeTime(time) || !timeZone || !isValidTimeZone(timeZone)) return undefined
      return { kind: 'daily', time, timeZone }
    }
    case 'weekly': {
      const time = record.time
      const weekdays = normalizeWeekdays(record.weekdays)
      if (typeof time !== 'string' || !normalizeTime(time) || !weekdays ||
          !timeZone || !isValidTimeZone(timeZone)) return undefined
      return { kind: 'weekly', time, timeZone, weekdays }
    }
    case 'cron': {
      const expression = record.expression
      if (typeof expression !== 'string' || !timeZone || !isValidTimeZone(timeZone)) return undefined
      const canonical = expression.trim().split(/\s+/).join(' ')
      if (!parseCronExpression(canonical)) return undefined
      const monthly = MONTHLY_CRON_RE.exec(canonical)
      if (monthly) {
        const minute = Number(monthly[1])
        const hour = Number(monthly[2])
        const day = Number(monthly[3])
        if (minute >= 0 && minute <= 59 && hour >= 0 && hour <= 23 &&
            day >= MIN_MONTH_DAY && day <= MAX_MONTH_DAY) {
          const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`
          return { kind: 'monthly', time, timeZone, day }
        }
      }
      return { kind: 'cron', expression: canonical, timeZone }
    }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// specSummary
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** Short, bounded audit summary. Never includes prompt text. */
export function specSummary(spec: ScheduleSpec): string {
  let summary: string
  switch (spec.kind) {
    case 'once':
      summary = `once ${spec.at} ${spec.timeZone}`
      break
    case 'every':
      summary = `every ${spec.everySeconds}s`
      break
    case 'daily':
      summary = `daily ${spec.time} ${spec.timeZone}`
      break
    case 'weekly':
      summary = `weekly ${spec.weekdays.map((d) => WEEKDAY_LABELS[d - 1] ?? String(d)).join(',')} ${spec.time} ${spec.timeZone}`
      break
    case 'monthly':
      summary = `monthly day ${spec.day} ${spec.time} ${spec.timeZone}`
      break
    case 'cron':
      summary = `cron ${spec.expression} ${spec.timeZone}`
      break
  }
  return summary.slice(0, MAX_SUMMARY_LENGTH)
}
