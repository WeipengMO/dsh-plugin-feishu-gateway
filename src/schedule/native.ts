/**
 * Structural adapter over DSH's native `ctx.get('schedule')` Host service.
 *
 * The real service is remote/typed; this wrapper normalizes its results into
 * small, browser-safe DTOs and converts every rejection into a bounded
 * `ScheduleNativeError`. No raw exception text, session ids or prompts from a
 * thrown Error ever escape to the manager or the read model.
 *
 * Derived from the installed `@deepseek-ai/dsh-schedule@0.2.2-rc.1` types:
 * `ScheduleCatalogEntry`, `ScheduleListResult`, `ScheduleViewResult`,
 * `ScheduleDeliveryHistoryResult`, `ScheduleEditResult`, `ScheduleRunResult`,
 * `ScheduleDeleteInactiveResult`, `ScheduleService.deliveryLimits()`.
 * See docs/SCHEDULE-API-CONTRACT.md §3.
 */
import type { CordisLike } from '../types.js'
import type { NativeTiming } from './spec.js'

// ---------------------------------------------------------------------------
// Normalized DTOs consumed by the manager
// ---------------------------------------------------------------------------

export interface NativeDelivery {
  readonly scheduledAt: string
  readonly deliveredAt: string
  readonly messageId: string
  readonly targetSessionId: string
  /** Present on native delivery-history records; never published in the read model. */
  readonly prompt?: string
}

export interface NativeTarget {
  readonly kind: 'session' | 'new_once' | 'new'
  readonly sessionId?: string
  readonly create?: { readonly cwd?: string; readonly agentPreset?: string }
}

export interface NativeTask {
  readonly id: string
  readonly kind: 'at' | 'after' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule'
  readonly title: string
  readonly prompt: string
  readonly scheduledAt: string
  readonly afterSeconds?: number
  readonly everySeconds?: number
  readonly time?: string
  readonly timeZone?: string
  readonly weekdays?: number[]
  readonly expression?: string
  readonly rrule?: string
  readonly target: NativeTarget
  readonly status: 'active' | 'paused' | 'ended'
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly executionActive?: boolean
  readonly deliveryFloorEndsAt?: string
  readonly lastDelivery?: NativeDelivery
}

