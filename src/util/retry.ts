export interface RetryOptions {
  readonly retries: number
  readonly baseDelayMs: number
  readonly maxDelayMs?: number
  readonly signal?: AbortSignal
  /** Called before each retry (attempt index starts at 1). */
  readonly onRetry?: (error: unknown, attempt: number) => void
}

/** True for errors that are worth retrying (transport / 5xx / rate limit). */
export function isRetryable(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false
  const code = (error as { code?: number })?.code
  if (typeof code === 'number' && code >= 400 && code < 500 && code !== 429) return false
  return true
}

export function abortError(): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  return error
}

/** Bounded exponential backoff with full jitter and abort support. */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, options.retries)
  const maxDelay = options.maxDelayMs ?? 10_000
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError()
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (options.signal?.aborted || !isRetryable(error) || attempt === attempts - 1) break
      const delay = Math.min(maxDelay, options.baseDelayMs * 2 ** attempt)
      const jittered = Math.round(delay * (0.5 + Math.random() * 0.5))
      options.onRetry?.(error, attempt + 1)
      await sleep(jittered, options.signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Promise.race with an abortable timeout that does not leak timers. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ value: T; timedOut: false } | { value: undefined; timedOut: true }> {
  if (signal?.aborted) return { value: undefined, timedOut: true }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const abort = new Promise<{ value: undefined; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ value: undefined, timedOut: true }), timeoutMs)
    onAbort = () => {
      clearTimeout(timer)
      resolve({ value: undefined, timedOut: true })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([
      promise.then((value) => ({ value, timedOut: false as const })),
      abort,
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
