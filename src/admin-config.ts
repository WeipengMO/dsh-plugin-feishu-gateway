import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { implicitEnvNames, resolveConfig } from './config.js'
import type { BotSpec, GatewayConfig } from './types.js'

/**
 * Managed overrides are deliberately separate from the channel Profile.
 * They take effect ONLY on channel restart, never in the web process.
 * Secrets, stateDir and permission policy are never accepted here.
 */
export interface ManagedChannelConfig {
  bots?: BotSpec[]
  allowlist?: string[]
  workspace?: string
  agent?: { provider?: string; model?: string }
  replyTimeoutMs?: number
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
  assertFields(value, ['bots', 'allowlist', 'workspace', 'agent', 'replyTimeoutMs', 'replyFormat', 'sendRetries',
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
  if (value.workspace !== undefined) {
    if (typeof value.workspace !== 'string' || value.workspace.length > 4096 ||
        !path.isAbsolute(value.workspace) || value.workspace.includes('\0')) {
      throw new Error('workspace must be an absolute path')
    }
    result.workspace = path.normalize(value.workspace)
  }
  if (value.agent !== undefined) {
    if (!dictionary(value.agent)) throw new Error('agent must be an object')
    assertFields(value.agent, ['provider', 'model'])
    const agent: { provider?: string; model?: string } = {}
    for (const field of ['provider', 'model'] as const) {
      const v = value.agent[field]
      if (v !== undefined) {
        if (typeof v !== 'string' || !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(v)) {
          throw new Error(`invalid agent ${field}`)
        }
        agent[field] = v
      }
    }
    result.agent = agent
  }
  if (value.replyTimeoutMs !== undefined) {
    result.replyTimeoutMs = positiveInteger(value.replyTimeoutMs, 'replyTimeoutMs', 5_000, 1_800_000)
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
    result.approvalTimeoutMs = positiveInteger(value.approvalTimeoutMs, 'approvalTimeoutMs', 5_000, 300_000)
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
    agent: managed.agent ? { ...base.agent, ...managed.agent } : base.agent,
    bots: managed.bots ?? base.bots,
  })
}