export interface NativeList {
  readonly items: readonly NativeTask[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

export interface NativeHistory {
  readonly records: readonly NativeDelivery[]
  readonly earlierRecordsUnavailable: boolean
  readonly earlierRecordsPruned: boolean
}

export interface NativeCodeResult {
  readonly code: 'schedule_not_found' | 'delivery_cursor_not_found' | 'schedule_conflict' | 'schedule_execution_pending'
  readonly id: string
}

export interface NativeDeleted {
  readonly id: string
  readonly deleted: true
}

export type ScheduleNativeErrorKind =
  | 'input_invalid'
  | 'not_found'
  | 'conflict'
  | 'execution_pending'
  | 'native_error'

/** Bounded, stable error. `message` is fixed; `code` is from an allowlist. */
export class ScheduleNativeError extends Error {
  readonly kind: ScheduleNativeErrorKind
  readonly code: string
  constructor(kind: ScheduleNativeErrorKind, code: string) {
    super('native schedule service error')
    this.name = 'ScheduleNativeError'
    this.kind = kind
    this.code = code
  }
}

export function isScheduleNativeError(value: unknown): value is ScheduleNativeError {
  return value instanceof ScheduleNativeError
}

export type NativeListResult = NativeList | ScheduleNativeError
export type NativeViewResult = NativeTask | NativeCodeResult | ScheduleNativeError
export type NativeHistoryResult = NativeHistory | NativeCodeResult | ScheduleNativeError
export type NativeCreateResult = NativeTask | ScheduleNativeError
export type NativeEditResult = NativeTask | NativeDeleted | NativeCodeResult | ScheduleNativeError
export type NativeRunResult = NativeTask | NativeCodeResult | ScheduleNativeError
export type NativeDeleteInactiveResult = { readonly deleted: number } | ScheduleNativeError
export type NativeDeliveryLimits = { readonly newSessionIntervalSeconds: number } | ScheduleNativeError

export interface NativeCreateRequest {
  readonly title: string
  readonly prompt: string
  readonly timing: NativeTiming
  readonly target?: { readonly kind: 'session'; readonly sessionId: string }
}

export interface NativePatch {
  readonly title?: string
  readonly prompt?: string
  readonly timing?: NativeTiming
  readonly target?: { readonly kind: 'session'; readonly sessionId: string }
  readonly active?: boolean
}

export type NativeEditRequest =
  | { readonly id: string; readonly action: 'update'; readonly patch: NativePatch; readonly expectedUpdatedAt?: string | null }
  | { readonly id: string; readonly action: 'delete'; readonly expectedUpdatedAt?: string | null }

export interface NativeSchedulePort {
  list(request?: { readonly limit?: number; readonly offset?: number; readonly active?: boolean }): Promise<NativeListResult>
  view(request: { readonly id: string }): Promise<NativeViewResult>
  history(request: { readonly id: string; readonly limit: number; readonly before?: string }): Promise<NativeHistoryResult>
  create(request: NativeCreateRequest): Promise<NativeCreateResult>
  edit(request: NativeEditRequest): Promise<NativeEditResult>
  run(request: { readonly id: string }): Promise<NativeRunResult>
  deleteInactive(): Promise<NativeDeleteInactiveResult>
  deliveryLimits(): Promise<NativeDeliveryLimits>
}

// ---------------------------------------------------------------------------
// Error classification (never leak raw exception bodies)
// ---------------------------------------------------------------------------

const SAFE_CODES = new Set([
  'schedule_not_found', 'delivery_cursor_not_found', 'schedule_conflict',
  'schedule_execution_pending', 'invalid_prompt', 'invalid_selector',
  'invalid_rule', 'invalid_time_zone', 'not_future', 'time_out_of_range',
  'frequency_too_high', 'subagent_session', 'internal_error',
  'schedule/input-invalid', 'schedule/target-archived', 'input_invalid',
])
const INPUT_MARKERS = new Set([
  'invalid_prompt', 'invalid_selector', 'invalid_rule', 'invalid_time_zone',
  'not_future', 'time_out_of_range', 'frequency_too_high', 'subagent_session',
  'input_invalid', 'schedule/input-invalid',
])
const DEFAULT_CODES: Record<ScheduleNativeErrorKind, string> = {
  input_invalid: 'input_invalid',
  not_found: 'schedule_not_found',
  conflict: 'schedule_conflict',
  execution_pending: 'schedule_execution_pending',
  native_error: 'native_error',
}
const CODE_RE = /^[A-Za-z0-9_./-]{1,64}$/

function toNativeError(cause: unknown): ScheduleNativeError {
  const codes: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = cause
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) break
    seen.add(current)
    const record = current as Record<string, unknown>
    for (const key of ['code', 'name', 'type']) {
      const value = record[key]
      if (typeof value === 'string' && CODE_RE.test(value)) codes.push(value.toLowerCase())
    }
    for (const nested of [record.details, record.data]) {
      if (nested && typeof nested === 'object') {
        const inner = nested as Record<string, unknown>
        if (typeof inner.code === 'string' && CODE_RE.test(inner.code)) codes.push(inner.code.toLowerCase())
      }
    }
    current = record.cause
  }
  let kind: ScheduleNativeErrorKind = 'native_error'
  if (codes.some((c) => c.includes('not_found'))) kind = 'not_found'
  else if (codes.some((c) => c.includes('conflict'))) kind = 'conflict'
  else if (codes.some((c) => c.includes('execution_pending'))) kind = 'execution_pending'
  else if (codes.some((c) => INPUT_MARKERS.has(c))) kind = 'input_invalid'
  const code = codes.find((c) => SAFE_CODES.has(c)) ?? DEFAULT_CODES[kind]
  return new ScheduleNativeError(kind, code)
}

// ---------------------------------------------------------------------------
// Raw -> normalized helpers (defensive: the service is remote)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function str(value: unknown, max = 4096): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined
}
function nativeId(raw: unknown, fallback: string): string {
  return isRecord(raw) && typeof raw.id === 'string' ? raw.id.slice(0, 128) : fallback
}
function rawCode(raw: unknown): NativeCodeResult['code'] | undefined {
  if (!isRecord(raw)) return undefined
  const code = raw.code
  if (typeof code === 'string' &&
      (code === 'schedule_not_found' || code === 'delivery_cursor_not_found' ||
       code === 'schedule_conflict' || code === 'schedule_execution_pending')) return code
  return undefined
}

