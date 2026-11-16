import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { implicitEnvNames, resolveConfig } from './config.js'
import { DEFAULT_PROXY_URL_ENV } from './util/proxy-url.js'
import type {
  AgentFallbackRoute, BotSpec, GatewayConfig, GroupPolicy, GroupRule, GroupSessionScope,
} from './types.js'

/**
 * Strict reader for the admin-managed proxy URL (`network-proxy.json`).
 * Re-exported here so callers use one entry point for managed state; the
 * implementation lives next to the shared URL rules in `util/proxy-url.ts`.
 * Any problem (missing file, symlink, wrong mode, bad JSON, bad URL) returns
 * `undefined` instead of failing plugin startup.
 */
export { readStoredProxyUrl as loadStoredProxyUrl } from './util/proxy-url.js'

/**
 * Managed overrides are deliberately separate from the channel Profile.
 * They take effect ONLY on channel restart, never in the web process.
 * Secrets, stateDir and permission policy are never accepted here.
 */
export interface ManagedChannelConfig {
  bots?: BotSpec[]
  allowlist?: string[]
  groupPolicy?: GroupPolicy
  groupSenderAllowlist?: string[]
  groups?: GroupRule[]
  workspace?: string
  agentWorkspace?: string
  /**
   * Primary route override. Fields may stay partial (inheriting the rest from
   * the Profile); `fallback: null` explicitly clears a previously managed
   * fallback, while an object must name a complete provider/model route.
   */
  agent?: {
    provider?: string
    model?: string
    fallback?: AgentFallbackRoute | null
  }
  replyTimeoutMs?: number
  networkProxy?: { enabled: boolean; urlEnv: string; fallbackDirect: boolean }
  replyFormat?: 'text' | 'markdown'
  sendRetries?: number
  outboxRetryIntervalMs?: number
  autoConnect?: boolean
  approvalCards?: boolean
  streamCards?: boolean
  approvalTimeoutMs?: number
  streamIntervalMs?: number
}

export function managedConfigPath(stateDir: string): string {
  return path.join(stateDir, 'admin-config.json')
}

function dictionary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertFields(obj: Record<string, unknown>, fields: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!fields.includes(key)) throw new Error(`unsupported managed config field: ${key}`)
  }
}

function positiveInteger(value: unknown, key: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`invalid ${key}; expected integer ${min}..${max}`)
  }
  return value as number
}

