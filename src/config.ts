import Schema from '@deepseek-ai/schemastery'
import type { BotCredentials, BotSpec, GatewayConfig } from './types.js'

export type { GatewayConfig, BotSpec } from './types.js'

/**
 * Config schema. Secrets are NEVER declared here: app id / secret are read from
 * environment variables (or, for local development only, from literal fields).
 * See `.env.example` and docs/ARCHITECTURE.md.
 */
const BotSchema = Schema.object({
  id: Schema.string().description('Stable local name for this bot (used in state keys and logs).'),
  enabled: Schema.boolean().default(true).description('Set false to keep the bot installed but disconnected.'),
  domain: Schema.union([Schema.const('feishu'), Schema.const('lark')]).default('feishu')
    .description('Open platform domain: feishu.cn or larksuite.com.'),
  appIdEnv: Schema.string().description('Env var name holding the app id (recommended).'),
  appSecretEnv: Schema.string().description('Env var name holding the app secret (recommended).'),
  appId: Schema.string().description('Literal app id — local development only, never a secret.'),
  appSecret: Schema.string().description('Literal app secret — local development only. Prefer appSecretEnv.'),
})

/**
 * Opaque Standard-Schema validator. Keeping the inferred schemastery type out
 * of the public `.d.ts` avoids leaking pnpm-internal cosmokit paths (TS2742).
 */
export type ConfigValidator = { readonly '~standard': unknown }

export const Config: ConfigValidator = Schema.object({
  bots: Schema.array(BotSchema).default([]).description('One entry per Feishu app/bot.'),
  allowlist: Schema.array(Schema.string()).default([])
    .description('Allowed sender open_ids. Empty = deny all inbound messages (fail closed).'),
  allowGroups: Schema.boolean().default(false)
    .description('Group chats stay OFF in v0.1.0. Enabling this flag is still rejected by the router.'),
  workspace: Schema.string().default('')
    .description('Absolute cwd for native DSH Sessions. Empty resolves to the profile working directory.'),
  agentPreset: Schema.string().description('Optional DSH agent preset name.'),
  agent: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
    reasoningEffort: Schema.string(),
  }).default({}).description('Optional model route override; omitted fields inherit the profile default.'),
  stateDir: Schema.string().default('')
    .description('Durable state directory. Empty resolves to $DSH_HOME/feishu-gateway.'),
  dedupTtlMs: Schema.number().default(24 * 60 * 60 * 1000)
    .description('How long a processed message_id is remembered.'),
  maxDedupEntries: Schema.number().default(50_000)
    .description('Upper bound on remembered message ids (oldest are pruned first).'),
  maxTextLength: Schema.number().default(8000)
    .description('Inbound text is truncated to this many code points.'),
  replyTimeoutMs: Schema.number().default(120_000)
    .description('Maximum time to wait for the native Session reply.'),
  sendRetries: Schema.number().default(3)
    .description('Outbound send attempts before the message is parked in the durable outbox.'),
  sendRetryBaseDelayMs: Schema.number().default(500),
  autoConnect: Schema.boolean().default(true)
    .description('Open WebSocket connections on plugin activation.'),
  offline: Schema.boolean().default(false)
    .description('Hard offline switch: no Feishu network calls (mock/local profiles).'),
  diagnoseOnStart: Schema.boolean().default(true)
    .description('Log a redacted configuration/health summary at startup.'),
}) as unknown as ConfigValidator

