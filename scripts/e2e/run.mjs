#!/usr/bin/env node
/**
 * Real-LLM / real-Feishu E2E runner.
 *
 *   node scripts/e2e/run.mjs preflight
 *   node scripts/e2e/run.mjs session-bridge --llm mock
 *   node scripts/e2e/run.mjs session-bridge --llm real
 *   node scripts/e2e/run.mjs feishu --llm real --host daemon --wait-ms 300000
 *
 * Honesty rules enforced by this script:
 *  - A missing credential makes the run BLOCKED (exit 3) with the minimal
 *    env-var NAMES to provide; it never claims PASS.
 *  - `--llm mock` runs are labelled MOCK so they can never be mistaken for the
 *    real-commercial-LLM P0.
 *  - Credential VALUES are never read into the report, logged or echoed.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_TOKEN, ENV_SPECS, checkEnv, evaluateIsolation, evaluateResume, evaluateThreeTurns,
  requiredEnvNames, verdict,
} from './lib.mjs'
import { parseArgs, setupProfile } from './setup.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const TOKEN = process.env.E2E_TOKEN || DEFAULT_TOKEN

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(msg) { console.log(`[e2e] ${msg}`) }

function freePort(start) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(freePort(start + 1)))
    srv.listen(start, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    setTimeout(() => reject(new Error('port scan timeout')), 5000)
  })
}

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new Error(`timeout waiting for ${label} (last=${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

async function httpJson(port, pathname, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method })
  return res.json()
}

/** Spawn a DSH host; resolve once the daemon reports ready. */
async function bootHost({ home, mode, daemonPort, env, logFile, task }) {
  const args = mode === 'daemon'
    ? ['--profile', 'feishu-gateway-test']
    : ['--profile', 'feishu-gateway-test', task || 'HOST_KEEPALIVE 请只回复 OK，不要调用任何工具，不要修改任何文件。']
  const child = spawn('dsh', args, {
    env: { ...process.env, ...env, DSH_HOME: home, DSH_PERMISSION_MODE: 'read-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks = []
  const collect = (b) => { chunks.push(b.toString()); }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('exit', (code, sig) => { chunks.push(`\n[exit code=${code} sig=${sig}]\n`) })
  if (mode === 'daemon') {
    await waitFor(() => chunks.join('').includes('E2E_DAEMON_READY'), { timeoutMs: 60000, label: 'daemon ready' })
  }
  const finish = async (timeoutMs = 120000) => {
    const done = new Promise((r) => child.once('exit', r))
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await Promise.race([done, sleep(timeoutMs)])
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    if (logFile) await writeFile(logFile, chunks.join(''), 'utf8').catch(() => undefined)
    return chunks.join('')
  }
  return { child, output: () => chunks.join(''), finish }
}

function readJson(file) {
  return readFile(file, 'utf8').then(JSON.parse).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// session-bridge: 3 turns / cross-host resume / isolation
// ---------------------------------------------------------------------------
async function runSessionBridge(opts) {
  const label = opts.llm === 'real' ? 'REAL-LLM' : 'MOCK-LLM'
  const outDir = opts.out || path.join(REPO, '.tmp/e2e', `session-bridge-${opts.llm}-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const report = { kind: 'session-bridge', llmMode: opts.llm, label, startedAt: new Date().toISOString(), token: TOKEN, checks: {}, logs: [] }

  // --- preflight -----------------------------------------------------------
  const env = checkEnv(process.env, { llmMode: opts.llm, feishuMode: 'offline' })
  if (env.blocked) {
    report.status = 'BLOCKED'
    report.missing = env.missing
    report.minimalSteps = env.missing.map((n) => ({ envVar: n, purpose: ENV_SPECS[n]?.purpose }))
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    log(`BLOCKED — missing: ${env.missing.join(', ')}`)
    return { report, exitCode: 3 }
  }

  // --- LLM server ----------------------------------------------------------
  let mock
  const mockPort = await freePort(opts.port || 18080)
  if (opts.llm === 'mock') {
    mock = spawn('node', [path.join(REPO, 'scripts/real-runtime/mock-llm.mjs'), String(mockPort)], {
      env: { ...process.env, MOCK_LLM_TOKEN: TOKEN, MOCK_LLM_FAIL_PATTERN: 'FAIL_MARKER', MOCK_LLM_LOG: path.join(outDir, 'llm-log.jsonl') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitFor(async () => (await httpJson(mockPort, '/v1/models').catch(() => null))?.data, { label: 'mock llm' })
  }

  try {
    // --- host 1: three turns ----------------------------------------------
    const home1 = await mkdtemp(path.join(os.tmpdir(), 'e2e-h1-'))
    const p1 = await setupProfile({ ...opts, home: home1, host: 'oneshot', port: mockPort })
    const host1 = await bootHost({ home: home1, mode: 'oneshot', logFile: path.join(outDir, 'host1.log'), env: { FEISHU_GATEWAY_TEST_LLM_KEY: process.env.FEISHU_GATEWAY_TEST_LLM_KEY || 'mock-key', PROBE_MODE: 'three-turns', PROBE_TOKEN: TOKEN } })
    const probeOut = path.join(p1.probeStateDir, 'probe-result.json')
    const r1 = await waitFor(() => readJson(probeOut), { timeoutMs: 180000, label: 'three-turn probe result' })
    await host1.finish()
    const c1 = evaluateThreeTurns(r1, TOKEN)
    await writeFile(path.join(outDir, 'three-turn-probe-result.json'), `${JSON.stringify(r1, null, 2)}\n`)
    report.checks['same-host-3-turns'] = verdict({ turns: c1.turns, sameSessionId: c1.sameSessionId, firstTurnAcknowledged: c1.firstTurnAcknowledged, secondTurnRecalls: c1.secondTurnRecalls, thirdTurnRecalls: c1.thirdTurnRecalls, bridgeSequence: c1.bridgeSequence, handleDisposedOnce: c1.handleDisposedOnce, servicesLive: c1.servicesLive, noErrors: c1.noErrors })
    report.replies = c1.replies
    report.sessionId = c1.sessionId
    report.home1 = home1

    // --- host 2: a NEW host process cold-resumes the same Session -----------
    // The isolation guard ties a chat binding to the stateDir-derived agent
    // workspace (src/agent-workspace.ts:13-30, src/gateway.ts:1181-1186).
    // Copying a binding into a DIFFERENT home is an intentionally blocked
    // cross-identity migration, not a cold resume. A real restart keeps the
    // same DSH_HOME/stateDir, so reuse home1 and boot a fresh process.
    const home2 = home1
    const resumeOut = path.join(p1.probeStateDir, 'probe-result.json')
    // host1 left its result at the same path; remove it so waitFor cannot
    // mistake the previous run's JSON for the cold-resume result.
    await rm(resumeOut, { force: true })
    const host2 = await bootHost({
      home: home2, mode: 'oneshot', logFile: path.join(outDir, 'host2.log'),
      env: { FEISHU_GATEWAY_TEST_LLM_KEY: process.env.FEISHU_GATEWAY_TEST_LLM_KEY || 'mock-key', PROBE_MODE: 'resume', PROBE_SESSION_ID: c1.sessionId || '', PROBE_TOKEN: TOKEN },
    })
    const r2 = await waitFor(async () => {
      const value = await readJson(resumeOut)
      return value?.mode === 'resume' ? value : null
    }, { timeoutMs: 180000, label: 'resume probe result' })
    await host2.finish()
    await writeFile(path.join(outDir, 'resume-probe-result.json'), `${JSON.stringify(r2, null, 2)}\n`)
    const c2 = evaluateResume(r2, TOKEN)
    report.checks['cross-host-resume'] = verdict({ sameSessionId: c2.sameSessionId, recallsToken: c2.recallsToken, coldResumeUsed: c2.coldResumeUsed, noErrors: c2.noErrors })
    report.resumeReply = c2.reply
    report.home2 = home2
    report.resumeScenario = 'new host process, same DSH_HOME/stateDir (isolation-guard-compatible cold resume)'

    // --- host 3: timeout / cancel / error isolation -----------------------
    const home3 = await mkdtemp(path.join(os.tmpdir(), 'e2e-h3-'))
    const p3 = await setupProfile({ ...opts, home: home3, host: 'oneshot', port: mockPort })
    const host3 = await bootHost({
      home: home3, mode: 'oneshot', logFile: path.join(outDir, 'host3.log'),
      env: { FEISHU_GATEWAY_TEST_LLM_KEY: process.env.FEISHU_GATEWAY_TEST_LLM_KEY || 'mock-key', PROBE_MODE: 'isolation', PROBE_OUT_FILE: path.join(p3.probeStateDir, 'probe-result.json'), PROBE_STATE_DIR: p3.probeStateDir, PROBE_WORKSPACE: p3.workspace, PROBE_TOKEN: TOKEN },
    })
    const r3 = await waitFor(() => readJson(path.join(p3.probeStateDir, 'probe-result.json')), { timeoutMs: 240000, label: 'isolation probe result' })
    await host3.finish()
    const c3 = evaluateIsolation(r3)
    report.checks['isolation'] = verdict({ allScenariosPresent: c3.allScenariosPresent, allCreateNewSession: c3.allCreateNewSession, noOldTextLeaked: c3.noOldTextLeaked, noCrossAttributedEvents: c3.noCrossAttributedEvents })
    report.home3 = home3

    const allPass = Object.values(report.checks).every((c) => c.result === 'PASS')
    report.status = allPass ? 'PASS' : 'FAIL'
    report.note = opts.llm === 'mock'
      ? 'MOCK-LLM run: proves the harness and the SessionBridge plumbing only. This is NOT the real-commercial-LLM P0.'
      : 'REAL-LLM run against the configured commercial endpoint/model.'
    report.finishedAt = new Date().toISOString()
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return { report, exitCode: allPass ? 0 : 1 }
  } finally {
    if (mock) { try { mock.kill('SIGKILL') } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------------------
// feishu: live tenant E2E against a long-running Host
// ---------------------------------------------------------------------------
async function runFeishu(opts) {
  const outDir = opts.out || path.join(REPO, '.tmp/e2e', `feishu-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const report = { kind: 'feishu-live', llmMode: opts.llm, startedAt: new Date().toISOString(), token: TOKEN, checks: {} }

  const env = checkEnv(process.env, { llmMode: opts.llm, feishuMode: 'live' })
  if (env.blocked) {
    report.status = 'BLOCKED'
    report.missing = env.missing
    report.minimalSteps = env.missing.map((n) => ({ envVar: n, purpose: ENV_SPECS[n]?.purpose }))
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    log(`BLOCKED — missing: ${env.missing.join(', ')}`)
    return { report, exitCode: 3 }
  }

  const daemonPort = await freePort(opts.daemonPort || 18091)
  let mock
  if (opts.llm === 'mock') {
    mock = spawn('node', [path.join(REPO, 'scripts/real-runtime/mock-llm.mjs'), String(opts.port || 18080)], {
      env: { ...process.env, MOCK_LLM_TOKEN: TOKEN, MOCK_LLM_FAIL_PATTERN: 'FAIL_MARKER', MOCK_LLM_LOG: path.join(outDir, 'llm-log.jsonl') }, stdio: 'ignore',
    })
    await waitFor(async () => (await httpJson(opts.port || 18080, '/v1/models').catch(() => null))?.data, { label: 'mock llm' })
  }

  const home = await mkdtemp(path.join(os.tmpdir(), 'e2e-live-'))
  const p = await setupProfile({ ...opts, home, host: 'daemon', daemonPort, allowlist: opts.allowlist })
  const host = await bootHost({ home, mode: 'daemon', daemonPort, logFile: path.join(outDir, 'host.log') })

  try {
    const health0 = await waitFor(async () => {
      const h = await httpJson(daemonPort, '/health')
      return h.gatewayProvided && h.health ? h : null
    }, { timeoutMs: 90000, label: 'gateway service in live host' })
    report.hostStart = { gatewayProvided: health0.gatewayProvided, transports: health0.health?.transports, sessionBridge: health0.health?.sessionBridge }

    // Wait for the real WebSocket to reach `connected`.
    const connected = await waitFor(async () => {
      const h = await httpJson(daemonPort, '/health')
      const states = Object.values(h.health?.transports || {})
      return states.length > 0 && states.every((s) => s === 'connected') ? h : null
    }, { timeoutMs: 120000, label: 'feishu websocket connected' })
    report.checks['websocket-connected'] = verdict({ connected: true })
    report.connectedHealth = connected.health

    log(`waiting up to ${opts.waitMs} ms for real inbound messages (send them from the test account now)`)
    const deadline = Date.now() + opts.waitMs
    let lastHealth = connected.health
    while (Date.now() < deadline) {
      lastHealth = (await httpJson(daemonPort, '/health')).health
      if ((lastHealth?.processed || 0) >= 3) break
      await sleep(2000)
    }
    report.finalHealth = lastHealth

    const processed = lastHealth?.processed || 0
    report.checks['three-messages-processed'] = verdict({ processedAtLeast3: processed >= 3 })
    report.checks['no-gateway-errors'] = verdict({ errors: (lastHealth?.errors || 0) === 0 })
    report.checks['inbox-durable'] = verdict({ done: (lastHealth?.inbox?.done || 0) >= 3 })
    report.checks['outbox-delivered'] = verdict({ noPending: (lastHealth?.outbox?.pending || 0) === 0 })
    report.checks['session-bound'] = verdict({ bound: (lastHealth?.boundSessions || 0) >= 1 })

    // Session continuity across the three turns: exactly one binding, no churn.
    report.checks['single-session-per-chat'] = verdict({ oneBinding: (lastHealth?.boundSessions || 0) === 1 })

    const allPass = Object.values(report.checks).every((c) => c.result === 'PASS')
    report.status = allPass ? 'PASS' : 'INCOMPLETE'
    report.note = allPass
      ? 'Live tenant E2E observed 3 processed messages, one bound Session, no pending outbox.'
      : 'Live host connected but the expected 3 inbound messages were not all observed; see finalHealth.'
    report.finishedAt = new Date().toISOString()
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return { report, exitCode: allPass ? 0 : 1 }
  } finally {
    try { await httpJson(daemonPort, '/shutdown', 'POST') } catch { /* ignore */ }
    await host.finish(30000)
    if (mock) { try { mock.kill('SIGKILL') } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------------------
// daemon-smoke: proves the long-running Host mechanism WITHOUT any credential.
// Boots the daemon profile with feishu offline=true, then asserts that the
// gateway service is provided, health is served, and shutdown is clean.
// ---------------------------------------------------------------------------
async function runDaemonSmoke(opts) {
  const outDir = opts.out || path.join(REPO, '.tmp/e2e', `daemon-smoke-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const report = { kind: 'daemon-smoke', startedAt: new Date().toISOString(), checks: {} }
  const daemonPort = await freePort(opts.daemonPort || 18091)
  const home = await mkdtemp(path.join(os.tmpdir(), 'e2e-smoke-'))
  await setupProfile({ ...opts, home, host: 'daemon', feishu: 'offline', daemonPort })
  const host = await bootHost({ home, mode: 'daemon', daemonPort, logFile: path.join(outDir, 'host.log') })
  try {
    const h = await waitFor(async () => {
      const j = await httpJson(daemonPort, '/health')
      return j.gatewayProvided && j.health ? j : null
    }, { timeoutMs: 90000, label: 'gateway provided in daemon host' })
    report.health = h.health
    report.pid = h.pid
    report.checks['gateway-service-provided'] = verdict({ provided: h.gatewayProvided === true })
    report.checks['host-stays-alive'] = verdict({ alive: h.uptimeMs > 0 })
    report.checks['offline-transport-connected'] = verdict({ connected: Object.values(h.health.transports || {}).every((s) => s === 'connected') })
    report.checks['native-session-bridge-available'] = verdict({ available: h.health.sessionBridge?.available === true })
    // Event stream is served (real session/event plumbing reachable).
    const ev = await httpJson(daemonPort, '/events')
    report.checks['event-stream-served'] = verdict({ served: Array.isArray(ev.events) })
    // Clean shutdown through the control surface.
    const sd = await httpJson(daemonPort, '/shutdown', 'POST')
    report.checks['graceful-shutdown-accepted'] = verdict({ accepted: sd.ok === true })
    const log = await host.finish(30000)
    report.checks['shutdown-teardown-logged'] = verdict({ logged: log.includes('E2E_DAEMON_STOPPED') })
    const allPass = Object.values(report.checks).every((c) => c.result === 'PASS')
    report.status = allPass ? 'PASS' : 'FAIL'
    report.finishedAt = new Date().toISOString()
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return { report, exitCode: allPass ? 0 : 1 }
  } catch (e) {
    report.status = 'FAIL'
    report.error = String(e)
    await host.finish(15000)
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return { report, exitCode: 1 }
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const opts = parseArgs(rest)
  opts.waitMs = Number(rest[rest.indexOf('--wait-ms') + 1]) || 300000
  if (!Number.isFinite(opts.waitMs) || opts.waitMs <= 0) opts.waitMs = 300000
  if (cmd === 'preflight') {
    const forLlm = opts.llm || 'real'
    const forFeishu = opts.feishu || 'live'
    const env = checkEnv(process.env, { llmMode: forLlm, feishuMode: forFeishu })
    console.log(JSON.stringify({
      llmMode: forLlm, feishuMode: forFeishu,
      required: requiredEnvNames({ llmMode: forLlm, feishuMode: forFeishu }),
      present: env.present, missing: env.missing, blocked: env.blocked,
      minimalSteps: env.missing.map((n) => ({ envVar: n, purpose: ENV_SPECS[n]?.purpose })),
    }, null, 2))
    process.exit(env.blocked ? 3 : 0)
  }
  if (cmd === 'session-bridge') {
    const { report, exitCode } = await runSessionBridge({ ...opts, llm: opts.llm || 'mock' })
    console.log(JSON.stringify({ status: report.status, label: report.label, checks: report.checks, sessionId: report.sessionId, replies: report.replies, resumeReply: report.resumeReply, missing: report.missing, note: report.note }, null, 2))
    process.exit(exitCode)
  }
  if (cmd === 'daemon-smoke') {
    const { report, exitCode } = await runDaemonSmoke(opts)
    console.log(JSON.stringify({ status: report.status, checks: report.checks, pid: report.pid, health: report.health }, null, 2))
    process.exit(exitCode)
  }
  if (cmd === 'feishu') {
    const { report, exitCode } = await runFeishu({ ...opts, llm: opts.llm || 'real', allowlist: opts.allowlist })
    console.log(JSON.stringify({ status: report.status, checks: report.checks, finalHealth: report.finalHealth, missing: report.missing, note: report.note }, null, 2))
    process.exit(exitCode)
  }
  console.error('usage: run.mjs <preflight|session-bridge|daemon-smoke|feishu> [options]')
  process.exit(2)
}

await main()