/** Validation is intentionally strict: an invalid overlay stops startup. */
export function validateManagedConfig(value: unknown): ManagedChannelConfig {
  if (!dictionary(value)) throw new Error('managed config must be an object')
  assertFields(value, ['bots', 'allowlist', 'groupPolicy', 'groupSenderAllowlist', 'groups', 'workspace', 'agentWorkspace', 'agent', 'replyTimeoutMs', 'networkProxy', 'replyFormat', 'sendRetries',
    'outboxRetryIntervalMs', 'autoConnect',
    'approvalCards', 'streamCards', 'approvalTimeoutMs', 'streamIntervalMs'])
  const result: ManagedChannelConfig = {}

  if (value.bots !== undefined) {
    if (!Array.isArray(value.bots) || value.bots.length > 8) throw new Error('bots must be an array (max 8)')
    const seen = new Set<string>()
    result.bots = value.bots.map((item: unknown) => {
      if (!dictionary(item)) throw new Error('bot must be an object')
      assertFields(item, ['id', 'enabled', 'domain'])
      if (typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(item.id)) {
        throw new Error('invalid bot id')
      }
      if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('invalid bot enabled')
      if (item.domain !== 'feishu' && item.domain !== 'lark') throw new Error('invalid bot domain')
      const vars = implicitEnvNames(item.id)
      if (seen.has(vars.appId)) throw new Error('colliding bot environment names')
      seen.add(vars.appId)
      return { id: item.id, enabled: item.enabled !== false, domain: item.domain,
        appIdEnv: vars.appId, appSecretEnv: vars.appSecret }
    })
  }
  if (value.allowlist !== undefined) {
    if (!Array.isArray(value.allowlist) || value.allowlist.length > 200 ||
        value.allowlist.some(v => typeof v !== 'string' || !/^ou_[A-Za-z0-9_-]{2,128}$/.test(v))) {
      throw new Error('allowlist must contain at most 200 valid Feishu open_ids')
    }
    if (new Set(value.allowlist).size !== value.allowlist.length) throw new Error('duplicate open_id in allowlist')
    result.allowlist = [...value.allowlist]
  }
  if (value.groupPolicy !== undefined) {
    if (value.groupPolicy !== 'disabled' && value.groupPolicy !== 'allowlist' && value.groupPolicy !== 'open')
      throw new Error('invalid groupPolicy')
    result.groupPolicy = value.groupPolicy
  }
  if (value.groupSenderAllowlist !== undefined) {
    if (!Array.isArray(value.groupSenderAllowlist) || value.groupSenderAllowlist.length > 200 ||
      value.groupSenderAllowlist.some(id => typeof id !== 'string' || !/^ou_[A-Za-z0-9_-]{2,128}$/.test(id)) ||
      new Set(value.groupSenderAllowlist).size !== value.groupSenderAllowlist.length)
      throw new Error('invalid groupSenderAllowlist')
    result.groupSenderAllowlist = [...value.groupSenderAllowlist]
  }
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups) || value.groups.length > 200) throw new Error('invalid groups')
    const seen = new Set<string>()
    result.groups = value.groups.map((raw: unknown): GroupRule => {
      if (!dictionary(raw)) throw new Error('invalid group rule')
      assertFields(raw, ['chatId', 'enabled', 'name', 'requireMention', 'senderAllowlist', 'sessionScope'])
      if (typeof raw.chatId !== 'string' || !/^oc_[A-Za-z0-9_-]{2,128}$/.test(raw.chatId) || seen.has(raw.chatId))
        throw new Error('invalid or duplicate group chatId')
      seen.add(raw.chatId)
      if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('invalid enabled')
      if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 100)) throw new Error('invalid group name')
      if (raw.requireMention !== undefined && typeof raw.requireMention !== 'boolean') throw new Error('invalid requireMention')
      if (raw.senderAllowlist !== undefined &&
        (!Array.isArray(raw.senderAllowlist) || raw.senderAllowlist.length > 200 ||
          raw.senderAllowlist.some(id => typeof id !== 'string' || !/^ou_[A-Za-z0-9_-]{2,128}$/.test(id)) ||
          new Set(raw.senderAllowlist).size !== raw.senderAllowlist.length)) throw new Error('invalid group senderAllowlist')
      const scope = raw.sessionScope ?? 'group_sender'
      if (scope !== 'group' && scope !== 'group_sender' && scope !== 'group_topic' && scope !== 'group_topic_sender')
        throw new Error('invalid group sessionScope')
      return { chatId: raw.chatId, enabled: raw.enabled !== false,
        ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
        requireMention: raw.requireMention !== false,
        ...(raw.senderAllowlist ? { senderAllowlist: [...raw.senderAllowlist as string[]] } : {}),
        sessionScope: scope as GroupSessionScope }
    })
  }
  if (value.workspace !== undefined) {
    if (typeof value.workspace !== 'string' || value.workspace.length > 4096 ||
        !path.isAbsolute(value.workspace) || value.workspace.includes('\0')) {
      throw new Error('workspace must be an absolute path')
    }
    result.workspace = path.normalize(value.workspace)
  }
  if (value.agentWorkspace !== undefined) {
    if (typeof value.agentWorkspace !== 'string' || value.agentWorkspace.length > 4096 ||
        !path.isAbsolute(value.agentWorkspace) || value.agentWorkspace.includes('\0')) {
      throw new Error('agentWorkspace must be an absolute path')
    }
    result.agentWorkspace = path.normalize(value.agentWorkspace)
  }
  if (value.agent !== undefined) {
    if (!dictionary(value.agent)) throw new Error('agent must be an object')
    assertFields(value.agent, ['provider', 'model', 'fallback'])
    const agent: ManagedChannelConfig['agent'] = {}
    for (const field of ['provider', 'model'] as const) {
      const v = value.agent[field]
      if (v !== undefined) {
        if (typeof v !== 'string' || !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(v)) {
          throw new Error(`invalid agent ${field}`)
        }
        agent[field] = v
      }
    }
    const fallback = value.agent.fallback
    if (fallback === null) {
      // Explicit clear: never inherit a stale managed/Profile fallback.
      agent.fallback = null
    } else if (fallback !== undefined) {
      if (!dictionary(fallback)) throw new Error('agent fallback must be an object or null')
      assertFields(fallback, ['provider', 'model'])
      const provider = fallback.provider
      const model = fallback.model
      if (typeof provider !== 'string' || !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(provider)) {
        throw new Error('invalid agent fallback provider')
      }
      if (typeof model !== 'string' || !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(model)) {
        throw new Error('invalid agent fallback model')
      }
      if (agent.provider === provider && agent.model === model) {
        throw new Error('agent fallback must differ from the primary route')
      }
      agent.fallback = { provider, model }
    }
    result.agent = agent
  }
  if (value.replyTimeoutMs !== undefined) {
    result.replyTimeoutMs = positiveInteger(value.replyTimeoutMs, 'replyTimeoutMs', 5_000, 1_800_000)
  }
  if (value.networkProxy !== undefined) {
    const v = value.networkProxy
    if (!dictionary(v)) throw new Error('networkProxy must be an object')
    // `url` is deliberately NOT an accepted field: the proxy URL (which may
    // carry credentials) lives only in network-proxy.json, never in this file.
    assertFields(v, ['enabled', 'urlEnv', 'fallbackDirect'])
    // Old (rc.9) overlays may omit urlEnv; it then falls back to the legacy name.
    const enabled = v.enabled === undefined ? false : v.enabled
    const fallbackDirect = v.fallbackDirect === undefined ? true : v.fallbackDirect
    const urlEnv = v.urlEnv === undefined ? DEFAULT_PROXY_URL_ENV : v.urlEnv
    if (typeof enabled !== 'boolean' || typeof fallbackDirect !== 'boolean' ||
        typeof urlEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(urlEnv))
      throw new Error('invalid networkProxy configuration')
    result.networkProxy = { enabled, urlEnv, fallbackDirect }
  }
  if (value.replyFormat !== undefined) {
    if (value.replyFormat !== 'text' && value.replyFormat !== 'markdown') throw new Error('invalid replyFormat')
    result.replyFormat = value.replyFormat
  }
  if (value.sendRetries !== undefined) {
    result.sendRetries = positiveInteger(value.sendRetries, 'sendRetries', 1, 10)
  }
  if (value.outboxRetryIntervalMs !== undefined) {
    result.outboxRetryIntervalMs = positiveInteger(value.outboxRetryIntervalMs, 'outboxRetryIntervalMs', 1_000, 300_000)
  }
  for (const field of ['approvalCards', 'streamCards'] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'boolean') throw new Error(`invalid ${field}`)
      result[field] = value[field]
    }
  }
  if (value.approvalTimeoutMs !== undefined)
    result.approvalTimeoutMs = positiveInteger(value.approvalTimeoutMs, 'approvalTimeoutMs', 5_000, 1_800_000)
  if (value.streamIntervalMs !== undefined)
    result.streamIntervalMs = positiveInteger(value.streamIntervalMs, 'streamIntervalMs', 500, 5_000)
  if (value.autoConnect !== undefined) {
    if (typeof value.autoConnect !== 'boolean') throw new Error('autoConnect must be boolean')
    result.autoConnect = value.autoConnect
  }
  return result
}

