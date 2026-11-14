/**
 * TEST-ONLY probe running INSIDE a real DSH 0.2.2-rc.1 host process.
 * Drives the REAL DshSessionBridge (no MockSessionBridge) through the public
 * createGateway() factory with a MockFeishuTransport as the inbound source.
 *
 * Modes (env PROBE_MODE):
 *   three-turns  — one host, 3 consecutive messages, same Session
 *   resume       — a NEW host; cold-resume the SAME Session ID from DSH persistence
 *   isolation    — timeout / cancel / error isolation
 *
 * All state is written to $PROBE_OUT_FILE. No credentials, no real Feishu.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from 'dsh-plugin-feishu-gateway'
import { MockFeishuTransport } from 'dsh-plugin-feishu-gateway/testing'

export const name = 'native-session-probe'
export const inject = ['agents', 'agentLoop', 'sessions', 'llm']

const MODE = process.env.PROBE_MODE || 'three-turns'
const OUT = process.env.PROBE_OUT_FILE || '/tmp/probe-out.json'
const STATE_DIR = process.env.PROBE_STATE_DIR || path.join(os.tmpdir(), 'probe-state')
const WORKSPACE = process.env.PROBE_WORKSPACE || path.join(os.tmpdir(), 'probe-workspace')
const EXPECTED_SESSION_ID = process.env.PROBE_SESSION_ID || ''

const TURNS = [
  '请记住字符串 GBM-7429。',
  '我上一轮让你记住了什么？',
  '请再次重复第一轮的字符串。',
]
const RECALL_AFTER_RESUME = '我第一轮让你记住的字符串是什么？'

function safe(v) {
  try {
    if (v === undefined) return 'undefined'
    if (typeof v === 'string') return v.slice(0, 300)
    if (v instanceof Error) return `Error(${v.name}): ${v.message}`
    return JSON.stringify(v, (k, x) => (k === 'signal' || k === 'agent' ? '[omitted]' : x))?.slice(0, 400) ?? String(v)
  } catch { return String(v) }
}

export function apply(ctx, config) {
  const result = {
    mode: MODE,
    startedAt: new Date().toISOString(),
    expectedSessionId: EXPECTED_SESSION_ID || null,
    bridgeCalls: [],
    disposeCalls: [],
    events: [],
    streams: [],
    turns: [],
    snapshots: [],
    errors: [],
    notes: [],
  }
  const logger = {
    debug() {}, info() {}, warn() {},
    error: (msg, ...args) => { result.errors.push(`${String(msg)} ${args.map(safe).join(' ')}`) },
  }

  const offSession = ctx.on('session/event', (session, event) => {
    if (result.events.length < 400) result.events.push({
      at: Date.now(), sessionId: String(session?.id ?? ''),
      type: String(event?.type ?? ''),
      data: safe(event?.data),
    })
  })
  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    if (result.streams.length < 400) result.streams.push({
      at: Date.now(), agentId: String(payload?.agent?.id ?? ''),
      frameType: String(payload?.frame?.type ?? ''),
      chunkType: String(payload?.frame?.chunk?.type ?? ''),
    })
  })

  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')

  function snapshot(label, sessionId) {
    let agentRegistryHas = null, factoryPresent = null, sessionStoreHas = null
    try { agentRegistryHas = typeof agents?.get === 'function' ? Boolean(agents.get(sessionId)) : null } catch (e) { agentRegistryHas = `error:${safe(e)}` }
    try { factoryPresent = agents ? Boolean(agents.factory) : null } catch (e) { factoryPresent = `error:${safe(e)}` }
    try { sessionStoreHas = typeof sessions?.get === 'function' ? Boolean(sessions.get(sessionId)) : null } catch (e) { sessionStoreHas = `error:${safe(e)}` }
    const snap = {
      label, at: Date.now(), sessionId,
      agentRegistryHas, factoryPresent, sessionStoreHas,
      bridgeHandleCount: bridge ? bridge.handles.size : null,
      disposeCalls: result.disposeCalls.length,
    }
    result.snapshots.push(snap)
    return snap
  }

  let bridge = null
  let gw = null
  let transport = null

  function instrumentBridge(b) {
    bridge = b
    for (const m of ['create', 'resume', 'submit', 'waitForReply', 'cancel', 'dispose']) {
      const orig = b[m]
      if (typeof orig !== 'function') continue
      b[m] = async (...args) => {
        const entry = { m, at: Date.now(), args: args.map(safe) }
        result.bridgeCalls.push(entry)
        try {
          const r = await orig.apply(b, args)
          entry.ok = true
          entry.result = safe(r)
          // Wrap the newly created/restored AgentHandle.dispose exactly once.
          const sid = args[0]
          const handle = b.handles.get(sid)
          if (handle && (m === 'create' || m === 'resume') && !handle.__probeWrapped) {
            handle.__probeWrapped = true
            const origDispose = handle.dispose
            handle.dispose = async () => {
              result.disposeCalls.push({ sessionId: sid, at: Date.now(), via: m })
              return origDispose.call(handle)
            }
          }
          return r
        } catch (e) {
          entry.ok = false
          entry.error = safe(e)
          throw e
        }
      }
    }
  }

  async function registryState() {
    try { return JSON.parse(await readFile(path.join(STATE_DIR, 'sessions.json'), 'utf8')) }
    catch (e) { return { error: safe(e) } }
  }

  async function runThreeTurns() {
    await mkdir(STATE_DIR, { recursive: true })
    await mkdir(WORKSPACE, { recursive: true })
    transport = new MockFeishuTransport('default')
    gw = createGateway({
      stateDir: STATE_DIR, allowlist: ['ou_test'], offline: true,
      workspace: WORKSPACE, replyTimeoutMs: 30000, sendRetries: 1,
      autoConnect: true, diagnoseOnStart: false,
    }, { ctx, transports: [transport], logger })
    instrumentBridge(gw.bridge)
    await gw.start()
    result.notes.push('gateway.start() in real DSH host')

    for (let i = 0; i < TURNS.length; i += 1) {
      const messageId = `r2-turn-${i + 1}`
      await transport.emitMessage({ senderId: 'ou_test', chatId: 'oc_r2', messageId, text: TURNS[i] })
      await gw.whenIdle()
      const sent = transport.sent.map((s) => s.text)
      const submitCalls = result.bridgeCalls.filter((c) => c.m === 'submit')
      const sid = submitCalls.length ? submitCalls[submitCalls.length - 1].args[0] : null
      result.turns.push({
        turn: i + 1, messageId, prompt: TURNS[i], sessionId: sid,
        replies: sent.slice(-1), allReplies: sent,
        health: gw.health(),
        snapshot: snapshot(`after-turn-${i + 1}`, sid),
      })
    }
    result.sessionId = result.turns[0]?.sessionId || null
    result.registry = await registryState()
    result.finalSnapshot = snapshot('before-stop', result.sessionId)
  }

  async function runResume() {
    result.notes.push(`cold resume expectedSessionId=${EXPECTED_SESSION_ID}`)
    await mkdir(WORKSPACE, { recursive: true })
    transport = new MockFeishuTransport('default')
    gw = createGateway({
      stateDir: STATE_DIR, allowlist: ['ou_test'], offline: true,
      workspace: WORKSPACE, replyTimeoutMs: 30000, sendRetries: 1,
      autoConnect: true, diagnoseOnStart: false,
    }, { ctx, transports: [transport], logger })
    instrumentBridge(gw.bridge)
    await gw.start()
    result.registry = await registryState()
    result.notes.push('fresh bridge in a NEW host; no cached AgentHandle')

    const before = transport.sent.length
    // Unique per host so a copied stateDir does not dedupe this delivery.
    const resumeMessageId = `r2-resume-${Date.now()}`
    await transport.emitMessage({
      senderId: 'ou_test', chatId: 'oc_r2', messageId: resumeMessageId, text: RECALL_AFTER_RESUME,
    })
    await gw.whenIdle()
    const submitCalls = result.bridgeCalls.filter((c) => c.m === 'submit')
    const sid = submitCalls.length ? submitCalls[submitCalls.length - 1].args[0] : null
    result.turns.push({
      turn: 'resume', messageId: resumeMessageId, prompt: RECALL_AFTER_RESUME, sessionId: sid,
      replies: transport.sent.slice(before), allReplies: transport.sent,
      health: gw.health(), snapshot: snapshot('after-resume', sid),
    })
    result.sessionId = sid
    result.resumeCalls = result.bridgeCalls.filter((c) => c.m === 'resume')
  }

  async function runIsolation() {
    await mkdir(STATE_DIR, { recursive: true })
    await mkdir(WORKSPACE, { recursive: true })
    const stateDirE = `${STATE_DIR}-error`
    await mkdir(stateDirE, { recursive: true })
    result.isolation = {}

    // ---------- Gateway T: TIMEOUT (short replyTimeoutMs) + CANCEL ----------
    const tT = new MockFeishuTransport('default')
    const gwT = createGateway({
      stateDir: STATE_DIR, allowlist: ['ou_test'], offline: true,
      workspace: WORKSPACE, replyTimeoutMs: 200, sendRetries: 1,
      autoConnect: true, diagnoseOnStart: false,
    }, { ctx, transports: [tT], logger })
    instrumentBridge(gwT.bridge)
    const bridgeT = gwT.bridge
    await gwT.start()

    const lastSid = () => {
      const c = result.bridgeCalls.filter((x) => x.m === 'submit').slice(-1)[0]
      return c ? String(c.args[0]) : null
    }
    const repliesSince = (t, n) => t.sent.slice(n).map((s) => String(s.text))

    let n = tT.sent.length
    await tT.emitMessage({ senderId: 'ou_test', chatId: 'oc_iso_t', messageId: 'iso-timeout', text: 'DELAY_MARKER 请记住字符串 ISO-TIMEOUT.' })
    await gwT.whenIdle()
    const sidT1 = lastSid()
    const timeoutReplies = repliesSince(tT, n)
    result.turns.push({ kind: 'timeout', sessionId: sidT1, replies: timeoutReplies, health: gwT.health(), snapshot: snapshot('after-timeout', sidT1) })

    n = tT.sent.length
    await tT.emitMessage({ senderId: 'ou_test', chatId: 'oc_iso_t', messageId: 'iso-after-timeout', text: '请确认超时后的新会话可用。' })
    await gwT.whenIdle()
    const sidT2 = lastSid()
    const afterTimeoutReplies = repliesSince(tT, n)
    result.turns.push({ kind: 'after-timeout', sessionId: sidT2, replies: afterTimeoutReplies, health: gwT.health(), snapshot: snapshot('after-timeout-followup', sidT2) })
    result.isolation.timeout = {
      newSession: sidT1 !== sidT2,
      oldTextLeaked: afterTimeoutReplies.some((x) => x.includes('ISO-TIMEOUT')),
      diagnostic: timeoutReplies[0] || null,
    }

    // CANCEL: drive the REAL bridge directly with an AbortController.
    const sidC1 = `feishu-iso-cancel-${Date.now()}`
    const sidC2 = `feishu-iso-after-cancel-${Date.now()}`
    try {
      const ac = new AbortController()
      await bridgeT.create(sidC1, WORKSPACE)
      await bridgeT.submit(sidC1, 'DELAY_MARKER 请记住字符串 ISO-CANCEL.', ac.signal)
      const waiting = bridgeT.waitForReply(sidC1, { timeoutMs: 5000, signal: ac.signal })
      bridgeT.cancel(sidC1)
      ac.abort()
      const cancelled = await waiting
      result.turns.push({ kind: 'cancel', sessionId: sidC1, reply: cancelled.text, snapshot: snapshot('after-cancel', sidC1) })

      await bridgeT.create(sidC2, WORKSPACE)
      const ac2 = new AbortController()
      await bridgeT.submit(sidC2, '请确认取消后的新会话可用。', ac2.signal)
      const fresh = await bridgeT.waitForReply(sidC2, { timeoutMs: 5000, signal: ac2.signal })
      result.turns.push({ kind: 'after-cancel', sessionId: sidC2, reply: fresh.text, snapshot: snapshot('after-cancel-followup', sidC2) })
      result.isolation.cancel = {
        newSession: sidC1 !== sidC2,
        oldTextLeaked: String(fresh.text).includes('ISO-CANCEL'),
        cancelledReply: cancelled.text, freshReply: fresh.text,
      }
    } catch (e) {
      result.errors.push(`cancel scenario: ${safe(e)}`)
    }
    await gwT.stop()

    // ---------- Gateway E: genuine AGENT ERROR (long replyTimeoutMs) ----------
    const tE = new MockFeishuTransport('default')
    const gwE = createGateway({
      stateDir: stateDirE, allowlist: ['ou_test'], offline: true,
      workspace: WORKSPACE, replyTimeoutMs: 20000, sendRetries: 1,
      autoConnect: true, diagnoseOnStart: false,
    }, { ctx, transports: [tE], logger })
    instrumentBridge(gwE.bridge)
    transport = tE
    gw = gwE
    await gwE.start()

    n = tE.sent.length
    await tE.emitMessage({ senderId: 'ou_test', chatId: 'oc_iso_e', messageId: 'iso-error', text: 'FAIL_MARKER 请回答 ISO-ERROR.' })
    await gwE.whenIdle()
    const sidE1 = lastSid()
    const errorReplies = repliesSince(tE, n)
    result.turns.push({ kind: 'error', sessionId: sidE1, replies: errorReplies, health: gwE.health(), snapshot: snapshot('after-error', sidE1) })

    n = tE.sent.length
    await tE.emitMessage({ senderId: 'ou_test', chatId: 'oc_iso_e', messageId: 'iso-after-error', text: '请确认异常后的新会话可用。' })
    await gwE.whenIdle()
    const sidE2 = lastSid()
    const afterErrorReplies = repliesSince(tE, n)
    result.turns.push({ kind: 'after-error', sessionId: sidE2, replies: afterErrorReplies, health: gwE.health(), snapshot: snapshot('after-error-followup', sidE2) })
    result.isolation.error = {
      newSession: sidE1 !== sidE2,
      oldTextLeaked: afterErrorReplies.some((x) => x.includes('ISO-ERROR')),
      errorReply: errorReplies[0] || null,
      gatewayErrors: gwE.health().errors,
    }
    result.registry = await registryState()

    // Late events from old sessions must not be attributed to a new session.
    const oldIds = [sidT1, sidE1, sidC1].filter(Boolean)
    const newIds = [sidT2, sidE2, sidC2].filter(Boolean)
    result.isolation.eventIsolation = {
      oldSessionEventCounts: Object.fromEntries(oldIds.map((id) => [id, result.events.filter((e) => e.sessionId === id).length])),
      newSessionEventCounts: Object.fromEntries(newIds.map((id) => [id, result.events.filter((e) => e.sessionId === id).length])),
      crossAttributed: result.events.filter((e) => oldIds.includes(e.sessionId) && newIds.includes(e.sessionId)).length,
      errorSessionEvents: result.events.filter((e) => e.sessionId === sidE1).map((e) => e.type),
    }
  }

  const work = (async () => {
    try {
      if (MODE === 'three-turns') await runThreeTurns()
      else if (MODE === 'resume') await runResume()
      else if (MODE === 'isolation') await runIsolation()
      else result.errors.push(`unknown mode ${MODE}`)
    } catch (e) {
      result.errors.push(`FATAL ${e && e.stack ? e.stack : safe(e)}`)
    } finally {
      snapshot('at-finally', result.sessionId)
      if (gw) {
        try { await gw.stop() } catch (e) { result.errors.push(`stop: ${safe(e)}`) }
      }
      result.finishedAt = new Date().toISOString()
      result.finalDisposeCalls = result.disposeCalls.length
      result.registryFinal = await registryState()
      try { offSession?.() } catch { /* ignore */ }
      try { offStream?.() } catch { /* ignore */ }
      await writeFile(OUT, JSON.stringify(result, null, 2), 'utf8')
    }
  })()

  ctx.effect(() => async () => { await work }, 'native-session-probe.work')
}
