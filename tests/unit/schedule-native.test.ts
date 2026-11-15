import { describe, expect, it } from 'vitest'
import type { CordisLike } from '../../src/types.js'
import {
  createNativeSchedulePort, isScheduleNativeError, ScheduleNativeError,
} from '../../src/schedule/native.js'
import type {
  NativeCreateRequest, NativeEditRequest, NativeSchedulePort,
} from '../../src/schedule/native.js'

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    scheduledAt: '2026-01-02T01:00:00.000Z',
    deliveredAt: '2026-01-02T01:00:01.000Z',
    messageId: 'msg-1',
    targetSessionId: 'sess-1',
    prompt: 'summarize today',
    ...overrides,
  }
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'schedule-1',
    kind: 'daily',
    title: 'Daily briefing',
    prompt: 'summarize today',
    scheduledAt: '2026-01-03T01:00:00.000Z',
    time: '09:00:00',
    timeZone: 'Asia/Shanghai',
    target: { kind: 'session', sessionId: 'sess-1' },
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastDelivery: delivery(),
    ...overrides,
  }
}

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    list: async () => ({ items: [entry()], shown: 1, total: 1, limit: 500, offset: 0 }),
    view: async () => entry(),
    history: async () => ({
      id: 'schedule-1', records: [delivery()],
      earlierRecordsUnavailable: false, earlierRecordsPruned: false,
    }),
    create: async () => entry(),
    edit: async () => entry(),
    run: async () => entry(),
    deleteInactive: async () => ({ deleted: 2 }),
    deliveryLimits: () => ({ newSessionIntervalSeconds: 60 }),
    ...overrides,
  }
}

function fakeCtx(service: unknown): CordisLike {
  return {
    get: (name) => (name === 'schedule' ? service : undefined),
    provide: () => () => {},
    on: () => () => true,
    effect: (fn) => fn(),
  }
}

const createReq: NativeCreateRequest = {
  title: 'Daily briefing',
  prompt: 'summarize today',
  timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } },
  target: { kind: 'session', sessionId: 'sess-1' },
}

