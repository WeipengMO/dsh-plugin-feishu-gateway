import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadManagedConfig,
  loadStoredProxyUrl,
  managedConfigPath,
  validateManagedConfig,
} from '../../src/admin-config.js'
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
      agent: { model: 'group/new' }, agentWorkspace: '/tmp/feishu-independent',
      bots: [{ id: 'default', domain: 'feishu', enabled: false }],
    } }))
    const result = loadManagedConfig(base)
    expect(result.allowlist).toEqual(['ou_managed'])
    expect(result.agent).toEqual({ provider: 'magpie', model: 'group/new' })
    expect(result.bots[0]?.enabled).toBe(false)
    expect(result.bots[0]?.appSecretEnv).toBe('FEISHU_GATEWAY_DEFAULT_APP_SECRET')
    expect(result.workspace).toBe('/tmp')
    expect(result.agentWorkspace).toBe('/tmp/feishu-independent')
    expect(result.stateDir).toBe(d.dir)
  })
  it('manages an explicit fallback route and can clear it without inheriting a stale one', async () => {
    const d = await tempDir()
    cleanup.push(d.cleanup)
    expect(validateManagedConfig({ agent: {
      provider: 'magpie', model: 'group/deepseek',
      fallback: { provider: 'magpie', model: 'group/hy4-free' },
    } }).agent).toEqual({
      provider: 'magpie', model: 'group/deepseek',
      fallback: { provider: 'magpie', model: 'group/hy4-free' },
    })
    // Incomplete, invalid, or identical fallbacks are rejected: a fallback
    // must be a complete, different route.
    expect(() => validateManagedConfig({ agent: { fallback: { provider: 'magpie' } } }))
      .toThrow(/fallback/)
    expect(() => validateManagedConfig({ agent: { fallback: { provider: 'bad route', model: 'm' } } }))
      .toThrow(/fallback/)
    expect(() => validateManagedConfig({ agent: {
      provider: 'magpie', model: 'm', fallback: { provider: 'magpie', model: 'm' },
    } })).toThrow(/differ/)
    expect(validateManagedConfig({ agent: { fallback: null } }).agent).toEqual({ fallback: null })

    const base = resolveConfig({ stateDir: d.dir, agent: {
      provider: 'magpie', model: 'group/deepseek',
      fallback: { provider: 'magpie', model: 'group/hy4-free' },
    } })
    await writeFile(managedConfigPath(d.dir), JSON.stringify({ version: 1, config: {
      agent: { provider: 'magpie', model: 'auto/hy4flash-free',
        fallback: { provider: 'magpie', model: 'group/deepseek' } },
    } }))
    expect(loadManagedConfig(base).agent).toEqual({
      provider: 'magpie', model: 'auto/hy4flash-free',
      fallback: { provider: 'magpie', model: 'group/deepseek' },
    })
    // Explicit clear must not resurrect the Profile fallback.
    await writeFile(managedConfigPath(d.dir), JSON.stringify({ version: 1, config: {
      agent: { fallback: null },
    } }))
    expect(loadManagedConfig(base).agent).toEqual({
      provider: 'magpie', model: 'group/deepseek',
    })
  })

  it('rejects secrets, unknown fields, invalid ids, and env collisions', () => {
    expect(() => validateManagedConfig({ appSecret: 'top-secret' })).toThrow(/unsupported/)
    expect(() => validateManagedConfig({ bots: [{ id: 'a-b', domain: 'feishu' }, { id: 'a_b', domain: 'lark' }] })).toThrow(/colliding/)
    expect(() => validateManagedConfig({ allowlist: ['not-an-open-id'] })).toThrow(/allowlist/)
    expect(() => validateManagedConfig({ workspace: '../somewhere' })).toThrow(/absolute/)
    expect(() => validateManagedConfig({ agentWorkspace: '../somewhere' })).toThrow(/absolute/)
  })
  it('accepts explicitly managed Markdown reply format', () => {
    expect(validateManagedConfig({ replyFormat: 'markdown' }).replyFormat).toBe('markdown')
    expect(() => validateManagedConfig({ replyFormat: 'html' })).toThrow(/replyFormat/)
  })

  it('fails closed on bad managed JSON rather than reverting to Profile', async () => {
    const d = await tempDir()
    cleanup.push(d.cleanup)
    const base = resolveConfig({ stateDir: d.dir })
    await writeFile(path.join(d.dir, 'admin-config.json'), '{bad', 'utf8')
    expect(() => loadManagedConfig(base)).toThrow(/invalid managed config JSON/)
  })
})

