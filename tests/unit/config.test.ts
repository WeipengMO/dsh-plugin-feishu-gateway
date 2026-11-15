import { describe, expect, it } from 'vitest'
import {
  Config,
  implicitEnvNames,
  redactedConfigSummary,
  resolveBotCredentials,
  resolveConfig,
} from '../../src/config.js'

describe('resolveConfig', () => {
  it('applies secure defaults', () => {
    const config = resolveConfig(undefined)
    expect(config.bots).toEqual([])
    expect(config.allowlist).toEqual([])
    expect(config.allowGroups).toBe(false)
    expect(config.offline).toBe(process.env.FEISHU_GATEWAY_OFFLINE === '1')
    expect(config.autoConnect).toBe(true)
    expect(config.sendRetries).toBe(3)
    expect(config.replyTimeoutMs).toBe(120_000)
    expect(config.networkProxy).toEqual({
      enabled: false, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', fallbackDirect: true,
    })
    expect(config.replyFormat).toBe('text')
    expect(config.workspace).toBe(process.cwd())
  })

  it('supports opt-in Markdown without changing the default', () => {
    expect(resolveConfig({ replyFormat: 'markdown' }).replyFormat).toBe('markdown')
    expect(resolveConfig(undefined).replyFormat).toBe('text')
  })

  it('supports proxy configuration without leaking the actual URL', () => {
    const config = resolveConfig({ networkProxy: {
      enabled: true, urlEnv: 'HTTPS_PROXY', fallbackDirect: true,
    } })
    expect(config.networkProxy.enabled).toBe(true)
    expect(config.networkProxy.urlEnv).toBe('HTTPS_PROXY')
    const summary = JSON.stringify(redactedConfigSummary(config))
    expect(summary).toContain('HTTPS_PROXY')
    expect(summary).not.toContain('http://example.invalid:3000')
  })

  it('honours FEISHU_GATEWAY_OFFLINE as a hard offline switch', () => {
    const previous = process.env.FEISHU_GATEWAY_OFFLINE
    process.env.FEISHU_GATEWAY_OFFLINE = '1'
    try {
      expect(resolveConfig({ offline: false }).offline).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.FEISHU_GATEWAY_OFFLINE
      else process.env.FEISHU_GATEWAY_OFFLINE = previous
    }
  })

  it('normalizes bots and never invents credentials', () => {
    const config = resolveConfig({
      bots: [{ id: 'ops', enabled: false, domain: 'lark', appIdEnv: 'OPS_ID' }],
      allowlist: ['ou_alice'],
    })
    expect(config.bots[0]).toMatchObject({ id: 'ops', enabled: false, domain: 'lark', appIdEnv: 'OPS_ID' })
    expect(config.allowlist).toEqual(['ou_alice'])
  })

  it('exposes a Standard-Schema validator as Config', () => {
    expect(Config).toBeDefined()
    expect(typeof (Config as { '~standard': { validate: unknown } })['~standard'].validate).toBe('function')
  })
})

describe('implicitEnvNames', () => {
  it('produces POSIX-safe uppercased names', () => {
    expect(implicitEnvNames('my-bot.2')).toEqual({
      appId: 'FEISHU_GATEWAY_MY_BOT_2_APP_ID',
      appSecret: 'FEISHU_GATEWAY_MY_BOT_2_APP_SECRET',
    })
  })
})

describe('resolveBotCredentials', () => {
  const bot = { id: 'default', enabled: true, domain: 'feishu' as const }

  it('reads explicit env-var names first', () => {
    const env = { CUSTOM_ID: 'cli_custom', CUSTOM_SECRET: 'sec_custom' }
    const result = resolveBotCredentials({ ...bot, appIdEnv: 'CUSTOM_ID', appSecretEnv: 'CUSTOM_SECRET' }, env)
    expect(result.credentials).toEqual({ appId: 'cli_custom', appSecret: 'sec_custom', domain: 'feishu' })
    expect(result.source).toContain('env:CUSTOM_ID')
    expect(result.missing).toEqual([])
  })

  it('falls back to implicit names', () => {
    const result = resolveBotCredentials(bot, {
      FEISHU_GATEWAY_DEFAULT_APP_ID: 'cli_implicit',
      FEISHU_GATEWAY_DEFAULT_APP_SECRET: 'sec_implicit',
    })
    expect(result.credentials?.appId).toBe('cli_implicit')
    expect(result.source).toContain('env:FEISHU_GATEWAY_DEFAULT_APP_ID')
  })

  it('rejects missing secrets instead of falling back to config literals', () => {
    const result = resolveBotCredentials(bot, {})
    expect(result.credentials).toBeUndefined()
    expect(result.missing).toContain('FEISHU_GATEWAY_DEFAULT_APP_SECRET')
  })

  it('fails closed and reports missing names without exposing values', () => {
    const result = resolveBotCredentials(bot, { FEISHU_GATEWAY_DEFAULT_APP_ID: 'cli_only' })
    expect(result.credentials).toBeUndefined()
    expect(result.missing).toContain('FEISHU_GATEWAY_DEFAULT_APP_SECRET')
    expect(JSON.stringify(result)).not.toContain('cli_only')
  })

  it('rejects invalid env var names', () => {
    const result = resolveBotCredentials({ ...bot, appIdEnv: 'BAD;NAME' }, {})
    expect(result.credentials).toBeUndefined()
    expect(result.missing.join(' ')).toContain('invalid env var name')
  })

  it('keeps the lark domain', () => {
    const result = resolveBotCredentials(
      { ...bot, domain: 'lark' },
      { FEISHU_GATEWAY_DEFAULT_APP_ID: 'cli', FEISHU_GATEWAY_DEFAULT_APP_SECRET: 'sec' },
    )
    expect(result.credentials?.domain).toBe('lark')
  })
})

describe('redactedConfigSummary', () => {
  it('never includes secrets or allowlist contents', () => {
    const config = resolveConfig({
      bots: [{ id: 'default', enabled: true, domain: 'feishu', appIdEnv: 'APP_ID', appSecretEnv: 'APP_SECRET' }],
      allowlist: ['ou_secret_person'],
    })
    const summary = JSON.stringify(redactedConfigSummary(config))
    expect(summary).not.toContain('SUPER_SECRET')
    expect(summary).not.toContain('cli_x')
    expect(summary).not.toContain('ou_secret_person')
    expect(summary).toContain('"allowlistSize":1')
  })
})
