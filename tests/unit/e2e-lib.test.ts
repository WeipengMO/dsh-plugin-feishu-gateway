import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOKEN, ENV_SPECS, appIdShapeValid, buildPatch, bundlesFor, checkEnv,
  evaluateIsolation, evaluateResume, evaluateThreeTurns, requiredEnvNames, verdict,
} from '../../scripts/e2e/lib.mjs'

/**
 * These tests cover the E2E harness's PURE logic: credential gating, generated
 * profile patches, and result evaluation. They never read a credential, never
 * open a socket and never boot DSH — the real-runtime part is exercised by
 * `node scripts/e2e/run.mjs session-bridge|daemon-smoke` (see docs/E2E.md).
 */

const fullRealEnv = {
  FEISHU_GATEWAY_TEST_LLM_KEY: 'k-test',
  FEISHU_GATEWAY_TEST_LLM_BASE_URL: 'https://llm.test/v1',
  FEISHU_GATEWAY_TEST_LLM_MODEL: 'real-model',
  FEISHU_GATEWAY_DEFAULT_APP_ID: 'cli_0123456789abcdef',
  FEISHU_GATEWAY_DEFAULT_APP_SECRET: 's-test',
  FEISHU_GATEWAY_TEST_ALLOWLIST: 'ou_test',
}

describe('E2E credential gating', () => {
  it('requires nothing for a pure mock/offline run', () => {
    expect(requiredEnvNames({ llmMode: 'mock', feishuMode: 'offline' })).toEqual([])
    expect(checkEnv({}, { llmMode: 'mock', feishuMode: 'offline' }))
      .toEqual({ present: [], missing: [], blocked: false })
  })

  it('blocks a real-LLM run until the test LLM route is provided', () => {
    const res = checkEnv({}, { llmMode: 'real', feishuMode: 'offline' })
    expect(res.blocked).toBe(true)
    expect(res.missing).toEqual([
      'FEISHU_GATEWAY_TEST_LLM_KEY',
      'FEISHU_GATEWAY_TEST_LLM_BASE_URL',
      'FEISHU_GATEWAY_TEST_LLM_MODEL',
    ])
  })

  it('blocks a live-Feishu run until the dedicated test app is provided', () => {
    const res = checkEnv({}, { llmMode: 'mock', feishuMode: 'live' })
    expect(res.missing).toEqual([
      'FEISHU_GATEWAY_DEFAULT_APP_ID',
      'FEISHU_GATEWAY_DEFAULT_APP_SECRET',
      'FEISHU_GATEWAY_TEST_ALLOWLIST',
    ])
  })

  it('reports only NAMES, never values', () => {
    const res = checkEnv(fullRealEnv, { llmMode: 'real', feishuMode: 'live' })
    expect(res.blocked).toBe(false)
    const serialized = JSON.stringify(res)
    for (const value of Object.values(fullRealEnv)) expect(serialized).not.toContain(value)
    // Every documented name has a purpose string for the BLOCKED report.
    for (const name of Object.keys(ENV_SPECS)) expect(ENV_SPECS[name]!.purpose.length).toBeGreaterThan(10)
  })

  it('treats template placeholders as absent, not as real credentials', () => {
    const res = checkEnv({
      FEISHU_GATEWAY_TEST_LLM_KEY: 'xxxxxxxxxxxxxxxx',
      FEISHU_GATEWAY_DEFAULT_APP_ID: 'cli_xxxxxxxxxxxxxxxx',
      FEISHU_GATEWAY_DEFAULT_APP_SECRET: '',
    }, { llmMode: 'real', feishuMode: 'live' })
    expect(res.missing).toContain('FEISHU_GATEWAY_TEST_LLM_KEY')
    expect(res.missing).toContain('FEISHU_GATEWAY_DEFAULT_APP_ID')
    expect(res.missing).toContain('FEISHU_GATEWAY_DEFAULT_APP_SECRET')
  })

  it('validates only the app id SHAPE', () => {
    expect(appIdShapeValid('cli_0123456789abcdef')).toBe(true)
    expect(appIdShapeValid('app_0123456789abcdef')).toBe(false)
    expect(appIdShapeValid('cli_short')).toBe(false)
    expect(appIdShapeValid(undefined)).toBe(false)
  })
})

