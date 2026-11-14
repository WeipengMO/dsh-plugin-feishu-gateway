import type { GatewayLogger } from '../types.js'

const PREFIX = '[feishu-gateway]'

/** Console logger used when no Cordis logger is available (tests, standalone). */
export const consoleLogger: GatewayLogger = {
  debug: (message, ...args) => console.debug(PREFIX, message, ...args),
  info: (message, ...args) => console.info(PREFIX, message, ...args),
  warn: (message, ...args) => console.warn(PREFIX, message, ...args),
  error: (message, ...args) => console.error(PREFIX, message, ...args),
}

/** Silent logger for tests that must not pollute output. */
export const silentLogger: GatewayLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Adapt a Cordis `ctx.logger(name)` result (or anything with debug/info/warn/
 * error) into our port, falling back to console.
 */
export function fromCordisLogger(ctx: unknown): GatewayLogger {
  const anyCtx = ctx as { logger?: (name: string) => unknown } | undefined
  if (typeof anyCtx?.logger !== 'function') return consoleLogger
  try {
    const candidate = anyCtx.logger('feishu-gateway') as Partial<GatewayLogger> | undefined
    if (candidate && typeof candidate.info === 'function' && typeof candidate.error === 'function') {
      return {
        debug: (m, ...a) => candidate.debug?.(m, ...a),
        info: (m, ...a) => candidate.info?.(m, ...a),
        warn: (m, ...a) => candidate.warn?.(m, ...a),
        error: (m, ...a) => candidate.error?.(m, ...a),
      }
    }
  } catch {
    // fall through
  }
  return consoleLogger
}

/** Wrap a logger so every message carries a stable scope prefix. */
export function scopedLogger(base: GatewayLogger, scope: string): GatewayLogger {
  const prefix = `${PREFIX}[${scope}]`
  return {
    debug: (m, ...a) => base.debug(prefix, m, ...a),
    info: (m, ...a) => base.info(prefix, m, ...a),
    warn: (m, ...a) => base.warn(prefix, m, ...a),
    error: (m, ...a) => base.error(prefix, m, ...a),
  }
}
