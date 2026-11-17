/**
 * Opt-in-free, bounded operations telemetry for the local authenticated Web Admin.
 * NEVER store conversation text, chat/user IDs, tool arguments, credentials,
 * command output, paths, or raw exception messages here.
 *
 * The Web Admin exposes only these explicitly curated DTOs; it must not read
 * and return inbox.jsonl or outbox.json, which contain private conversations.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import type { ModelTokenUsage } from '../types.js'
import path from 'node:path'

export type OpsKind = 'message' | 'task' | 'approval' | 'transport' | 'delivery' | 'system'
export interface OpsEvent {
  readonly version: 1
  readonly ts: number
  readonly kind: OpsKind
  readonly state: string
  readonly ref?: string
  readonly session?: string
  readonly botId?: string
  readonly model?: string
  readonly tokens?: number
  readonly elapsedMs?: number
}
export interface OpsTask {
  readonly ref: string
  readonly session?: string
  readonly botId: string
  readonly phase: 'running' | 'finalizing'
  readonly elapsedMs: number
}
export interface OpsSession {
  readonly ref: string
  readonly createdAt: number
  readonly lastActiveAt: number
  readonly persisted: boolean
}
export interface OpsSnapshot {
  /** The native DSH working directory actually used to create Feishu Sessions. */
  readonly workspace: string
  /** Former/shared project directory; not the Feishu Session cwd. */
  readonly sharedProjectWorkspace?: string
  readonly isolatedAgent?: boolean
  /**
   * The Gateway Host's DSH model directory: flat routes stay for older readers,
   * `providers` feeds the Web Admin's provider/model selectors.
   */
  readonly modelCatalog?: {
    readonly ts: number
    readonly incomplete: boolean
    readonly models: readonly string[]
    readonly providers?: readonly {
      readonly id: string
      readonly name?: string
      readonly models: readonly { readonly id: string; readonly name?: string }[]
    }[]
  }
  /** Read-only native DSH compaction capability and local observations. The
   * Gateway cannot override host-owned auto trigger policy. */
  readonly compaction?: {
    readonly available: boolean
    readonly completedInProcess: number
    readonly lastCompletedAt?: number
    readonly lastShadowedItems?: number
    readonly lastShadowedTokens?: number
  }
  /** Effective model route configured for Feishu Sessions (Profile + managed). */
  readonly agentRoute?: {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly fallback?: { readonly provider: string; readonly model: string }
    readonly fallbacks?: readonly { readonly provider: string; readonly model: string }[]
  }
  /** The Host Profile's own `agent-default-model` selection (read-only fact). */
  readonly profileDefaultRoute?: {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
  }
  readonly version: 1
  readonly ts: number
  readonly status: string
  readonly tasks: readonly OpsTask[]
  readonly sessions: readonly OpsSession[]
  readonly transport: Record<string, {
    readonly state: string
    readonly reconnects: number
    readonly failures: number
    readonly lastConnectedAt?: number
    readonly lastDisconnectedAt?: number
  }>
  readonly stats: {
    readonly activeTurns: number
    readonly boundSessions: number
    readonly pendingApprovals: number
    readonly processed: number
    readonly errors: number
    readonly outboxPending: number
    readonly inboxPending: number
  }
}

