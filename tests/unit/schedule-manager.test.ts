import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { silentLogger } from '../../src/util/logger.js'
import type { ObservedScheduleTurn } from '../../src/types.js'
import { ScheduleNativeError } from '../../src/schedule/native.js'
import { CARD_TEXT_MAX } from '../../src/schedule/card.js'
import type {
  NativeCreateRequest, NativeEditRequest, NativeSchedulePort, NativeTask,
} from '../../src/schedule/native.js'
import { ScheduleManager } from '../../src/schedule/manager.js'
import type {
  FeishuDeliveryInput, ScheduleCommand, ScheduleManagerHooks, ScheduleRunRecord,
} from '../../src/schedule/manager.js'

const FAKE_NOW = Date.parse('2026-01-01T00:00:00.000Z')

const dirs: string[] = []
const managers: ScheduleManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try { await manager.stop() } catch { /* best effort */ }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'feishu-schedule-'))
  dirs.push(dir)
  return dir
}
function track<T extends ScheduleManager>(manager: T): T {
  managers.push(manager)
  return manager
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface SentCall {
  botId: string
  target: { chatId: string; text: string; format?: 'text' | 'markdown'; card?: Record<string, unknown> }
  key: string
}
interface HookSpy {
  hooks: ScheduleManagerHooks
  sent: SentCall[]
  sessionsCreated: string[]
  sessionsReleased: string[]
  setNow: (value: number) => void
  setTargetOk: (ok: boolean) => void
}
function makeHooks(stateDir: string, overrides: Partial<ScheduleManagerHooks> = {}): HookSpy {
  let now = FAKE_NOW
  let targetOk = true
  const sent: SentCall[] = []
  const sessionsCreated: string[] = []
  const sessionsReleased: string[] = []
  const hooks: ScheduleManagerHooks = {
    logger: silentLogger,
    stateDir,
    now: () => now,
    isStopped: () => false,
    ensureTaskSession: async (clientRef) => {
      sessionsCreated.push(clientRef)
      return `sess-${clientRef}`
    },
    releaseTaskSession: async (sessionId) => { sessionsReleased.push(sessionId) },
    validateFeishuTarget: async () => (targetOk ? { ok: true } : { ok: false, reason: 'denied' }),
    sendFeishu: async (botId, target, idempotencyKey) => {
      sent.push({ botId, target, key: idempotencyKey })
      return true
    },
    ...overrides,
  }
  return {
    hooks, sent, sessionsCreated, sessionsReleased,
    setNow: (value) => { now = value },
    setTargetOk: (ok) => { targetOk = ok },
  }
}

interface PortCalls {
  list: number
  history: number
  view: string[]
  create: NativeCreateRequest[]
  edit: NativeEditRequest[]
  run: string[]
  deleteInactive: number
  deliveryLimits: number
}
function taskFromCreate(id: string, req: NativeCreateRequest): NativeTask {
  const base = {
    id, title: req.title, prompt: req.prompt,
    scheduledAt: '2026-01-03T01:00:00.000Z',
    target: { kind: 'session' as const, sessionId: req.target?.sessionId ?? 'sess' },
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const timing = req.timing
  switch (timing.kind) {
    case 'daily':
      return { ...base, kind: 'daily', time: timing.daily.time, timeZone: timing.daily.time_zone }
    case 'weekly':
      return { ...base, kind: 'weekly', time: timing.weekly.time, timeZone: timing.weekly.time_zone, weekdays: timing.weekly.weekdays }
    case 'every':
      return { ...base, kind: 'every', everySeconds: timing.every_seconds }
    case 'cron':
      return { ...base, kind: 'cron', expression: timing.cron.expression, timeZone: timing.cron.time_zone }
    default:
      return { ...base, kind: 'at' }
  }
}
function dailyTask(id: string, overrides: Partial<NativeTask> = {}): NativeTask {
  return {
    id, kind: 'daily', title: 'Daily', prompt: 'summarize',
    scheduledAt: '2026-01-03T01:00:00.000Z',
    time: '09:00:00', timeZone: 'Asia/Shanghai',
    target: { kind: 'session', sessionId: `sess-${id}` },
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
function fakePort() {
  const tasks = new Map<string, NativeTask>()
  const calls: PortCalls = {
    list: 0, history: 0, view: [], create: [], edit: [], run: [], deleteInactive: 0, deliveryLimits: 0,
  }
  let seq = 0
  const port: NativeSchedulePort = {
    list: async () => {
      calls.list += 1
      return { items: [...tasks.values()], total: tasks.size, limit: 500, offset: 0 }
    },
    view: async ({ id }) => {
      calls.view.push(id)
      return tasks.get(id) ?? { code: 'schedule_not_found', id }
    },
    history: async () => {
      calls.history += 1
      return { records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false }
    },
    create: async (req) => {
      calls.create.push(req)
      seq += 1
      const id = `schedule-${seq}`
      const task = taskFromCreate(id, req)
      tasks.set(id, task)
      return task
    },
    edit: async (req) => {
      calls.edit.push(req)
      if (req.action === 'delete') {
        const existed = tasks.delete(req.id)
        return existed ? { id: req.id, deleted: true } : { code: 'schedule_not_found', id: req.id }
      }
      const current = tasks.get(req.id)
      if (!current) return { code: 'schedule_not_found', id: req.id }
      const updated: NativeTask = {
        ...current,
        ...(req.patch.title !== undefined ? { title: req.patch.title } : {}),
        ...(req.patch.prompt !== undefined ? { prompt: req.patch.prompt } : {}),
        ...(req.patch.active === false ? { status: 'paused' as const } : {}),
        ...(req.patch.active === true ? { status: 'active' as const } : {}),
      }
      tasks.set(req.id, updated)
      return updated
    },
    run: async ({ id }) => {
      calls.run.push(id)
      return tasks.get(id) ?? { code: 'schedule_not_found', id }
    },
    deleteInactive: async () => { calls.deleteInactive += 1; return { deleted: 0 } },
    deliveryLimits: async () => { calls.deliveryLimits += 1; return { newSessionIntervalSeconds: 60 } },
  }
  return { port, tasks, calls }
}

const DELIVERY: FeishuDeliveryInput = {
  botId: 'default', chatId: 'oc_abc', chatType: 'group', senderId: 'ou_xyz',
}
function createCommand(overrides: Partial<ScheduleCommand> = {}): ScheduleCommand {
  return {
    action: 'create', actor: 'dsh-web-admin', clientRef: 'client-1',
    title: 'Daily news', prompt: 'SECRET_PROMPT_SUMMARIZE',
    spec: { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' },
    notify: 'both',
    delivery: DELIVERY,
    ...overrides,
  }
}
function makeRun(index: number): ScheduleRunRecord {
  return {
    ts: FAKE_NOW + index, taskId: 'schedule-0', messageId: `msg-${index}`,
    sessionRef: 'abcdef0123456789', status: 'success', elapsedMs: 100,
    delivered: true, error: null,
  }
}

async function boot(overrides: Partial<ScheduleManagerHooks> = {}) {
  const dir = await tmpDir()
  const spy = makeHooks(dir, overrides)
  const fp = fakePort()
  const manager = track(new ScheduleManager(spy.hooks))
  return { dir, spy, fp, manager }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScheduleManager — availability', () => {
  it('is unavailable until a port is attached; refresh() before start() publishes a model', async () => {
    const { dir, manager } = await boot()
    expect(manager.available).toBe(false)
    expect(manager.unavailableReason).toContain('not mounted')
    await manager.refresh() // safe before start()
    expect(manager.snapshot().available).toBe(false)
    expect(manager.snapshot().reason).toContain('not mounted')
    const outcome = await manager.execute(createCommand())
    expect(outcome.state).toBe('error')
    expect(outcome.message).toContain('unavailable')
    const raw = JSON.parse(await readFile(path.join(dir, 'ops-schedule.json'), 'utf8'))
    expect(raw.available).toBe(false)
    expect(raw.version).toBe(1)
  })

  it('attachNative / refresh / onChanged are safe before start(); stop() is idempotent', async () => {
    const { manager, fp } = await boot()
    manager.onChanged() // before start
    manager.attachNative(fp.port)
    await manager.refresh() // before start
    expect(manager.available).toBe(true)
    expect(manager.unavailableReason).toBeUndefined()
    expect(manager.snapshot().available).toBe(true)
    await manager.stop()
    await manager.stop() // idempotent
  })

  it('snapshot() is synchronous and reflects attachNative immediately', async () => {
    const { manager, fp } = await boot()
    expect(manager.snapshot().available).toBe(false)
    manager.attachNative(fp.port)
    expect(manager.snapshot().available).toBe(true)
    expect(typeof manager.snapshot()).toBe('object')
  })
})

describe('ScheduleManager — create and command execution', () => {
  it('create validates the target, reserves a session, passes target, and persists the sidecar', async () => {
    let validated: FeishuDeliveryInput | undefined
    const { dir, spy, fp, manager } = await boot({
      validateFeishuTarget: async (target) => { validated = target; return { ok: true } },
    })
    manager.attachNative(fp.port)
    await manager.start()
    const outcome = await manager.execute(createCommand())
    expect(outcome.state).toBe('completed')
    expect(outcome.taskId).toBe('schedule-1')
    expect(validated).toMatchObject({ chatId: 'oc_abc', chatType: 'group' })
    expect(spy.sessionsCreated).toEqual(['client-1'])
    expect(fp.calls.create).toEqual([{
      title: 'Daily news', prompt: 'SECRET_PROMPT_SUMMARIZE',
      timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } },
      target: { kind: 'session', sessionId: 'sess-client-1' },
    }])
    // Session registered immediately (before/independent of a refresh).
    expect(manager.isTaskSession('sess-client-1')).toBe(true)

    await manager.refresh()
    const model = manager.snapshot()
    expect(model.tasks).toHaveLength(1)
    expect(model.tasks[0]!.target.sessionId).toBe('sess-client-1') // full raw id
    expect(model.tasks[0]!.delivery).toMatchObject({ chatId: 'oc_abc', notify: 'both' })
    expect(model.tasks[0]!.spec).toMatchObject({ kind: 'daily' })

    const sidecar = JSON.parse(await readFile(path.join(dir, 'schedule-delivery.json'), 'utf8'))
    expect(sidecar.sessions['schedule-1']).toBe('sess-client-1')
    expect(sidecar.configs['schedule-1']).toMatchObject({ chatId: 'oc_abc', notify: 'both' })
  })

  it('rejects a delivery target that fails the allowlist, without calling native', async () => {
    const { spy, fp, manager } = await boot({
      validateFeishuTarget: async () => ({ ok: false, reason: 'group denied' }),
    })
    manager.attachNative(fp.port)
    const outcome = await manager.execute(createCommand())
    expect(outcome.state).toBe('rejected')
    expect(outcome.message).toContain('not allowed')
    expect(fp.calls.create).toHaveLength(0)
    expect(spy.sessionsCreated).toHaveLength(0)
  })

  it('validates every field authoritatively before calling native', async () => {
    const { fp, manager } = await boot()
    manager.attachNative(fp.port)
    const invalids: ScheduleCommand[] = [
      createCommand({ spec: { kind: 'daily', time: '9:00', timeZone: 'UTC' } }),
      createCommand({ title: '' }),
      createCommand({ prompt: 'x'.repeat(4001) }),
      createCommand({ actor: 'a'.repeat(100) }),
      { action: 'pause', actor: 'dsh-web-admin', taskId: 'bad id!' },
      { action: 'pause', actor: 'dsh-web-admin', taskId: 'schedule-1', expectedUpdatedAt: 'garbage' },
      { action: 'nope' as unknown as ScheduleCommand['action'], actor: 'dsh-web-admin' },
    ]
    for (const command of invalids) {
      const outcome = await manager.execute(command)
      expect(outcome.state).toBe('rejected')
    }
    expect(fp.calls.create).toHaveLength(0)
  })

  it('update sends only changed fields (timing mapped, target unchanged)', async () => {
    const { fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.execute(createCommand())
    const outcome = await manager.execute({
      action: 'update', actor: 'dsh-web-admin', taskId: 'schedule-1',
      title: 'Renamed',
      spec: { kind: 'weekly', time: '10:30:00', timeZone: 'Asia/Shanghai', weekdays: [5, 1] },
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(outcome.state).toBe('completed')
    expect(fp.calls.edit).toHaveLength(1)
    const req = fp.calls.edit[0] as Extract<NativeEditRequest, { action: 'update' }>
    expect(req.action).toBe('update')
    expect(req.patch).toEqual({
      title: 'Renamed',
      timing: { kind: 'weekly', weekly: { time: '10:30:00', time_zone: 'Asia/Shanghai', weekdays: [1, 5] } },
    })
    expect(req.patch).not.toHaveProperty('target')
    expect(req.expectedUpdatedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('pause / resume set patch.active; delete-inactive and refresh route correctly', async () => {
    const { fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.execute(createCommand())
    expect((await manager.execute({ action: 'pause', actor: 'dsh-web-admin', taskId: 'schedule-1' })).state).toBe('completed')
    expect((await manager.execute({ action: 'resume', actor: 'dsh-web-admin', taskId: 'schedule-1' })).state).toBe('completed')
    expect((fp.calls.edit[0] as Extract<NativeEditRequest, { action: 'update' }>).patch).toEqual({ active: false })
    expect((fp.calls.edit[1] as Extract<NativeEditRequest, { action: 'update' }>).patch).toEqual({ active: true })
    expect((await manager.execute({ action: 'delete-inactive', actor: 'dsh-web-admin' })).state).toBe('completed')
    expect(fp.calls.deleteInactive).toBe(1)
    expect((await manager.execute({ action: 'refresh', actor: 'dsh-web-admin' })).state).toBe('completed')
    expect(fp.calls.list).toBeGreaterThan(0)
  })

  it('run returns completed; pending -> rejected; not-found -> not-found', async () => {
    const { fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.execute(createCommand())
    expect((await manager.execute({ action: 'run', actor: 'dsh-web-admin', taskId: 'schedule-1' })).state).toBe('completed')
    expect(fp.calls.run).toEqual(['schedule-1'])

    fp.port.run = async () => ({ code: 'schedule_execution_pending', id: 'schedule-1' })
    expect((await manager.execute({ action: 'run', actor: 'dsh-web-admin', taskId: 'schedule-1' })))
      .toMatchObject({ state: 'rejected', message: 'execution pending' })
    fp.port.run = async () => ({ code: 'schedule_not_found', id: 'schedule-1' })
    expect((await manager.execute({ action: 'run', actor: 'dsh-web-admin', taskId: 'schedule-1' })).state).toBe('not-found')
  })

  it('delete removes the sidecar and releases the reserved session', async () => {
    const { dir, spy, fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.execute(createCommand())
    expect(manager.isTaskSession('sess-client-1')).toBe(true)
    const outcome = await manager.execute({ action: 'delete', actor: 'dsh-web-admin', taskId: 'schedule-1' })
    expect(outcome.state).toBe('completed')
    expect(spy.sessionsReleased).toContain('sess-client-1')
    expect(manager.isTaskSession('sess-client-1')).toBe(false)
    const sidecar = JSON.parse(await readFile(path.join(dir, 'schedule-delivery.json'), 'utf8'))
    expect(sidecar.configs['schedule-1']).toBeUndefined()
    expect(sidecar.sessions['schedule-1']).toBeUndefined()
  })

  it('maps native code results to conflict / not-found', async () => {
    const { fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.execute(createCommand())
    fp.port.edit = async () => ({ code: 'schedule_conflict', id: 'schedule-1' })
    expect((await manager.execute({ action: 'pause', actor: 'dsh-web-admin', taskId: 'schedule-1' })).state).toBe('conflict')
    fp.port.edit = async () => ({ code: 'schedule_not_found', id: 'schedule-1' })
    expect((await manager.execute({ action: 'pause', actor: 'dsh-web-admin', taskId: 'schedule-1' })).state).toBe('not-found')
  })

  it('maps ScheduleNativeError kinds to bounded outcomes', async () => {
    const { fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.execute(createCommand())
    fp.port.edit = async () => new ScheduleNativeError('input_invalid', 'invalid_prompt')
    expect((await manager.execute({ action: 'pause', actor: 'dsh-web-admin', taskId: 'schedule-1' })))
      .toMatchObject({ state: 'rejected' })
    fp.port.edit = async () => new ScheduleNativeError('conflict', 'schedule_conflict')
    expect((await manager.execute({ action: 'pause', actor: 'dsh-web-admin', taskId: 'schedule-1' })).state).toBe('conflict')
    fp.port.edit = async () => new ScheduleNativeError('not_found', 'schedule_not_found')
    expect((await manager.execute({ action: 'pause', actor: 'dsh-web-admin', taskId: 'schedule-1' })).state).toBe('not-found')
    fp.port.edit = async () => new ScheduleNativeError('native_error', 'native_error')
    expect((await manager.execute({ action: 'pause', actor: 'dsh-web-admin', taskId: 'schedule-1' })))
      .toMatchObject({ state: 'error', message: 'native schedule error' })
  })
})

describe('ScheduleManager — audit and read model', () => {
  it('appends one bounded audit entry per command, never prompt text, mode 0600', async () => {
    const { dir, manager, fp } = await boot()
    manager.attachNative(fp.port)
    await manager.execute(createCommand())
    await manager.execute({ action: 'pause', actor: 'dsh-web-admin', taskId: 'schedule-1' })
    const file = path.join(dir, 'schedule-audit.jsonl')
    const raw = await readFile(file, 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(raw).not.toContain('SECRET_PROMPT_SUMMARIZE')
    const first = JSON.parse(lines[0]!)
    expect(first).toMatchObject({ actor: 'dsh-web-admin', action: 'create', state: 'completed', taskId: 'schedule-1' })
    expect(first.summary).toContain('daily')
    expect(first.summary.length).toBeLessThanOrEqual(200)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('writes ops-schedule.json atomically (0600) with no leftover temp files', async () => {
    const { dir, manager, fp } = await boot()
    manager.attachNative(fp.port)
    await manager.refresh()
    const file = path.join(dir, 'ops-schedule.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const model = JSON.parse(await readFile(file, 'utf8'))
    expect(model.version).toBe(1)
    expect(model.ts).toBe(FAKE_NOW)
    expect(model.available).toBe(true)
    expect((await readdir(dir)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('bounds tasks, deliveries, runs and audit in the read model', async () => {
    const { dir, manager, fp } = await boot()
    for (let i = 0; i < 250; i += 1) fp.tasks.set(`schedule-${i}`, dailyTask(`schedule-${i}`))
    fp.port.history = async () => ({
      records: Array.from({ length: 50 }, (_, k) => ({
        scheduledAt: '2026-01-02T01:00:00.000Z', deliveredAt: '2026-01-02T01:00:01.000Z',
        messageId: `msg-${k}`, targetSessionId: 'sess-1',
      })),
      earlierRecordsUnavailable: false, earlierRecordsPruned: false,
    })
    await writeFile(path.join(dir, 'schedule-runs.json'), JSON.stringify({
      version: 1, runs: Array.from({ length: 250 }, (_, k) => makeRun(k)), dedupe: [], notices: [],
    }))
    await writeFile(path.join(dir, 'schedule-audit.jsonl'),
      Array.from({ length: 250 }, () => JSON.stringify({
        ts: FAKE_NOW, actor: 'dsh-web-admin', action: 'create', taskId: 'schedule-0',
        state: 'completed', summary: 'daily 09:00 UTC',
      }) + '\n').join(''))
    manager.attachNative(fp.port)
    await manager.refresh()
    const model = manager.snapshot()
    expect(model.tasks).toHaveLength(200)
    expect(model.deliveries['schedule-0']).toHaveLength(20)
    expect(model.runs).toHaveLength(200)
    expect(model.audit).toHaveLength(200)
    expect(model.limits).toEqual({ newSessionIntervalSeconds: 60 })
  })
})

describe('ScheduleManager — observed turns and fallback', () => {
  const successTurn: ObservedScheduleTurn = {
    sessionId: 'sess-client-1', messageId: 'msg-xyz', text: 'Hello '.repeat(300),
    status: 'success', elapsedMs: 1200, model: 'deepseek-chat', tokens: 42,
  }

  it('records precise schedule usage once, including silent and missing-usage turns', async () => {
    const recordUsage = vi.fn(async (_value: Parameters<NonNullable<ScheduleManagerHooks['recordUsage']>>[0]) => {})
    const { fp, manager } = await boot({ recordUsage })
    manager.attachNative(fp.port)
    await manager.execute(createCommand())
    const usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 }
    await manager.onScheduleTurn({ ...successTurn, usage, text: 'NO_REPLY' })
    await manager.onScheduleTurn({ ...successTurn, usage, text: 'NO_REPLY' })
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      ref: 'schedule:msg-xyz', botId: 'default', session: 'sess-client-1', usage, status: 'done',
    }))
    await manager.onScheduleTurn({ ...successTurn, messageId: 'unknown-usage', status: 'failed' })
    expect(recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      ref: 'schedule:unknown-usage', status: 'failed',
    }))
    expect(recordUsage.mock.calls[1]?.[0]).not.toHaveProperty('usage')
  })

  it('onScheduleTurn sends the truncated result, records a run and dedupes', async () => {
    const { dir, spy, fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.execute(createCommand())
    await manager.onScheduleTurn(successTurn)
    expect(spy.sent).toHaveLength(1)
    expect(spy.sent[0]!.key).toBe('schedule:schedule-1:msg-xyz')
    expect(spy.sent[0]!.target.text.length).toBeLessThanOrEqual(CARD_TEXT_MAX)
    expect(spy.sent[0]!.target.text).not.toContain('sess-client-1')
    // Results are pushed as Feishu interactive cards, not plain text.
    expect(spy.sent[0]!.target.card).toHaveProperty('header.template', 'blue')
    expect(spy.sent[0]!.target.card).toHaveProperty('config.wide_screen_mode', true)
    await manager.onScheduleTurn(successTurn) // duplicate messageId
    expect(spy.sent).toHaveLength(1)

    await manager.refresh()
    expect(manager.snapshot().runs).toHaveLength(1)
    expect(manager.snapshot().runs[0]).toMatchObject({
      taskId: 'schedule-1', status: 'success', delivered: true, tokens: 42, model: 'deepseek-chat',
    })
    expect(manager.snapshot().runs[0]!.sessionRef).toMatch(/^[a-f0-9]{16}$/)
    const ledger = JSON.parse(await readFile(path.join(dir, 'schedule-runs.json'), 'utf8'))
    expect(ledger.dedupe).toContain('msg-xyz')
  })

  it('suppresses a short NO_REPLY (silent skip), but not a long report mentioning it', async () => {
    const { spy, fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.execute(createCommand({ notify: 'both' }))
    await manager.onScheduleTurn({ ...successTurn, messageId: 'msg-silent', text: 'NO_REPLY' })
    expect(spy.sent).toHaveLength(0)
    await manager.refresh()
    expect(manager.snapshot().runs[0]).toMatchObject({ status: 'skipped', delivered: false })

    await manager.onScheduleTurn({ ...successTurn, messageId: 'msg-long',
      text: '今日简报正文。'.repeat(40) + ' 不要输出 NO_REPLY 令牌。' })
    expect(spy.sent).toHaveLength(1)
    await manager.refresh()
    expect(manager.snapshot().runs.find((r) => r.messageId === 'msg-long'))
      .toMatchObject({ status: 'success', delivered: true })
  })

  it('respects notify=none, failure notices and the allowlist re-check', async () => {
    const { spy, fp, manager } = await boot()
    manager.attachNative(fp.port)
    // notify none -> no send, but a run is still recorded with delivered:false
    await manager.execute(createCommand({ notify: 'none' }))
    await manager.onScheduleTurn(successTurn)
    expect(spy.sent).toHaveLength(0)
    await manager.refresh()
    expect(manager.snapshot().runs[0]).toMatchObject({ delivered: false, status: 'success' })
  })

  it('sends a bounded failure notice (never raw text) for failed turns', async () => {
    const { spy, fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.execute(createCommand({ notify: 'both' }))
    const failed: ObservedScheduleTurn = {
      sessionId: 'sess-client-1', messageId: 'msg-fail', text: 'RAW_EXCEPTION_BODY /home/secret',
      status: 'failed', elapsedMs: 50,
    }
    await manager.onScheduleTurn(failed)
    expect(spy.sent).toHaveLength(1)
    expect(spy.sent[0]!.target.text).not.toContain('RAW_EXCEPTION_BODY')
    expect(spy.sent[0]!.target.text).toContain('failed')
    expect(spy.sent[0]!.target.card).toHaveProperty('header.template', 'orange')
    await manager.refresh()
    expect(manager.snapshot().runs[0]!.status).toBe('failed')

    // allowlist re-check failure -> no send, bounded error recorded
    spy.setTargetOk(false)
    await manager.onScheduleTurn({ ...successTurn, messageId: 'msg-denied', status: 'success' })
    expect(spy.sent).toHaveLength(1)
    await manager.refresh()
    const denied = manager.snapshot().runs.find((r) => r.messageId === 'msg-denied')
    expect(denied).toMatchObject({ delivered: false, error: 'target_rejected' })
  })

  it('sends one bounded fallback notice after the long grace, then never again', async () => {
    const { spy, fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.start()
    await manager.execute(createCommand({ notify: 'both' }))
    const task = fp.tasks.get('schedule-1')!
    fp.tasks.set('schedule-1', {
      ...task,
      lastDelivery: {
        scheduledAt: '2026-01-01T00:00:00.000Z',
        deliveredAt: '2026-01-01T00:00:00.000Z',
        messageId: 'm-fallback', targetSessionId: 'sess-client-1',
      },
    })
    spy.setNow(Date.parse('2026-01-01T00:02:00.000Z')) // 2min: still inside grace
    await manager.refresh()
    expect(spy.sent).toHaveLength(0)
    spy.setNow(Date.parse('2026-01-01T00:06:00.000Z')) // 6min: past grace
    await manager.refresh()
    expect(spy.sent).toHaveLength(1)
    expect(spy.sent[0]!.key).toBe('schedule:schedule-1:m-fallback:notice')
    expect(spy.sent[0]!.target.text).toContain('会话')
    expect(spy.sent[0]!.target.text).not.toContain('DSH')
    expect(spy.sent[0]!.target.text).not.toContain('sess-client-1')
    expect(spy.sent[0]!.target.card).toHaveProperty('header.template', 'orange')
    await manager.refresh()
    expect(spy.sent).toHaveLength(1) // marker persisted, no duplicate
    // The admin run history must explain the missing result instead of
    // showing only the outbound notice card.
    expect(manager.snapshot().runs.find((run) => run.messageId === 'm-fallback'))
      .toMatchObject({ status: 'skipped', delivered: false, error: 'execution result unavailable' })
  })

  it('does not send a fallback notice when a run already covers the delivery', async () => {
    const { spy, fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.start()
    await manager.execute(createCommand({ notify: 'both' }))
    const task = fp.tasks.get('schedule-1')!
    fp.tasks.set('schedule-1', {
      ...task,
      lastDelivery: {
        scheduledAt: '2026-01-01T00:00:00.000Z', deliveredAt: '2026-01-01T00:00:00.000Z',
        messageId: 'm-covered', targetSessionId: 'sess-client-1',
      },
    })
    await manager.onScheduleTurn({
      sessionId: 'sess-client-1', messageId: 'm-covered', text: 'ok', status: 'success', elapsedMs: 10,
    })
    spy.setNow(Date.parse('2026-01-01T00:06:00.000Z')) // past the long grace
    await manager.refresh()
    // Only the turn's own send, no extra notice.
    expect(spy.sent.map((s) => s.key)).toEqual(['schedule:schedule-1:m-covered'])
  })

  it('never races a slow running native turn with a fallback notice', async () => {
    const { spy, fp, manager } = await boot()
    manager.attachNative(fp.port)
    await manager.start()
    await manager.execute(createCommand({ notify: 'both' }))
    const task = fp.tasks.get('schedule-1')!
    fp.tasks.set('schedule-1', {
      ...task,
      executionActive: true,
      lastDelivery: {
        scheduledAt: '2026-01-01T00:00:00.000Z', deliveredAt: '2026-01-01T00:00:00.000Z',
        messageId: 'm-slow', targetSessionId: 'sess-client-1',
      },
    })
    spy.setNow(Date.parse('2026-01-01T00:09:00.000Z')) // well past grace, but still running
    await manager.refresh()
    expect(spy.sent).toHaveLength(0)
  })
})

describe('ScheduleManager — debounce', () => {
  it('onChanged debounces and triggers exactly one refresh', async () => {
    vi.useFakeTimers()
    try {
      const { fp, manager } = await boot()
      manager.attachNative(fp.port)
      await manager.start()
      const before = fp.calls.list
      manager.onChanged()
      manager.onChanged()
      manager.onChanged()
      await vi.advanceTimersByTimeAsync(300)
      expect(fp.calls.list).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('src/schedule/index.ts barrel', () => {
  it('re-exports the public API the Lead imports', async () => {
    const barrel = await import('../../src/schedule/index.js') as unknown as Record<string, unknown>
    for (const name of [
      'ScheduleManager', 'createNativeSchedulePort', 'isScheduleNativeError',
      'ScheduleNativeError', 'validateSpec', 'toNativeTiming', 'previewOccurrences',
      'nativeRecordToSpec', 'specSummary', 'boundedText', 'isValidTimeZone', 'sessionRef',
    ]) {
      expect(typeof barrel[name]).toBe('function')
    }
  })
})