describe('createNativeSchedulePort — resolution', () => {
  it('wraps a fully-shaped ctx.get("schedule") service', () => {
    const port = createNativeSchedulePort(fakeCtx(makeService()))
    expect(port).toBeDefined()
    for (const method of ['list', 'view', 'history', 'create', 'edit', 'run', 'deleteInactive', 'deliveryLimits']) {
      expect(typeof (port as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('returns undefined when the service is absent, throws, or is incomplete', () => {
    expect(createNativeSchedulePort(fakeCtx(undefined))).toBeUndefined()
    expect(createNativeSchedulePort(fakeCtx(null))).toBeUndefined()
    expect(createNativeSchedulePort(fakeCtx('not-a-service'))).toBeUndefined()
    const throwing: CordisLike = {
      ...fakeCtx(undefined),
      get: () => { throw new Error('boom') },
    }
    expect(createNativeSchedulePort(throwing)).toBeUndefined()
    expect(createNativeSchedulePort(fakeCtx({ list: async () => ({ items: [] }) }))).toBeUndefined()
  })
})

describe('createNativeSchedulePort — normalized success results', () => {
  it('normalizes list, view, history, create, edit, run, deleteInactive and deliveryLimits', async () => {
    const port = createNativeSchedulePort(fakeCtx(makeService())) as NativeSchedulePort

    const list = await port.list({ limit: 500 })
    expect(isScheduleNativeError(list)).toBe(false)
    if (!isScheduleNativeError(list)) {
      expect(list.items).toHaveLength(1)
      expect(list.items[0]).toMatchObject({
        id: 'schedule-1', kind: 'daily', title: 'Daily briefing',
        timeZone: 'Asia/Shanghai', status: 'active',
        target: { kind: 'session', sessionId: 'sess-1' },
      })
      expect(list.items[0]!.lastDelivery).toMatchObject({ messageId: 'msg-1', targetSessionId: 'sess-1' })
      expect(list.total).toBe(1)
      expect(list.limit).toBe(500)
    }

    const view = await port.view({ id: 'schedule-1' })
    expect(isScheduleNativeError(view)).toBe(false)
    expect(view).toMatchObject({ id: 'schedule-1', kind: 'daily' })

    const history = await port.history({ id: 'schedule-1', limit: 20 })
    expect(isScheduleNativeError(history)).toBe(false)
    if ('records' in history) {
      expect(history.records).toHaveLength(1)
      expect(history.records[0]).toMatchObject({ messageId: 'msg-1', targetSessionId: 'sess-1' })
    }

    expect(await port.create(createReq)).toMatchObject({ id: 'schedule-1', kind: 'daily' })
    const limits = await port.deliveryLimits()
    expect(limits).toEqual({ newSessionIntervalSeconds: 60 })
    expect(await port.deleteInactive()).toEqual({ deleted: 2 })
  })

  it('handles view / edit / run miss, conflict and pending without throwing', async () => {
    const miss = createNativeSchedulePort(fakeCtx(makeService({
      view: async () => ({ code: 'schedule_not_found', id: 'schedule-1' }),
      edit: async () => ({ code: 'schedule_conflict', id: 'schedule-1' }),
      run: async () => ({ code: 'schedule_execution_pending', id: 'schedule-1' }),
    }))) as NativeSchedulePort

    expect(await miss.view({ id: 'schedule-1' })).toEqual({ code: 'schedule_not_found', id: 'schedule-1' })
    const editReq: NativeEditRequest = { id: 'schedule-1', action: 'update', patch: { active: false } }
    expect(await miss.edit(editReq)).toEqual({ code: 'schedule_conflict', id: 'schedule-1' })
    expect(await miss.run({ id: 'schedule-1' })).toEqual({ code: 'schedule_execution_pending', id: 'schedule-1' })

    const notFound = createNativeSchedulePort(fakeCtx(makeService({
      edit: async () => ({ code: 'schedule_not_found', id: 'schedule-1' }),
      run: async () => ({ code: 'schedule_not_found', id: 'schedule-1' }),
    }))) as NativeSchedulePort
    expect(await notFound.edit(editReq)).toEqual({ code: 'schedule_not_found', id: 'schedule-1' })
    expect(await notFound.run({ id: 'schedule-1' })).toEqual({ code: 'schedule_not_found', id: 'schedule-1' })
  })

  it('normalizes edit delete and history cursor miss', async () => {
    const port = createNativeSchedulePort(fakeCtx(makeService({
      edit: async () => ({ id: 'schedule-1', deleted: true }),
      history: async () => ({ code: 'delivery_cursor_not_found', id: 'schedule-1' }),
    }))) as NativeSchedulePort
    expect(await port.edit({ id: 'schedule-1', action: 'delete' })).toEqual({ id: 'schedule-1', deleted: true })
    expect(await port.history({ id: 'schedule-1', limit: 20 })).toEqual({ code: 'delivery_cursor_not_found', id: 'schedule-1' })
  })

  it('forwards request arguments to the service', async () => {
    let listArgs: unknown
    let createArgs: unknown
    const port = createNativeSchedulePort(fakeCtx(makeService({
      list: async (req: unknown) => { listArgs = req; return { items: [], total: 0, limit: 500, offset: 0 } },
      create: async (req: unknown) => { createArgs = req; return entry() },
    }))) as NativeSchedulePort
    await port.list({ limit: 500 })
    await port.create(createReq)
    expect(listArgs).toEqual({ limit: 500 })
    expect(createArgs).toEqual(createReq)
  })
})

describe('createNativeSchedulePort — bounded error wrapping', () => {
  it('converts synchronous and asynchronous rejections into ScheduleNativeError without raw text', async () => {
    const secret = 'SECRET token=abc /home/private/prompt.txt'
    const syncPort = createNativeSchedulePort(fakeCtx(makeService({
      create: () => { throw new Error(secret) },
    }))) as NativeSchedulePort
    const asyncPort = createNativeSchedulePort(fakeCtx(makeService({
      create: async () => { throw new Error(secret) },
    }))) as NativeSchedulePort

    for (const port of [syncPort, asyncPort]) {
      const result = await port.create(createReq)
      expect(isScheduleNativeError(result)).toBe(true)
      const error = result as ScheduleNativeError
      expect(error).toBeInstanceOf(ScheduleNativeError)
      expect(error.message).not.toContain('SECRET')
      expect(error.message).not.toContain('/home/private')
      expect(error.message).toBe('native schedule service error')
      expect(error.kind).toBe('native_error')
      expect(error.code).toBe('native_error')
    }
  })

  it('classifies ScheduleInputError-style rejection codes without leaking them raw', async () => {
    const inputErr = Object.assign(new Error('raw internal detail'), { code: 'invalid_prompt' })
    const port = createNativeSchedulePort(fakeCtx(makeService({
      create: () => { throw inputErr },
    }))) as NativeSchedulePort
    const result = await port.create(createReq) as ScheduleNativeError
    expect(isScheduleNativeError(result)).toBe(true)
    expect(result.kind).toBe('input_invalid')
    expect(result.code).toBe('invalid_prompt')
    expect(result.message).not.toContain('raw internal detail')
  })

  it('classifies remote schedule errors and not-found / conflict / pending rejections', async () => {
    const cases: Array<{ code: string; extra?: Record<string, unknown>; kind: string }> = [
      { code: 'schedule/input-invalid', extra: { details: { code: 'invalid_time_zone' } }, kind: 'input_invalid' },
      { code: 'schedule_not_found', kind: 'not_found' },
      { code: 'schedule_conflict', kind: 'conflict' },
      { code: 'schedule_execution_pending', kind: 'execution_pending' },
    ]
    for (const c of cases) {
      const err = Object.assign(new Error('secret detail'), { code: c.code }, c.extra ?? {})
      const port = createNativeSchedulePort(fakeCtx(makeService({
        create: () => { throw err },
      }))) as NativeSchedulePort
      const result = await port.create(createReq) as ScheduleNativeError
      expect(result.kind).toBe(c.kind)
      expect(result.message).not.toContain('secret detail')
      expect(result.code.length).toBeLessThanOrEqual(64)
    }
  })

  it('returns a bounded invalid_result error for malformed native responses', async () => {
    const port = createNativeSchedulePort(fakeCtx(makeService({
      create: async () => ({ nonsense: true }),
      list: async () => 42,
    }))) as NativeSchedulePort
    expect(await port.create(createReq)).toMatchObject({ kind: 'native_error', code: 'invalid_result' })
    expect(await port.list({ limit: 500 })).toMatchObject({ kind: 'native_error', code: 'invalid_result' })
  })
})
