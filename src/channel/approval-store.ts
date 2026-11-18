/**
 * Durable permanent tool-authorization rules and a bounded approval audit for
 * the Feishu channel.
 *
 * DSH's native approval API can only grant one call at a time
 * (`allowed-once`), so "permanent" means: the Gateway persists a narrow rule
 * and answers later matching requests itself without showing a new card. A
 * rule is always scoped to one tool, and for `bash` additionally to the
 * command's executable root (`lark-cli`, `git`, ...) — never to arbitrary
 * reviewed arguments. The operator can revoke every rule from the Web Admin.
 *
 * Files (stateDir, 0600, atomic writes, symlink-refusing):
 *   approvals.json       {version:1, rules:[...]}
 *   approval-audit.jsonl bounded JSON-lines decision history
 *   ops-approvals.json   read model consumed by the Web Admin
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises'
import path from 'node:path'

export type ApprovalDecision =
  | 'requested'
  | 'allowed-once'
  | 'allowed-permanent'
  | 'auto-allowed'
  | 'rejected'
  | 'timed-out'
  | 'cancelled'
  | 'unavailable'

export interface ApprovalRule {
  readonly ref: string
  readonly tool: string
  readonly commandRoot?: string
  readonly label: string
  readonly createdAt: number
  readonly createdByRef: string
  readonly lastUsedAt: number | null
  readonly uses: number
}

export interface ApprovalRecordInput {
  readonly ts: number
  readonly tool: string
  readonly command: string | null
  readonly decision: ApprovalDecision
  readonly botId: string
  readonly chatRef: string
  readonly ruleRef?: string | null
  readonly elapsedMs?: number | null
}

export interface ApprovalPendingView {
  readonly ref: string
  readonly botId: string
  readonly chatRef: string
  readonly tool: string
  readonly command: string | null
  readonly requestedAt: number
  readonly expiresAt: number
}

export interface ApprovalReadModel {
  readonly version: 1
  readonly ts: number
  readonly available: boolean
  readonly reason: string | null
  readonly timeoutMs: number
  readonly pending: readonly ApprovalPendingView[]
  readonly rules: readonly ApprovalRule[]
  readonly records: readonly (Omit<ApprovalRecordInput, 'ruleRef'> & { readonly ruleRef: string | null })[]
  readonly recordLimit: number
}

export const APPROVAL_RULES_FILE = 'approvals.json'
export const APPROVAL_AUDIT_FILE = 'approval-audit.jsonl'
export const APPROVAL_MODEL_FILE = 'ops-approvals.json'
export const APPROVAL_MAX_RULES = 200
export const APPROVAL_MAX_RECORDS = 200
const AUDIT_KEEP_LINES = 500
const FILE_MAX_BYTES = 1024 * 1024
const REF_RE = /^[a-f0-9]{16}$/
const TOOL_RE = /^[A-Za-z0-9_.:@/-]{1,96}$/
const ROOT_RE = /^[A-Za-z0-9_.:@/+-]{1,64}$/
const DECISIONS = new Set<ApprovalDecision>([
  'requested', 'allowed-once', 'allowed-permanent', 'auto-allowed',
  'rejected', 'timed-out', 'cancelled', 'unavailable',
])

/** Stable display handle for opaque ids (same 16-hex shape as ops refs). */
export function approvalRef(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** Prefer an existing 16-hex handle so hashed inputs are not hashed twice. */
export function asRef(value: string | undefined): string {
  return typeof value === 'string' && REF_RE.test(value) ? value : approvalRef(String(value ?? ''))
}

/**
 * Executable root of a shell command, used as the permanent-allowance scope.
 * Strips leading environment assignments and common wrappers; returns only a
 * conservative single token (no arguments, no redirections).
 */
export function commandRoot(command: string | undefined | null): string | undefined {
  if (typeof command !== 'string') return undefined
  const line = command.split('\n')[0]?.trim() ?? ''
  if (!line) return undefined
  const tokens = line.split(/\s+/)
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1
  if (index >= tokens.length) return undefined
  let token = tokens[index]!
  if (['sudo', 'env', 'nohup', 'time', 'command'].includes(token) && tokens[index + 1]) {
    token = tokens[index + 1]!
  }
  token = token.replace(/^['"]|['"]$/g, '')
  const base = token.slice(token.lastIndexOf('/') + 1)
  return ROOT_RE.test(base) ? base : undefined
}

/** One-line bounded command summary safe for audit tables. */
export function commandSummary(command: string | undefined | null): string | null {
  if (typeof command !== 'string') return null
  const clean = command.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return clean.slice(0, 200)
}

function boundedNumber(value: unknown, max = 1e13): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
    ? Math.floor(value) : null
}

function safeString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

function ruleKey(tool: string, root: string | undefined): string {
  return tool + '\u0000' + (root ?? '')
}

function ruleLabel(tool: string, root: string | undefined): string {
  return root ? tool + ' · ' + root + '*' : tool
}

export interface ApprovalStoreOptions {
  readonly stateDir: string
  readonly logger?: { warn(...args: unknown[]): void }
}

/**
 * Persistent rules + audit. Rules fail closed: a corrupt or unreadable store
 * loads as empty (no auto-allow) and only logs a warning.
 */
export class ApprovalStore {
  private readonly stateDir: string
  private readonly logger: ApprovalStoreOptions['logger']
  private rules: ApprovalRule[] = []
  private records: ApprovalRecordInput[] = []
  private loaded = false
  private queue: Promise<void> = Promise.resolve()

  constructor(options: ApprovalStoreOptions) {
    this.stateDir = options.stateDir
    this.logger = options.logger
  }

  get rulesFile(): string { return path.join(this.stateDir, APPROVAL_RULES_FILE) }
  get auditFile(): string { return path.join(this.stateDir, APPROVAL_AUDIT_FILE) }
  get modelFile(): string { return path.join(this.stateDir, APPROVAL_MODEL_FILE) }

  private async readPrivateFile(file: string): Promise<string | undefined> {
    try {
      const st = await lstat(file)
      if (!st.isFile() || st.isSymbolicLink()) return undefined
      if (st.size > FILE_MAX_BYTES) return undefined
      return await readFile(file, 'utf8')
    } catch {
      return undefined
    }
  }

  private static parseRule(raw: unknown): ApprovalRule | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const r = raw as Record<string, unknown>
    const ref = safeString(r.ref, 16)
    const tool = safeString(r.tool, 96)
    if (!ref || !REF_RE.test(ref) || !tool || !TOOL_RE.test(tool)) return undefined
    const root = r.commandRoot === undefined ? undefined : safeString(r.commandRoot, 64)
    if (r.commandRoot !== undefined && (!root || !ROOT_RE.test(root))) return undefined
    if (tool === 'bash' && root === undefined) return undefined
    const label = safeString(r.label, 160) ?? ruleLabel(tool, root)
    const createdAt = boundedNumber(r.createdAt)
    if (createdAt === null) return undefined
    const createdByRef = safeString(r.createdByRef, 16)
    if (!createdByRef || !REF_RE.test(createdByRef)) return undefined
    const lastUsedAt = r.lastUsedAt === null || r.lastUsedAt === undefined ? null : boundedNumber(r.lastUsedAt)
    const uses = boundedNumber(r.uses) ?? 0
    return { ref, tool, ...(root ? { commandRoot: root } : {}), label,
      createdAt, createdByRef, lastUsedAt, uses }
  }

  private static parseRecord(raw: unknown): ApprovalRecordInput | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const r = raw as Record<string, unknown>
    const ts = boundedNumber(r.ts)
    const tool = safeString(r.tool, 96)
    const decision = safeString(r.decision, 32) as ApprovalDecision | undefined
    const botId = safeString(r.botId, 32)
    const chatRef = safeString(r.chatRef, 16)
    if (ts === null || !tool || !TOOL_RE.test(tool) || !decision || !DECISIONS.has(decision) ||
        !botId || !chatRef || !REF_RE.test(chatRef)) return undefined
    const command = r.command === null || r.command === undefined ? null : commandSummary(String(r.command))
    const ruleRef = r.ruleRef === null || r.ruleRef === undefined ? null
      : (safeString(r.ruleRef, 16) && REF_RE.test(String(r.ruleRef)) ? String(r.ruleRef) : null)
    const elapsedMs = r.elapsedMs === null || r.elapsedMs === undefined ? null : boundedNumber(r.elapsedMs)
    return { ts, tool, command, decision, botId, chatRef, ruleRef, elapsedMs }
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await this.readPrivateFile(this.rulesFile)
      if (raw) {
        const doc = JSON.parse(raw) as Record<string, unknown>
        if (doc.version === 1 && Array.isArray(doc.rules)) {
          this.rules = doc.rules
            .map(rule => ApprovalStore.parseRule(rule))
            .filter((rule): rule is ApprovalRule => rule !== undefined)
            .slice(-APPROVAL_MAX_RULES)
        }
      }
    } catch {
      this.logger?.warn('approval rules store unreadable; permanent authorizations disabled')
      this.rules = []
    }
    try {
      const raw = await this.readPrivateFile(this.auditFile)
      if (raw) {
        const lines = raw.trim().split('\n').slice(-AUDIT_KEEP_LINES)
        this.records = lines
          .map(line => {
            try { return ApprovalStore.parseRecord(JSON.parse(line)) } catch { return undefined }
          })
          .filter((record): record is ApprovalRecordInput => record !== undefined)
      }
    } catch {
      this.records = []
    }
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    const temp = file + '.' + randomUUID() + '.tmp'
    try {
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      await rename(temp, file)
      await lstat(file).catch(() => undefined)
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  private persistRules(): Promise<void> {
    const content = JSON.stringify({ version: 1, rules: this.rules }, null, 2) + '\n'
    this.queue = this.queue.then(() => this.atomicWrite(this.rulesFile, content)).catch(error => {
      this.logger?.warn('persisting approval rules failed:', String(error))
    })
    return this.queue
  }

  private async appendAudit(record: ApprovalRecordInput): Promise<void> {
    this.records.push(record)
    if (this.records.length > AUDIT_KEEP_LINES) {
      this.records = this.records.slice(-AUDIT_KEEP_LINES)
    }
  }

  private persistAudit(): Promise<void> {
    const lines = this.records.slice(-AUDIT_KEEP_LINES).map(record => JSON.stringify(record)).join('\n') + '\n'
    this.queue = this.queue.then(() => this.atomicWrite(this.auditFile, lines)).catch(error => {
      this.logger?.warn('persisting approval audit failed:', String(error))
    })
    return this.queue
  }

  /** Matching rule for a tool/command root, or undefined (fail closed). */
  ruleFor(tool: string, root: string | undefined): ApprovalRule | undefined {
    if (tool === 'bash' && !root) return undefined
    const key = ruleKey(tool, root)
    return this.rules.find(rule => ruleKey(rule.tool, rule.commandRoot) === key)
  }

  /** Persist one narrow rule; repeat grants for the same scope are idempotent. */
  async remember(input: {
    readonly tool: string
    readonly root: string | undefined
    readonly createdBy: string
    readonly now?: number
  }): Promise<ApprovalRule | undefined> {
    const tool = TOOL_RE.test(input.tool) ? input.tool : undefined
    const root = input.root === undefined ? undefined : (ROOT_RE.test(input.root) ? input.root : undefined)
    if (!tool || (tool === 'bash' && !root)) return undefined
    const now = input.now ?? Date.now()
    const createdByRef = approvalRef(input.createdBy)
    const existing = this.ruleFor(tool, root)
    if (existing) {
      const updated: ApprovalRule = { ...existing, lastUsedAt: now }
      this.rules = this.rules.map(rule => rule.ref === existing.ref ? updated : rule)
      await this.persistRules()
      return updated
    }
    if (this.rules.length >= APPROVAL_MAX_RULES) {
      this.rules = this.rules.slice(-(APPROVAL_MAX_RULES - 1))
    }
    const rule: ApprovalRule = {
      ref: approvalRef(tool + '\u0000' + (root ?? '') + '\u0000' + randomUUID()),
      tool,
      ...(root ? { commandRoot: root } : {}),
      label: ruleLabel(tool, root),
      createdAt: now,
      createdByRef,
      lastUsedAt: null,
      uses: 0,
    }
    this.rules = [...this.rules, rule]
    await this.persistRules()
    return rule
  }

  /** Record one automatic allow and bump the rule's usage counters. */
  async touch(ref: string, now = Date.now()): Promise<void> {
    let changed = false
    this.rules = this.rules.map(rule => {
      if (rule.ref !== ref) return rule
      changed = true
      return { ...rule, lastUsedAt: now, uses: rule.uses + 1 }
    })
    if (changed) await this.persistRules()
  }

  async revoke(ref: string): Promise<ApprovalRule | undefined> {
    const removed = this.rules.find(rule => rule.ref === ref)
    if (!removed) return undefined
    this.rules = this.rules.filter(rule => rule.ref !== ref)
    await this.persistRules()
    return removed
  }

  async record(input: ApprovalRecordInput): Promise<void> {
    await this.appendAudit(ApprovalStore.parseRecord(input) ?? input)
    await this.persistAudit()
  }

  rulesView(): readonly ApprovalRule[] {
    return [...this.rules].sort((a, b) => b.createdAt - a.createdAt).slice(0, APPROVAL_MAX_RULES)
  }

  recordsView(): readonly ApprovalReadModel['records'][number][] {
    return [...this.records].reverse().slice(0, APPROVAL_MAX_RECORDS).map(record => ({
      ts: record.ts, tool: record.tool, command: record.command ?? null,
      decision: record.decision, botId: record.botId, chatRef: record.chatRef,
      ruleRef: record.ruleRef ?? null, elapsedMs: record.elapsedMs ?? null,
    }))
  }

  readModel(pending: readonly ApprovalPendingView[], timeoutMs: number): ApprovalReadModel {
    return {
      version: 1, ts: Date.now(), available: true, reason: null,
      timeoutMs: Math.max(0, Math.floor(timeoutMs)),
      pending: pending.slice(0, 50).map(view => ({ ...view })),
      rules: this.rulesView(),
      records: this.recordsView(),
      recordLimit: APPROVAL_MAX_RECORDS,
    }
  }

  /** Drain queued rule/audit writes before shutdown or temporary-dir cleanup. */
  async flush(): Promise<void> {
    await this.queue
  }

  /** Publish the Web Admin read model (atomic, 0600). */
  async publish(pending: readonly ApprovalPendingView[], timeoutMs: number): Promise<void> {
    const model = this.readModel(pending, timeoutMs)
    await this.atomicWrite(this.modelFile, JSON.stringify(model) + '\n')
  }
}