describe('generated profile patch', () => {
  const base = { stateDir: '/tmp/h/state', workspace: '/tmp/h/ws' }

  it('never embeds a credential value and references env-var names only', () => {
    const yaml = buildPatch({ ...base, llmMode: 'real', feishuMode: 'live', allowlist: ['ou_test'], baseURL: 'https://llm.test/v1', modelId: 'real-model' })
    expect(yaml).toContain('apiKeyEnv: "FEISHU_GATEWAY_TEST_LLM_KEY"')
    expect(yaml).toContain('appIdEnv: "FEISHU_GATEWAY_DEFAULT_APP_ID"')
    expect(yaml).toContain('appSecretEnv: "FEISHU_GATEWAY_DEFAULT_APP_SECRET"')
    expect(yaml).not.toMatch(/appSecret:\s*"/)
    expect(yaml).not.toContain('k-test')
  })

  it('turns the long connection ON only for live mode', () => {
    expect(buildPatch({ ...base, feishuMode: 'offline' })).toContain('offline: true')
    expect(buildPatch({ ...base, feishuMode: 'live', allowlist: ['ou_test'] })).toContain('offline: false')
  })

  it('uses the real endpoint/model in real mode and the loopback mock otherwise', () => {
    const real = buildPatch({ ...base, llmMode: 'real', baseURL: 'https://llm.test/v1', modelId: 'real-model' })
    expect(real).toContain('baseURL: "https://llm.test/v1"')
    expect(real).toContain('model: "real-model"')
    const mock = buildPatch({ ...base, llmMode: 'mock', mockLlmPort: 12345 })
    expect(mock).toContain('baseURL: "http://127.0.0.1:12345/v1"')
    expect(mock).toContain('model: "mock-model"')
  })

  it('gives the probe its own stateDir so the owner lock is not violated', () => {
    const yaml = buildPatch({ ...base, probeEnabled: true })
    expect(yaml).toContain('stateDir: "/tmp/h/state-probe"')
    expect(yaml).toContain('outFile: "/tmp/h/state-probe/probe-result.json"')
  })

  it('mounts the daemon app only in daemon mode', () => {
    expect(buildPatch({ ...base, hostMode: 'daemon' })).toContain('./e2e-daemon.mjs')
    expect(buildPatch({ ...base, hostMode: 'oneshot' })).not.toContain('./e2e-daemon.mjs')
  })

  it('drops dsh-headless for daemon mode so the host is not one-shot', () => {
    expect(bundlesFor('daemon')).toEqual(['@deepseek-ai/dsh-base', 'dsh-plugin-feishu-gateway'])
    expect(bundlesFor('oneshot')).toContain('@deepseek-ai/dsh-headless')
  })
})

describe('result evaluation', () => {
  const threeTurnResult = (token: string) => ({
    sessionId: 'sid-1',
    errors: [],
    bridgeCalls: [
      { m: 'create' }, { m: 'submit' }, { m: 'waitForReply' },
      { m: 'resume' }, { m: 'submit' }, { m: 'waitForReply' },
      { m: 'resume' }, { m: 'submit' }, { m: 'waitForReply' }, { m: 'dispose' },
    ],
    disposeCalls: [{ sessionId: 'sid-1' }],
    snapshots: [{ agentRegistryHas: true, sessionStoreHas: true, factoryPresent: true }],
    turns: [
      { turn: 1, sessionId: 'sid-1', replies: [`已记录：请记住字符串 ${token}。`] },
      { turn: 2, sessionId: 'sid-1', replies: [token] },
      { turn: 3, sessionId: 'sid-1', replies: [token] },
    ],
  })

  it('accepts three turns that recall the token from real history', () => {
    const res = evaluateThreeTurns(threeTurnResult('GBM-7429'), 'GBM-7429')
    expect(res).toMatchObject({
      turns: true, sameSessionId: true, firstTurnAcknowledged: true,
      secondTurnRecalls: true, thirdTurnRecalls: true, bridgeSequence: true,
      handleDisposedOnce: true, servicesLive: true, noErrors: true,
    })
    expect(verdict(res as unknown as Record<string, boolean>).result).toBe('PASS')
  })

  it('is tolerant of prose a real commercial model adds around the token', () => {
    const result = threeTurnResult('ABC-12345')
    result.turns[1]!.replies = ['你上一轮让我记住的是 ABC-12345。']
    result.turns[2]!.replies = ['第一轮的字符串是 **ABC-12345**。']
    const res = evaluateThreeTurns(result, 'ABC-12345')
    expect(res.secondTurnRecalls).toBe(true)
    expect(res.thirdTurnRecalls).toBe(true)
  })

  it('fails when a turn lost the context', () => {
    const result = threeTurnResult('ABC-12345')
    result.turns[2]!.replies = ['抱歉，我没有上下文。']
    const res = evaluateThreeTurns(result, 'ABC-12345')
    expect(res.thirdTurnRecalls).toBe(false)
    expect(verdict(res as unknown as Record<string, boolean>).result).toBe('FAIL')
  })

  it('fails when the Session id changed mid-conversation', () => {
    const result = threeTurnResult('ABC-12345')
    result.turns[2]!.sessionId = 'sid-2'
    expect(evaluateThreeTurns(result, 'ABC-12345').sameSessionId).toBe(false)
  })

  it('fails when the handle was disposed more than once', () => {
    const result = threeTurnResult('ABC-12345')
    result.disposeCalls = [{}, {}] as never
    expect(evaluateThreeTurns(result, 'ABC-12345').handleDisposedOnce).toBe(false)
  })

  it('evaluates cross-host cold resume', () => {
    const ok = evaluateResume({
      expectedSessionId: 'sid-1', errors: [],
      bridgeCalls: [{ m: 'resume' }, { m: 'submit' }, { m: 'waitForReply' }, { m: 'dispose' }],
      turns: [{ sessionId: 'sid-1', replies: ['ABC-12345'] }],
    }, 'ABC-12345')
    expect(ok).toMatchObject({ sameSessionId: true, recallsToken: true, coldResumeUsed: true, noErrors: true })

    const bad = evaluateResume({
      expectedSessionId: 'sid-1', errors: [],
      bridgeCalls: [{ m: 'create' }, { m: 'submit' }],
      turns: [{ sessionId: 'sid-9', replies: [''] }],
    }, 'ABC-12345')
    expect(bad.sameSessionId).toBe(false)
    expect(bad.coldResumeUsed).toBe(false)
  })

  it('evaluates timeout/cancel/error isolation', () => {
    const ok = evaluateIsolation({
      isolation: {
        timeout: { newSession: true, oldTextLeaked: false },
        cancel: { newSession: true, oldTextLeaked: false },
        error: { newSession: true, oldTextLeaked: false },
        eventIsolation: { crossAttributed: 0 },
      },
    })
    expect(ok).toMatchObject({
      allScenariosPresent: true, allCreateNewSession: true,
      noOldTextLeaked: true, noCrossAttributedEvents: true,
    })

    const bad = evaluateIsolation({
      isolation: {
        timeout: { newSession: true, oldTextLeaked: false },
        cancel: { newSession: true, oldTextLeaked: false },
        error: { newSession: false, oldTextLeaked: true },
        eventIsolation: { crossAttributed: 12 },
      },
    })
    expect(bad.allCreateNewSession).toBe(false)
    expect(bad.noOldTextLeaked).toBe(false)
    expect(bad.noCrossAttributedEvents).toBe(false)
  })

  it('exposes a stable default token for documentation parity', () => {
    expect(DEFAULT_TOKEN).toBe('GBM-7429')
  })
})
