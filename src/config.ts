import Schema from '@deepseek-ai/schemastery'
import { resolveProxyUrl } from './util/proxy-url.js'
import type {
  AgentRoute, BotCredentials, BotSpec, GatewayConfig, GroupRule, GroupSessionScope,
} from './types.js'

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
  allowGroups: Schema.boolean().default(false).description('Legacy switch; never enables group chats.'),
  groupPolicy: Schema.union([Schema.const('disabled'), Schema.const('allowlist'), Schema.const('open')]).default('disabled'),
  groupSenderAllowlist: Schema.array(Schema.string()).default([]),
  groups: Schema.array(Schema.object({
    chatId: Schema.string(), enabled: Schema.boolean().default(true),
    name: Schema.string(), requireMention: Schema.boolean().default(true),
    senderAllowlist: Schema.array(Schema.string()),
    sessionScope: Schema.union([Schema.const('group'), Schema.const('group_sender'),
      Schema.const('group_topic'), Schema.const('group_topic_sender')]).default('group_sender'),
  })).default([]),
  workspace: Schema.string().default('')
    .description('Legacy/shared project root. The native Feishu Session uses its own isolated agentWorkspace.'),
  agentWorkspace: Schema.string().default('')
    .description('Dedicated Feishu Agent cwd. Empty chooses an isolated channel-only directory.'),
  agentPreset: Schema.string().description('Optional DSH agent preset name.'),
  agent: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
    reasoningEffort: Schema.string(),
    fallback: Schema.object({
      provider: Schema.string(),
      model: Schema.string(),
    }),
  }).default({}).description('Optional model route override plus a Gateway-owned fallback rescue route.'),
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
  networkProxy: Schema.object({
    enabled: Schema.boolean().default(false),
    urlEnv: Schema.string().default('FEISHU_CHANNEL_PROXY_URL'),
    fallbackDirect: Schema.boolean().default(true),
  }).default({ enabled: false, urlEnv: 'FEISHU_CHANNEL_PROXY_URL', fallbackDirect: true })
    .description('Optional startup proxy for Feishu channel and DSH Agent HTTP requests; proxy URL is read from the named env variable only.'),
  replyFormat: Schema.union([Schema.const('text'), Schema.const('markdown')]).default('text')
    .description('Feishu reply type: legacy text (default) or post/md rich Markdown.'),
  approvalCards: Schema.boolean().default(false)
    .description('Answer DSH approval/request using authenticated one-shot Feishu cards. Requires DSH approval policy ask.'),
  streamCards: Schema.boolean().default(false)
    .description('Show optional CardKit streaming progress while final answer stays in durable Outbox.'),
  approvalTimeoutMs: Schema.number().default(600_000)
    .description('Time limit for one interactive tool approval (ms). Timeout denies.'),
  streamIntervalMs: Schema.number().default(800)
    .description('CardKit update interval; max one update per interval, never per-token.'),

  sendRetries: Schema.number().default(3)
    .description('Outbound send attempts before the message is parked in the durable outbox.'),
  sendRetryBaseDelayMs: Schema.number().default(500),
  outboxRetryIntervalMs: Schema.number().default(30_000)
    .description('Periodic retry for parked replies even if the WebSocket stays connected (ms).'),
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
    groupPolicy: raw.groupPolicy === 'allowlist' || raw.groupPolicy === 'open' ? raw.groupPolicy : 'disabled',
    groupSenderAllowlist: Array.isArray(raw.groupSenderAllowlist)
      ? [...new Set(raw.groupSenderAllowlist.filter((id): id is string => typeof id === 'string' && /^ou_[A-Za-z0-9_-]{2,128}$/.test(id)))]
      : [],
    groups: Array.isArray(raw.groups) ? (raw.groups as Partial<GroupRule>[])
      .filter(g => g && typeof g.chatId === 'string' && /^oc_[A-Za-z0-9_-]{2,128}$/.test(g.chatId))
      .map(g => ({
        chatId: g.chatId!,
        enabled: g.enabled !== false,
        ...(typeof g.name === 'string' ? { name: g.name.slice(0, 100) } : {}),
        requireMention: g.requireMention !== false,
        ...(Array.isArray(g.senderAllowlist) ? { senderAllowlist: g.senderAllowlist.filter(id => /^ou_[A-Za-z0-9_-]{2,128}$/.test(id)) } : {}),
        sessionScope: (['group', 'group_sender', 'group_topic', 'group_topic_sender'] as GroupSessionScope[])
          .includes(g.sessionScope as GroupSessionScope) ? g.sessionScope as GroupSessionScope : 'group_sender',
      })) : [],
    workspace,
    ...(typeof raw.agentWorkspace === 'string' && raw.agentWorkspace.trim() ?
      { agentWorkspace: raw.agentWorkspace } : {}),
    ...(typeof raw.agentPreset === 'string' && raw.agentPreset ? { agentPreset: raw.agentPreset } : {}),
    agent: normalizeAgentRoute(raw.agent),
    stateDir,
    dedupTtlMs: numberOr(raw.dedupTtlMs, 24 * 60 * 60 * 1000),
    maxDedupEntries: numberOr(raw.maxDedupEntries, 50_000),
    maxTextLength: numberOr(raw.maxTextLength, 8000),
    replyTimeoutMs: numberOr(raw.replyTimeoutMs, 120_000),
    networkProxy: {
      enabled: (raw.networkProxy as Partial<GatewayConfig['networkProxy']> | undefined)?.enabled === true,
      urlEnv: (() => {
        const value = (raw.networkProxy as Partial<GatewayConfig['networkProxy']> | undefined)?.urlEnv
        return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
          ? value : 'FEISHU_CHANNEL_PROXY_URL'
      })(),
      fallbackDirect: (raw.networkProxy as Partial<GatewayConfig['networkProxy']> | undefined)?.fallbackDirect !== false,
    },
    replyFormat: raw.replyFormat === 'markdown' ? 'markdown' : 'text',
    approvalCards: raw.approvalCards === true,
    streamCards: raw.streamCards === true,
    approvalTimeoutMs: Math.max(5_000, Math.min(1_800_000, numberOr(raw.approvalTimeoutMs, 600_000))),
    streamIntervalMs: Math.max(500, Math.min(5_000, numberOr(raw.streamIntervalMs, 800))),
    sendRetries: numberOr(raw.sendRetries, 3),
    sendRetryBaseDelayMs: numberOr(raw.sendRetryBaseDelayMs, 500),
    outboxRetryIntervalMs: Math.max(20, numberOr(raw.outboxRetryIntervalMs, 30_000)),
    autoConnect: raw.autoConnect !== false,
    offline: raw.offline === true || process.env.FEISHU_GATEWAY_OFFLINE === '1',
    diagnoseOnStart: raw.diagnoseOnStart !== false,
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** One provider/model route id; matches the admin API's accepted alphabet. */
const ROUTE_VALUE = /^[A-Za-z0-9_./:@+-]{1,160}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize the optional model route. A base profile may legitimately override
 * only one of provider/model, so partial routes are preserved. A fallback is
 * kept only when BOTH ids are present and valid and it is not the primary route
 * (a fallback identical to the primary can never rescue the turn).
 */