function normalizeTarget(raw: unknown): NativeTarget {
  if (!isRecord(raw)) return { kind: 'new' }
  const kind = raw.kind
  const normalizedKind: NativeTarget['kind'] =
    kind === 'session' || kind === 'new_once' || kind === 'new' ? kind : 'new'
  const sessionId = str(raw.sessionId, 256)
  const createRaw = raw.create
  let create: NativeTarget['create']
  if (isRecord(createRaw)) {
    const cwd = str(createRaw.cwd, 4096)
    const agentPreset = str(createRaw.agentPreset, 256)
    if (cwd || agentPreset) {
      create = { ...(cwd ? { cwd } : {}), ...(agentPreset ? { agentPreset } : {}) }
    }
  }
  return {
    kind: normalizedKind,
    ...(sessionId ? { sessionId } : {}),
    ...(create ? { create } : {}),
  }
}

function normalizeDelivery(raw: unknown): NativeDelivery | undefined {
  if (!isRecord(raw)) return undefined
  const scheduledAt = str(raw.scheduledAt, 64)
  const deliveredAt = str(raw.deliveredAt, 64)
  const messageId = str(raw.messageId, 256)
  const targetSessionId = str(raw.targetSessionId, 256)
  if (!scheduledAt || !deliveredAt || !messageId || !targetSessionId) return undefined
  const prompt = str(raw.prompt, 4096)
  return { scheduledAt, deliveredAt, messageId, targetSessionId, ...(prompt ? { prompt } : {}) }
}

/** Normalize one `ScheduleCatalogEntry` (record fields + catalog metadata). */
function normalizeTask(raw: unknown): NativeTask | undefined {
  if (!isRecord(raw)) return undefined
  const id = str(raw.id, 128)
  const kind = raw.kind
  const title = str(raw.title, 4096)
  const prompt = str(raw.prompt, 4096)
  const scheduledAt = str(raw.scheduledAt, 64)
  if (!id || typeof kind !== 'string' || title === undefined || prompt === undefined || !scheduledAt) return undefined
  const allowedKinds = ['at', 'after', 'every', 'daily', 'weekly', 'cron', 'rrule']
  const normalizedKind = (allowedKinds.includes(kind) ? kind : 'rrule') as NativeTask['kind']
  const status = raw.status === 'active' || raw.status === 'paused' || raw.status === 'ended' ? raw.status : 'ended'
  const weekdays = Array.isArray(raw.weekdays)
    ? raw.weekdays.filter((d): d is number => typeof d === 'number' && Number.isInteger(d))
    : undefined
  const lastDelivery = normalizeDelivery(raw.lastDelivery)
  return {
    id, kind: normalizedKind, title, prompt, scheduledAt,
    ...(num(raw.afterSeconds) !== undefined ? { afterSeconds: num(raw.afterSeconds) } : {}),
    ...(num(raw.everySeconds) !== undefined ? { everySeconds: num(raw.everySeconds) } : {}),
    ...(str(raw.time, 32) ? { time: str(raw.time, 32) } : {}),
    ...(str(raw.timeZone, 128) ? { timeZone: str(raw.timeZone, 128) } : {}),
    ...(weekdays ? { weekdays } : {}),
    ...(str(raw.expression, 256) ? { expression: str(raw.expression, 256) } : {}),
    ...(str(raw.rrule, 4096) ? { rrule: str(raw.rrule, 4096) } : {}),
    target: normalizeTarget(raw.target),
    status,
    ...(str(raw.createdAt, 64) ? { createdAt: str(raw.createdAt, 64) } : {}),
    ...(str(raw.updatedAt, 64) ? { updatedAt: str(raw.updatedAt, 64) } : {}),
    ...(raw.executionActive === true ? { executionActive: true } : {}),
    ...(str(raw.deliveryFloorEndsAt, 64) ? { deliveryFloorEndsAt: str(raw.deliveryFloorEndsAt, 64) } : {}),
    ...(lastDelivery ? { lastDelivery } : {}),
  }
}

