import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  archiveNativeSession,
  organizationSettings,
  reconcileSessionOrganization,
  saveOrganizationSettings,
  sessionOrganizationInventory,
} from '../src/session-organizer.mjs'

const SID = 'feishu-default-abc-session-111'
const NEXT = 'feishu-default-abc-session-222'
const ORPHAN = 'feishu-default-abc-session-000'
const SCHEDULE = 'feishu-schedule-abc-session-333'
const json = async (dir, name, value) =>
  writeFile(path.join(dir, name), JSON.stringify(value) + '\n')

async function fixture(t, { bound = SID, other = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'feishu-org-test-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const stateDir = path.join(dir, 'state')
  const cwd = path.join(stateDir, 'agent-workspace')
  await mkdir(cwd, { recursive: true })
  const ids = [SID, NEXT, ORPHAN, SCHEDULE]
  const snapshots = ids.map(id => ({ header: { id, cwd, createdAt: Date.now() - 86400_000 } }))
  const attached = []
  const archived = []
  const workspace = {
    id: 'ws-feishu', title: '飞书会话', sessionIds: [],
    async attachSession(id) {
      if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
      attached.push(id)
    },
  }
  const native = {
    persistence: {
      async list() { return snapshots },
      async resume() { throw Error('must never resume a Gateway Session') },
    },
    registry: {
      archivedSessionIds: archived,
      list() { return workspace.sessionIds.length ? [workspace] : [] },
      async resolveByPath() { return workspace.sessionIds.length ? workspace : null },
      async create() { return workspace },
      async archiveSession(id) {
        if (id === SID && bound === SID) throw Error('active Session')
        if (!archived.includes(id)) archived.push(id)
      },
    },
    query: { async readTitle(id) { return 'title for ' + id.slice(-3) } },
  }
  const bindings = other ? { 'default:oc_other': {
    sessionId: NEXT, createdAt: Date.now(), lastActiveAt: Date.now(), persisted: true,
  } } : {}
  if (bound) bindings['default:oc_chat'] = {
    sessionId: bound, createdAt: Date.now(), lastActiveAt: Date.now(), persisted: true,
  }
  const writeBindings = (value = bindings) => json(stateDir, 'sessions.json', { bindings: value })
  await writeBindings()
  await json(stateDir, 'ops-runtime.json', {
    version: 1, ts: Date.now(), workspace: cwd, isolatedAgent: true,
    tasks: [], status: 'ok', stats: {}, transport: {},
  })
  return { dir, stateDir, cwd, ids, snapshots, attached, archived, workspace, native, writeBindings }
}

test('opt-in disabled by default: preview reads headers without writes or agent resume', async t => {
  const f = await fixture(t)
  const settings = await organizationSettings(f.stateDir)
  assert.equal(settings.enabled, false)
  const preview = await reconcileSessionOrganization(f.stateDir, f.native)
  assert.equal(preview.available, true)
  assert.deepEqual(preview.attach, [SID])
  assert.equal(preview.archive.length, 0)
  assert.deepEqual(f.attached, [])
  assert.deepEqual(f.archived, [])
  const ledger = await sessionOrganizationInventory(f.stateDir, f.native, { orphanOnly: true })
  assert.equal(ledger.total, 3)
  assert.ok(ledger.items.every(row => !('sessionId' in row)))
})

test('idempotent reconciliation adopts bound sessions, not unconfirmed historical orphans', async t => {
  const f = await fixture(t)
  await saveOrganizationSettings(f.stateDir, { enabled: true })
  const first = await reconcileSessionOrganization(f.stateDir, f.native, { dryRun: false })
  assert.equal(first.attached, 1)
  assert.deepEqual(f.attached, [SID])
  assert.equal(f.workspace.sessionIds.includes(ORPHAN), false)
  const again = await reconcileSessionOrganization(f.stateDir, f.native, { dryRun: false })
  assert.equal(again.attached, 0)
  assert.deepEqual(f.attached, [SID])
  assert.deepEqual(f.archived, [])
})

test('/new temporarily unbinds: original session is archived only after a new binding exists', async t => {
  const f = await fixture(t)
  await saveOrganizationSettings(f.stateDir, { enabled: true })
  await reconcileSessionOrganization(f.stateDir, f.native, { dryRun: false })
  await f.writeBindings({})
  let result = await reconcileSessionOrganization(f.stateDir, f.native, { dryRun: false })
  assert.equal(result.archive.length, 0)
  assert.equal(f.archived.includes(SID), false)
  await f.writeBindings({ 'default:oc_chat': {
    sessionId: NEXT, createdAt: Date.now(), lastActiveAt: Date.now(), persisted: true,
  } })
  result = await reconcileSessionOrganization(f.stateDir, f.native, { dryRun: false })
  assert.deepEqual(result.archive.map(row => row.id), [SID])
  assert.deepEqual(f.archived, [SID])
  await reconcileSessionOrganization(f.stateDir, f.native, { dryRun: false })
  assert.deepEqual(f.archived, [SID])
  assert.equal(f.archived.includes(ORPHAN), false)
})

test('manual archive rejects current binding and is not repeated after user restores it', async t => {
  const f = await fixture(t)
  await assert.rejects(archiveNativeSession(f.stateDir, f.native, SID), { status: 409 })
  const result = await archiveNativeSession(f.stateDir, f.native, ORPHAN)
  assert.equal(result.archived, true)
  assert.ok(f.archived.includes(ORPHAN))
  f.archived.splice(f.archived.indexOf(ORPHAN), 1)
  await saveOrganizationSettings(f.stateDir, { enabled: true })
  const preview = await reconcileSessionOrganization(f.stateDir, f.native)
  assert.equal(preview.archive.some(row => row.id === ORPHAN), false)
})
