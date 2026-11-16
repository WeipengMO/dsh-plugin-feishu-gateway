/**
 * Gateway-side bridge to DSH's native schedule Host service.
 *
 * The Gateway is NOT a scheduler. It owns only:
 *   - a Feishu delivery sidecar (`schedule-delivery.json`),
 *   - a bounded run/dedupe ledger (`schedule-runs.json`),
 *   - an append-only audit trail (`schedule-audit.jsonl`),
 *   - a redacted, atomic read model (`ops-schedule.json`).
 *
 * All task definitions, recurrence and delivery history live in the native
 * `ctx.schedule` service. When that service is not mounted, `available` is
 * false and no substitute scheduler is ever created.
 *
 * See docs/SCHEDULE-API-CONTRACT.md §3 and §4.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { GatewayLogger, ObservedScheduleTurn, ModelTokenUsage } from '../types.js'
import { JsonStore } from '../storage/json-store.js'
import {
  MAX_ACTOR_LENGTH, MAX_PROMPT_LENGTH, MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH,
  boundedText, nativeRecordToSpec, sessionRef, specSummary, toNativeTiming, validateSpec,
} from './spec.js'
import type { ScheduleSpec } from './spec.js'
import { buildScheduleCard, CARD_TEXT_MAX } from './card.js'
import {
  isScheduleNativeError, ScheduleNativeError,
} from './native.js'
import type {
  NativeCodeResult, NativeCreateRequest, NativeDelivery, NativeEditRequest,
  NativePatch, NativeSchedulePort, NativeTask,
} from './native.js'

export type { ObservedScheduleTurn } from '../types.js'

// ---------------------------------------------------------------------------
// Public API (contract §3)
// ---------------------------------------------------------------------------

export interface FeishuDeliveryInput {
  readonly botId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly senderId?: string
}

export interface ScheduleManagerHooks {
  readonly logger: GatewayLogger
  readonly stateDir: string
  readonly now: () => number
  readonly isStopped: () => boolean
  /** Create/reserve one Gateway-owned native DSH Session for a task. */
  readonly ensureTaskSession: (clientRef: string) => Promise<string>
  /** Retire a task Session after deletion (best effort). */
  readonly releaseTaskSession: (sessionId: string) => Promise<void>
  /** Re-check the current allowlist/group policy for a Feishu target. */
  readonly validateFeishuTarget: (target: FeishuDeliveryInput) =>
    Promise<{ ok: true } | { ok: false; reason: string }>
  /** Record one schedule turn in the shared usage ledger. */
  readonly recordUsage?: (value: {
    ref: string; botId: string; session: string; chat?: string; user?: string
    model?: string; status: 'done' | 'failed' | 'timeout'; source?: 'schedule'; usage?: ModelTokenUsage
  }) => Promise<void>
  /** Durable, idempotent Outbox send. key must be stable per delivery. */
  readonly sendFeishu: (
    botId: string,
    target: {
      chatId: string
      text: string
      format?: 'text' | 'markdown'
      /** Feishu interactive card; when present the transport sends the card. */
      card?: Record<string, unknown>
    },
    idempotencyKey: string,
  ) => Promise<boolean>
}

export interface ScheduleCommand {
  readonly action: 'create' | 'update' | 'pause' | 'resume' | 'run' | 'delete' | 'delete-inactive' | 'refresh'
  readonly actor: string
  readonly clientRef?: string
  readonly taskId?: string
  readonly title?: string
  readonly prompt?: string
  readonly spec?: ScheduleSpec
  readonly notify?: 'result' | 'failure' | 'both' | 'none'
  readonly delivery?: FeishuDeliveryInput | null
  readonly expectedUpdatedAt?: string | null
}

export interface ScheduleCommandOutcome {
  readonly state: 'completed' | 'rejected' | 'not-found' | 'conflict' | 'error'
  readonly taskId?: string
  /** Bounded, stable code/message only. */
  readonly message?: string
}

export interface DeliveryConfig {
  readonly botId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly senderId?: string
  readonly notify: 'result' | 'failure' | 'both' | 'none'
}

export interface ScheduleTaskView {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly spec?: ScheduleSpec
  readonly timingKind: string
  readonly timeZone: string | null
  readonly scheduledAt: string
  readonly status: 'active' | 'paused' | 'ended'
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly executionActive: boolean
  readonly lastDelivery?: NativeDelivery
  readonly target: { readonly kind: string; readonly sessionId?: string }
  readonly delivery?: DeliveryConfig
}

export interface ScheduleRunRecord {
  readonly ts: number
  readonly taskId: string
  readonly messageId: string
  readonly sessionRef: string
  /** Read-model status: ObservedScheduleTurn 'empty' is folded into 'skipped'. */
  readonly status: 'success' | 'failed' | 'skipped' | 'timeout'
  readonly elapsedMs: number
  readonly tokens?: number
  readonly model?: string
  readonly delivered: boolean
  readonly error: string | null
}

export interface ScheduleAuditEntry {
  readonly ts: number
  readonly actor: string
  readonly action: string
  readonly taskId: string
  readonly state: ScheduleCommandOutcome['state']
  readonly summary: string
}

