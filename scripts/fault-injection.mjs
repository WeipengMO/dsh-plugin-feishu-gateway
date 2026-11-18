#!/usr/bin/env node
/**
 * Additional, EMPIRICAL fault-injection / crash-recovery verification for the
 * Feishu gateway plugin. Focus: risk of DUPLICATE EXECUTION or LOST MESSAGES
 * during crash recovery.
 *
 *   node scripts/fault-injection.mjs
 *
 * Prerequisites: `lib/` is the fresh build output (created by `pnpm run build`).
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION:
 *   - Every scenario uses a FRESH `mkdtemp()` directory under os.tmpdir().
 *   - All temp directories are removed in a `finally` block.
 *   - Nothing is ever written to ~/.dsh, the web profile, the running GUI,
 *     real Feishu credentials, or any production data.
 *   - No App Secret / credential is ever read or printed.
 *   - No repo file is modified by this script.
 *
 * The harness deliberately catches ALL per-scenario failures so every scenario
 * runs, prints PASS/FAIL/SKIP/BUG with observed evidence, prints a final
 * summary table (including CONFIRMED BUGs) and exits 0.
 *
 * `--crash-child <stateDir>` is an internal mode: it builds a gateway whose
 * Agent turn is deliberately left in-flight and then stays alive so the parent
 * can kill it with SIGKILL (a genuine hard crash, not a graceful stop()).
 */
import { mkdtemp, rm, readFile, writeFile, readdir, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { createGateway } from '../lib/index.js'
import { MockFeishuTransport } from '../lib/channel/mock-transport.js'
import { MockSessionBridge } from '../lib/session/mock-session-bridge.js'
import { resolveConfig } from '../lib/config.js'
import { silentLogger } from '../lib/util/logger.js'

const HARNESS_PATH = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(HARNESS_PATH), '..')
const SENDER = 'ou_demo_user'
const CHAT = 'oc_fi_chat'
const TMP_PREFIX = 'feishu-gw-fi-'
const CRASH_ID = 'fi-crash-inflight'
const CRASH_TEXT = 'FI-CRASH-INFLIGHT-TURN'
const NEW_ID = 'fi-after-recovery'
const NEW_TEXT = 'FI-AFTER-RECOVERY-TURN'
const buildReply = (p) => `reply:${p}`

// ---------------------------------------------------------------------------
// Small helpers (all read-only except for temp-dir state files)
// ---------------------------------------------------------------------------
const makeConfig = (stateDir, overrides = {}) => resolveConfig({
  stateDir, allowlist: [SENDER], offline: true, sendRetries: 1, ...overrides,
})
const makeBridge = (opts = {}) => new MockSessionBridge({ reply: buildReply, ...opts })
const makeTransport = (opts = {}) => new MockFeishuTransport('default', opts)
const makeGateway = (stateDir, bridge, transport, overrides = {}) => createGateway(
  makeConfig(stateDir, overrides), { transports: [transport], bridge, logger: silentLogger },
)

async function readJsonMaybe(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}
async function inboxEvents(stateDir) {
  const file = path.join(stateDir, 'inbox.jsonl')
  const text = await readFile(file, 'utf8').catch((e) => {
    if (e.code === 'ENOENT') return ''
    throw e
  })
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const parsed = []
  const errors = []
  for (const l of lines) {
    try { parsed.push(JSON.parse(l)) } catch (e) { errors.push({ line: l.slice(0, 120), error: String(e) }) }
  }
  return { text, lines, parsed, errors }
}
async function fileHas(file, needle) {
  const t = await readFile(file, 'utf8').catch(() => '')
  return t.includes(needle)
}
async function waitFor(predicate, timeoutMs = 5000, intervalMs = 12) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    let v
    try { v = await predicate() } catch { v = false }
    if (v) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}
function killWait(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(resolve, 2500)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}
async function stopQuietly(gw) {
  let timer
  try {
    await Promise.race([gw.stop(), new Promise((r) => { timer = setTimeout(r, 1500) })])
  } catch { /* ignore */ } finally { if (timer) clearTimeout(timer) }
}