/** Wrap a native call: catch rejections, then normalize the raw result. */
async function resolve<T>(
  call: () => unknown | Promise<unknown>,
  normalize: (raw: unknown) => T | ScheduleNativeError,
): Promise<T | ScheduleNativeError> {
  let raw: unknown
  try {
    raw = await call()
  } catch (cause) {
    return toNativeError(cause)
  }
  try {
    return normalize(raw)
  } catch {
    return new ScheduleNativeError('native_error', 'invalid_result')
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

type NativeService = Record<string, unknown>

const REQUIRED_METHODS = [
  'list', 'view', 'history', 'create', 'edit', 'run', 'deleteInactive', 'deliveryLimits',
] as const

/**
 * Resolve `ctx.get('schedule')` and wrap every method. Returns undefined when
 * the service is not mounted in this profile (so the manager stays unavailable).
 */
export function createNativeSchedulePort(ctx: CordisLike): NativeSchedulePort | undefined {
  let service: unknown
  try {
    service = ctx.get('schedule')
  } catch {
    return undefined
  }
  if (!isRecord(service)) return undefined
  const host = service as NativeService
  for (const method of REQUIRED_METHODS) {
    if (typeof host[method] !== 'function') return undefined
  }

  const call = (method: string, ...args: unknown[]): unknown | Promise<unknown> =>
    (host[method] as (...a: unknown[]) => unknown | Promise<unknown>)(...args)

  return {
    list: (request) => resolve<NativeList>(
      () => call('list', request ?? {}),
      (raw) => {
        if (isScheduleNativeError(raw)) return raw
        if (!isRecord(raw) || !Array.isArray(raw.items)) {
          return new ScheduleNativeError('native_error', 'invalid_result')
        }
        const items = raw.items.slice(0, 500).map(normalizeTask).filter((t): t is NativeTask => t !== undefined)
        return {
          items,
          total: num(raw.total) ?? items.length,
          limit: num(raw.limit) ?? 500,
          offset: num(raw.offset) ?? 0,
        }
      },
    ),

    view: (request) => resolve<NativeTask | NativeCodeResult>(
      () => call('view', { id: request.id }),
      (raw) => {
        const code = rawCode(raw)
        if (code) return { code, id: nativeId(raw, request.id) }
        const task = normalizeTask(raw)
        return task ?? new ScheduleNativeError('native_error', 'invalid_result')
      },
    ),

    history: (request) => resolve<NativeHistory | NativeCodeResult>(
      () => call('history', { id: request.id, limit: request.limit, ...(request.before ? { before: request.before } : {}) }),
      (raw) => {
        const code = rawCode(raw)
        if (code) return { code, id: nativeId(raw, request.id) }
        if (!isRecord(raw) || !Array.isArray(raw.records)) {
          return new ScheduleNativeError('native_error', 'invalid_result')
        }
        const records = raw.records.slice(0, 100).map(normalizeDelivery)
          .filter((d): d is NativeDelivery => d !== undefined)
        return {
          records,
          earlierRecordsUnavailable: raw.earlierRecordsUnavailable === true,
          earlierRecordsPruned: raw.earlierRecordsPruned === true,
        }
      },
    ),

    create: (request) => resolve<NativeTask>(
      () => call('create', request),
      (raw) => normalizeTask(raw) ?? new ScheduleNativeError('native_error', 'invalid_result'),
    ),

    edit: (request) => resolve<NativeTask | NativeDeleted | NativeCodeResult>(
      () => call('edit', request),
      (raw) => {
        const code = rawCode(raw)
        if (code) return { code, id: nativeId(raw, request.id) }
        if (isRecord(raw) && raw.deleted === true) return { id: nativeId(raw, request.id), deleted: true }
        return normalizeTask(raw) ?? new ScheduleNativeError('native_error', 'invalid_result')
      },
    ),

    run: (request) => resolve<NativeTask | NativeCodeResult>(
      () => call('run', { id: request.id }),
      (raw) => {
        const code = rawCode(raw)
        if (code) return { code, id: nativeId(raw, request.id) }
        return normalizeTask(raw) ?? new ScheduleNativeError('native_error', 'invalid_result')
      },
    ),

    deleteInactive: () => resolve<{ readonly deleted: number }>(
      () => call('deleteInactive'),
      (raw) => {
        if (!isRecord(raw)) return new ScheduleNativeError('native_error', 'invalid_result')
        return { deleted: Math.max(0, num(raw.deleted) ?? 0) }
      },
    ),

    deliveryLimits: () => resolve<{ readonly newSessionIntervalSeconds: number }>(
      () => call('deliveryLimits'),
      (raw) => {
        if (!isRecord(raw)) return new ScheduleNativeError('native_error', 'invalid_result')
        return {
          newSessionIntervalSeconds: Math.max(0, Math.min(1e6, num(raw.newSessionIntervalSeconds) ?? 0)),
        }
      },
    ),
  }
}
