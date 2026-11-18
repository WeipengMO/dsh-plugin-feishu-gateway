/**
 * A native DSH Agent turn ended with `reason.kind === 'error'` and produced no
 * assistant message. The tool counters let the Gateway decide whether an
 * automatic fallback-model retry is side-effect safe: once any tool ran, the
 * turn must never be replayed.
 *
 * Kept in its own module so the Gateway can classify the failure without
 * importing the concrete DSH bridge, and so tests can construct one.
 */
export class SessionTurnFailure extends Error {
  /** Tool calls observed before the failure (0 means nothing executed). */
  readonly toolCalls: number
  /** Failed tool results observed before the failure. */
  readonly toolFailures: number
  /** Native failure detail (`error: <message>` from `turn/end`). */
  readonly failure: string

  constructor(failure: string, details: { toolCalls?: number; toolFailures?: number } = {}) {
    super(`native DSH Agent turn failed (${failure})`)
    this.name = 'SessionTurnFailure'
    this.failure = failure
    this.toolCalls = Math.max(0, Math.trunc(details.toolCalls ?? 0))
    this.toolFailures = Math.max(0, Math.trunc(details.toolFailures ?? 0))
  }
}
