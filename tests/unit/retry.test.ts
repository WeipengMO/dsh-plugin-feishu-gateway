import { describe, expect, it } from 'vitest'
import { abortError, isRetryable, withRetry, withTimeout } from '../../src/util/retry.js'

describe('isRetryable', () => {
  it('does not retry abort or 4xx (except 429)', () => {
    expect(isRetryable(abortError())).toBe(false)
    expect(isRetryable(Object.assign(new Error('bad'), { code: 400 }))).toBe(false)
    expect(isRetryable(Object.assign(new Error('rate'), { code: 429 }))).toBe(true)
    expect(isRetryable(Object.assign(new Error('down'), { code: 503 }))).toBe(true)
    expect(isRetryable(new Error('socket hang up'))).toBe(true)
  })
})

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    let calls = 0
    const value = await withRetry(async () => {
      calls += 1
      return 42
    }, { retries: 3, baseDelayMs: 1 })
    expect(value).toBe(42)
    expect(calls).toBe(1)
  })

  it('retries transient failures and eventually succeeds', async () => {
    let calls = 0
    const retries: number[] = []
    const value = await withRetry(async () => {
      calls += 1
      if (calls < 3) throw new Error('temporary')
      return 'ok'
    }, { retries: 4, baseDelayMs: 1, onRetry: (_e, attempt) => retries.push(attempt) })
    expect(value).toBe('ok')
    expect(calls).toBe(3)
    expect(retries).toEqual([1, 2])
  })

  it('gives up after the configured attempts', async () => {
    let calls = 0
    await expect(withRetry(async () => {
      calls += 1
      throw new Error('always')
    }, { retries: 3, baseDelayMs: 1 })).rejects.toThrow('always')
    expect(calls).toBe(3)
  })

  it('does not retry a non-retryable error', async () => {
    let calls = 0
    await expect(withRetry(async () => {
      calls += 1
      throw Object.assign(new Error('bad request'), { code: 400 })
    }, { retries: 5, baseDelayMs: 1 })).rejects.toThrow('bad request')
    expect(calls).toBe(1)
  })

  it('respects an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(withRetry(async () => 'x', { retries: 3, baseDelayMs: 1, signal: controller.signal }))
      .rejects.toThrow('aborted')
  })
})

describe('withTimeout', () => {
  it('returns the value when the promise settles first', async () => {
    const result = await withTimeout(Promise.resolve(7), 1000)
    expect(result).toEqual({ value: 7, timedOut: false })
  })

  it('reports a timeout', async () => {
    const result = await withTimeout(new Promise(() => {}), 5)
    expect(result.timedOut).toBe(true)
  })

  it('reports abort as a timeout without leaking timers', async () => {
    const controller = new AbortController()
    const promise = withTimeout(new Promise(() => {}), 60_000, controller.signal)
    controller.abort()
    expect((await promise).timedOut).toBe(true)
  })
})
