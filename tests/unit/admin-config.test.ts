import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadManagedConfig, managedConfigPath, validateManagedConfig } from '../../src/admin-config.js'
import { resolveConfig } from '../../src/config.js'
import { tempDir } from '../helpers.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

describe('managed Feishu channel overlay', () => {
  it('inherits untouched Profile values when no overlay exists', async () => {
    const d = await tempDir()
    cleanup.push(d.cleanup)
    const base = resolveConfig({ stateDir: d.dir, allowlist: ['ou_original'], replyTimeoutMs: 321000 })
    expect(loadManagedConfig(base)).toEqual(base)
  })
  it('applies only allowlisted settings and preserves the Profile workspace/stateDir', async () => {
    const d = await tempDir()
    cleanup.push(d.cleanup)
    const base = resolveConfig({ stateDir: d.dir, workspace: '/tmp', allowlist: ['ou_original'],
      agent: { provider: 'magpie', model: 'group/deepseek' } })
    await writeFile(managedConfigPath(d.dir), JSON.stringify({ version: 1, config: {
      allowlist: ['ou_managed'], replyTimeoutMs: 300000,
      agent: { model: 'group/new' },
      bots: [{ id: 'default', domain: 'feishu', enabled: false }],
    } }))
    const result = loadManagedConfig(base)
    expect(result.allowlist).toEqual(['ou_managed'])
    expect(result.agent).toEqual({ provider: 'magpie', model: 'group/new' })
    expect(result.bots[0]?.enabled).toBe(false)
    expect(result.bots[0]?.appSecretEnv).toBe('FEISHU_GATEWAY_DEFAULT_APP_SECRET')
    expect(result.workspace).toBe('/tmp')
    expect(result.stateDir).toBe(d.dir)
  })
  it('rejects secrets, unknown fields, invalid ids, and env collisions', () => {
    expect(() => validateManagedConfig({ appSecret: 'top-secret' })).toThrow(/unsupported/)
    expect(() => validateManagedConfig({ bots: [{ id: 'a-b', domain: 'feishu' }, { id: 'a_b', domain: 'lark' }] })).toThrow(/colliding/)
    expect(() => validateManagedConfig({ allowlist: ['not-an-open-id'] })).toThrow(/allowlist/)
    expect(() => validateManagedConfig({ workspace: '../somewhere' })).toThrow(/absolute/)
  })
  it('fails closed on bad managed JSON rather than reverting to Profile', async () => {
    const d = await tempDir()
    cleanup.push(d.cleanup)
    const base = resolveConfig({ stateDir: d.dir })
    await writeFile(path.join(d.dir, 'admin-config.json'), '{bad', 'utf8')
    expect(() => loadManagedConfig(base)).toThrow(/invalid managed config JSON/)
  })
})
