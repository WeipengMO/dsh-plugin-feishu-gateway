import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, realpath, rm, symlink, lstat, readFile, writeFile } from 'node:fs/promises'
import { resolveConfig } from '../../src/config.js'
import { prepareFeishuWorkspace, resolveFeishuWorkspace } from '../../src/agent-workspace.js'

describe('Feishu-only Agent workspace', () => {
  it('uses a dedicated cwd outside the normal DSH workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-feishu-separate-'))
    try {
      const shared = path.join(root, 'dsh-project')
      const state = path.join(root, 'channel-state')
      await mkdir(shared)
      const config = resolveConfig({ workspace: shared, stateDir: state, offline: true })
      expect(resolveFeishuWorkspace(config)).toBe(path.join(state, 'agent-workspace'))
      const privateCwd = await prepareFeishuWorkspace(config)
      expect(privateCwd).not.toBe(shared)
      expect(privateCwd.startsWith(shared + path.sep)).toBe(false)
      expect(await realpath(privateCwd)).toBe(privateCwd)
      const policy = await readFile(path.join(privateCwd, 'AGENTS.local.md'), 'utf8')
      expect(policy).toContain('5 次网页检索')
      await writeFile(path.join(privateCwd, 'AGENTS.local.md'), 'my custom rules')
      await prepareFeishuWorkspace(config)
      expect(await readFile(path.join(privateCwd, 'AGENTS.local.md'), 'utf8')).toBe('my custom rules')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('falls back outside shared project if stateDir is nested inside DSH cwd', () => {
    const root = path.join(os.tmpdir(), 'dsh-shared-project-example')
    const config = resolveConfig({ workspace: root, stateDir: path.join(root, '.feishu-gateway') })
    expect(resolveFeishuWorkspace(config)).toBe(path.resolve(os.homedir(), '.dsh', 'feishu-channel-agent'))
  })

  it('refuses explicit shared cwd, parent workspace, relative paths and symlinks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-feishu-separate-'))
    try {
      const shared = path.join(root, 'regular-dsh')
      const separate = path.join(root, 'feishu-agent')
      await mkdir(shared);await mkdir(separate)
      const base = resolveConfig({ workspace: shared, stateDir: path.join(root, 'state') })
      expect(() => resolveFeishuWorkspace({ ...base, agentWorkspace: shared })).toThrow(/separate/)
      expect(() => resolveFeishuWorkspace({ ...base, agentWorkspace: path.dirname(shared) })).toThrow(/separate/)
      expect(() => resolveFeishuWorkspace({ ...base, agentWorkspace: path.join(shared, 'child') })).toThrow(/separate/)
      expect(() => resolveFeishuWorkspace({ ...base, agentWorkspace: 'relative/path' })).toThrow(/absolute/)
      const linked = path.join(root, 'linked')
      await symlink(separate, linked)
      await expect(prepareFeishuWorkspace({ ...base, agentWorkspace: linked })).rejects.toThrow(/symlinked/)
      // Old DSH cwd can itself be a symlink to the future Feishu cwd parent.
      const legacyAlias = path.join(root, 'legacy-alias')
      await symlink(shared, legacyAlias)
      await expect(prepareFeishuWorkspace({
        ...base, workspace: legacyAlias, agentWorkspace: path.join(shared, 'nested'),
      })).rejects.toThrow(/aliases/)
      await expect(lstat(path.join(shared, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