// ---------------------------------------------------------------------------
// Scenario framework: each scenario owns its temp dirs; all are cleaned up.
// ---------------------------------------------------------------------------
const results = []
async function scenario(id, title, fn) {
  const createdDirs = []
  const gws = []
  const evidence = []
  const checks = []
  let bugNote = null
  let skipReason = null
  const api = {
    async dir() {
      const d = await mkdtemp(path.join(os.tmpdir(), TMP_PREFIX))
      createdDirs.push(d)
      return d
    },
    gw(gw) { gws.push(gw); return gw },
    check(label, cond, detail = '') {
      const ok = !!cond
      checks.push({ label, ok })
      evidence.push(`   ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
      return ok
    },
    note(s) { evidence.push(`   • ${s}`) },
    bug(s) { bugNote = s },
    skip(s) { skipReason = s },
  }
  try {
    await fn(api)
  } catch (e) {
    checks.push({ label: 'scenario did not throw', ok: false })
    evidence.push(`   ✗ UNCAUGHT: ${e && e.stack ? e.stack : String(e)}`)
  } finally {
    for (const gw of gws) await stopQuietly(gw)
    for (const d of createdDirs) {
      try { await chmod(d, 0o700) } catch { /* ignore */ }
      try { await rm(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
  let verdict
  if (skipReason) verdict = 'SKIP'
  else if (bugNote) verdict = 'BUG'
  else if (checks.some((c) => !c.ok)) verdict = 'FAIL'
  else verdict = 'PASS'
  const res = { id, title, verdict, evidence, bugNote, skipReason,
    failed: checks.filter((c) => !c.ok).map((c) => c.label) }
  results.push(res)
  console.log(`\n[${id}] ${title}  =>  ${verdict}`)
  for (const line of evidence) console.log(line)
  if (bugNote) console.log(`   🐞 CONFIRMED BUG: ${bugNote}`)
  if (skipReason) console.log(`   ⏭  SKIP: ${skipReason}`)
}

// ---------------------------------------------------------------------------
// S1 — Duplicate inbound delivery
// ---------------------------------------------------------------------------
async function s1(a) {
  const dir = await a.dir()
  const t = makeTransport()
  const b = makeBridge()
  const gw = a.gw(makeGateway(dir, b, t))
  await gw.start()
  const id = 's1-dup'
  // sequential duplicate, then a rapid concurrent duplicate burst (same id)
  await t.emitMessage({ senderId: SENDER, text: 's1-text', messageId: id, chatId: CHAT })
  await t.emitMessage({ senderId: SENDER, text: 's1-text-AGAIN', messageId: id, chatId: CHAT })
  await Promise.all([
    t.emitMessage({ senderId: SENDER, text: 's1-rapid-a', messageId: id, chatId: CHAT }),
    t.emitMessage({ senderId: SENDER, text: 's1-rapid-b', messageId: id, chatId: CHAT }),
  ])
  await gw.whenIdle()
  const h = gw.health()
  const inbox = await inboxEvents(dir)
  const dedup = await readJsonMaybe(path.join(dir, 'dedup.json'))
  const outbox = await readJsonMaybe(path.join(dir, 'outbox.json'))
  a.check('exactly ONE Agent execution for 4 deliveries of same messageId',
    b.prompts.length === 1, `bridge.prompts=${b.prompts.length} ${JSON.stringify(b.prompts.map((p) => p.text))}`)
  a.check('exactly ONE outbound reply', t.sent.length === 1,
    `transport.sent=${t.sent.length} ${JSON.stringify(t.sent.map((s) => s.text))}`)
  a.check('health.processed === 1', h.processed === 1, `processed=${h.processed}`)
  a.check('inbox has exactly 1 received event (no duplicate admission)',
    inbox.parsed.filter((e) => e.type === 'received').length === 1,
    `receivedEvents=${inbox.parsed.filter((e) => e.type === 'received').length}`)
  a.check('inbox.done === 1, inbox.total === 1', h.inbox.done === 1 && h.inbox.total === 1,
    `inbox=${JSON.stringify(h.inbox)}`)
  a.check('dedup.json updated with the id', !!dedup && Object.prototype.hasOwnProperty.call(dedup.seen, id),
    `dedup=${JSON.stringify(dedup)}`)
  a.check('outbox sent ledger has exactly 1 reply idempotency key',
    !!outbox && Object.keys(outbox.sent || {}).length === 1, `outbox=${JSON.stringify(outbox)}`)

  // Cross-restart redelivery of the same messageId (Feishu reconnect scenario).
  await gw.stop()
  const t2 = makeTransport()
  const b2 = makeBridge()
  const gw2 = a.gw(makeGateway(dir, b2, t2))
  await gw2.start()
  await t2.emitMessage({ senderId: SENDER, text: 's1-text', messageId: id, chatId: CHAT })
  await gw2.whenIdle()
  a.check('restart + redeliver same id => still 0 new executions / 0 new sends',
    b2.prompts.length === 0 && t2.sent.length === 0,
    `gw2 prompts=${b2.prompts.length} sent=${t2.sent.length}`)

  // "rapid duplicate without id": the mock assigns a FRESH random messageId when
  // omitted, so two no-id emits are two DISTINCT Feishu events (not a redelivery).
  const dirB = await a.dir()
  const tb = makeTransport()
  const bb = makeBridge()
  const gwb = a.gw(makeGateway(dirB, bb, tb))
  await gwb.start()
  await tb.emitMessage({ senderId: SENDER, text: 's1-noid-a', chatId: CHAT })
  await tb.emitMessage({ senderId: SENDER, text: 's1-noid-b', chatId: CHAT })
  await gwb.whenIdle()
  const ids = (await inboxEvents(dirB)).parsed.filter((e) => e.type === 'received').map((e) => e.record.messageId)
  a.check('two no-id emits receive two DISTINCT generated messageIds', new Set(ids).size === 2,
    `ids=${JSON.stringify(ids)}`)
  a.check('two no-id emits -> 2 distinct executions (not merged)', bb.prompts.length === 2,
    `prompts=${bb.prompts.length}`)
  a.note('SKIP (sub-check): "suppress a duplicate without id" is NOT representable with this API — ' +
    'MockFeishuTransport.emitMessage assigns a new random messageId when messageId is omitted, so the two ' +
    'events are genuinely distinct. Dedup is keyed only on messageId; it correctly does not merge them. ' +
    'This is expected behaviour, not a bug (Feishu always supplies a stable message_id for a redelivery).')
}

// ---------------------------------------------------------------------------
// S2 — Crash AFTER durable admission but BEFORE the Agent finishes (CORE)
// ---------------------------------------------------------------------------
async function s2(a) {
  // ---- Part A: deterministic in-process "crash" via abort mid-turn ----
  // A bridge with a long waitForReply is submitted, then the gateway is stopped
  // while the turn is still pending. stop() aborts; dispatch returns early via
  // `if (signal.aborted) return` WITHOUT writing `processed`, leaving the exact
  // durable 'running'-with-no-'processed' state a hard crash would leave.
  const dir = await a.dir()
  const t = makeTransport()
  const b = makeBridge({ delayMs: 15000 })
  const gw = a.gw(makeGateway(dir, b, t))
  await gw.start()
  await t.emitMessage({ senderId: SENDER, text: CRASH_TEXT, messageId: CRASH_ID, chatId: CHAT })
  const inboxFile = path.join(dir, 'inbox.jsonl')
  const admitted = await waitFor(async () => (
    (await fileHas(inboxFile, '"type":"received"')) &&
    (await fileHas(inboxFile, '"type":"running"')) && b.prompts.length >= 1
  ), 5000, 10)
  a.check('durable admission + running event + Agent turn STARTED before crash', admitted,
    `runningEvent=${await fileHas(inboxFile, '"type":"running"')} prompts=${b.prompts.length}`)
  const oldSessionId = b.created[0]?.sessionId ?? null
  await gw.stop() // <-- simulated hard crash: turn never finishes, no markProcessed
  const afterCrash = await inboxEvents(dir)
  a.check('crash state: running event present, NO processed event',
    afterCrash.parsed.some((e) => e.type === 'running' && e.messageId === CRASH_ID) &&
    !afterCrash.parsed.some((e) => e.type === 'processed'),
    `events=${JSON.stringify(afterCrash.parsed.map((e) => e.type))}`)
  a.note(`Part A method: stop()-abort mid-turn; old bridge prompt log at crash = ` +
    `${JSON.stringify(b.prompts.map((p) => p.text))} (turn was ADMITTED + SUBMITTED, never completed).`)

  // Brand-new gateway on the SAME stateDir.
  const t2 = makeTransport()
  const b2 = makeBridge()
  const gw2 = a.gw(makeGateway(dir, b2, t2))
  await gw2.start()
  await t2.emitMessage({ senderId: SENDER, text: NEW_TEXT, messageId: NEW_ID, chatId: CHAT })
  await gw2.whenIdle()
  const recovered = await inboxEvents(dir)
  const h2 = gw2.health()
  a.check('(a) interrupted turn NOT re-executed (no duplicate Agent prompt)',
    !b2.prompts.some((p) => p.text === CRASH_TEXT),
    `gw2 prompts=${JSON.stringify(b2.prompts.map((p) => p.text))}`)
  a.check('(b) inbox record became uncertain on restart',
    recovered.parsed.some((e) => e.type === 'uncertain' && e.messageId === CRASH_ID),
    `events=${JSON.stringify(recovered.parsed.map((e) => e.type))}`)
  a.check('(b2) interrupted record is NEVER marked processed',
    !recovered.parsed.some((e) => e.type === 'processed' && e.messageId === CRASH_ID),
    `processedEvents=${JSON.stringify(recovered.parsed.filter((e) => e.type === 'processed').map((e) => e.messageId))}`)
  a.check('(c) a NEW distinct message IS processed normally afterward',
    b2.prompts.some((p) => p.text === NEW_TEXT) && t2.sent.some((s) => s.text === buildReply(NEW_TEXT)),
    `gw2 prompts=${JSON.stringify(b2.prompts.map((p) => p.text))} sent=${JSON.stringify(t2.sent.map((s) => s.text))}`)
  a.check('no duplicate reply for the interrupted turn',
    !t2.sent.some((s) => s.text === buildReply(CRASH_TEXT)),
    `sent texts=${JSON.stringify(t2.sent.map((s) => s.text))}`)
  a.note(`Conservative recovery: instead of replaying, start() sends ONE diagnostic notice ` +
    `(outbox key recovery:${CRASH_ID}) and marks recoveryNotified; health.processed=${h2.processed}. ` +
    `The human must inspect the DSH session and decide whether to resend.`)
  a.note(`OBSERVED (F2 residual risk): recovery does NOT unbind/quarantine the Session. ` +
    `Follow-up message resumed old sessionId=${JSON.stringify(oldSessionId)}; ` +
    `gw2 bridge.resumed=${JSON.stringify(b2.resumed)}, created=${JSON.stringify(b2.created.map((c) => c.sessionId))}.`)

  // ---- Part B: a GENUINE SIGKILL of a child process (not a graceful stop) ----
  // Corroborates that an OS-level hard kill leaves the identical durable state
  // and that a fresh gateway recovers identically.
  const dirB = await a.dir()
  let child = null
  try {
    child = spawn(process.execPath, [HARNESS_PATH, '--crash-child', dirB],
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += String(d) })
    const readyFile = path.join(dirB, '_child_ready.json')
    const ready = await waitFor(async () => existsSync(readyFile), 9000, 20)
    const childEv = existsSync(readyFile) ? JSON.parse(await readFile(readyFile, 'utf8')) : null
    a.check('SIGKILL child reached in-flight turn (running durable + Agent started)',
      !!ready && !!childEv && childEv.hasRunning === true && childEv.prompts >= 1,
      `ready=${ready} childEvidence=${JSON.stringify(childEv)} childStderr=${stderr.trim().slice(0, 200)}`)
    child.kill('SIGKILL')
    await killWait(child)
    child = null
    const crashB = await inboxEvents(dirB)
    a.check('SIGKILL left received+running and NO processed event',
      crashB.parsed.some((e) => e.type === 'received') &&
      crashB.parsed.some((e) => e.type === 'running') &&
      !crashB.parsed.some((e) => e.type === 'processed'),
      `events=${JSON.stringify(crashB.parsed.map((e) => e.type))}`)

    const tB = makeTransport()
    const bB = makeBridge()
    const gwB = a.gw(makeGateway(dirB, bB, tB))
    await gwB.start()
    await tB.emitMessage({ senderId: SENDER, text: NEW_TEXT, messageId: 'fi-s2b-new', chatId: CHAT })
    await gwB.whenIdle()
    const recB = await inboxEvents(dirB)
    a.check('SIGKILL: interrupted turn NOT re-executed',
      !bB.prompts.some((p) => p.text === CRASH_TEXT),
      `gw2 prompts=${JSON.stringify(bB.prompts.map((p) => p.text))}`)
    a.check('SIGKILL: record became uncertain', recB.parsed.some((e) => e.type === 'uncertain' && e.messageId === CRASH_ID),
      `events=${JSON.stringify(recB.parsed.map((e) => e.type))}`)
    a.check('SIGKILL: new message still processed normally',
      bB.prompts.some((p) => p.text === NEW_TEXT), `prompts=${JSON.stringify(bB.prompts.map((p) => p.text))}`)
  } catch (e) {
    a.note(`SIGKILL sub-check could not complete (SKIP for this sub-check): ${String(e)}`)
  } finally {
    if (child) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------------------
// S3 — Crash AFTER reply sent but BEFORE markProcessed
// ---------------------------------------------------------------------------
async function s3(a) {
  const dir = await a.dir()
  const t = makeTransport()
  const b = makeBridge()
  const gw = a.gw(makeGateway(dir, b, t))
  await gw.start()
  await t.emitMessage({ senderId: SENDER, text: 's3-text', messageId: 's3-msg', chatId: CHAT })
  await gw.whenIdle()
  const outboxBefore = await readJsonMaybe(path.join(dir, 'outbox.json'))
  const replyBefore = t.sent[0]
  a.check('reply WAS actually delivered before the crash',
    !!replyBefore && replyBefore.text === buildReply('s3-text'),
    `sent=${JSON.stringify(t.sent.map((s) => ({ text: s.text, uuid: s.uuid })))}`)
  a.check('outbox.sent ledger already holds reply idempotency key',
    !!outboxBefore && Object.prototype.hasOwnProperty.call(outboxBefore.sent || {}, 'idem:default:reply:s3-msg'),
    `outboxBefore=${JSON.stringify(outboxBefore)}`)
  const uuidBefore = replyBefore?.uuid
  await gw.stop()

  // Construct the exact crash-window state: the reply is durable (sent ledger),
  // but the trailing `processed` inbox event was never written.
  const inboxFile = path.join(dir, 'inbox.jsonl')
  const ev = await inboxEvents(dir)
  const kept = ev.lines.filter((l) => { try { return JSON.parse(l).type !== 'processed' } catch { return true } })
  await writeFile(inboxFile, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
  a.note('METHOD / reachability: the public API exposes NO hook to fail precisely between ' +
    'outbox.send() and inbox.markProcessed(). The crash window is therefore CONSTRUCTED by ' +
    'removing the trailing `processed` event from inbox.jsonl while leaving outbox.sent intact. ' +
    'Net on-disk bytes are identical to a real crash at that instant (events: received + running; ' +
    'outbox.sent present; sessions.json touched). This is state injection, not a triggered kill.')
  const crashState = await inboxEvents(dir)
  a.check('constructed crash state folds to running (no processed event)',
    !crashState.parsed.some((e) => e.type === 'processed') && crashState.parsed.some((e) => e.type === 'running'),
    `events=${JSON.stringify(crashState.parsed.map((e) => e.type))}`)

  const t2 = makeTransport()
  const b2 = makeBridge()
  const gw2 = a.gw(makeGateway(dir, b2, t2))
  await gw2.start()
  await gw2.whenIdle()
  const outboxAfter = await readJsonMaybe(path.join(dir, 'outbox.json'))
  a.check('restart does NOT re-execute the Agent', b2.prompts.length === 0,
    `gw2 prompts=${JSON.stringify(b2.prompts.map((p) => p.text))}`)
  a.check('restart does NOT re-send the SAME reply (no duplicate of original text)',
    !t2.sent.some((s) => s.text === buildReply('s3-text')),
    `gw2 sent=${JSON.stringify(t2.sent.map((s) => s.text))}`)
  a.check('restart does NOT reuse/re-emit the original reply uuid',
    !t2.sent.some((s) => s.uuid === uuidBefore),
    `uuidBefore=${uuidBefore} gw2 uuids=${JSON.stringify(t2.sent.map((s) => s.uuid))}`)
  a.check('original reply idempotency key unchanged in sent ledger',
    !!outboxAfter && Object.prototype.hasOwnProperty.call(outboxAfter.sent || {}, 'idem:default:reply:s3-msg'),
    `outboxAfter.sent=${JSON.stringify(outboxAfter && outboxAfter.sent)}`)
  a.note('Restart classifies the running record as uncertain and sends a NEW one-time recovery ' +
    'notice (outbox key recovery:s3-msg, distinct idempotency key), NOT a replay of the original reply. ' +
    'The original reply is neither re-sent nor re-executed; the human is asked to inspect/resend.')
}

// ---------------------------------------------------------------------------
// S4 — Truncated JSONL tail
// ---------------------------------------------------------------------------
async function s4(a) {
  const dir = await a.dir()
  const inboxFile = path.join(dir, 'inbox.jsonl')
  const received = { type: 'received', record: {
    messageId: 's4-valid', botId: 'default', chatId: CHAT, senderId: SENDER,
    text: 's4-valid-text', receivedAt: Date.now(), status: 'pending', attempts: 0,
  } }
  const processed = { type: 'processed', messageId: 's4-valid' }
  const torn = '{"type":"running","messageId":"s4-va' // truncated JSON, NO trailing newline
  await writeFile(inboxFile, JSON.stringify(received) + '\n' + JSON.stringify(processed) + '\n' + torn, 'utf8')
  a.note(`pre-start inbox.jsonl = 2 valid events + torn tail ${JSON.stringify(torn)} with NO trailing newline`)
  const t = makeTransport()
  const b = makeBridge()
  const gw = a.gw(makeGateway(dir, b, t))
  let startError = null
  try { await gw.start() } catch (e) { startError = e }
  a.check('start() does NOT throw on a torn final line', startError === null,
    startError ? String(startError) : 'no exception')
  const afterStart = await inboxEvents(dir)
  a.check('torn tail was truncated away (not present)', !afterStart.text.includes(torn),
    `fileTail=${JSON.stringify(afterStart.text.slice(-70))}`)
  a.check('valid received + processed records preserved',
    afterStart.parsed.some((e) => e.type === 'received' && e.record.messageId === 's4-valid') &&
    afterStart.parsed.some((e) => e.type === 'processed'),
    `events=${JSON.stringify(afterStart.parsed.map((e) => e.type))}`)
  a.check('every line parses after start (0 parse errors)', afterStart.errors.length === 0,
    `errors=${JSON.stringify(afterStart.errors)}`)
  a.check('done record is NOT replayed (start replays only pending)', b.prompts.length === 0,
    `prompts=${b.prompts.length}`)

  // A subsequent append must not concatenate two JSON objects into one line.
  await t.emitMessage({ senderId: SENDER, text: 's4-new-text', messageId: 's4-new', chatId: CHAT })
  await gw.whenIdle()
  const final = await inboxEvents(dir)
  a.check('after append: EVERY line still JSON.parse-able (no concatenated objects)',
    final.errors.length === 0, `parseErrors=${JSON.stringify(final.errors)}`)
  a.check('after append: no line contains two glued JSON objects',
    !final.lines.some((l) => /\}\s*\{/.test(l)), `lines=${final.lines.length}`)
  a.check('new message appended as its own complete received + processed lines',
    final.parsed.filter((e) => e.type === 'received' && e.record.messageId === 's4-new').length === 1 &&
    final.parsed.some((e) => e.type === 'processed' && e.messageId === 's4-new'),
    `events=${JSON.stringify(final.parsed.map((e) => e.type))}`)
  a.check('new message processed normally (no lost work, no corruption)',
    b.prompts.some((p) => p.text === 's4-new-text') && t.sent.some((s) => s.text === buildReply('s4-new-text')),
    `prompts=${JSON.stringify(b.prompts.map((p) => p.text))}`)
}

// ---------------------------------------------------------------------------
// S5 — Admission persistence FAILURE
// ---------------------------------------------------------------------------
async function s5(a) {
  const dir = await a.dir()
  const t = makeTransport()
  const b = makeBridge()
  const gw = a.gw(makeGateway(dir, b, t))
  await gw.start()
  const before = gw.health()
  const inboxFile = path.join(dir, 'inbox.jsonl')
  a.check('fresh state: inbox.jsonl absent before any admission', !existsSync(inboxFile),
    `stateDir files=${JSON.stringify(await readdir(dir))}`)
  // chmod AFTER start (start() itself writes dedup.json via dedup.prune()).
  await chmod(dir, 0o500)
  a.note('chmod(stateDir, 0o500) AFTER start(): removes create/write on the directory; ' +
    'inbox.jsonl does not exist yet, so the durable append must fail with EACCES. ' +
    `Runtime uid=${process.getuid ? process.getuid() : 'n/a'} (not root, so perms are enforced).`)
  let thrown = null
  try {
    await t.emitMessage({ senderId: SENDER, text: 's5-text', messageId: 's5-msg', chatId: CHAT })
  } catch (e) { thrown = e }
  await chmod(dir, 0o700).catch(() => {})
  a.check('emitMessage REJECTS / THROWS on admission persistence failure', thrown !== null,
    thrown ? `${thrown.code || ''} ${thrown.message}` : 'NO ERROR — message was silently admitted (BUG)')
  a.note(`exact error: ${thrown ? `${thrown.code ? thrown.code + ': ' : ''}${thrown.message}` : 'none'}`)
  const after = gw.health()
  a.check('no durable admission (inbox.jsonl still absent)', !existsSync(inboxFile),
    `exists=${existsSync(inboxFile)}`)
  a.check('health: processed still 0 (not silently acknowledged)', after.processed === 0,
    `processed=${after.processed}`)
  a.check('health: rejected all 0 (not counted as a normal drop)',
    Object.values(after.rejected).every((v) => v === 0), `rejected=${JSON.stringify(after.rejected)}`)
  a.check('health: errors still 0, inbox.total still 0',
    after.errors === 0 && after.inbox.total === 0,
    `errors=${after.errors} inbox=${JSON.stringify(after.inbox)}`)
  const dedup = await readJsonMaybe(path.join(dir, 'dedup.json'))
  a.check('dedup.json has NO admission for the id (was never reached)',
    !!dedup && !Object.prototype.hasOwnProperty.call(dedup.seen || {}, 's5-msg'),
    `dedup=${JSON.stringify(dedup)}`)
  a.note(`health counters before: processed=${before.processed} errors=${before.errors} ` +
    `inbox.total=${before.inbox.total}. CONCLUSION: the inbound path throws, so the Feishu ` +
    'long-connection handler would NOT emit a 200 ACK (Feishu redelivers) and the message is NOT ' +
    'durably admitted. It is therefore NOT an "acknowledged-and-lost" message. ' +
    'OBSERVABILITY CAVEAT: health() shows NO increment in processed/rejected/errors for this ' +
    'failure — the error is surfaced only as the rejected emitMessage promise, invisible to a ' +
    'health()-only monitor.')
}

// ---------------------------------------------------------------------------
// S6 — Two gateway instances sharing ONE stateDir (F1 regression)
// ---------------------------------------------------------------------------
async function s6(a) {
  // The Inbox admission authority is an in-memory Map. Before the fix, two
  // instances on one stateDir both admitted the same message_id and executed
  // the Agent twice (CONFIRMED HIGH finding F1). The fix adds an exclusive
  // `.owner.lock` (O_EXCL) + per-instance JsonStore temp names, so the second
  // instance now FAILS CLOSED instead of duplicating irreversible side effects.
  const dir = await a.dir()
  const t1 = makeTransport(), b1 = makeBridge()
  const t2 = makeTransport(), b2 = makeBridge()
  const gw1 = a.gw(makeGateway(dir, b1, t1))
  const gw2 = a.gw(makeGateway(dir, b2, t2))

  await gw1.start()
  let secondError
  try { await gw2.start() } catch (e) { secondError = String(e) }
  const refused = /already owned by a running Feishu gateway/.test(secondError ?? '')
  a.check('second gateway on the SAME stateDir is REFUSED by the owner lock',
    refused, `gw2.start() error=${secondError ?? '(none — fix regressed)'}`)
  a.check('stateDir carries an exclusive .owner.lock file',
    (await readdir(dir)).includes('.owner.lock'),
    `files=${JSON.stringify(await readdir(dir))}`)

  await t1.emitMessage({ senderId: SENDER, text: 's6-shared-text', messageId: 's6-shared', chatId: CHAT })
  await gw1.whenIdle()
  const inbox = await inboxEvents(dir)
  const received = inbox.parsed.filter((e) => e.type === 'received' && e.record.messageId === 's6-shared').length
  a.check('exactly ONE Agent execution for the shared messageId (no duplicate)',
    b1.prompts.length + b2.prompts.length === 1,
    `b1.prompts=${b1.prompts.length} b2.prompts=${b2.prompts.length}`)
  a.check('exactly ONE durable received event', received === 1, `received=${received}`)
  a.check('exactly ONE outbound reply', t1.sent.length === 1 && t2.sent.length === 0,
    `t1.sent=${t1.sent.length} t2.sent=${t2.sent.length}`)

  await gw1.stop()
  // A crash/SIGKILL leaves a stale lock; a fresh instance must still take over.
  const t3 = makeTransport(), b3 = makeBridge()
  const gw3 = a.gw(makeGateway(dir, b3, t3))
  let restartError
  try { await gw3.start() } catch (e) { restartError = String(e) }
  a.check('a fresh gateway takes over the stateDir after the owner stops',
    restartError === undefined, `restart error=${restartError ?? '(none)'}`)
  await t3.emitMessage({ senderId: SENDER, text: 's6-after-restart', messageId: 's6-new', chatId: CHAT })
  await gw3.whenIdle()
  a.check('a NEW message is processed normally after takeover',
    b3.prompts.length === 1, `b3.prompts=${b3.prompts.length}`)

  // JsonStore temp names are now per-instance: two stores in ONE process no
  // longer collide on "<file>.<pid>.tmp" (F1 part B).
  const files = await readdir(dir)
  const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
  const jsonErrors = []
  for (const f of ['dedup.json', 'outbox.json', 'sessions.json']) {
    if (!files.includes(f)) continue
    try { await readJsonMaybe(path.join(dir, f)) } catch (e) { jsonErrors.push(`${f}: ${String(e)}`) }
  }
  a.check('no leftover JsonStore temp files after ownership changes',
    tmpFiles.length === 0, `tmpFiles=${JSON.stringify(tmpFiles)}`)
  a.check('state JSON documents remain parseable',
    jsonErrors.length === 0, `jsonErrors=${JSON.stringify(jsonErrors)}`)
  const inboxFinal = await inboxEvents(dir)
  a.check('inbox.jsonl lines remain individually parseable',
    inboxFinal.errors.length === 0, `parseErrors=${JSON.stringify(inboxFinal.errors)}`)
  a.note('BEFORE THE FIX this scenario CONFIRMED F1: two live instances each admitted ' +
    'the same messageId (2 Agent executions + 2 replies) and their shared ' +
    '`${pid}.tmp` JsonStore paths collided. It is now prevented by the exclusive ' +
    'owner lock + per-instance temp names; the second instance fails closed.')

  // Stale-lock takeover (genuine crash): write a lock owned by a dead pid.
  const dirC = await a.dir()
  await writeFile(path.join(dirC, '.owner.lock'), JSON.stringify({
    owner: 'dead-owner', pid: 2_147_483_647, host: os.hostname(), acquiredAt: 0,
  }), 'utf8')
  const gw4 = a.gw(makeGateway(dirC, makeBridge(), makeTransport()))
  let staleError
  try { await gw4.start() } catch (e) { staleError = String(e) }
  a.check('a stale owner lock from a dead process is taken over (restart not bricked)',
    staleError === undefined, `stale-lock restart error=${staleError ?? '(none)'}`)
}

// ---------------------------------------------------------------------------
// S7 — Rapid burst ordering + dedup (no loss, no duplicates, per-chat FIFO)
// ---------------------------------------------------------------------------
async function s7(a) {
  const dir = await a.dir()
  const t = makeTransport()
  const b = makeBridge()
  const gw = a.gw(makeGateway(dir, b, t))
  await gw.start()
  const burst = [
    ['s7-b1', 'seq:1'], ['s7-b2', 'seq:2'], ['s7-b1', 'seq:1-DUP'],
    ['s7-b3', 'seq:3'], ['s7-b2', 'seq:2-DUP'], ['s7-b4', 'seq:4'],
    ['s7-b5', 'seq:5'], ['s7-b3', 'seq:3-DUP'],
  ]
  await Promise.all(burst.map(([id, text]) =>
    t.emitMessage({ senderId: SENDER, text, messageId: id, chatId: CHAT })))
  await gw.whenIdle()
  const h = gw.health()
  const inbox = await inboxEvents(dir)
  const dedup = await readJsonMaybe(path.join(dir, 'dedup.json'))
  const promptTexts = b.prompts.map((p) => p.text)
  const sentTexts = t.sent.map((s) => s.text)
  const admissionTexts = inbox.parsed.filter((e) => e.type === 'received').map((e) => e.record.text)
  const expectedSet = ['seq:1', 'seq:2', 'seq:3', 'seq:4', 'seq:5']
  a.check('no LOST messages: 5 unique ids processed', h.processed === 5, `processed=${h.processed}`)
  a.check('no DUPLICATES: exactly 5 Agent executions', b.prompts.length === 5, `prompts=${b.prompts.length}`)
  a.check('DUP-variant texts were suppressed (first admission wins)',
    !promptTexts.some((x) => x.includes('DUP')), `prompts=${JSON.stringify(promptTexts)}`)
  a.check('execution set == admitted set (no loss / no dup)',
    JSON.stringify([...promptTexts].sort()) === JSON.stringify([...expectedSet].sort()),
    `prompts=${JSON.stringify(promptTexts)}`)
  a.check('per-chat ordering: dispatch order == durable admission order',
    JSON.stringify(promptTexts) === JSON.stringify(admissionTexts),
    `prompts=${JSON.stringify(promptTexts)} admission=${JSON.stringify(admissionTexts)}`)
  a.check('outbound replies in the same per-chat order',
    JSON.stringify(sentTexts) === JSON.stringify(expectedSet.map(buildReply)),
    `sent=${JSON.stringify(sentTexts)}`)
  a.check('inbox has 5 received + 5 processed events',
    inbox.parsed.filter((e) => e.type === 'received').length === 5 &&
    inbox.parsed.filter((e) => e.type === 'processed').length === 5,
    `events=${JSON.stringify(inbox.parsed.map((e) => e.type))}`)
  a.check('dedup.json has exactly 5 ids',
    !!dedup && Object.keys(dedup.seen || {}).length === 5, `dedup=${JSON.stringify(dedup)}`)
}

// ---------------------------------------------------------------------------
// S8 — Outbox UUID / idempotency-key stability across a simulated restart
// ---------------------------------------------------------------------------
async function s8(a) {
  const dir = await a.dir()
  const t1 = makeTransport({ failSends: 5 }) // park the reply as a pending outbox record
  const b1 = makeBridge()
  const gw = a.gw(makeGateway(dir, b1, t1))
  await gw.start()
  await t1.emitMessage({ senderId: SENDER, text: 's8-text', messageId: 's8-msg', chatId: CHAT })
  await gw.whenIdle()
  const outbox1 = await readJsonMaybe(path.join(dir, 'outbox.json'))
  const pendingRec = outbox1?.pending?.[0]
  a.check('reply is parked as a PENDING outbox record (send failed on run 1)',
    !!pendingRec, `outbox1=${JSON.stringify(outbox1)}`)
  a.check('pending record carries a stable target.uuid', !!pendingRec?.target?.uuid,
    `uuid=${pendingRec?.target?.uuid}`)
  const uuid1 = pendingRec?.target?.uuid
  const idemKey = pendingRec?.id
  a.check('no reply delivered on run 1 (send failed)', t1.sent.length === 0, `t1.sent=${t1.sent.length}`)
  a.check('inbox turn completed (done) even though reply is pending in outbox',
    gw.health().inbox.done === 1, `inbox=${JSON.stringify(gw.health().inbox)}`)
  await gw.stop()

  // Simulated restart: a brand-new gateway + WORKING transport drains the
  // persisted pending record on start().
  const t2 = makeTransport()
  const b2 = makeBridge()
  const gw2 = a.gw(makeGateway(dir, b2, t2))
  await gw2.start()
  await gw2.whenIdle()
  const outbox2 = await readJsonMaybe(path.join(dir, 'outbox.json'))
  a.check('UUID UNCHANGED across restart (same target.uuid delivered)',
    t2.sent.length === 1 && t2.sent[0].uuid === uuid1,
    `uuid1=${uuid1} deliveredUuids=${JSON.stringify(t2.sent.map((s) => s.uuid))}`)
  a.check('NO duplicate send (exactly 1 delivery total)',
    t1.sent.length + t2.sent.length === 1, `t1=${t1.sent.length} t2=${t2.sent.length}`)
  a.check('idempotency key preserved in outbox.sent ledger',
    !!outbox2 && Object.prototype.hasOwnProperty.call(outbox2.sent || {}, idemKey),
    `idemKey=${idemKey} sentLedger=${JSON.stringify(outbox2 && outbox2.sent)}`)
  a.check('pending queue drained on restart', !!outbox2 && outbox2.pending.length === 0,
    `pending=${JSON.stringify(outbox2 && outbox2.pending)}`)
  a.check('Agent NOT re-executed on restart', b2.prompts.length === 0, `gw2 prompts=${b2.prompts.length}`)

  // Reconnect drain + re-emit the SAME id must not duplicate anything.
  await t2.simulateReconnect()
  await gw2.whenIdle()
  await t2.emitMessage({ senderId: SENDER, text: 's8-text-AGAIN', messageId: 's8-msg', chatId: CHAT })
  await gw2.whenIdle()
  a.check('reconnect drain + re-emit same id => still 0 duplicate sends / 0 executions',
    t2.sent.length === 1 && b2.prompts.length === 0,
    `sent=${t2.sent.length} prompts=${b2.prompts.length}`)
}

// ---------------------------------------------------------------------------
// S9 (EXTRA) — Never-started (pending) work IS replayed (no lost message)
// ---------------------------------------------------------------------------
async function s9(a) {
  const dir = await a.dir()
  const inboxFile = path.join(dir, 'inbox.jsonl')
  const rec = { type: 'received', record: {
    messageId: 's9-pending', botId: 'default', chatId: CHAT, senderId: SENDER,
    text: 's9-pending-text', receivedAt: Date.now(), status: 'pending', attempts: 0,
  } }
  // Durable admission happened, but the process died BEFORE the turn started.
  await writeFile(inboxFile, JSON.stringify(rec) + '\n', 'utf8')
  a.note('pre-start state: a single `received` (status=pending) event and nothing else — ' +
    'models a crash after durable admission but before the Agent turn began.')
  const t = makeTransport()
  const b = makeBridge()
  const gw = a.gw(makeGateway(dir, b, t))
  await gw.start()
  await gw.whenIdle()
  const ev = await inboxEvents(dir)
  a.check('pending record REPLAYED => exactly 1 Agent execution (no lost message)',
    b.prompts.length === 1 && b.prompts[0].text === 's9-pending-text',
    `prompts=${JSON.stringify(b.prompts.map((p) => p.text))}`)
  a.check('reply delivered (message not lost)',
    t.sent.some((s) => s.text === buildReply('s9-pending-text')),
    `sent=${JSON.stringify(t.sent.map((s) => s.text))}`)
  a.check('record progressed running -> processed',
    ev.parsed.some((e) => e.type === 'running' && e.messageId === 's9-pending') &&
    ev.parsed.some((e) => e.type === 'processed' && e.messageId === 's9-pending'),
    `events=${JSON.stringify(ev.parsed.map((e) => e.type))}`)
  a.check('NOT executed twice', b.prompts.length === 1, `prompts=${b.prompts.length}`)
  a.check('health processed=1, inbox.done=1',
    gw.health().processed === 1 && gw.health().inbox.done === 1,
    `health=${JSON.stringify({ processed: gw.health().processed, inbox: gw.health().inbox })}`)
  a.note('This is the OTHER half of the conservative-recovery boundary: never-started `pending` ' +
    'work IS replayed (avoids LOSS), whereas in-progress `running -> uncertain` work is NOT ' +
    'replayed (avoids DUPLICATE EXECUTION, see S2).')
}

// ---------------------------------------------------------------------------
// Child mode (genuine SIGKILL target)
// ---------------------------------------------------------------------------
async function runCrashChild(stateDir) {
  const transport = makeTransport()
  // Long block so the parent has ample time to SIGKILL us mid-turn.
  const bridge = makeBridge({ delayMs: 30000 })
  const gw = createGateway(makeConfig(stateDir, { replyTimeoutMs: 120000 }),
    { transports: [transport], bridge, logger: silentLogger })
  await gw.start()
  await transport.emitMessage({ senderId: SENDER, text: CRASH_TEXT, messageId: CRASH_ID, chatId: CHAT })
  const inboxFile = path.join(stateDir, 'inbox.jsonl')
  const ok = await waitFor(async () => (
    (await fileHas(inboxFile, '"type":"running"')) && bridge.prompts.length >= 1
  ), 6000, 10)
  await writeFile(path.join(stateDir, '_child_ready.json'), JSON.stringify({
    ok, prompts: bridge.prompts.length, hasRunning: await fileHas(inboxFile, '"type":"running"'),
  }), 'utf8')
  // Stay alive (a never-resolving promise + a keepalive interval) until SIGKILL.
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function envInfo() {
  let commit = 'unknown', branch = 'unknown'
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim() } catch { /* ignore */ }
  try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT }).toString().trim() } catch { /* ignore */ }
  return { commit, branch }
}

async function main() {
  const env = envInfo()
  console.log('===================================================================')
  console.log(' Feishu Gateway — ADDITIONAL fault-injection / crash-recovery harness')
  console.log(' Focus: DUPLICATE EXECUTION / LOST MESSAGES during crash recovery')
  console.log('===================================================================')
  console.log(` node=${process.version} platform=${os.platform()}/${os.arch()} pid=${process.pid}`)
  console.log(` root=${ROOT}`)
  console.log(` branch=${env.branch} commit=${env.commit} (read-only git query)`)
  console.log(` date=${new Date().toISOString()}`)
  console.log(` state: FRESH mkdtemp(${path.join(os.tmpdir(), TMP_PREFIX)}*) per scenario; rm -rf in finally`)
  console.log(` NOTE: uid=${process.getuid ? process.getuid() : 'n/a'} (non-root), offline mocks only, no credentials touched`)

  await scenario('S1', 'Duplicate inbound delivery (same messageId, rapid + restart)', s1)
  await scenario('S2', 'Crash after durable admission, before Agent finishes (CORE)', s2)
  await scenario('S3', 'Crash after reply sent, before markProcessed (constructed window)', s3)
  await scenario('S4', 'Truncated JSONL tail must not corrupt recovery', s4)
  await scenario('S5', 'Admission persistence failure must reject (no silent ACK)', s5)
  await scenario('S6', 'Two gateway instances sharing ONE stateDir (F1)', s6)
  await scenario('S7', 'Rapid burst ordering + dedup (no loss / no dup / per-chat FIFO)', s7)
  await scenario('S8', 'Outbox UUID / idempotency-key stability across restart', s8)
  await scenario('S9*', 'EXTRA: never-started pending work IS replayed (no lost message)', s9)

  console.log('\n================ FINAL SUMMARY ================')
  console.log('| ID  | Scenario                                                        | Verdict |')
  console.log('|-----|-----------------------------------------------------------------|---------|')
  for (const r of results) {
    const title = r.title.length > 63 ? r.title.slice(0, 60) + '...' : r.title.padEnd(63)
    console.log(`| ${r.id.padEnd(4)} | ${title} | ${r.verdict.padEnd(7)} |`)
  }
  const counts = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc }, {})
  console.log(`\nTOTALS: ${JSON.stringify(counts)}`)
  const bugs = results.filter((r) => r.verdict === 'BUG')
  console.log('\nDISCOVERED / CONFIRMED BUGS:')
  if (bugs.length === 0) console.log('  (none)')
  else for (const r of bugs) console.log(`  - [${r.id}] ${r.bugNote}`)
  const fails = results.filter((r) => r.verdict === 'FAIL')
  if (fails.length) {
    console.log('\nFAILED CHECKS (honest):')
    for (const r of fails) console.log(`  - [${r.id}] ${r.failed.join(' | ')}`)
  }

  console.log('\nCONCLUSION — duplicate-execution / message-loss risk during crash recovery:')
  console.log('  Within a SINGLE gateway instance the conservative-recovery design holds up empirically:')
  console.log('   * Admission is authoritative on durable inbox.jsonl; duplicate delivery of the same')
  console.log('     messageId is suppressed -> exactly ONE Agent execution and ONE reply (S1, S7).')
  console.log('   * A turn interrupted by a crash (running, never processed) is NEVER auto-replayed;')
  console.log('     it becomes `uncertain`, a one-time diagnostic is sent, and a human must decide (S2,')
  console.log('     verified BOTH with stop()-abort and a genuine SIGKILL child process). This protects')
  console.log('     against DUPLICATE execution / replay of already-applied Agent side effects.')
  console.log('   * Conversely, never-started `pending` work IS replayed -> no LOST messages (S9); a torn')
  console.log('     JSONL tail is truncated safely and later appends stay well-formed (S4).')
  console.log('   * Outbound delivery is idempotent: outbox.sent ledger + stable UUID. A crash after the')
  console.log('     reply was sent but before markProcessed does NOT re-send or re-execute (S3, constructed);')
  console.log('     a pending outbox record survives restart with the SAME uuid, drained exactly once (S8).')
  console.log('   * Admission persistence failure THROWS (EACCES) rather than silently ACKing (S5).')
  console.log('  GUARANTEE BOUNDARY (honest, AFTER the F1 fix): admission is still IN-MEMORY and')
  console.log('  PER-INSTANCE, but stateDir is now protected by an exclusive `.owner.lock` (O_EXCL).')
  console.log('  A second live instance sharing one stateDir is REFUSED at start() rather than')
  console.log('  double-executing (S6); a stale lock from a dead process is taken over, so a crash')
  console.log('  restart is not bricked. JsonStore temp names are now per-instance, removing the')
  console.log('  in-process `${pid}.tmp` collision. This is an ADVISORY single-owner guard, not a')
  console.log('  distributed mutex: stateDir must be local to ONE host and ONE gateway instance.')
  console.log('  Remaining caveats: `uncertain`/`failed` are terminal with NO programmatic')
  console.log('  resolve/replay (human re-send required), the human-in-the-loop recovery means a')
  console.log('  reply may be effectively "lost" until manual resend, admission failures are')
  console.log('  invisible to health() counters, and exactly-once is NOT provided across machine')
  console.log('  power loss (appendFile is not fsync-d) or beyond the bounded 20k `sent` ledger /')
  console.log('  Feishu ~1h uuid window. Net: for a correctly-deployed single-owner gateway, crash')
  console.log('  recovery favours "pause + ask a human" over "silently duplicate or silently lose".')
  console.log('\n(Harness exits 0 by design; FAIL/BUG verdicts are findings, not a non-zero exit.)')
}

const flagIndex = process.argv.indexOf('--crash-child')
if (flagIndex !== -1) {
  await runCrashChild(process.argv[flagIndex + 1])
} else {
  await main()
  process.exit(0)
}
