import { Context, type Plugin } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config.js'
import * as plugin from '../../src/index.js'
import { silentLogger } from '../../src/util/logger.js'
import { tempDir } from '../helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/**
 * Mount the real plugin on a real Cordis Context. Only the four official
 * DSH services it injects are faked; everything else (fiber lifecycle,
 * ctx.effect, ctx.provide, ctx.logger) is the genuine Cordis 4.1.0 runtime.
 */
describe('Cordis plugin lifecycle', () => {
  it('exports the official plugin shape', () => {
    expect(plugin.name).toBe('feishu-gateway')
    expect(plugin.inject).toEqual(['agents', 'agentLoop', 'sessions', 'llm'])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.Config).toBeDefined()
  })

  it('activates, provides a diagnostics service, and unloads cleanly', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const ctx = new Context()

    // Official services required by `inject`.
    const fakeAgents = {
      create: async () => ({
        agent: { followup: () => {}, cancel: () => {}, whenIdle: async () => {} },
        dispose: async () => {},
      }),
      resume: async () => ({
        agent: { followup: () => {}, cancel: () => {}, whenIdle: async () => {} },
        dispose: async () => {},
      }),
    }
    ctx.provide('agents', fakeAgents)
    ctx.provide('agentLoop', {})
    ctx.provide('sessions', {})
    ctx.provide('llm', {})

    const config = resolveConfig({
      stateDir: dir,
      offline: true,
      autoConnect: false,
      allowlist: [],
      bots: [],
      diagnoseOnStart: false,
    })

    const fiber = ctx.plugin(plugin as unknown as Plugin, config)
    await fiber

    const service = ctx.get('feishuGateway') as { health: () => { status: string } } | undefined
    expect(service).toBeDefined()
    expect(service?.health().status).not.toBe('stopped')

    await fiber.dispose()
    expect(ctx.get('feishuGateway')).toBeUndefined()
    expect(service?.health().status).toBe('stopped')
    await ctx.fiber.dispose().catch(() => undefined)
  })

  it('never throws when the required DSH services are absent (fiber stays inactive)', async () => {
    const ctx = new Context()
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const config = resolveConfig({
      stateDir: dir,
      offline: true,
      autoConnect: false,
      bots: [],
      diagnoseOnStart: false,
    })
    const fiber = ctx.plugin(plugin as unknown as Plugin, config)
    await fiber
    // Injected services are missing: the loader must not run apply(), so no
    // service is provided and no socket/timer is created.
    expect(ctx.get('feishuGateway')).toBeUndefined()
    await fiber.dispose()
    await ctx.fiber.dispose().catch(() => undefined)
  })

  it('createGateway is directly usable with injected mocks (silent logger)', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const gateway = plugin.createGateway(
      resolveConfig({ stateDir: dir, offline: true, autoConnect: false, allowlist: ['ou_x'] }),
      { transports: [], bridge: undefined, logger: silentLogger },
    )
    await gateway.start()
    expect(gateway.health().status).toBe('degraded') // no agents service in this fake ctx
    await gateway.stop()
  })
})
