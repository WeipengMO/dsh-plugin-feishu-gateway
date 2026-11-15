import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
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
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