// A SHA256 prefix is a UI correlation handle, NOT an authorization token.
// Never use this value to authorize an administrative action.
export function opsRef(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function safeBot(bot?: string): string | undefined {
  return typeof bot === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(bot) ? bot : undefined
}
function safeModel(model?: string): string | undefined {
  return typeof model === 'string' && /^[a-zA-Z0-9_.:/-]{1,96}$/.test(model) ? model : undefined
}
function safeNumber(value?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(1e13, Math.floor(value)) : undefined
}
async function checkFile(file: string): Promise<void> {
  try {
    const st = await lstat(file)
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('unsafe telemetry file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export class OpsTelemetry {
  private lastRetentionDay: string | undefined
  private readonly usageRetentionDays: number
  private readonly eventsFile: string
  private readonly snapshotFile: string
  private chain: Promise<unknown> = Promise.resolve()
  private writes = 0
  constructor(private readonly stateDir: string, retentionDays = Number(process.env.DSH_FEISHU_USAGE_RETENTION_DAYS ?? 365)) {
    if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 730)
      throw new Error('DSH_FEISHU_USAGE_RETENTION_DAYS must be an integer between 7 and 730')
    this.usageRetentionDays = retentionDays
    this.eventsFile = path.join(stateDir, 'ops-events.jsonl')
    this.snapshotFile = path.join(stateDir, 'ops-runtime.json')
  }
  private queue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job)
    this.chain = next.catch(() => undefined)
    return next
  }
  async record(value: {
    kind: OpsKind; state: string; botId?: string; ref?: string
    session?: string; model?: string; tokens?: number; elapsedMs?: number
  }): Promise<void> {
    // Every event string comes from an allowlisted, finite alphabet. Reject
    // arbitrary text rather than accidentally recording an exception body.
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(value.state)) return
    const event: OpsEvent = {
      version: 1, ts: Date.now(), kind: value.kind, state: value.state,
      ...(value.ref ? { ref: opsRef(value.ref) } : {}),
      ...(value.session ? { session: opsRef(value.session) } : {}),
      ...(safeBot(value.botId) ? { botId: safeBot(value.botId) } : {}),
      ...(safeModel(value.model) ? { model: safeModel(value.model) } : {}),
      ...(safeNumber(value.tokens) !== undefined ? { tokens: safeNumber(value.tokens) } : {}),
      ...(safeNumber(value.elapsedMs) !== undefined ? { elapsedMs: safeNumber(value.elapsedMs) } : {}),
    }
    await this.queue(async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
      await checkFile(this.eventsFile)
      await appendFile(this.eventsFile, JSON.stringify(event) + '\n', { mode: 0o600 })
      this.writes += 1
      // Bounded file size: at most 2 MiB before rotating to 1,000 lines.
      if (this.writes % 32 !== 0) return
      const { size } = await lstat(this.eventsFile)
      if (size <= 2 * 1024 * 1024) return
      const raw = await readFile(this.eventsFile, 'utf8')
      const tail = raw.trimEnd().split('\n').slice(-1000).join('\n') + '\n'
      await this.privateWrite(this.eventsFile, tail)
    })
  }
  /**
   * A separate, retention-bounded, append-only ledger. Each terminal task has
   * one stable hashed correlation key; the reader deduplicates after retries.
   * Do not record raw Feishu identities, conversations, or tool output.
   * A missing model-reported usage object is recorded as UNKNOWN, not zero.
   */
  async recordUsage(value: {
    ref: string; botId: string; session?: string; user?: string; chat?: string
    model?: string; status: 'done' | 'failed' | 'cancelled' | 'timeout' | 'uncertain'
    source?: 'schedule'
    usage?: ModelTokenUsage
  }): Promise<void> {
    const botId = safeBot(value.botId)
    if (!botId || !value.ref) return
    const validToken = (n: number | undefined): n is number =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1e13
    const usage = value.usage
    const known = usage && validToken(usage.inputTokens) && validToken(usage.outputTokens)
    const now = Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    const event = {
      version: 1 as const, ts: now, ref: opsRef(value.ref), botId,
      status: value.status,
      ...(value.source === 'schedule' ? { source: 'schedule' as const } : {}),
      ...(value.session ? { session: opsRef(value.session) } : {}),
      ...(value.user ? { user: opsRef(value.user) } : {}),
      ...(value.chat ? { chat: opsRef(value.chat) } : {}),
      ...(safeModel(value.model) ? { model: safeModel(value.model) } : {}),
      ...(known ? {
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        ...(validToken(usage.cacheReadTokens) ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(validToken(usage.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      } : {}),
    }
    await this.queue(async () => {
      const root = path.join(this.stateDir, 'ops-usage')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const st = await lstat(root)
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('unsafe usage directory')
      const file = path.join(root, day + '.jsonl')
      await checkFile(file)
      await appendFile(file, JSON.stringify(event) + '\n', { mode: 0o600 })
      if (this.lastRetentionDay === day) return
      this.lastRetentionDay = day
      // Retain the last N UTC dates; never delete unexpected names or links.
      const cutoff = new Date(Date.parse(day + 'T00:00:00Z') -
        (this.usageRetentionDays - 1) * 86400000).toISOString().slice(0, 10)
      for (const name of await readdir(root)) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) || name.slice(0, 10) >= cutoff) continue
        const previous = path.join(root, name)
        const info = await lstat(previous)
        if (info.isFile() && !info.isSymbolicLink()) await rm(previous)
      }
    })
  }
  async snapshot(state: OpsSnapshot): Promise<void> {
    await this.queue(async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
      await this.privateWrite(this.snapshotFile, JSON.stringify(state) + '\n')
    })
  }
  private async privateWrite(file: string, content: string): Promise<void> {
    await checkFile(file)
    const temp = file + '.' + randomUUID() + '.tmp'
    try {
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      await rename(temp, file)
    } finally { await rm(temp, { force: true }).catch(() => undefined) }
  }
  async whenIdle(): Promise<void> { await this.chain }
}