export function loadManagedConfig(base: GatewayConfig): GatewayConfig {
  const filename = managedConfigPath(base.stateDir)
  try {
    const stat = lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('managed config must be a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base
    throw error
  }
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(filename, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`invalid managed config JSON: ${filename}`, { cause: error })
  }
  if (!dictionary(doc) || doc.version !== 1) throw new Error('unsupported managed config version')
  assertFields(doc, ['version', 'config'])
  const managed = validateManagedConfig(doc.config)
  return resolveConfig({
    ...base,
    ...managed,
    agent: mergeAgentRoute(base.agent, managed.agent),
    bots: managed.bots ?? base.bots,
  })
}

/**
 * Apply the managed route over the Profile route. A managed `fallback: null`
 * removes the route entirely instead of resurrecting a Profile fallback; the
 * primary ids stay independent so a partial managed override keeps working.
 */
function mergeAgentRoute(
  base: GatewayConfig['agent'],
  managed: ManagedChannelConfig['agent'],
): GatewayConfig['agent'] {
  if (!managed) return base
  const merged: {
    provider?: string
    model?: string
    reasoningEffort?: string
    fallback?: { provider: string; model: string }
  } = { ...base }
  if (managed.provider !== undefined) merged.provider = managed.provider
  if (managed.model !== undefined) merged.model = managed.model
  if (managed.fallback === null) delete merged.fallback
  else if (managed.fallback) merged.fallback = managed.fallback
  return merged
}
