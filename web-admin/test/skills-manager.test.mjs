import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import {
  parseSkillMarkdown, listFeishuSkills, saveFeishuSkill, readFeishuSkill,
  setFeishuSkillEnabled, deleteFeishuSkill, syncFeishuSkills,
} from '../src/skills-manager.mjs'

const skill = (name, description = 'Helps with a task') => [
  '---', 'name: ' + name, 'description: ' + description, '---', '',
  '# ' + name, '', 'Follow these specific steps.', '',
].join('\n')

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'feishu-skills-'))
  const ctx = { stateDir: path.join(root, 'state'), workspace: path.join(root, 'agent'),
    sharedProjectWorkspace: path.join(root, 'ordinary-dsh') }
  await Promise.all([mkdir(ctx.stateDir), mkdir(ctx.workspace), mkdir(ctx.sharedProjectWorkspace)])
  return { ctx, close: () => rm(root, { recursive: true, force: true }) }
}

test('Agent Skills frontmatter is minimal and strict', () => {
  assert.deepEqual(parseSkillMarkdown(skill('gbm-research')), {
    name: 'gbm-research', description: 'Helps with a task',
  })
  assert.throws(() => parseSkillMarkdown('no frontmatter'), /frontmatter/)
  assert.throws(() => parseSkillMarkdown(skill('../escape')), /name/)
  assert.throws(() => parseSkillMarkdown(skill('Research')), /name/)
  assert.throws(() => parseSkillMarkdown(skill('x', '')), /description/)
  assert.throws(() => parseSkillMarkdown(skill('x') + '\n<!-- DSH-FEISHU-SKILLS:BEGIN -->'), /invalid/)
})

test('Skills are disabled by default and only enabled content reaches Feishu overlay', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.ctx.workspace, 'AGENTS.local.md'),
      'Custom original instructions\n\n<!-- DSH-FEISHU-AGENT-PROFILE:BEGIN -->\nprofile\n<!-- DSH-FEISHU-AGENT-PROFILE:END -->\n')
    const created = await saveFeishuSkill(f.ctx, { name: 'gbm-research', content: skill('gbm-research'),
      expectedRevision: 'absent' })
    assert.equal(created.skill.enabled, false)
    const initial = await listFeishuSkills(f.ctx)
    assert.equal(initial.items.length, 1)
    assert.equal(initial.enabled, 0)
    assert.equal(initial.syncNeeded, false)
    const enabled = await setFeishuSkillEnabled(f.ctx, { name: 'gbm-research',
      enabled: true, expectedRevision: created.skill.revision })
    const overlay = await readFile(path.join(f.ctx.workspace, 'AGENTS.local.md'), 'utf8')
    assert.match(overlay, /Custom original instructions/)
    assert.match(overlay, /profile/)
    assert.match(overlay, /### Skill: gbm-research/)
    assert.equal(enabled.skill.enabled, true)
    assert.equal((overlay.match(/DSH-FEISHU-SKILLS:BEGIN/g) || []).length, 1)
    const read = await readFeishuSkill(f.ctx, 'gbm-research')
    assert.equal(read.content, skill('gbm-research'))
    await assert.rejects(saveFeishuSkill(f.ctx, { name: 'gbm-research',
      content: skill('gbm-research', 'New instructions'), expectedRevision: created.skill.revision }), /changed/)
    const removed = await deleteFeishuSkill(f.ctx, { name: 'gbm-research',
      expectedRevision: enabled.skill.revision })
    assert.equal(removed.deleted, 'gbm-research')
    const after = await readFile(path.join(f.ctx.workspace, 'AGENTS.local.md'), 'utf8')
    assert.doesNotMatch(after, /### Skill:/)
    assert.match(after, /profile/)
    assert.equal((await listFeishuSkills(f.ctx)).items.length, 0)
  } finally { await f.close() }
})

test('Skills reject symlink overlays, colliding markers and ordinary DSH workspace', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.ctx.workspace, 'AGENTS.local.md'),
      '<!-- DSH-FEISHU-SKILLS:BEGIN -->\nmissing end')
    await assert.rejects(saveFeishuSkill(f.ctx, { name: 'safe-skill', content: skill('safe-skill'),
      expectedRevision: 'absent' }), /conflicting/)
    await rm(path.join(f.ctx.workspace, 'AGENTS.local.md'))
    await symlink(path.join(f.ctx.stateDir, 'outside.md'), path.join(f.ctx.workspace, 'AGENTS.local.md'))
    await assert.rejects(syncFeishuSkills(f.ctx), /unsafe/)
    await assert.rejects(listFeishuSkills({ ...f.ctx, workspace: f.ctx.sharedProjectWorkspace }), /ordinary DSH/)
  } finally { await f.close() }
})

test('Skills context budget is enforced on enabling a new skill', async () => {
  const f = await fixture()
  try {
    let previous
    for (let i = 0; i < 3; i++) {
      const name = 'large-' + i
      const content = skill(name) + '\n' + 'x'.repeat(10 * 1024)
      const saved = await saveFeishuSkill(f.ctx, { name, content, expectedRevision: 'absent' })
      if (i < 2) {
        previous = await setFeishuSkillEnabled(f.ctx, {
          name, enabled: true, expectedRevision: saved.skill.revision,
        })
      } else {
        await assert.rejects(setFeishuSkillEnabled(f.ctx, {
          name, enabled: true, expectedRevision: saved.skill.revision,
        }), /context budget/)
      }
    }
    const result = await listFeishuSkills(f.ctx)
    assert.equal(result.enabled, 2)
    assert.equal(result.syncNeeded, false)
    assert.ok(previous.contextBytes < 24 * 1024)
  } finally { await f.close() }
})