export interface ScheduleReadModel {
  readonly version: 1
  readonly ts: number
  readonly available: boolean
  readonly reason: string | null
  readonly limits: { readonly newSessionIntervalSeconds: number }
  readonly tasks: readonly ScheduleTaskView[]
  readonly deliveries: Record<string, readonly NativeDelivery[]>
  readonly runs: readonly ScheduleRunRecord[]
  readonly audit: readonly ScheduleAuditEntry[]
}

// ---------------------------------------------------------------------------
// Durable state shapes
// ---------------------------------------------------------------------------

interface DeliveryState {
  readonly version: 1
  /** taskId -> Feishu delivery config. */
  readonly configs: Record<string, DeliveryConfig>
  /** taskId -> reserved Gateway-owned native Session id. */
  readonly sessions: Record<string, string>
}

interface RunState {
  readonly version: 1
  readonly runs: ScheduleRunRecord[]
  /** Persisted dedupe ledger of observed message ids. */
  readonly dedupe: string[]
  /** Persisted fallback-notice markers (idempotency keys). */
  readonly notices: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UNAVAILABLE_REASON = 'DSH native schedule service is not mounted in this profile'
const FALLBACK_NOTICE_TEXT = '定时任务已触发；完整结果请到 DSH Session 查看'
/**
 * A scheduled Agent turn can legitimately take minutes (data-collection scripts,
 * slow models). Wait long enough that a real result is not racing a fallback
 * notice, and never notify while the native task still reports an active run.
 */
const FALLBACK_GRACE_MS = 5 * 60_000
const DEBOUNCE_MS = 250
const MAX_TASKS = 200
const MAX_HISTORY_TASKS = 50
const MAX_DELIVERIES_PER_TASK = 20
const MAX_RUNS = 200
const MAX_AUDIT = 200
const MAX_DEDUPE = 400
const MAX_NOTICES = 400

const ACTIONS = new Set([
  'create', 'update', 'pause', 'resume', 'run', 'delete', 'delete-inactive', 'refresh',
])
const NOTIFY = new Set(['result', 'failure', 'both', 'none'])
const OUTCOME_STATES = new Set(['completed', 'rejected', 'not-found', 'conflict', 'error'])
const UPDATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const REF_RE = /^[A-Za-z0-9_-]{1,128}$/
const BOT_RE = /^[a-z][a-z0-9_-]{0,31}$/
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const ACTOR_RE = /^[A-Za-z0-9_.:@-]{1,64}$/
const MODEL_RE = /^[A-Za-z0-9_.:/-]{1,96}$/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
function boundedNum(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : min
}

function boundedDelivery(d: NativeDelivery): NativeDelivery {
  return {
    scheduledAt: boundedString(d.scheduledAt, 64),
    deliveredAt: boundedString(d.deliveredAt, 64),
    messageId: boundedString(d.messageId, 256),
    targetSessionId: boundedString(d.targetSessionId, 256),
  }
}

function toDeliveryInput(config: DeliveryConfig): FeishuDeliveryInput {
  return {
    botId: config.botId,
    chatId: config.chatId,
    chatType: config.chatType,
    ...(config.senderId ? { senderId: config.senderId } : {}),
  }
}

function normalizeDeliveryInput(value: unknown): FeishuDeliveryInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const allowed = ['botId', 'chatId', 'chatType', 'senderId']
  if (!Object.keys(record).every((key) => allowed.includes(key))) return undefined
  const { botId, chatId, chatType, senderId } = record
  if (typeof botId !== 'string' || !BOT_RE.test(botId)) return undefined
  if (typeof chatId !== 'string' || !ID_RE.test(chatId)) return undefined
  if (chatType !== 'p2p' && chatType !== 'group') return undefined
  if (senderId !== undefined && (typeof senderId !== 'string' || !ID_RE.test(senderId))) return undefined
  return {
    botId, chatId, chatType,
    ...(typeof senderId === 'string' ? { senderId } : {}),
  }
}

function isValidUpdatedAt(value: string): boolean {
  const v = value.trim()
  return v.length <= 40 && UPDATED_AT_RE.test(v) && Number.isFinite(Date.parse(v))
}

/**
 * OpenClaw-style silent reply. A short `NO_REPLY` (optionally with a trailing
 * reason) suppresses Feishu delivery for this occurrence without being treated
 * as a failure. Long reports that merely mention the token are never suppressed.
 */
function isSilentReply(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed.length <= 80 && /\bNO_REPLY\b/i.test(trimmed)
}

function nativeOutcome(error: ScheduleNativeError): ScheduleCommandOutcome {
  switch (error.kind) {
    case 'not_found':
      return { state: 'not-found' }
    case 'conflict':
      return { state: 'conflict' }
    case 'execution_pending':
      return { state: 'rejected', message: 'execution pending' }
    case 'input_invalid':
      return { state: 'rejected', message: `invalid input:${error.code}`.slice(0, MAX_SUMMARY_LENGTH) }
    default:
      return { state: 'error', message: 'native schedule error' }
  }
}

