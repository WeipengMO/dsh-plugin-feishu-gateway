import { describe, expect, it } from 'vitest'
import {
  MAX_PREVIEW_COUNT, PREVIEW_HORIZON_DAYS,
  isValidTimeZone, nativeRecordToSpec, previewOccurrences, specSummary,
  toNativeTiming, validateSpec,
} from '../../src/schedule/spec.js'
import type { ScheduleSpec } from '../../src/schedule/spec.js'

const NOW = Date.parse('2026-01-01T00:00:00.000Z')

function valid(spec: unknown, nowMs = NOW): ScheduleSpec {
  const result = validateSpec(spec, nowMs)
  if (!result.ok) throw new Error(`expected valid spec, got: ${result.error}`)
  return result.spec
}

describe('validateSpec — canonical shape', () => {
  it('accepts all six kinds and returns a normalized copy', () => {
    expect(valid({ kind: 'once', at: '2026-06-01T00:00:00.000Z', timeZone: 'UTC' }))
      .toEqual({ kind: 'once', at: '2026-06-01T00:00:00.000Z', timeZone: 'UTC' })
    expect(valid({ kind: 'every', everySeconds: 300 }))
      .toEqual({ kind: 'every', everySeconds: 300 })
    expect(valid({ kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' }))
      .toEqual({ kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' })
    expect(valid({ kind: 'weekly', time: '09:00:00', timeZone: 'Asia/Shanghai', weekdays: [5, 1, 3, 5] }))
      .toEqual({ kind: 'weekly', time: '09:00:00', timeZone: 'Asia/Shanghai', weekdays: [1, 3, 5] })
    expect(valid({ kind: 'monthly', time: '09:30:00', timeZone: 'Asia/Shanghai', day: 15 }))
      .toEqual({ kind: 'monthly', time: '09:30:00', timeZone: 'Asia/Shanghai', day: 15 })
    expect(valid({ kind: 'cron', expression: '  */15   9-17  *  *  1-5 ', timeZone: 'UTC' }))
      .toEqual({ kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'UTC' })
  })

  it('accepts a local wall-clock once and trims strings', () => {
    expect(valid({ kind: 'once', at: ' 2026-06-01T09:00:00 ', timeZone: ' Asia/Shanghai ' }))
      .toEqual({ kind: 'once', at: '2026-06-01T09:00:00', timeZone: 'Asia/Shanghai' })
  })

  it('rejects unknown keys, wrong types and non-objects', () => {
    for (const bad of [
      null, 42, 'daily', [],
      { kind: 'daily', time: '09:00:00', timeZone: 'UTC', extra: true },
      { kind: 'every', everySeconds: 300, oops: 1 },
      { kind: 'daily', time: '09:00:00' },
      { kind: 'daily', time: 9, timeZone: 'UTC' },
      { kind: 'every', everySeconds: '300' },
      { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: '1' },
    ]) {
      expect(validateSpec(bad, NOW).ok).toBe(false)
    }
  })

  it('rejects invalid kinds', () => {
    expect(validateSpec({ kind: 'yearly' }, NOW)).toMatchObject({ ok: false })
    expect(validateSpec({}, NOW)).toMatchObject({ ok: false })
  })

  it('validates IANA zones strictly (UTC or Area/Location only)', () => {
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true)
    expect(isValidTimeZone('Etc/GMT+5')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('EST')).toBe(false)
    expect(isValidTimeZone('+08:00')).toBe(false)
    expect(validateSpec({ kind: 'daily', time: '09:00:00', timeZone: 'Not/AZone' }, NOW))
      .toEqual({ ok: false, error: 'invalid_time_zone' })
  })

  it('rejects malformed clock times, weekdays, day and interval', () => {
    expect(validateSpec({ kind: 'daily', time: '9:00', timeZone: 'UTC' }, NOW)).toMatchObject({ ok: false })
    expect(validateSpec({ kind: 'daily', time: '24:00:00', timeZone: 'UTC' }, NOW)).toMatchObject({ ok: false })
    expect(validateSpec({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [0] }, NOW))
      .toEqual({ ok: false, error: 'invalid_weekdays' })
    expect(validateSpec({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [8] }, NOW))
      .toEqual({ ok: false, error: 'invalid_weekdays' })
    expect(validateSpec({ kind: 'monthly', time: '09:00:00', timeZone: 'UTC', day: 32 }, NOW))
      .toEqual({ ok: false, error: 'invalid_day' })
    expect(validateSpec({ kind: 'every', everySeconds: 59 }, NOW))
      .toEqual({ ok: false, error: 'invalid_interval' })
    expect(validateSpec({ kind: 'every', everySeconds: 60 }, NOW).ok).toBe(true)
  })

  it('requires exactly five cron fields with valid ranges', () => {
    for (const expression of [
      '* * * *',            // 4 fields
      '* * * * * *',         // 6 fields
      '60 * * * *',          // minute out of range
      '* 24 * * *',          // hour out of range
      '* * 0 * *',           // day-of-month out of range
      '* * * 13 *',          // month out of range
      '* * * * 8',           // day-of-week out of range
      '*/0 * * * *',         // zero step
      'abc * * * *',         // non-numeric
      '5-2 * * * *',         // reversed range
    ]) {
      expect(validateSpec({ kind: 'cron', expression, timeZone: 'UTC' }, NOW))
        .toEqual({ ok: false, error: 'invalid_cron' })
    }
    for (const expression of ['* * * * *', '0 9 * * 1-5', '*/15 9-17 * * 1-5', '0 0 1 1 *', '0,30 8 * * 7']) {
      expect(validateSpec({ kind: 'cron', expression, timeZone: 'UTC' }, NOW).ok).toBe(true)
    }
  })

  it('rejects past-only once instants', () => {
    expect(validateSpec({ kind: 'once', at: '2020-01-01T00:00:00.000Z', timeZone: 'UTC' }, NOW))
      .toEqual({ ok: false, error: 'not_future' })
    expect(validateSpec({ kind: 'once', at: '2020-01-01T09:00:00', timeZone: 'Asia/Shanghai' }, NOW))
      .toEqual({ ok: false, error: 'not_future' })
    expect(validateSpec({ kind: 'once', at: 'not-a-date', timeZone: 'UTC' }, NOW))
      .toEqual({ ok: false, error: 'invalid_at' })
  })
})

describe('toNativeTiming — exact snake_case shapes', () => {
  it('maps all six kinds', () => {
    expect(toNativeTiming({ kind: 'once', at: '2026-06-01T00:00:00.000Z', timeZone: 'UTC' }))
      .toEqual({ kind: 'at', at: '2026-06-01T00:00:00.000Z' })
    expect(toNativeTiming({ kind: 'once', at: '2026-06-01T09:00:00', timeZone: 'Asia/Shanghai' }))
      .toEqual({ kind: 'at', at: { date: '2026-06-01', time: '09:00:00', time_zone: 'Asia/Shanghai' } })
    expect(toNativeTiming({ kind: 'every', everySeconds: 300 }))
      .toEqual({ kind: 'every', every_seconds: 300 })
    expect(toNativeTiming({ kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' }))
      .toEqual({ kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } })
    expect(toNativeTiming({ kind: 'weekly', time: '09:00:00', timeZone: 'Asia/Shanghai', weekdays: [1, 3, 5] }))
      .toEqual({ kind: 'weekly', weekly: { time: '09:00:00', time_zone: 'Asia/Shanghai', weekdays: [1, 3, 5] } })
    expect(toNativeTiming({ kind: 'monthly', time: '09:30:00', timeZone: 'Asia/Shanghai', day: 15 }))
      .toEqual({ kind: 'cron', cron: { expression: '30 9 15 * *', time_zone: 'Asia/Shanghai' } })
    expect(toNativeTiming({ kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'UTC' }))
      .toEqual({ kind: 'cron', cron: { expression: '*/15 9-17 * * 1-5', time_zone: 'UTC' } })
  })
})

describe('previewOccurrences — DST-safe, bounded, day-by-day', () => {
  it('daily 09:00 Asia/Shanghai -> 01:00Z', () => {
    const spec: ScheduleSpec = { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' }
    expect(previewOccurrences(spec, 3, NOW)).toEqual([
      '2026-01-01T01:00:00.000Z',
      '2026-01-02T01:00:00.000Z',
      '2026-01-03T01:00:00.000Z',
    ])
  })

  it('probes the real DST offset (America/New_York spring forward)', () => {
    const spec: ScheduleSpec = { kind: 'daily', time: '09:00:00', timeZone: 'America/New_York' }
    const occurrences = previewOccurrences(spec, 10, Date.parse('2026-03-01T12:00:00.000Z'))
    expect(occurrences).toHaveLength(10)
    // EST (UTC-5) => 14:00Z before the transition; EDT (UTC-4) => 13:00Z after.
    // A fixed numeric offset could never produce both.
    expect(occurrences.some((o) => o.endsWith('T14:00:00.000Z'))).toBe(true)
    expect(occurrences.some((o) => o.endsWith('T13:00:00.000Z'))).toBe(true)
    expect(occurrences.every((o, i, all) => i === 0 || all[i - 1]! < o)).toBe(true)
  })

  it('generates weekly occurrences only on selected ISO weekdays', () => {
    const spec: ScheduleSpec = { kind: 'weekly', time: '09:00:00', timeZone: 'Asia/Shanghai', weekdays: [1, 3] }
    const occurrences = previewOccurrences(spec, 3, NOW)
    expect(occurrences).toHaveLength(3)
    for (const iso of occurrences) {
      expect(iso.endsWith('T01:00:00.000Z')).toBe(true)
      const dow = new Date(iso).getUTCDay()
      expect(dow === 1 || dow === 3).toBe(true)
    }
  })

  it('generates monthly occurrences and skips months without that day', () => {
    const spec: ScheduleSpec = { kind: 'monthly', time: '09:00:00', timeZone: 'Asia/Shanghai', day: 31 }
    const occurrences = previewOccurrences(spec, 4, Date.parse('2026-01-01T00:00:00.000Z'))
    // Jan 31, Mar 31, May 31, Jul 31 (February/April/June have no 31st).
    expect(occurrences).toEqual([
      '2026-01-31T01:00:00.000Z',
      '2026-03-31T01:00:00.000Z',
      '2026-05-31T01:00:00.000Z',
      '2026-07-31T01:00:00.000Z',
    ])
  })

  it('expands cron minute/hour sets per day', () => {
    const spec: ScheduleSpec = { kind: 'cron', expression: '*/15 9 * * *', timeZone: 'UTC' }
    expect(previewOccurrences(spec, 4, NOW)).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-01T09:15:00.000Z',
      '2026-01-01T09:30:00.000Z',
      '2026-01-01T09:45:00.000Z',
    ])
  })

  it('honours cron day-of-week semantics', () => {
    const spec: ScheduleSpec = { kind: 'cron', expression: '0 9 * * 1', timeZone: 'UTC' }
    const occurrences = previewOccurrences(spec, 3, NOW)
    expect(occurrences).toHaveLength(3)
    for (const iso of occurrences) {
      expect(iso.endsWith('T09:00:00.000Z')).toBe(true)
      expect(new Date(iso).getUTCDay()).toBe(1) // Monday
    }
  })

  it('previews once (absolute) and every', () => {
    expect(previewOccurrences({ kind: 'once', at: '2026-06-01T00:00:00.000Z', timeZone: 'UTC' }, 3, NOW))
      .toEqual(['2026-06-01T00:00:00.000Z'])
    expect(previewOccurrences({ kind: 'every', everySeconds: 300 }, 3, NOW))
      .toEqual([
        '2026-01-01T00:05:00.000Z',
        '2026-01-01T00:10:00.000Z',
        '2026-01-01T00:15:00.000Z',
      ])
  })

  it('clamps count to 1..10 and bounds the horizon', () => {
    const spec: ScheduleSpec = { kind: 'daily', time: '09:00:00', timeZone: 'UTC' }
    expect(previewOccurrences(spec, 999, NOW)).toHaveLength(MAX_PREVIEW_COUNT)
    expect(previewOccurrences(spec, 0, NOW)).toHaveLength(1)
    expect(PREVIEW_HORIZON_DAYS).toBeLessThanOrEqual(366)
    const far = previewOccurrences(spec, 10, Date.now() + 400 * 86400000)
    expect(far).toHaveLength(10) // still bounded, never an unbounded loop
  })
})

describe('nativeRecordToSpec — round trips and rejections', () => {
  const base = {
    id: 'schedule-abc', title: 't', prompt: 'p',
    scheduledAt: '2026-06-01T01:00:00.000Z', status: 'active',
    target: { kind: 'session', sessionId: 'sess-1' },
  }

  it('maps every supported record kind back to a canonical spec', () => {
    expect(nativeRecordToSpec({ ...base, kind: 'at' }))
      .toEqual({ kind: 'once', at: '2026-06-01T01:00:00.000Z', timeZone: 'UTC' })
    expect(nativeRecordToSpec({ ...base, kind: 'after', afterSeconds: 600 }))
      .toEqual({ kind: 'once', at: '2026-06-01T01:00:00.000Z', timeZone: 'UTC' })
    expect(nativeRecordToSpec({ ...base, kind: 'every', everySeconds: 300 }))
      .toEqual({ kind: 'every', everySeconds: 300 })
    expect(nativeRecordToSpec({ ...base, kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' }))
      .toEqual({ kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' })
    expect(nativeRecordToSpec({ ...base, kind: 'weekly', time: '09:00:00', timeZone: 'Asia/Shanghai', weekdays: [3, 1, 3] }))
      .toEqual({ kind: 'weekly', time: '09:00:00', timeZone: 'Asia/Shanghai', weekdays: [1, 3] })
    expect(nativeRecordToSpec({ ...base, kind: 'cron', expression: '30 9 15 * *', timeZone: 'Asia/Shanghai' }))
      .toEqual({ kind: 'monthly', time: '09:30:00', timeZone: 'Asia/Shanghai', day: 15 })
    expect(nativeRecordToSpec({ ...base, kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'UTC' }))
      .toEqual({ kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'UTC' })
  })

  it('round trips through toNativeTiming / validateSpec', () => {
    const record = { ...base, kind: 'cron', expression: '0 9 15 * *', timeZone: 'Asia/Shanghai' }
    const spec = nativeRecordToSpec(record)
    expect(spec).toBeDefined()
    expect(validateSpec(spec, NOW).ok).toBe(true)
    expect(toNativeTiming(spec!)).toEqual({
      kind: 'cron', cron: { expression: '0 9 15 * *', time_zone: 'Asia/Shanghai' },
    })
  })

  it('returns undefined for unsupported / malformed shapes', () => {
    for (const bad of [
      undefined, null, 7, {},
      { ...base, kind: 'rrule', rrule: 'DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY' },
      { ...base, kind: 'daily', time: '09:00:00' },               // no zone
      { ...base, kind: 'daily', time: '09:00:00', timeZone: 'Not/AZone' },
      { ...base, kind: 'cron', expression: '60 * * * *', timeZone: 'UTC' },
      { ...base, kind: 'every', everySeconds: 5 },
      { ...base, kind: 'at', scheduledAt: 'not-a-date' },
    ]) {
      expect(nativeRecordToSpec(bad)).toBeUndefined()
    }
  })
})

describe('specSummary — bounded, no prompt text', () => {
  it('summarizes every kind without leaking prompt text', () => {
    const specs: ScheduleSpec[] = [
      { kind: 'once', at: '2026-06-01T00:00:00.000Z', timeZone: 'UTC' },
      { kind: 'every', everySeconds: 300 },
      { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' },
      { kind: 'weekly', time: '09:00:00', timeZone: 'Asia/Shanghai', weekdays: [1, 3, 5] },
      { kind: 'monthly', time: '09:00:00', timeZone: 'Asia/Shanghai', day: 15 },
      { kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'UTC' },
    ]
    for (const spec of specs) {
      const summary = specSummary(spec)
      expect(summary.length).toBeLessThanOrEqual(200)
      expect(summary).not.toContain('SECRET_PROMPT')
    }
    expect(specSummary({ kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' }))
      .toBe('daily 09:00:00 Asia/Shanghai')
    expect(specSummary({ kind: 'weekly', time: '09:00:00', timeZone: 'Asia/Shanghai', weekdays: [1, 3, 5] }))
      .toBe('weekly Mon,Wed,Fri 09:00:00 Asia/Shanghai')
  })
})