export function normalizeAgentRoute(value: unknown): AgentRoute {
  if (!isRecord(value)) return {}
  const route: {
    provider?: string
    model?: string
    reasoningEffort?: string
    fallback?: { provider: string; model: string }
  } = {}
  for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
    const raw = value[key]
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (text && ROUTE_VALUE.test(text)) route[key] = text
  }
  const fallback = value.fallback
  if (isRecord(fallback)) {
    const provider = typeof fallback.provider === 'string' ? fallback.provider.trim() : ''
    const model = typeof fallback.model === 'string' ? fallback.model.trim() : ''
    if (provider && model && ROUTE_VALUE.test(provider) && ROUTE_VALUE.test(model) &&
      !(route.provider === provider && route.model === model)) {
      route.fallback = { provider, model }
    }
  }
  return route
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
 * Secrets are never logged; only the resolved *source* is reported.
 */
export function resolveBotCredentials(
  bot: BotSpec,
  env: NodeJS.ProcessEnv = process.env,
): { credentials?: BotCredentials; source: string; missing: string[] } {
  const implicit = implicitEnvNames(bot.id)
  const missing: string[] = []
  const sources: string[] = []

  const read = (explicitName: string | undefined, implicitName: string) => {
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
    missing.push(implicitName)
    return undefined
  }

  const appId = read(bot.appIdEnv, implicit.appId)
  const appSecret = read(bot.appSecretEnv, implicit.appSecret)

  if (!appId || !appSecret) {
    return { source: sources.join(',') || 'none', missing }
  }
  return {
    credentials: { appId, appSecret, domain: bot.domain },
    source: sources.join(','),
    missing: [],
  }
}

/** Redacted config summary — safe to log. The proxy URL itself never appears. */
export function redactedConfigSummary(config: GatewayConfig): Record<string, unknown> {
  const proxy = config.networkProxy
  // Presence only: the effective URL (managed file → env var) is never rendered.
  const effectiveProxyUrl = resolveProxyUrl(proxy, config.stateDir)
  return {
    bots: config.bots.map((b) => ({ id: b.id, enabled: b.enabled, domain: b.domain })),
    allowlistSize: config.allowlist.length,
    allowGroups: config.allowGroups,
    workspace: config.workspace,
    agentWorkspace: config.agentWorkspace ?? '(auto: isolated Feishu agent workspace)',
    stateDir: config.stateDir,
    offline: config.offline,
    autoConnect: config.autoConnect,
    replyFormat: config.replyFormat,
    approvalCards: config.approvalCards,
    streamCards: config.streamCards,
    proxy: {
      enabled: proxy.enabled,
      urlEnv: proxy.urlEnv,
      fallbackDirect: proxy.fallbackDirect,
      configured: effectiveProxyUrl !== undefined,
      selected: process.env.FEISHU_GATEWAY_PROXY_SELECTED ?? 'unmanaged',
    },
  }
}
