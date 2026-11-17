import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  archiveNativeSession,
  restoreNativeSession,
  retentionSettings, saveRetentionSettings, previewRetention,
  previewTrashSession, moveNativeSessionToTrash, restoreNativeSessionFromTrash,
  autoArchiveExpiredSessions,
  previewNativePermanentDelete, permanentlyDeleteNativeSession,
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
        if (!archived.includes(id)) archived.push(id)
      },
      async unarchiveSession(id) {
        const i = archived.indexOf(id)
        if (i >= 0) archived.splice(i, 1)
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
  assert.ok(ledger.items.every(row => row.lastActiveKnown === false),
    'orphan Session createdAt must never be presented as known last use')
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


test('schedule orphan is archived only after configured grace period', async t => {
  const f = await fixture(t)
  await saveOrganizationSettings(f.stateDir, { enabled: true, graceHours: 1 })
  await json(f.stateDir, 'ops-session-organization.json', {
    version: 1, bindings: {}, schedule: { [SCHEDULE]: 1 },
    missing: {}, pending: {}, retired: {}, handled: [],
  })
  const now = Date.now()
  const first = await reconcileSessionOrganization(f.stateDir, f.native,
    { dryRun: false, now })
  assert.equal(first.archive.some(row => row.id === SCHEDULE), false)
  const second = await reconcileSessionOrganization(f.stateDir, f.native,
    { dryRun: false, now: now + 3600001 })
  assert.equal(second.archive.some(row => row.id === SCHEDULE), true)
  assert.equal(f.archived.includes(SCHEDULE), true)
})

test('stale Gateway snapshot keeps header inventory visible but prevents mutation', async t => {
  const f = await fixture(t)
  await saveOrganizationSettings(f.stateDir, { enabled: true })
  await json(f.stateDir, 'ops-runtime.json', {
    version: 1, ts: Date.now() - 60000, workspace: f.cwd,
    isolatedAgent: true, tasks: [], status: 'ok', stats: {}, transport: {},
  })
  const list = await sessionOrganizationInventory(f.stateDir, f.native)
  assert.equal(list.available, true)
  assert.equal(list.nativeCount, 4)
  assert.equal(list.items.find(row => row.botId === 'default').status, 'unknown')
  const result = await reconcileSessionOrganization(f.stateDir, f.native, { dryRun: false })
  assert.equal(result.available, false)
  assert.deepEqual(f.attached, [])
  assert.deepEqual(f.archived, [])
})

test('native ledger filters bot and last activity UTC date interval', async t => {
  const f = await fixture(t)
  const report = await sessionOrganizationInventory(f.stateDir, f.native, { bot: 'default' })
  assert.equal(report.total, 1)
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const filtered = await sessionOrganizationInventory(f.stateDir, f.native, { from: future })
  assert.equal(filtered.total, 0)
})

test('archived Session can be restored with a native capability without touching history', async t => {
  const f = await fixture(t)
  await archiveNativeSession(f.stateDir, f.native, ORPHAN)
  const list = await sessionOrganizationInventory(f.stateDir, f.native, { status: 'archived' })
  assert.equal(list.canRestore, true)
  assert.equal(list.items.length, 1)
  const restored = await restoreNativeSession(f.stateDir, f.native, list.items[0].sessionRef)
  assert.equal(restored.restored, true)
  assert.equal(restored.nativeHistoryPreserved, true)
  assert.deepEqual(f.archived, [])
  await assert.rejects(restoreNativeSession(f.stateDir, f.native, list.items[0].sessionRef),
    { status: 409 })
  await saveOrganizationSettings(f.stateDir, { enabled: true })
  const dryRun = await reconcileSessionOrganization(f.stateDir, f.native)
  assert.equal(dryRun.archive.some(row => row.id === ORPHAN), false)
})

test('restore is disabled when the installed DSH runtime has no unarchive API', async t => {
  const f = await fixture(t)
  await archiveNativeSession(f.stateDir, f.native, ORPHAN)
  delete f.native.registry.unarchiveSession
  const list = await sessionOrganizationInventory(f.stateDir, f.native, { status: 'archived' })
  assert.equal(list.canRestore, false)
  await assert.rejects(restoreNativeSession(f.stateDir, f.native, list.items[0].sessionRef),
    { status: 501 })
  assert.ok(f.archived.includes(ORPHAN))
})

test('restore rejects forged or stale Session references', async t => {
  const f = await fixture(t)
  await assert.rejects(restoreNativeSession(f.stateDir, f.native, 'unsafe/../ref'),
    { status: 400 })
  await assert.rejects(restoreNativeSession(f.stateDir, f.native, '0'.repeat(16)),
    { status: 409 })
})

test('recycle bin stages only unbound native history and restores original visibility', async t => {
  const f = await fixture(t)
  const current = await sessionOrganizationInventory(f.stateDir, f.native, { status: 'current' })
  const orphan = current.items.find(row => row.orphan && row.type !== 'schedule')
  assert.ok(orphan)
  await assert.rejects(previewTrashSession(f.stateDir, f.native,
    (await sessionOrganizationInventory(f.stateDir, f.native)).items.find(row => row.botId === 'default').sessionRef),
  { status: 409 })
  const preview = await previewTrashSession(f.stateDir, f.native, orphan.sessionRef)
  assert.equal(preview.nativeHistoryPreserved, true)
  const moved = await moveNativeSessionToTrash(f.stateDir, f.native, orphan.sessionRef)
  assert.equal(moved.trashed, true)
  const recycled = await sessionOrganizationInventory(f.stateDir, f.native, { status: 'trashed' })
  assert.equal(recycled.total, 1)
  assert.equal(recycled.items[0].sessionRef, orphan.sessionRef)
  assert.equal(recycled.items[0].status, 'trashed')
  assert.equal(recycled.items[0].previousArchived, false)
  assert.equal((await sessionOrganizationInventory(f.stateDir, f.native, { status: 'current' })).total, current.total - 1)
  assert.ok(f.archived.includes(ORPHAN) || f.archived.includes(NEXT))
  const restored = await restoreNativeSessionFromTrash(f.stateDir, f.native, orphan.sessionRef)
  assert.equal(restored.target, 'current')
  assert.deepEqual(f.archived, [])
  assert.equal((await sessionOrganizationInventory(f.stateDir, f.native, { status: 'trashed' })).total, 0)
  await assert.rejects(restoreNativeSessionFromTrash(f.stateDir, f.native, orphan.sessionRef), { status: 409 })
})

test('recycle bin restores already archived history to archive, not active list', async t => {
  const f = await fixture(t)
  await archiveNativeSession(f.stateDir, f.native, ORPHAN)
  const archived = await sessionOrganizationInventory(f.stateDir, f.native, { status: 'archived' })
  assert.equal(archived.total, 1)
  const moved = await moveNativeSessionToTrash(f.stateDir, f.native, archived.items[0].sessionRef)
  assert.equal(moved.nativeHistoryPreserved, true)
  const result = await restoreNativeSessionFromTrash(f.stateDir, f.native, archived.items[0].sessionRef)
  assert.equal(result.target, 'archived')
  assert.ok(f.archived.includes(ORPHAN))
  assert.equal((await sessionOrganizationInventory(f.stateDir, f.native, { status: 'archived' })).total, 1)
})

test('trash is denied if native restore is unavailable, runtime is stale or task is scheduled', async t => {
  const f = await fixture(t)
  const list = await sessionOrganizationInventory(f.stateDir, f.native, { status: 'unbound' })
  const orphan = list.items.find(x => x.type !== 'schedule')
  const scheduled = list.items.find(x => x.type === 'schedule')
  await assert.rejects(previewTrashSession(f.stateDir, f.native, scheduled.sessionRef), { status: 409 })
  delete f.native.registry.unarchiveSession
  await assert.rejects(previewTrashSession(f.stateDir, f.native, orphan.sessionRef), { status: 501 })
  f.native.registry.unarchiveSession = async id => {
    const index = f.archived.indexOf(id)
    if (index >= 0) f.archived.splice(index, 1)
  }
  await json(f.stateDir, 'ops-runtime.json', {
    version: 1, ts: Date.now()-60000, workspace: f.cwd, isolatedAgent: true,
    tasks: [], status: 'ok', stats: {}, transport: {},
  })
  await assert.rejects(moveNativeSessionToTrash(f.stateDir, f.native, orphan.sessionRef), { status: 409 })
  assert.deepEqual(f.archived, [])
})

test('retention defaults to 90-day archive and 30-day trash without any auto-delete toggle', async t => {
  const f = await fixture(t)
  const defaults = await retentionSettings(f.stateDir)
  assert.deepEqual(defaults, {autoArchiveEnabled:false, archiveAfterDays:90, trashKeepDays:30, autoDeleteEnabled:false})
  assert.deepEqual(await saveRetentionSettings(f.stateDir, {autoArchiveEnabled:true, archiveAfterDays:180, trashKeepDays:7}),
    {autoArchiveEnabled:true, archiveAfterDays:180, trashKeepDays:7, autoDeleteEnabled:false})
  await assert.rejects(saveRetentionSettings(f.stateDir, {autoDeleteEnabled:true}), { status: 400 })
  await assert.rejects(saveRetentionSettings(f.stateDir, {trashKeepDays:0}), { status: 400 })
})

test('auto archive acts only on tracked reliable last activity, skips unknown and never deletes', async t => {
  const f = await fixture(t)
  const now = Date.now()
  await saveRetentionSettings(f.stateDir, {autoArchiveEnabled:true})
  const oldActivity = now - 95 * 86400000
  await json(f.stateDir, 'ops-session-organization.json', {
    version: 1, bindings:{}, schedule:{}, missing:{}, handled:[],
    pending:{}, retired:{}, activity:{[ORPHAN]:oldActivity}
  })
  const preview = await previewRetention(f.stateDir, f.native, now)
  assert.equal(preview.candidates, 1)
  assert.deepEqual(preview.candidatePreview.map(row=>row.title), ['title for 000'])
  assert.ok(preview.candidatePreview.every(row=>!('sessionId' in row)))
  assert.ok(preview.skippedUnknownActivity >= 1)
  assert.equal(preview.physicalDeleteAvailable, false)
  const result = await autoArchiveExpiredSessions(f.stateDir, f.native, now)
  assert.equal(result.archived, 1)
  assert.equal(result.physicalDeletePerformed, false)
  assert.ok(f.archived.includes(ORPHAN))
  assert.equal(f.snapshots.length, 4)
  const second = await autoArchiveExpiredSessions(f.stateDir, f.native, now)
  assert.equal(second.archived, 0)
  assert.ok(!f.archived.includes(NEXT))
  assert.ok(!f.archived.includes(SID))
})

test('trash age is previewed but physical deletion is impossible', async t => {
  const f = await fixture(t)
  const orphan = (await sessionOrganizationInventory(f.stateDir, f.native,
    { status:'unbound' })).items.find(x => x.type !== 'schedule')
  await moveNativeSessionToTrash(f.stateDir, f.native, orphan.sessionRef, Date.now() - 32*86400000)
  const report = await previewRetention(f.stateDir, f.native)
  assert.equal(report.expiredTrash, 1)
  assert.equal(report.physicalDeleteAvailable, false)
  assert.equal(f.snapshots.length, 4)
})

test('normal history search finds human-readable DSH conversation titles without raw IDs', async t => {
  const f = await fixture(t)
  const result = await sessionOrganizationInventory(f.stateDir, f.native,
    { status: 'current', search: 'title for 000' })
  assert.equal(result.total, 1)
  assert.equal(result.titleSearchLimited, false)
  assert.equal(result.items[0].sessionTitle, 'title for 000')
  assert.ok(!('sessionId' in result.items[0]))
})

test('archived history is one list, including legacy recycle-bin entries', async t => {
  const f = await fixture(t)
  await archiveNativeSession(f.stateDir, f.native, ORPHAN)
  const list = await sessionOrganizationInventory(f.stateDir, f.native, {status:'archived'})
  assert.equal(list.total, 1)
  const archived = list.items[0]
  await moveNativeSessionToTrash(f.stateDir, f.native, archived.sessionRef)
  const merged = await sessionOrganizationInventory(f.stateDir, f.native, {status:'archived'})
  assert.equal(merged.total, 1)
  assert.equal(merged.items[0].status, 'trashed') // UI calls both archived
  const restored = await restoreNativeSessionFromTrash(f.stateDir, f.native, archived.sessionRef)
  assert.equal(restored.target,'archived')
})

test('permanent delete is unavailable without an authoritative owner service', async t => {
  const f = await fixture(t)
  await archiveNativeSession(f.stateDir, f.native, ORPHAN)
  const list = await sessionOrganizationInventory(f.stateDir, f.native, {status:'archived'})
  assert.equal(list.canDelete, false)
  await assert.rejects(previewNativePermanentDelete(f.stateDir, f.native, list.items[0].sessionRef),
    {status:501})
  await assert.rejects(permanentlyDeleteNativeSession(f.stateDir, f.native, list.items[0].sessionRef),
    {status:501})
  assert.equal(f.snapshots.length,4)
})

test('a compatible DSH storage owner can inspect and physically delete cold archived history', async t => {
  const f = await fixture(t)
  await archiveNativeSession(f.stateDir, f.native, ORPHAN)
  const deleted = []
  const deleter = {
    isLive(){return false},
    async inspect(id){return {sessionId:id,bytes:2048,live:false,rawPath:'/secret/must-not-leak'}},
    async delete(id,options){
      assert.deepEqual(options,{force:false,backup:false})
      deleted.push(id)
      f.snapshots.splice(f.snapshots.findIndex(x=>x.header.id===id),1)
      const index=f.archived.indexOf(id)
      if(index>=0)f.archived.splice(index,1)
      return {deleted:true,bytesRemoved:2048}
    },
    async presentSessionIds(){return new Set(f.snapshots.map(x=>x.header.id))}
  }
  const services={...f.native,deleter}
  const list=await sessionOrganizationInventory(f.stateDir,services,{status:'archived'})
  assert.equal(list.canDelete,true)
  const p=await previewNativePermanentDelete(f.stateDir,services,list.items[0].sessionRef)
  assert.deepEqual(p,{sessionRef:list.items[0].sessionRef,permanent:true,reversible:false,estimatedBytes:2048})
  assert.ok(!JSON.stringify(p).includes('/secret/'))
  const result=await permanentlyDeleteNativeSession(f.stateDir,services,list.items[0].sessionRef)
  assert.deepEqual(deleted,[ORPHAN])
  assert.equal(result.deleted,true)
  assert.equal(result.bytesRemoved,2048)
  assert.equal((await sessionOrganizationInventory(f.stateDir,services,{status:'archived'})).total,0)
  await assert.rejects(permanentlyDeleteNativeSession(f.stateDir,services,list.items[0].sessionRef),
    {status:409})
})

test('permanent delete rejects running, bound, stale, scheduled or live-owner sessions', async t => {
  const f = await fixture(t)
  await archiveNativeSession(f.stateDir,f.native,ORPHAN)
  const ref=(await sessionOrganizationInventory(f.stateDir,f.native,{status:'archived'})).items[0].sessionRef
  let calls=0
  const services={...f.native,deleter:{
    isLive(){return true},async inspect(){return {live:true}},async delete(){calls++;return {deleted:true}}
  }}
  await assert.rejects(previewNativePermanentDelete(f.stateDir,services,ref),{status:409})
  await assert.rejects(permanentlyDeleteNativeSession(f.stateDir,services,ref),{status:409})
  assert.equal(calls,0)
  services.deleter.isLive=()=>false
  await json(f.stateDir,'ops-runtime.json',{
    version:1,ts:Date.now()-60000,workspace:f.cwd,isolatedAgent:true,
    tasks:[],status:'ok',stats:{},transport:{}
  })
  await assert.rejects(previewNativePermanentDelete(f.stateDir,services,ref),{status:409})
  assert.equal(calls,0)
})