function codeOutcome(result: NativeCodeResult, _taskId: string): ScheduleCommandOutcome {
  switch (result.code) {
    case 'schedule_not_found':
      return { state: 'not-found' }
    case 'schedule_conflict':
      return { state: 'conflict' }
    case 'schedule_execution_pending':
      return { state: 'rejected', message: 'execution pending' }
    case 'delivery_cursor_not_found':
      return { state: 'rejected', message: 'history cursor not found' }
  }
}

type MutablePatch = { -readonly [K in keyof NativePatch]: NativePatch[K] }

interface NormalizedCommand {
  action: ScheduleCommand['action']
  actor: string
  clientRef?: string
  taskId?: string
  title?: string
  prompt?: string
  spec?: ScheduleSpec
  notify?: 'result' | 'failure' | 'both' | 'none'
  delivery?: FeishuDeliveryInput | null
  expectedUpdatedAt?: string | null
}
type CommandValidation =
  | { readonly ok: true; readonly cmd: NormalizedCommand }
  | { readonly ok: false; readonly error: string }

function bad(error: string): CommandValidation {
  return { ok: false, error }
}

// ---------------------------------------------------------------------------
// ScheduleManager
// ---------------------------------------------------------------------------

export class ScheduleManager {
  private readonly hooks: ScheduleManagerHooks
  private readonly deliveryStore: JsonStore<DeliveryState>
  private readonly runStore: JsonStore<RunState>
  private readonly auditFile: string
  private readonly opsFile: string
  private port: NativeSchedulePort | undefined
  private _available = false
  private reason: string
  private started = false
  private stopped = false
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private model: ScheduleReadModel
  private readonly taskSessionIds = new Set<string>()
  private readonly dedupe = new Set<string>()
  private auditWrites = 0

  constructor(hooks: ScheduleManagerHooks) {
    this.hooks = hooks
    this.reason = UNAVAILABLE_REASON
    this.deliveryStore = new JsonStore<DeliveryState>(hooks.stateDir, 'schedule-delivery', {
      version: 1, configs: {}, sessions: {},
    })
    this.runStore = new JsonStore<RunState>(hooks.stateDir, 'schedule-runs', {
      version: 1, runs: [], dedupe: [], notices: [],
    })
    this.auditFile = path.join(hooks.stateDir, 'schedule-audit.jsonl')
    this.opsFile = path.join(hooks.stateDir, 'ops-schedule.json')
    this.model = {
      version: 1, ts: 0, available: false, reason: this.reason,
      limits: { newSessionIntervalSeconds: 0 },
      tasks: [], deliveries: {}, runs: [], audit: [],
    }
  }

  get available(): boolean {
    return this._available
  }
  get unavailableReason(): string | undefined {
    return this._available ? undefined : this.reason
  }

  /** Called from apply() when ctx.inject(['schedule']) resolves. Safe before start(). */
  attachNative(port: NativeSchedulePort | undefined): void {
    this.port = port
    this._available = port !== undefined
    this.reason = port !== undefined ? '' : UNAVAILABLE_REASON
    // Keep snapshot() correct even before the first refresh.
    this.model = {
      ...this.model,
      available: this._available,
      reason: this._available ? null : this.reason,
    }
  }

