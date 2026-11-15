import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createGateway } from '../../src/index.js'
import { resolveConfig } from '../../src/config.js'
import { MockFeishuTransport } from '../../src/channel/mock-transport.js'
import { MockSessionBridge } from '../../src/session/mock-session-bridge.js'
import { createNativeSchedulePort } from '../../src/schedule/index.js'
import { silentLogger } from '../../src/util/logger.js'
import { tempDir } from '../helpers.js'
import type { CordisLike } from '../../src/types.js'

/**
 * End-to-end bridge coverage for Issue #19:
 * Web Admin command file -> Gateway mailbox -> native DSH schedule port ->
 * redacted read model -> durable Outbox -> Feishu chat.
 * Everything is in-memory / temp files; no credentials, network or live DSH.
 */

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

interface NativeCall { readonly method: string; readonly request: unknown }

/** A structural stand-in for the installed `ScheduleService` Host service. */
function fakeScheduleService() {
  const tasks = new Map<string, Record<string, unknown>>()
  const calls: NativeCall[] = []
  const conflictIds = new Set<string>()
  const nowIso = () => new Date().toISOString()
  const entry = (id: string, request: Record<string, unknown>): Record<string, unknown> => ({
    id,
    kind: 'daily',
    title: request.title ?? 'task',
    prompt: request.prompt ?? '',
    time: '09:00:00.000',
    timeZone: 'Asia/Shanghai',
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    target: request.target ?? { kind: 'session', sessionId: 'unknown' },
    involvedSessionIds: [],
    status: 'active',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  const service = {
    list: async (request?: { limit?: number; offset?: number; active?: boolean }) => {
      calls.push({ method: 'list', request: request ?? {} })
      const items = [...tasks.values()]
      return { items, shown: items.length, total: items.length,
        limit: request?.limit ?? 100, offset: request?.offset ?? 0 }
    },
    view: async ({ id }: { id: string }) => {
      calls.push({ method: 'view', request: { id } })
      return tasks.get(id) ?? { id, code: 'schedule_not_found' }
    },
    history: async ({ id, limit }: { id: string; limit: number }) => {
      calls.push({ method: 'history', request: { id, limit } })
      return { id, records: [], earlierRecordsUnavailable: false,
        earlierRecordsPruned: false, retention: { days: 30, records: 200 } }
    },
    create: async (request: Record<string, unknown>) => {
      calls.push({ method: 'create', request })
      const id = `schedule-${randomUUID()}`
      const created = entry(id, request)
      tasks.set(id, created)
      return created
    },
    edit: async (request: Record<string, unknown>) => {
      calls.push({ method: 'edit', request })
      const id = String(request.id)
      if (conflictIds.has(id)) return { id, code: 'schedule_conflict' }
      const existing = tasks.get(id)
      if (!existing) return { id, code: 'schedule_not_found' }
      if (request.action === 'delete') {
        tasks.delete(id)
        return { id, deleted: true }
      }
      const patch = (request.patch ?? {}) as Record<string, unknown>
      const updated = { ...existing, ...patch, updatedAt: nowIso() }
      tasks.set(id, updated)
      return updated
    },
    run: async ({ id }: { id: string }) => {
      calls.push({ method: 'run', request: { id } })
      return tasks.get(id) ?? { id, code: 'schedule_not_found' }
    },
    deleteInactive: async () => {
      calls.push({ method: 'deleteInactive', request: {} })
      return { deleted: 0 }
    },
    deliveryLimits: () => ({ newSessionIntervalSeconds: 60 }),
  }
  const ctx: CordisLike = {
    get: (name: string) => (name === 'schedule' ? service : undefined),
    provide: () => () => undefined,
    on: () => () => undefined,
    effect: (execute: () => unknown) => execute(),
  }
  return { ctx, calls, tasks, conflictIds }
}

async function setup(attach = true) {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const transport = new MockFeishuTransport('default')
  const bridge = new MockSessionBridge()
  const gateway = createGateway(resolveConfig({
    stateDir: dir,
    workspace: path.join(dir, 'shared-workspace'),
    bots: [{ id: 'default', enabled: true, domain: 'feishu' }],
    allowlist: ['ou_allowed123'],
    offline: true,
    autoConnect: true,
    diagnoseOnStart: false,
    sendRetries: 1,
    sendRetryBaseDelayMs: 1,
  }), { transports: [transport], bridge, logger: silentLogger })
  const native = fakeScheduleService()
  if (attach) gateway.scheduleManager.attachNative(createNativeSchedulePort(native.ctx))
  await gateway.start()
  cleanups.unshift(async () => { await gateway.stop() })
  return { gateway, bridge, transport, dir, native }
}

async function enqueue(dir: string, schedule: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  const folder = path.join(dir, 'ops-control', 'requests')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await writeFile(path.join(folder, id + '.json'), JSON.stringify({
    version: 1, id, ts: Date.now(), type: 'schedule', actor: 'dsh-web-admin', schedule,
  }), { mode: 0o600 })
  return id
}
async function resultFor(dir: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, 'ops-control', 'results', id + '.json'), 'utf8'))
}
async function readModel(dir: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(dir, 'ops-schedule.json'), 'utf8'))
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('wait condition not met')
}
const createCommand = (overrides: Record<string, unknown> = {}) => ({
  action: 'create',
  clientRef: randomUUID(),
  title: '每日新闻简报',
  prompt: '汇总今天的新闻',
  spec: { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' },
  notify: 'both',
  delivery: { botId: 'default', chatId: 'ou_allowed123', chatType: 'p2p', senderId: 'ou_allowed123' },
  ...overrides,
})

describe('native schedule command bridge', () => {
  it('creates a native task from a Web Admin command and publishes a redacted read model', async () => {
    const { gateway, bridge, dir, native } = await setup()
    const id = await enqueue(dir, createCommand())
    await gateway.pollOperatorCommands()
    const result = await resultFor(dir, id)
    expect(result).toMatchObject({ version: 1, type: 'schedule', state: 'completed' })

    const create = native.calls.find((call) => call.method === 'create')?.request as Record<string, any>
    expect(create).toBeTruthy()
    expect(create.timing).toMatchObject({ kind: 'daily',
      daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } })
    expect(create.target).toMatchObject({ kind: 'session', sessionId: expect.any(String) })
    expect(bridge.created).toHaveLength(1)
    expect(bridge.created[0]?.sessionId).toBe(create.target.sessionId)

    await gateway.scheduleManager.refresh()
    const model = await readModel(dir)
    expect(model.available).toBe(true)
    expect(model.tasks).toHaveLength(1)
    expect(model.tasks[0].title).toBe('每日新闻简报')
    expect(model.tasks[0].delivery.chatId).toBe('ou_allowed123')
    expect(model.audit.some((row: any) => row.action === 'create')).toBe(true)
  })

  it('rejects a delivery target that is not on the current allowlist', async () => {
    const { gateway, dir, native } = await setup()
    const id = await enqueue(dir, createCommand({
      delivery: { botId: 'default', chatId: 'ou_allowed123', chatType: 'p2p', senderId: 'ou_notallowed' },
    }))
    await gateway.pollOperatorCommands()
    expect((await resultFor(dir, id)).state).toBe('rejected')
    expect(native.calls.some((call) => call.method === 'create')).toBe(false)
  })

  it('forwards one observed schedule turn to Feishu exactly once', async () => {
    const { gateway, bridge, transport, dir } = await setup()
    const id = await enqueue(dir, createCommand())
    await gateway.pollOperatorCommands()
    expect((await resultFor(dir, id)).state).toBe('completed')
    await gateway.scheduleManager.refresh()
    const task = (await readModel(dir)).tasks[0]
    const sessionId = String(task.target.sessionId)

    bridge.emitScheduleTurn({ sessionId, messageId: 'msg-schedule-1',
      text: '今日简报内容', status: 'success', elapsedMs: 1200 })
    await until(() => transport.sent.some((message) => message.chatId === 'ou_allowed123'))
    const sent = transport.sent.find((message) => message.chatId === 'ou_allowed123')
    expect(sent?.text).toContain('今日简报内容')
    // A p2p target supplied as a user open_id must use receive_id_type=open_id.
    expect(sent?.receiveIdType).toBe('open_id')

    // The same native delivery id must never produce a duplicate Feishu message.
    bridge.emitScheduleTurn({ sessionId, messageId: 'msg-schedule-1',
      text: '今日简报内容', status: 'success', elapsedMs: 1200 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(transport.sent.filter((message) => message.chatId === 'ou_allowed123')).toHaveLength(1)

    await gateway.scheduleManager.refresh()
    const runs = (await readModel(dir)).runs as any[]
    expect(runs.some((run) => run.status === 'success' && run.delivered === true)).toBe(true)
  })

  it('supports pause/resume/run/delete and surfaces an optimistic conflict', async () => {
    const { gateway, dir, native } = await setup()
    const created = await enqueue(dir, createCommand())
    await gateway.pollOperatorCommands()
    await gateway.scheduleManager.refresh()
    const taskId = String((await readModel(dir)).tasks[0].id)

    for (const action of ['pause', 'resume', 'run', 'delete']) {
      const id = await enqueue(dir, { action, taskId })
      await gateway.pollOperatorCommands()
      expect((await resultFor(dir, id)).state).toBe('completed')
    }
    expect(native.calls.some((call) => call.method === 'run')).toBe(true)
    expect(native.calls.filter((call) => call.method === 'edit')).toHaveLength(3)
    expect(native.tasks.has(taskId)).toBe(false)

    native.conflictIds.add(taskId)
    const conflict = await enqueue(dir, { action: 'pause', taskId })
    await gateway.pollOperatorCommands()
    expect((await resultFor(dir, conflict)).state).toBe('conflict')
    expect(created).toBeTruthy()
  })

  it('reports the native service as unavailable instead of inventing a scheduler', async () => {
    const { gateway, dir } = await setup(false)
    await gateway.scheduleManager.refresh()
    const model = await readModel(dir)
    expect(model.available).toBe(false)
    expect(String(model.reason)).toContain('schedule')
    const id = await enqueue(dir, createCommand())
    await gateway.pollOperatorCommands()
    expect((await resultFor(dir, id)).state).toBe('error')
  })
})
