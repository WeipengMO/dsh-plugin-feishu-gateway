import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  listAgentFiles, readAgentFile, saveAgentFile, listAgentHistory, restoreAgentFile,
  saveAgentSettings, applyAgentProfile,
} from '../src/agent-profile.mjs'

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'feishu-agent-profile-'))
  const stateDir = path.join(dir, 'state')
  const workspace = path.join(dir, 'project')
  await mkdir(stateDir, { mode: 0o700 })
  await mkdir(workspace, { mode: 0o700 })
  return { dir, stateDir, workspace, close: () => rm(dir, { recursive: true, force: true }) }
}

test('profile files become DSH AGENTS.local guidance while preserving manual content', async () => {
  const ctx = await setup()
  try {
    const overlay = path.join(ctx.workspace, 'AGENTS.local.md')
    await writeFile(overlay, '# Existing human rules\nDo not overwrite this.\n')
    const initial = await listAgentFiles(ctx)
    assert.equal(initial.files.find(x => x.name === 'SOUL.md').revision, 'absent')
    assert.equal(initial.syncNeeded, false)
    const first = await saveAgentFile(ctx, { name: 'SOUL.md',
      content: '# Soul\nSpeak clearly, without fanfare.', expectedRevision: 'absent' })
    assert.equal(first.saved, true)
    assert.equal(first.loaded[0].name, 'SOUL.md')
    const text = await readFile(overlay, 'utf8')
    assert.match(text, /# Existing human rules\nDo not overwrite this/)
    assert.match(text, /### SOUL.md/)
    assert.match(text, /Speak clearly/)
    assert.equal(text.match(/DSH-FEISHU-AGENT-PROFILE:BEGIN/g).length, 1)
    const second = await saveAgentFile(ctx, { name: 'MEMORY.md',
      content: '# Long-term memory\nProject release planned.', expectedRevision: 'absent' })
    assert.equal(second.loaded.some(x => x.name === 'MEMORY.md'), true)
    const saved = await readAgentFile(ctx, 'MEMORY.md')
    assert.match(saved.content, /Project release/)
    assert.equal((await stat(path.join(ctx.workspace, 'SOUL.md'))).mode & 0o777, 0o600)
    assert.equal((await stat(overlay)).mode & 0o777, 0o600)
    assert.equal((await listAgentFiles(ctx)).syncNeeded, false)
  } finally { await ctx.close() }
})

test('revision checks, 30-version history, restore, and no duplicate managed blocks', async () => {
  const ctx = await setup()
  try {
    const first = await saveAgentFile(ctx, { name:'SOUL.md', content:'Version one', expectedRevision:'absent' })
    await assert.rejects(saveAgentFile(ctx, { name:'SOUL.md',
      content:'stale overwrite', expectedRevision:'absent' }), e => e.status === 409)
    const second = await saveAgentFile(ctx, { name:'SOUL.md',
      content:'Version two', expectedRevision:first.revision })
    const history = await listAgentHistory(ctx, 'SOUL.md')
    assert.ok(history.some(x => x.revision === first.revision))
    const prior = history.find(x => x.revision === first.revision)
    await restoreAgentFile(ctx, { name:'SOUL.md', id:prior.id, expectedRevision:second.revision })
    assert.equal((await readAgentFile(ctx,'SOUL.md')).content, 'Version one')
    const text = await readFile(path.join(ctx.workspace,'AGENTS.local.md'), 'utf8')
    assert.equal(text.match(/DSH-FEISHU-AGENT-PROFILE:BEGIN/g).length, 1)
    assert.doesNotMatch(text, /Version two/)
  } finally { await ctx.close() }
})

test('loading budget, memory toggle and daily notes without automatic prompt insertion', async () => {
  const ctx = await setup()
  try {
    const daily = await saveAgentFile(ctx, { name:'memory/2026-11-15.md',
      content:'# Notes\nPrivate diary entry.', expectedRevision:'absent' })
    assert.equal(daily.loaded.length, 0)
    await saveAgentFile(ctx, { name:'MEMORY.md',
      content:'M'.repeat(18000), expectedRevision:'absent' })
    const before = await listAgentFiles(ctx)
    assert.equal(before.loaded.find(x => x.name === 'MEMORY.md').truncated, true)
    assert.ok(before.contextBytes <= before.settings.maxBytes)
    const changed = await saveAgentSettings(ctx, {
      expectedRevision:before.settings.revision,
      settings:{enabled:{...before.settings.enabled,'MEMORY.md':false},
        maxBytes:8192, perFileBytes:2048},
    })
    assert.equal(changed.loaded.length, 0)
    const overlay = await readFile(path.join(ctx.workspace, 'AGENTS.local.md'),'utf8')
    assert.doesNotMatch(overlay, /M{50}/)
    assert.doesNotMatch(overlay, /Private diary entry/)
    assert.equal((await listAgentFiles(ctx)).files.some(x => x.name === 'memory/2026-11-15.md'),true)
    await assert.rejects(saveAgentSettings(ctx, {
      expectedRevision:'absent',
      settings:{enabled:{...before.settings.enabled},maxBytes:8192,perFileBytes:2048},
    }),e=>e.status===409)
  } finally { await ctx.close() }
})

test('manual instruction prefix and suffix stay byte-for-byte across resync', async () => {
  const ctx = await setup()
  try {
    await saveAgentFile(ctx, {name:'SOUL.md',content:'One',expectedRevision:'absent'})
    const overlay=path.join(ctx.workspace,'AGENTS.local.md')
    const existing=await readFile(overlay,'utf8')
    await writeFile(overlay,'# Custom before\n\n'+existing+'# Custom after\nKeep me.\n')
    const old=await readAgentFile(ctx,'SOUL.md')
    await saveAgentFile(ctx,{name:'SOUL.md',content:'Two',expectedRevision:old.revision})
    const current=await readFile(overlay,'utf8')
    assert.ok(current.startsWith('# Custom before\n\n'))
    assert.ok(current.endsWith('# Custom after\nKeep me.\n'))
    assert.match(current,/Two/)
    assert.doesNotMatch(current,/One/)
  } finally { await ctx.close() }
})

test('reject directory traversal, invalid dates, symlinked files and malformed managed boundaries', async () => {
  const ctx = await setup()
  try {
    await assert.rejects(readAgentFile(ctx,'../../.ssh/id_rsa'),e=>e.status===400)
    await assert.rejects(readAgentFile(ctx,'memory/2026-02-30.md'),e=>e.status===400)
    await assert.rejects(saveAgentFile(ctx,{name:'SOUL.md',
      content:'<!-- DSH-FEISHU-AGENT-PROFILE:END -->',expectedRevision:'absent'}),e=>e.status===400)
    const outside=path.join(ctx.dir,'secrets')
    await writeFile(outside,'TOP_SECRET')
    await symlink(outside,path.join(ctx.workspace,'SOUL.md'))
    await assert.rejects(readAgentFile(ctx,'SOUL.md'),e=>e.status===409)
    await rm(path.join(ctx.workspace,'SOUL.md'))
    await writeFile(path.join(ctx.workspace,'AGENTS.local.md'),
      '<!-- DSH-FEISHU-AGENT-PROFILE:BEGIN -->\ncorrupt')
    await assert.rejects(saveAgentFile(ctx,{name:'SOUL.md',
      content:'Cannot change',expectedRevision:'absent'}),e=>e.status===409)
    await assert.rejects(readFile(path.join(ctx.workspace,'SOUL.md'),'utf8'),
      e=>e.code==='ENOENT')
    const linked=path.join(ctx.dir,'linked-project')
    await symlink(ctx.workspace,linked)
    await assert.rejects(listAgentFiles({...ctx,workspace:linked}),e=>e.status===409)
  } finally { await ctx.close() }
})

test('explicit sync is repeatable and never erases independently-authored AGENTS.md', async () => {
  const ctx = await setup()
  try {
    await writeFile(path.join(ctx.workspace,'AGENTS.md'),'# DSH native rules\nKeep these.')
    const result=await applyAgentProfile(ctx)
    assert.equal(result.syncNeeded,false)
    assert.equal((await readFile(path.join(ctx.workspace,'AGENTS.md'),'utf8')),
      '# DSH native rules\nKeep these.')
    const overlay=await readFile(path.join(ctx.workspace,'AGENTS.local.md'),'utf8').catch(()=>null)
    assert.equal(overlay,null)
  } finally { await ctx.close() }
})
