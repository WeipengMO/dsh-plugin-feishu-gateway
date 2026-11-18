/**
 * Read-only, explicitly whitelisted approvals / permanent-authorization DTOs
 * for authenticated DSH Web. Everything here mirrors the strict style of
 * schedule-read.mjs: verified lstat chain (no symlinks followed), <= 1 MiB,
 * version===1, bounded arrays/strings, 16-hex refs, an allowlisted decision set,
 * clamped numbers, explicit null-vs-missing handling, no arbitrary keys and
 * never any raw exception text.
 *
 * Unlike the schedule model — an auxiliary telemetry file that may be corrupt
 * while the rest of the admin page keeps working — a missing/corrupt/unsafe
 * approvals file never throws: it degrades to a safe empty model and the page
 * simply shows no approvals. The Web Admin must never fabricate approvals or
 * locally decide them; only the Gateway publishes and mutates this state.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MODEL_FILE = 'ops-approvals.json'
const MODEL_MAX = 1024 * 1024 // 1 MiB
const PENDING_MAX = 50
const RULES_MAX = 200
const RECORDS_MAX = 200
const COMMAND_MAX = 200
const LABEL_MAX = 120
const REASON_MAX = 200
const RECORD_LIMIT_MAX = 1000
const USES_MAX = 1_000_000_000
const TIMEOUT_MS_MAX = 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 600000
const DEFAULT_RECORD_LIMIT = 200
const TIME_MAX = 1e13
const REF_RE = /^[a-f0-9]{16}$/
const BOT_RE = /^[a-z][a-z0-9_-]{0,31}$/
const TOOL_RE = /^[A-Za-z0-9_.:@/-]{1,96}$/
const ROOT_RE = /^[A-Za-z0-9_.:@/+-]{1,64}$/
const DECISIONS = new Set([
  'requested', 'allowed-once', 'allowed-permanent', 'auto-allowed',
  'rejected', 'timed-out', 'cancelled', 'unavailable',
])
const UNAVAILABLE_REASON = 'approvals read model unavailable'
const MISSING_REASON = 'approvals read model has not been published by the Gateway'

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function safeNum(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= TIME_MAX
    ? Math.floor(value) : undefined
}
function safeRef(value) { return typeof value === 'string' && REF_RE.test(value) ? value : undefined }
function safeBot(value) { return typeof value === 'string' && BOT_RE.test(value) ? value : undefined }
function safeTool(value) { return typeof value === 'string' && TOOL_RE.test(value) ? value : undefined }
function safeRoot(value) { return typeof value === 'string' && ROOT_RE.test(value) ? value : undefined }
function boundedText(value, max) {
  return typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : undefined
}
function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}
/** One-line bounded command summary; null when absent or unusable. */
function safeCommand(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, COMMAND_MAX) : null
}

/**
 * Safe empty read model used for missing/corrupt/unsafe state. Never creates
 * pending entries, rules or decisions: an unavailable model shows only that it
 * is unavailable.
 */
export function emptyApprovalsModel(reason = UNAVAILABLE_REASON, now = Date.now()) {
  return {
    version: 1,
    ts: safeNum(now) ?? Date.now(),
    available: false,
    reason: boundedText(reason, REASON_MAX) ?? UNAVAILABLE_REASON,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pending: [],
    rules: [],
    records: [],
    recordLimit: DEFAULT_RECORD_LIMIT,
  }
}

function sanitizePending(value) {
  if (!isObject(value)) return null
  const ref = safeRef(value.ref)
  const tool = safeTool(value.tool)
  const requestedAt = safeNum(value.requestedAt)
  const expiresAt = safeNum(value.expiresAt)
  if (!ref || !tool || requestedAt === undefined || expiresAt === undefined) return null
  const chatRef = safeRef(value.chatRef)
  return {
    ref,
    botId: safeBot(value.botId) ?? 'default',
    ...(chatRef ? { chatRef } : {}),
    tool,
    command: safeCommand(value.command),
    requestedAt,
    expiresAt,
  }
}

function sanitizeRule(value) {
  if (!isObject(value)) return null
  const ref = safeRef(value.ref)
  const tool = safeTool(value.tool)
  const createdAt = safeNum(value.createdAt)
  if (!ref || !tool || createdAt === undefined) return null
  const commandRoot = safeRoot(value.commandRoot)
  const createdByRef = safeRef(value.createdByRef)
  return {
    ref,
    tool,
    ...(commandRoot ? { commandRoot } : {}),
    label: boundedText(value.label, LABEL_MAX) ?? tool,
    createdAt,
    createdByRef: createdByRef ?? null,
    lastUsedAt: value.lastUsedAt === null || value.lastUsedAt === undefined
      ? null : (safeNum(value.lastUsedAt) ?? null),
    uses: clampInt(value.uses, 0, USES_MAX, 0),
  }
}