/** Merge schema defaults into a partial user config. */
export function resolveConfig(input: Partial<GatewayConfig> | undefined): GatewayConfig {
  const raw = (input ?? {}) as Record<string, unknown>
  const bots = ((raw.bots as BotSpec[] | undefined) ?? []).map((bot) => ({
    id: String(bot.id ?? 'default'),
    enabled: bot.enabled !== false,
    domain: bot.domain === 'lark' ? 'lark' : 'feishu',
    ...(bot.appIdEnv ? { appIdEnv: bot.appIdEnv } : {}),
    ...(bot.appSecretEnv ? { appSecretEnv: bot.appSecretEnv } : {}),
    ...(bot.appId ? { appId: bot.appId } : {}),
    ...(bot.appSecret ? { appSecret: bot.appSecret } : {}),
  })) satisfies BotSpec[]

  const workspace = typeof raw.workspace === 'string' && raw.workspace.trim() !== ''
    ? raw.workspace
    : process.cwd()
  const stateDir = typeof raw.stateDir === 'string' && raw.stateDir.trim() !== ''
    ? raw.stateDir
    : defaultStateDir()

  return {
    bots,
    allowlist: (raw.allowlist as string[] | undefined) ?? [],
    allowGroups: raw.allowGroups === true,
    workspace,
    ...(typeof raw.agentPreset === 'string' && raw.agentPreset ? { agentPreset: raw.agentPreset } : {}),
    agent: (raw.agent as GatewayConfig['agent']) ?? {},
    stateDir,
    dedupTtlMs: numberOr(raw.dedupTtlMs, 24 * 60 * 60 * 1000),
    maxDedupEntries: numberOr(raw.maxDedupEntries, 50_000),
    maxTextLength: numberOr(raw.maxTextLength, 8000),
    replyTimeoutMs: numberOr(raw.replyTimeoutMs, 120_000),
    sendRetries: numberOr(raw.sendRetries, 3),
    sendRetryBaseDelayMs: numberOr(raw.sendRetryBaseDelayMs, 500),
    autoConnect: raw.autoConnect !== false,
    offline: raw.offline === true || process.env.FEISHU_GATEWAY_OFFLINE === '1',
    diagnoseOnStart: raw.diagnoseOnStart !== false,
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function defaultStateDir(): string {
  const home = process.env.DSH_HOME
  return home ? `${home}/feishu-gateway` : `${process.cwd()}/.feishu-gateway`
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Feishu long-connection mode requires a self-built app id shaped like
 * `cli_` + 16 hex characters; `WSClient.start()` bails out early otherwise.
 * This is a diagnostic only — we never reject a config on a shape hunch.
 */
export function appIdLooksValid(appId: string): boolean {
  return /^cli_[0-9a-fA-F]{16}$/.test(appId)
}

/** Prefix used for the implicit per-bot environment variable names. */
export function implicitEnvNames(botId: string): { appId: string; appSecret: string } {
  const safe = botId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return {
    appId: `FEISHU_GATEWAY_${safe}_APP_ID`,
    appSecret: `FEISHU_GATEWAY_${safe}_APP_SECRET`,
  }
}

/**
 * Resolve one bot's credentials. Precedence:
 *   1. configured env-var name (`appIdEnv` / `appSecretEnv`)
 *   2. implicit `FEISHU_GATEWAY_<ID>_APP_ID` / `_APP_SECRET`
 *   3. literal config field (local development only)
 * Secrets are never logged; only the resolved *source* is reported.
 */
export function resolveBotCredentials(
  bot: BotSpec,
  env: NodeJS.ProcessEnv = process.env,
): { credentials?: BotCredentials; source: string; missing: string[] } {
  const implicit = implicitEnvNames(bot.id)
  const missing: string[] = []
  const sources: string[] = []

  const read = (explicitName: string | undefined, implicitName: string, literal: string | undefined) => {
    if (explicitName) {
      if (!ENV_NAME.test(explicitName)) {
        missing.push(`invalid env var name ${explicitName}`)
        return undefined
      }
      const value = env[explicitName]?.trim()
      if (value) {
        sources.push(`env:${explicitName}`)
        return value
      }
      missing.push(explicitName)
      return undefined
    }
    const implicitValue = env[implicitName]?.trim()
    if (implicitValue) {
      sources.push(`env:${implicitName}`)
      return implicitValue
    }
    if (literal) {
      sources.push('config-literal')
      return literal
    }
    missing.push(implicitName)
    return undefined
  }

  const appId = read(bot.appIdEnv, implicit.appId, bot.appId)
  const appSecret = read(bot.appSecretEnv, implicit.appSecret, bot.appSecret)

  if (!appId || !appSecret) {
    return { source: sources.join(',') || 'none', missing }
  }
  return {
    credentials: { appId, appSecret, domain: bot.domain },
    source: sources.join(','),
    missing: [],
  }
}

/** Redacted config summary — safe to log. */
export function redactedConfigSummary(config: GatewayConfig): Record<string, unknown> {
  return {
    bots: config.bots.map((b) => ({ id: b.id, enabled: b.enabled, domain: b.domain })),
    allowlistSize: config.allowlist.length,
    allowGroups: config.allowGroups,
    workspace: config.workspace,
    stateDir: config.stateDir,
    offline: config.offline,
    autoConnect: config.autoConnect,
  }
}
