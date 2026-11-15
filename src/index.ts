import type { Context } from '@deepseek-ai/cordis'
import { Config, redactedConfigSummary, resolveBotCredentials, resolveConfig, type ConfigValidator } from './config.js'
import { loadManagedConfig } from './admin-config.js'
import { LarkTransport } from './channel/lark-transport.js'
import { MockFeishuTransport } from './channel/mock-transport.js'
import { FeishuGateway } from './gateway.js'
import { DshSessionBridge } from './session/dsh-session-bridge.js'
import { fromCordisLogger } from './util/logger.js'
import { redactProxyUrl, resolveProxyUrl } from './util/proxy-url.js'
import type {
  CordisLike,
  FeishuTransport,
  GatewayConfig,
  GatewayLogger,
  NetworkProxyConfig,
  SessionBridge,
} from './types.js'
import type { ApprovalRequestLike, ApprovalOutcome } from './channel/approval-manager.js'

/** Stable Cordis plugin name (used for fiber diagnostics and loader rows). */
export const name = 'feishu-gateway'

/**
 * Official DSH services this plugin needs. Declaring them keeps the plugin
 * inactive (rather than crashing) in profiles that do not mount the native
 * Agent/Session stack. See docs/ARCHITECTURE.md for the capability matrix.
 */
export const inject = ['agents', 'agentLoop', 'sessions', 'llm']

export { Config }
export type { GatewayConfig } from './types.js'

export interface GatewayOverrides {
  readonly transports?: readonly FeishuTransport[]
  readonly bridge?: SessionBridge
  readonly logger?: GatewayLogger
  readonly ctx?: CordisLike
}

/**
 * Build a gateway. Production uses the real Lark SDK transport and the native
 * DSH Agent/Session bridge; tests inject mocks. This factory is exported so
 * the integration suite can exercise the exact production pipeline without
 * credentials, a network, or a live DSH runtime.
 */
export function createGateway(
  rawConfig: Partial<GatewayConfig> | undefined,
  overrides: GatewayOverrides = {},
): FeishuGateway {
  const config = loadManagedConfig(resolveConfig(rawConfig))
  const logger = overrides.logger ?? fromCordisLogger(overrides.ctx)

  const transports: FeishuTransport[] = overrides.transports
    ? [...overrides.transports]
    : buildTransports(config, logger)

  const bridge = overrides.bridge
    ?? new DshSessionBridge(overrides.ctx ?? ({ get: () => undefined, on: () => () => undefined, provide: () => () => undefined, effect: () => undefined } satisfies CordisLike), logger)

  return new FeishuGateway({ config, logger, transports, bridge })
}

function buildTransports(config: GatewayConfig, logger: GatewayLogger): FeishuTransport[] {
  const transports: FeishuTransport[] = []
  // Managed URL (admin UI) wins over the legacy env var. The resolved URL stays
  // in memory only: logs receive the redacted `scheme://host:port` form.
  const proxyUrl = resolveProxyUrl(config.networkProxy, config.stateDir)
  const networkProxy: NetworkProxyConfig = proxyUrl
    ? { ...config.networkProxy, url: proxyUrl }
    : config.networkProxy
  if (proxyUrl) logger.info('network proxy in use: %s', redactProxyUrl(proxyUrl))
  for (const bot of config.bots) {
    if (!bot.enabled) {
      logger.info('bot %s is disabled', bot.id)
      continue
    }
    if (config.offline) {
      transports.push(new MockFeishuTransport(bot.id))
      logger.info('bot %s uses the offline mock transport', bot.id)
      continue
    }
    const resolved = resolveBotCredentials(bot)
    if (!resolved.credentials) {
      // Fail closed: a bot without credentials is skipped, never guessed.
      logger.error(
        'bot %s is missing credentials (%s); set %s / %s or use appIdEnv/appSecretEnv',
        bot.id,
        resolved.missing.join(', '),
        `FEISHU_GATEWAY_${bot.id.toUpperCase()}_APP_ID`,
        `FEISHU_GATEWAY_${bot.id.toUpperCase()}_APP_SECRET`,
      )
      continue
    }
    transports.push(new LarkTransport(bot.id, resolved.credentials, logger, networkProxy))
    logger.info('bot %s credentials resolved from %s', bot.id, resolved.source)
  }
  return transports
}

/**
 * Cordis entry point. Everything registered here is fiber-owned:
 * `ctx.provide` and `ctx.effect` are undone automatically on unload, and the
 * effect disposer is the single place that closes WebSockets, cancels long
 * tasks and disposes every owned native AgentHandle.
 */
export function apply(ctx: Context, config: GatewayConfig): void {
  const logger = fromCordisLogger(ctx)
  const gateway = createGateway(config, { ctx: ctx as unknown as CordisLike, logger })

  if (config.diagnoseOnStart) {
    logger.info('configuration %s', JSON.stringify(redactedConfigSummary(loadManagedConfig(resolveConfig(config)))))
  }

  // Public, read-only service for diagnostics / health checks / future Web UI.
  ctx.provide('feishuGateway', {
    health: () => gateway.health(),
    diagnostics: () => gateway.diagnostics(),
    config: () => redactedConfigSummary(loadManagedConfig(resolveConfig(config))),
  })

  ctx.effect(() => {
    // Register the DSH waterfall answerer only while this Gateway fiber lives.
    // No session policy is changed here: approval=never remains unconditionally
    // denied inside DSH and never dispatches approval/request.
    const offApproval = (ctx as unknown as CordisLike).on('approval/request',
      (request: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) =>
        gateway.answerApproval(request, next))
    const start = gateway.start().catch((error: unknown) => {
      logger.error('startup failed: %s', String(error))
    })
    return async () => {
      offApproval()
      await start
      await gateway.stop()
    }
  }, 'feishu-gateway.lifecycle')
}

const plugin: {
  readonly name: string
  readonly inject: readonly string[]
  readonly Config: ConfigValidator
  readonly apply: (ctx: Context, config: GatewayConfig) => void
} = { name, inject, Config, apply }

export default plugin