function sanitizeRecord(value) {
  if (!isObject(value)) return null
  const ts = safeNum(value.ts)
  const tool = safeTool(value.tool)
  if (ts === undefined || !tool || !DECISIONS.has(value.decision)) return null
  const chatRef = safeRef(value.chatRef)
  return {
    ts,
    tool,
    command: safeCommand(value.command),
    decision: value.decision,
    botId: safeBot(value.botId) ?? 'default',
    ...(chatRef ? { chatRef } : {}),
    ruleRef: value.ruleRef === null || value.ruleRef === undefined
      ? null : (safeRef(value.ruleRef) ?? null),
    elapsedMs: value.elapsedMs === null || value.elapsedMs === undefined
      ? null : (safeNum(value.elapsedMs) ?? null),
  }
}

/**
 * Pure whitelist of an arbitrary object into the approvals read model. Unknown
 * keys are dropped, invalid rows are omitted, arrays/strings/numbers are
 * bounded and invalid refs/decisions are never exposed. Invalid top-level
 * metadata degrades to the safe empty model instead of throwing.
 */
export function sanitizeApprovalsModel(raw, now = Date.now()) {
  if (!isObject(raw) || raw.version !== 1) return emptyApprovalsModel(UNAVAILABLE_REASON, now)
  const ts = safeNum(raw.ts)
  if (ts === undefined) return emptyApprovalsModel(UNAVAILABLE_REASON, now)
  const available = raw.available === true
  const reason = available ? null : (boundedText(raw.reason, REASON_MAX) ?? null)
  // records are published newest-first; a cap keeps that order.
  const pending = (Array.isArray(raw.pending) ? raw.pending : [])
    .slice(0, PENDING_MAX).map(sanitizePending).filter(Boolean)
  const rules = (Array.isArray(raw.rules) ? raw.rules : [])
    .slice(0, RULES_MAX).map(sanitizeRule).filter(Boolean)
  const records = (Array.isArray(raw.records) ? raw.records : [])
    .slice(0, RECORDS_MAX).map(sanitizeRecord).filter(Boolean)
  return {
    version: 1,
    ts,
    available,
    reason,
    timeoutMs: clampInt(raw.timeoutMs, 0, TIMEOUT_MS_MAX, DEFAULT_TIMEOUT_MS),
    pending,
    rules,
    records,
    recordLimit: clampInt(raw.recordLimit, 1, RECORD_LIMIT_MAX, DEFAULT_RECORD_LIMIT),
  }
}

/**
 * Read stateDir/ops-approvals.json (0600 regular file, no symlinks, <= 1 MiB)
 * and return the sanitized read model. Always resolves to a model: a missing,
 * corrupt or unsafe file degrades to the safe empty model rather than failing
 * the whole admin page. Never throws for content, permissions or races.
 */
async function loadRaw(dir, file, maxBytes) {
  let root
  try {
    root = await fs.lstat(dir)
  } catch (error) {
    return error && error.code === 'ENOENT' ? { missing: true } : { unsafe: true }
  }
  if (!root.isDirectory() || root.isSymbolicLink()) return { unsafe: true }
  const name = path.join(dir, file)
  let st
  try {
    st = await fs.lstat(name)
  } catch (error) {
    return error && error.code === 'ENOENT' ? { missing: true } : { unsafe: true }
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes) return { unsafe: true }
  try {
    return { raw: await fs.readFile(name, 'utf8') }
  } catch {
    return { unsafe: true }
  }
}

export async function readApprovalsModel(dir, now = Date.now()) {
  const loaded = await loadRaw(dir, MODEL_FILE, MODEL_MAX)
  if (loaded.missing) return emptyApprovalsModel(MISSING_REASON, now)
  if (loaded.unsafe) return emptyApprovalsModel(UNAVAILABLE_REASON, now)
  let doc
  try {
    doc = JSON.parse(loaded.raw)
  } catch {
    return emptyApprovalsModel(UNAVAILABLE_REASON, now)
  }
  return sanitizeApprovalsModel(doc, now)
}