describe('managed network proxy configuration', () => {
  it('accepts a legacy rc.9 overlay and defaults urlEnv', () => {
    expect(validateManagedConfig({ networkProxy: { enabled: true, fallbackDirect: false } }).networkProxy)
      .toEqual({ enabled: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', fallbackDirect: false })
    expect(validateManagedConfig({ networkProxy: {} }).networkProxy)
      .toEqual({ enabled: false, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', fallbackDirect: true })
    expect(validateManagedConfig({ networkProxy: { enabled: true, urlEnv: 'HTTPS_PROXY' } }).networkProxy)
      .toEqual({ enabled: true, urlEnv: 'HTTPS_PROXY', fallbackDirect: true })
  })

  it('never accepts a proxy URL inside admin-config.json', () => {
    expect(() => validateManagedConfig({ networkProxy: {
      enabled: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', fallbackDirect: true,
      url: 'http://user:pass@proxy:2080',
    } })).toThrow(/unsupported/)
  })

  it('rejects invalid proxy switches and env var names', () => {
    expect(() => validateManagedConfig({ networkProxy: { enabled: 'yes' } })).toThrow(/networkProxy/)
    expect(() => validateManagedConfig({ networkProxy: { fallbackDirect: 1 } })).toThrow(/networkProxy/)
    expect(() => validateManagedConfig({ networkProxy: { urlEnv: 'not a name' } })).toThrow(/networkProxy/)
    expect(() => validateManagedConfig({ networkProxy: { urlEnv: 42 } })).toThrow(/networkProxy/)
  })

  it('applies the managed networkProxy overlay on load', async () => {
    const d = await tempDir()
    cleanup.push(d.cleanup)
    const base = resolveConfig({ stateDir: d.dir })
    await writeFile(managedConfigPath(d.dir), JSON.stringify({ version: 1, config: {
      networkProxy: { enabled: true, fallbackDirect: false },
    } }))
    const result = loadManagedConfig(base)
    expect(result.networkProxy).toEqual({
      enabled: true, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', fallbackDirect: false,
    })
    expect(JSON.stringify(result.networkProxy)).not.toContain('http://')
  })
})

describe('loadStoredProxyUrl (admin-managed proxy URL)', () => {
  async function writeProxyFile(dir: string, body: string, mode = 0o600): Promise<void> {
    const file = path.join(dir, 'network-proxy.json')
    await writeFile(file, body, { encoding: 'utf8', mode })
    await chmod(file, mode)
  }

  it('returns the validated URL from a 0600 network-proxy.json', async () => {
    const d = await tempDir()
    cleanup.push(d.cleanup)
    await writeProxyFile(d.dir, JSON.stringify({ version: 1, url: 'http://100.75.51.18:2080' }))
    expect(loadStoredProxyUrl(d.dir)).toBe('http://100.75.51.18:2080')
  })

  it('returns undefined instead of throwing for every unsafe file', async () => {
    const d = await tempDir()
    cleanup.push(d.cleanup)
    expect(loadStoredProxyUrl(d.dir)).toBeUndefined()
    await writeProxyFile(d.dir, JSON.stringify({ version: 1, url: 'http://proxy:2080' }), 0o644)
    expect(loadStoredProxyUrl(d.dir)).toBeUndefined()
    await writeProxyFile(d.dir, '{not json')
    expect(loadStoredProxyUrl(d.dir)).toBeUndefined()
    await writeProxyFile(d.dir, JSON.stringify({ version: 1, url: 'ftp://proxy:21' }))
    expect(loadStoredProxyUrl(d.dir)).toBeUndefined()
    await writeProxyFile(d.dir, JSON.stringify({ version: 1, url: 'http://proxy:2080/path' }))
    expect(loadStoredProxyUrl(d.dir)).toBeUndefined()
    expect(loadStoredProxyUrl(path.join(d.dir, 'missing'))).toBeUndefined()
  })
})