  /** Called on every native 'schedule/changed' emit (debounced). Safe before start(). */
  onChanged(): void {
    if (this.stopped) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    const timer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.refresh()
    }, DEBOUNCE_MS)
    timer.unref?.()
    this.debounceTimer = timer
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.stopped = false
    await mkdir(this.hooks.stateDir, { recursive: true, mode: 0o700 })
    const initial = await this.deliveryStore.load()
    await this.runStore.load()
    this.syncSessionIds(initial)
    await this.refresh()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.started = false
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
    await this.chain.catch(() => undefined)
  }

  /** Catalog + native delivery history + read model. Safe before start(). */
  async refresh(): Promise<void> {
    try {
      await this.enqueue(() => this.doRefresh())
    } catch (cause) {
      this.log('warn', 'schedule refresh failed')
      void cause
    }
  }

  async execute(command: ScheduleCommand): Promise<ScheduleCommandOutcome> {
    return this.enqueue(async () => {
      let outcome: ScheduleCommandOutcome
      try {
        outcome = await this.runCommand(command)
      } catch (cause) {
        this.log('warn', 'schedule command failed')
        void cause
        outcome = { state: 'error', message: 'schedule command failed' }
      }
      await this.appendAudit(command, outcome)
      if (outcome.state === 'completed' && command.action !== 'refresh') this.onChanged()
      return outcome
    })
  }

  /** Called when DshSessionBridge observes a schedule-sourced turn. */
  async onScheduleTurn(turn: ObservedScheduleTurn): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.handleTurn(turn)
      } catch (cause) {
        this.log('warn', 'schedule turn handling failed')
        void cause
      }
    })
  }

  /** True when sessionId belongs to a Gateway-managed scheduled task. */
  isTaskSession(sessionId: string): boolean {
    return typeof sessionId === 'string' && this.taskSessionIds.has(sessionId)
  }

  snapshot(): ScheduleReadModel {
    return this.model
  }

  // -------------------------------------------------------------------------
  // Command handling
  // -------------------------------------------------------------------------

  private async runCommand(command: ScheduleCommand): Promise<ScheduleCommandOutcome> {
    const checked = this.validateCommand(command)
    if (!checked.ok) return { state: 'rejected', message: checked.error }
    const cmd = checked.cmd
    // A refresh command always works, even while the native service is absent.
    if (cmd.action === 'refresh') {
      await this.doRefresh()
      return { state: 'completed' }
    }
    if (!this._available || !this.port) {
      return { state: 'error', message: 'native schedule service unavailable' }
    }
    switch (cmd.action) {
      case 'delete-inactive': {
        const result = await this.port.deleteInactive()
        return isScheduleNativeError(result) ? nativeOutcome(result) : { state: 'completed' }
      }
      case 'create':
        return this.doCreate(cmd)
      case 'update':
        return this.doUpdate(cmd)
      case 'pause':
        return this.setActive(cmd, false)
      case 'resume':
        return this.setActive(cmd, true)
      case 'run':
        return this.doRun(cmd)
      case 'delete':
        return this.doDelete(cmd)
    }
  }

  private validateCommand(command: ScheduleCommand): CommandValidation {
    if (!command || typeof command !== 'object' || Array.isArray(command)) return bad('invalid_command')
    const record = command as unknown as Record<string, unknown>
    const action = record.action
    if (typeof action !== 'string' || !ACTIONS.has(action)) return bad('invalid_action')
    const actor = boundedText(record.actor, MAX_ACTOR_LENGTH)
    if (!actor || !ACTOR_RE.test(actor)) return bad('invalid_actor')
    const cmd: NormalizedCommand = { action: action as ScheduleCommand['action'], actor }

    const needsTask = action === 'update' || action === 'pause' || action === 'resume' ||
      action === 'run' || action === 'delete'
    if (record.taskId !== undefined) {
      if (typeof record.taskId !== 'string' || !TASK_ID_RE.test(record.taskId)) return bad('invalid_task_id')
      cmd.taskId = record.taskId
    }
    if (needsTask && !cmd.taskId) return bad('invalid_task_id')

    if (record.clientRef !== undefined) {
      if (typeof record.clientRef !== 'string' || !REF_RE.test(record.clientRef)) return bad('invalid_client_ref')
      cmd.clientRef = record.clientRef
    }
    if (action === 'create' && !cmd.clientRef) return bad('invalid_client_ref')

    if (record.title !== undefined) {
      const title = boundedText(record.title, MAX_TITLE_LENGTH)
      if (!title) return bad('invalid_title')
      cmd.title = title
    }
    if (action === 'create' && !cmd.title) return bad('invalid_title')

    if (record.prompt !== undefined) {
      const prompt = boundedText(record.prompt, MAX_PROMPT_LENGTH)
      if (!prompt) return bad('invalid_prompt')
      cmd.prompt = prompt
    }
    if (action === 'create' && !cmd.prompt) return bad('invalid_prompt')

    if (record.spec !== undefined) {
      const validated = validateSpec(record.spec, this.hooks.now())
      if (!validated.ok) return bad(`invalid_spec:${validated.error}`)
      cmd.spec = validated.spec
    }
    if (action === 'create' && !cmd.spec) return bad('invalid_spec')

    if (record.notify !== undefined) {
      if (typeof record.notify !== 'string' || !NOTIFY.has(record.notify)) return bad('invalid_notify')
      cmd.notify = record.notify as NormalizedCommand['notify']
    }

    if (record.delivery !== undefined) {
      if (record.delivery === null) cmd.delivery = null
      else {
        const delivery = normalizeDeliveryInput(record.delivery)
        if (!delivery) return bad('invalid_delivery')
        cmd.delivery = delivery
      }
    }

    if (record.expectedUpdatedAt !== undefined) {
      if (record.expectedUpdatedAt === null) cmd.expectedUpdatedAt = null
      else if (typeof record.expectedUpdatedAt !== 'string' || !isValidUpdatedAt(record.expectedUpdatedAt)) {
        return bad('invalid_expected_updated_at')
      } else cmd.expectedUpdatedAt = record.expectedUpdatedAt.trim()
    }

    return { ok: true, cmd }
  }

  private async doCreate(cmd: NormalizedCommand): Promise<ScheduleCommandOutcome> {
    if (cmd.delivery) {
      const check = await this.hooks.validateFeishuTarget(cmd.delivery)
      if (!check.ok) return { state: 'rejected', message: 'delivery target not allowed' }
    }
    let sessionId: string
    try {
      sessionId = await this.hooks.ensureTaskSession(cmd.clientRef as string)
    } catch (cause) {
      this.log('warn', 'session reservation failed')
      void cause
      return { state: 'error', message: 'session reservation failed' }
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      return { state: 'error', message: 'session reservation failed' }
    }
    // Register immediately (before port.create): the schedule/resolve-agent
    // waterfall resolves the live Agent through isTaskSession(id).
    this.taskSessionIds.add(sessionId)
    const request: NativeCreateRequest = {
      title: cmd.title as string,
      prompt: cmd.prompt as string,
      timing: toNativeTiming(cmd.spec as ScheduleSpec),
      target: { kind: 'session', sessionId },
    }
    const result = await (this.port as NativeSchedulePort).create(request)
    if (isScheduleNativeError(result)) {
      this.taskSessionIds.delete(sessionId)
      try { await this.hooks.releaseTaskSession(sessionId) } catch { /* best effort */ }
      return nativeOutcome(result)
    }
    const taskId = result.id
    await this.deliveryStore.update((state) => {
      const configs = { ...state.configs }
      if (cmd.delivery) configs[taskId] = { ...cmd.delivery, notify: cmd.notify ?? 'result' }
      else if (cmd.delivery === null) delete configs[taskId]
      return { version: 1, configs, sessions: { ...state.sessions, [taskId]: sessionId } }
    })
    return { state: 'completed', taskId }
  }

  private async doUpdate(cmd: NormalizedCommand): Promise<ScheduleCommandOutcome> {
    const taskId = cmd.taskId as string
    const state0 = await this.deliveryStore.load()
    const existingSession = state0.sessions[taskId]
    const existingConfig = state0.configs[taskId]
    if (cmd.delivery) {
      const check = await this.hooks.validateFeishuTarget(cmd.delivery)
      if (!check.ok) return { state: 'rejected', message: 'delivery target not allowed' }
    }
    const patch: MutablePatch = {}
    if (cmd.title !== undefined) patch.title = cmd.title
    if (cmd.prompt !== undefined) patch.prompt = cmd.prompt
    if (cmd.spec !== undefined) patch.timing = toNativeTiming(cmd.spec)
    let newSessionId: string | undefined
    // Target stays unchanged unless a task with no reserved Session is adopted.
    if (cmd.delivery && !existingSession && cmd.clientRef) {
      try {
        const sid = await this.hooks.ensureTaskSession(cmd.clientRef)
        if (typeof sid === 'string' && sid) {
          newSessionId = sid
          this.taskSessionIds.add(sid)
          patch.target = { kind: 'session', sessionId: sid }
        }
      } catch (cause) {
        this.log('warn', 'session reservation failed')
        void cause
        return { state: 'error', message: 'session reservation failed' }
      }
    }
    const expected = cmd.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: cmd.expectedUpdatedAt }
      : {}
    if (Object.keys(patch).length > 0) {
      const request: NativeEditRequest = { id: taskId, action: 'update', patch, ...expected }
      const result = await (this.port as NativeSchedulePort).edit(request)
      if (isScheduleNativeError(result)) return nativeOutcome(result)
      if ('code' in result) return codeOutcome(result, taskId)
    } else {
      // Delivery-only edit: native forbids an empty patch; verify the task exists.
      const viewed = await (this.port as NativeSchedulePort).view({ id: taskId })
      if (isScheduleNativeError(viewed)) return nativeOutcome(viewed)
      if ('code' in viewed) return codeOutcome(viewed, taskId)
    }
    const notify = cmd.notify ?? existingConfig?.notify ?? 'result'
    await this.deliveryStore.update((state) => {
      const configs = { ...state.configs }
      if (cmd.delivery) configs[taskId] = { ...cmd.delivery, notify }
      else if (cmd.delivery === null) delete configs[taskId]
      const sessions = { ...state.sessions }
      if (newSessionId) sessions[taskId] = newSessionId
      return { version: 1, configs, sessions }
    })
    return { state: 'completed', taskId }
  }

  private async setActive(cmd: NormalizedCommand, active: boolean): Promise<ScheduleCommandOutcome> {
    const taskId = cmd.taskId as string
    const expected = cmd.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: cmd.expectedUpdatedAt }
      : {}
    const request: NativeEditRequest = { id: taskId, action: 'update', patch: { active }, ...expected }
    const result = await (this.port as NativeSchedulePort).edit(request)
    if (isScheduleNativeError(result)) return nativeOutcome(result)
    if ('code' in result) return codeOutcome(result, taskId)
    return { state: 'completed', taskId }
  }

  private async doRun(cmd: NormalizedCommand): Promise<ScheduleCommandOutcome> {
    const taskId = cmd.taskId as string
    const result = await (this.port as NativeSchedulePort).run({ id: taskId })
    if (isScheduleNativeError(result)) return nativeOutcome(result)
    if ('code' in result) return codeOutcome(result, taskId)
    return { state: 'completed', taskId }
  }

  private async doDelete(cmd: NormalizedCommand): Promise<ScheduleCommandOutcome> {
    const taskId = cmd.taskId as string
    const state0 = await this.deliveryStore.load()
    const sessionId = state0.sessions[taskId]
    const expected = cmd.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: cmd.expectedUpdatedAt }
      : {}
    const request: NativeEditRequest = { id: taskId, action: 'delete', ...expected }
    const result = await (this.port as NativeSchedulePort).edit(request)
    if (isScheduleNativeError(result)) return nativeOutcome(result)
    if ('code' in result) return codeOutcome(result, taskId)
    await this.deliveryStore.update((state) => {
      const configs = { ...state.configs }
      delete configs[taskId]
      const sessions = { ...state.sessions }
      delete sessions[taskId]
      return { version: 1, configs, sessions }
    })
    if (sessionId) {
      this.taskSessionIds.delete(sessionId)
      try { await this.hooks.releaseTaskSession(sessionId) } catch { /* best effort */ }
    }
    return { state: 'completed', taskId }
  }

  // -------------------------------------------------------------------------
  // Refresh + read model
  // -------------------------------------------------------------------------

  private async doRefresh(): Promise<void> {
    const now = this.hooks.now()
    let available = this._available
    let reason: string | null = available ? null : this.reason
    let tasks: ScheduleTaskView[] = []
    let deliveries: Record<string, readonly NativeDelivery[]> = {}
    let limits = { newSessionIntervalSeconds: 0 }
    try {
      if (available && this.port) {
        const list = await this.port.list({ limit: 500 })
        if (isScheduleNativeError(list)) {
          reason = 'native schedule list unavailable'
        } else {
          const items = list.items.slice(0, MAX_TASKS)
          const lim = await this.port.deliveryLimits()
          if (!isScheduleNativeError(lim)) {
            limits = { newSessionIntervalSeconds: boundedNum(lim.newSessionIntervalSeconds, 0, 1e6) }
          }
          const deliveryState = await this.deliveryStore.load()
          this.syncSessionIds(deliveryState)
          for (const item of items.slice(0, MAX_HISTORY_TASKS)) {
            const history = await this.port.history({ id: item.id, limit: 20 })
            if (!isScheduleNativeError(history) && 'records' in history) {
              deliveries[item.id] = history.records.slice(0, MAX_DELIVERIES_PER_TASK).map(boundedDelivery)
            }
          }
          tasks = items.map((item) => this.toTaskView(item, deliveryState))
          await this.maybeFallbackNotices(items, deliveryState, now)
        }
      }
      const runState = await this.runStore.load()
      const audit = await this.readAudit()
      this.model = {
        version: 1, ts: now, available, reason, limits,
        tasks, deliveries, runs: runState.runs.slice(-MAX_RUNS), audit,
      }
      await this.publishReadModel(this.model)
    } catch (cause) {
      this.log('warn', 'schedule refresh failed')
      void cause
      this.model = {
        version: 1, ts: now, available, reason: reason ?? 'refresh failed',
        limits: { newSessionIntervalSeconds: 0 },
        tasks: [], deliveries: {}, runs: [], audit: [],
      }
      try { await this.publishReadModel(this.model) } catch { /* best effort */ }
    }
  }

  private toTaskView(item: NativeTask, state: DeliveryState): ScheduleTaskView {
    const spec = nativeRecordToSpec(item)
    const config = state.configs[item.id]
    // The sidecar is authoritative for Gateway-managed tasks; fall back to the
    // native target so restoreTaskSessions() can resume after a restart.
    const sessionId = item.target.sessionId ?? state.sessions[item.id]
    const timeZone = item.timeZone ?? (spec && 'timeZone' in spec ? spec.timeZone : null)
    return {
      id: item.id,
      title: boundedString(item.title, MAX_TITLE_LENGTH),
      prompt: boundedString(item.prompt, MAX_PROMPT_LENGTH),
      ...(spec ? { spec } : {}),
      timingKind: item.kind,
      timeZone: timeZone ?? null,
      scheduledAt: boundedString(item.scheduledAt, 64),
      status: item.status,
      ...(item.createdAt ? { createdAt: boundedString(item.createdAt, 64) } : {}),
      ...(item.updatedAt ? { updatedAt: boundedString(item.updatedAt, 64) } : {}),
      executionActive: item.executionActive === true,
      ...(item.lastDelivery ? { lastDelivery: boundedDelivery(item.lastDelivery) } : {}),
      target: {
        kind: item.target.kind,
        // FULL raw id (never hashed): gateway.restoreTaskSessions() resumes it.
        ...(sessionId ? { sessionId: boundedString(sessionId, 512) } : {}),
      },
      ...(config ? { delivery: config } : {}),
    }
  }

  /**
   * Fallback notification: if a native lastDelivery has no matching run/notice
   * after a long grace (and the native task is no longer executing), send one
   * bounded notice. This covers Host-created Sessions that are scope-filtered
   * away from the plugin ctx without racing a slow but successful Agent turn.
   */
  private async maybeFallbackNotices(
    items: readonly NativeTask[], state: DeliveryState, now: number,
  ): Promise<void> {
    const runState = await this.runStore.load()
    const seenRuns = new Set(runState.runs.map((run) => run.messageId))
    const seenNotices = new Set(runState.notices)
    for (const item of items) {
      const config = state.configs[item.id]
      const last = item.lastDelivery
      if (!config || !last) continue
      // The native runtime holds an execution slot until the Agent is idle;
      // a result is still coming, so a notice here would duplicate it.
      if (item.executionActive === true) continue
      if (config.notify !== 'result' && config.notify !== 'both') continue
      const messageId = last.messageId
      if (!messageId) continue
      const key = `schedule:${item.id}:${messageId}:notice`
      if (seenRuns.has(messageId) || seenNotices.has(key)) continue
      const deliveredMs = Date.parse(last.deliveredAt)
      if (!Number.isFinite(deliveredMs) || now - deliveredMs < FALLBACK_GRACE_MS) continue
      const check = await this.hooks.validateFeishuTarget(toDeliveryInput(config))
      if (!check.ok) continue
      try {
        await this.hooks.sendFeishu(
          config.botId,
          { chatId: config.chatId, text: FALLBACK_NOTICE_TEXT, format: 'text',
            card: buildScheduleCard(FALLBACK_NOTICE_TEXT, { template: 'orange' }) },
          key,
        )
      } catch { /* Outbox is durable; a marker is still written below. */ }
      await this.runStore.update((current) => ({
        version: 1,
        runs: current.runs,
        dedupe: current.dedupe,
        notices: [...current.notices.filter((existing) => existing !== key), key].slice(-MAX_NOTICES),
      }))
      seenNotices.add(key)
    }
  }

  // -------------------------------------------------------------------------
  // Observed schedule turns
  // -------------------------------------------------------------------------

  private async handleTurn(turn: ObservedScheduleTurn): Promise<void> {
    if (!turn || typeof turn !== 'object') return
    const messageId = typeof turn.messageId === 'string' ? turn.messageId.slice(0, 256) : ''
    if (!messageId) return
    const runState = await this.runStore.load()
    if (this.dedupe.has(messageId) || runState.dedupe.includes(messageId)) return
    this.dedupe.add(messageId)
    if (this.dedupe.size > 1000) {
      const keep = [...this.dedupe].slice(-500)
      this.dedupe.clear()
      for (const id of keep) this.dedupe.add(id)
    }
    const deliveryState = await this.deliveryStore.load()
    const taskId = this.taskIdForSession(deliveryState, turn.sessionId)
    const config = taskId ? deliveryState.configs[taskId] : undefined
    const text = this.turnText(turn)
    // OpenClaw-style silent reply: a non-trading day or "nothing to report"
    // turn must not produce a Feishu message, but is still recorded as skipped.
    const silent = isSilentReply(text)
    let delivered = false
    let error: string | null = null
    if (taskId && config && config.notify !== 'none' && !silent &&
      this.notifyAllows(config.notify, turn.status)) {
      const check = await this.hooks.validateFeishuTarget(toDeliveryInput(config))
      if (check.ok) {
        const key = `schedule:${taskId}:${messageId}`
        try {
          delivered = await this.hooks.sendFeishu(
            config.botId,
            { chatId: config.chatId, text, format: 'text',
              card: buildScheduleCard(text, { template: turn.status === 'success' ? 'blue' : 'orange' }) },
            key,
          )
        } catch { delivered = false }
      } else {
        error = 'target_rejected'
      }
    }
    if (!taskId) {
      await this.runStore.update((state) => ({
        version: 1,
        runs: state.runs,
        dedupe: [...state.dedupe, messageId].slice(-MAX_DEDUPE),
        notices: state.notices,
      }))
      return
    }
    if (this.hooks.recordUsage) {
      try {
        await this.hooks.recordUsage({
          ref: 'schedule:' + messageId, botId: config?.botId ?? 'schedule', source: 'schedule',
          session: turn.sessionId, ...(config?.chatId ? { chat: config.chatId } : {}),
          ...(config?.senderId ? { user: config.senderId } : {}),
          ...(turn.model ? { model: turn.model } : {}),
          status: turn.status === 'failed' ? 'failed' : turn.status === 'timeout' ? 'timeout' : 'done',
          ...(turn.usage ? { usage: turn.usage } : {}),
        })
      } catch {
        this.log('warn', 'schedule usage recording failed')
      }
    }
    const record: ScheduleRunRecord = {
      ts: this.hooks.now(),
      taskId,
      messageId,
      sessionRef: sessionRef(typeof turn.sessionId === 'string' ? turn.sessionId : ''),
      status: silent ? 'skipped' : this.normalizeStatus(turn.status),
      elapsedMs: boundedNum(turn.elapsedMs, 0, 1e13),
      ...(typeof turn.tokens === 'number' ? { tokens: boundedNum(turn.tokens, 0, 1e13) } : {}),
      ...(typeof turn.model === 'string' && MODEL_RE.test(turn.model) ? { model: turn.model.slice(0, 96) } : {}),
      delivered,
      error,
    }
    await this.runStore.update((state) => ({
      version: 1,
      runs: [...state.runs, record].slice(-MAX_RUNS),
      dedupe: [...state.dedupe, messageId].slice(-MAX_DEDUPE),
      notices: state.notices,
    }))
  }

  private notifyAllows(notify: DeliveryConfig['notify'], status: ObservedScheduleTurn['status']): boolean {
    if (status === 'success') return notify === 'result' || notify === 'both'
    return notify === 'failure' || notify === 'both'
  }

  private turnText(turn: ObservedScheduleTurn): string {
    // Never send raw exception bodies or session ids. Failed/empty/timeout turns
    // get a fixed bounded notice instead of the assistant text.
    if (turn.status !== 'success') {
      const label = turn.status === 'failed' ? '执行失败'
        : turn.status === 'timeout' ? '执行超时' : '未产出内容'
      return `定时任务${label}（${turn.status}）；详情见 DSH Session`
    }
    const text = typeof turn.text === 'string' ? turn.text : ''
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, CARD_TEXT_MAX)
  }

  private normalizeStatus(status: ObservedScheduleTurn['status']): ScheduleRunRecord['status'] {
    switch (status) {
      case 'success':
        return 'success'
      case 'failed':
        return 'failed'
      case 'timeout':
        return 'timeout'
      // 'empty' folds into the read model's 'skipped' bucket; 'skipped' is also
      // available for fallback-notice / delivery-only run records.
      default:
        return 'skipped'
    }
  }

  private taskIdForSession(state: DeliveryState, sessionId: string): string | undefined {
    if (typeof sessionId !== 'string' || !sessionId) return undefined
    for (const [taskId, sid] of Object.entries(state.sessions)) {
      if (sid === sessionId) return taskId
    }
    return undefined
  }

  // -------------------------------------------------------------------------
  // Audit + atomic private write
  // -------------------------------------------------------------------------

  private async appendAudit(command: ScheduleCommand, outcome: ScheduleCommandOutcome): Promise<void> {
    const actor = boundedText(command.actor, MAX_ACTOR_LENGTH) ?? 'unknown'
    const action = typeof command.action === 'string' ? command.action.slice(0, 32) : 'unknown'
    const taskId = outcome.taskId ?? (typeof command.taskId === 'string' ? command.taskId.slice(0, 128) : '')
    const entry: ScheduleAuditEntry = {
      ts: this.hooks.now(),
      actor: ACTOR_RE.test(actor) ? actor : 'unknown',
      action: ACTIONS.has(action) ? action : 'unknown',
      taskId,
      state: outcome.state,
      summary: this.auditSummary(command),
    }
    try {
      await mkdir(this.hooks.stateDir, { recursive: true, mode: 0o700 })
      await this.checkFile(this.auditFile)
      await appendFile(this.auditFile, JSON.stringify(entry) + '\n', { mode: 0o600 })
      this.auditWrites += 1
      if (this.auditWrites % 16 === 0) await this.trimAudit()
    } catch (cause) {
      this.log('warn', 'schedule audit append failed')
      void cause
    }
  }

  private auditSummary(command: ScheduleCommand): string {
    if (command.spec) {
      const validated = validateSpec(command.spec, this.hooks.now())
      if (validated.ok) return specSummary(validated.spec).slice(0, MAX_SUMMARY_LENGTH)
    }
    const fields: string[] = []
    if (command.title !== undefined) fields.push('title')
    if (command.notify !== undefined) fields.push('notify')
    if (command.delivery !== undefined) fields.push('delivery')
    if (command.expectedUpdatedAt !== undefined) fields.push('revision')
    const summary = fields.length
      ? `${command.action}:${fields.join(',')}`
      : String(command.action)
    return summary.slice(0, MAX_SUMMARY_LENGTH)
  }

  private async trimAudit(): Promise<void> {
    const raw = await readFile(this.auditFile, 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean).slice(-MAX_AUDIT)
    await this.privateWrite(this.auditFile, lines.join('\n') + '\n')
  }

  private async readAudit(): Promise<ScheduleAuditEntry[]> {
    try {
      await this.checkFile(this.auditFile)
      const raw = await readFile(this.auditFile, 'utf8')
      return raw.trim().split('\n').filter(Boolean).slice(-MAX_AUDIT)
        .map((line) => this.parseAuditLine(line))
        .filter((entry): entry is ScheduleAuditEntry => entry !== undefined)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      this.log('warn', 'schedule audit read failed')
      void cause
      return []
    }
  }

  private parseAuditLine(line: string): ScheduleAuditEntry | undefined {
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (!value || typeof value !== 'object') return undefined
      const state = value.state
      if (typeof state !== 'string' || !OUTCOME_STATES.has(state)) return undefined
      return {
        ts: typeof value.ts === 'number' && Number.isFinite(value.ts) ? Math.floor(value.ts) : 0,
        actor: typeof value.actor === 'string' ? value.actor.slice(0, MAX_ACTOR_LENGTH) : 'unknown',
        action: typeof value.action === 'string' ? value.action.slice(0, 32) : 'unknown',
        taskId: typeof value.taskId === 'string' ? value.taskId.slice(0, 128) : '',
        state: state as ScheduleCommandOutcome['state'],
        summary: typeof value.summary === 'string' ? value.summary.slice(0, MAX_SUMMARY_LENGTH) : '',
      }
    } catch {
      return undefined
    }
  }

  private async publishReadModel(model: ScheduleReadModel): Promise<void> {
    await this.privateWrite(this.opsFile, JSON.stringify(model) + '\n')
  }

  /** Atomic 0600 write: temp + rename, never a plain writeFile on the final path. */
  private async privateWrite(file: string, content: string): Promise<void> {
    await mkdir(this.hooks.stateDir, { recursive: true, mode: 0o700 })
    await this.checkFile(file)
    const temp = file + '.' + randomUUID() + '.tmp'
    try {
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      await rename(temp, file)
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  private async checkFile(file: string): Promise<void> {
    try {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe schedule state file')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  private syncSessionIds(state: DeliveryState): void {
    for (const sessionId of Object.values(state.sessions)) {
      if (typeof sessionId === 'string' && sessionId) this.taskSessionIds.add(sessionId)
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.hooks.logger[level](message)
  }
}
