import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { NetworkProxyConfig } from '../types.js'

/**
 * Shared proxy-URL rules. The same rules are enforced by the web admin and the
 * channel launcher (see docs/PROXY-CONFIG-FLOW.md §2), so a URL accepted by one
 * component is accepted by the others.
 *
 * Nothing in this module ever logs or returns the raw URL to a caller that
 * prints it: `validateProxyUrl` error messages are static strings, and
 * `redactProxyUrl` strips userinfo/port-less display values only.
 */

/** Env var the launcher still exports for legacy deployments. */
export const DEFAULT_PROXY_URL_ENV = 'FEISHU_CHANNEL_PROXY_URL'

/** File written by the web admin inside the channel state dir (mode 0600). */
export const STORED_PROXY_FILENAME = 'network-proxy.json'

/** Upper bound for a proxy URL; longer values are rejected outright. */
export const MAX_PROXY_URL_LENGTH = 2048

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/

/**
 * Validate and normalize a proxy URL.
 *
 * Rules: `http:`/`https:` only, mandatory hostname, optional port 1..65535,
 * optional userinfo (proxy authentication), no path (a bare `/` is allowed),
 * no query, no fragment, at most 2048 characters.
 *
 * Error messages are deliberately static: they must never echo the URL or its
 * userinfo back to a log, an HTTP response or the UI.
 */
export function validateProxyUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('proxy URL must be a string')
  const value = raw
  if (value === '') throw new Error('proxy URL is empty')
  if (value.length > MAX_PROXY_URL_LENGTH) {
    throw new Error(`proxy URL must be at most ${MAX_PROXY_URL_LENGTH} characters`)
  }
  // The WHATWG parser strips tabs/newlines and percent-encodes spaces, which
  // would silently accept `http://ho\nst`. Reject them instead of guessing.
  // Surrounding whitespace is rejected too, matching the web admin validator;
  // `readProxyUrlFromEnv` trims env-file values before calling in.
  if (CONTROL_OR_SPACE.test(value)) {
    throw new Error('proxy URL must not contain whitespace or control characters')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('proxy URL is not a valid absolute URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('proxy URL must use http or https')
  }
  if (!parsed.hostname) throw new Error('proxy URL must include a hostname')
  if (parsed.port !== '') {
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('proxy URL port must be between 1 and 65535')
    }
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new Error('proxy URL must not contain a path')
  }
  if (parsed.search !== '') throw new Error('proxy URL must not contain a query string')
  if (parsed.hash !== '') throw new Error('proxy URL must not contain a fragment')
  return value
}

/**
 * Display-only form: `scheme://host[:port]` with userinfo removed. Never throws
 * and never returns the original string, so it is safe in logs and the UI.
 */
export function redactProxyUrl(raw: string): string {
  try {
    const parsed = new URL(String(raw).trim())
    const host = parsed.host || parsed.hostname
    return host ? `${parsed.protocol}//${host}` : '(invalid proxy url)'
  } catch {
    return '(invalid proxy url)'
  }
}

/**
 * Read the proxy URL from the named env var. Invalid values (or an invalid env
 * var name) yield `undefined` so a broken environment degrades to a direct
 * connection instead of failing plugin startup.
 */
export function readProxyUrlFromEnv(
  urlEnv: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const name = typeof urlEnv === 'string' && ENV_NAME.test(urlEnv) ? urlEnv : DEFAULT_PROXY_URL_ENV
  const raw = env[name]?.trim()
  if (!raw) return undefined
  try {
    return validateProxyUrl(raw)
  } catch {
    return undefined
  }
}

/**
 * Strict reader for `<stateDir>/network-proxy.json`.
 *
 * Requirements: regular file, NOT a symlink, mode 0600, JSON
 * `{ "version": 1, "url": "..." }` with a URL that passes `validateProxyUrl`.
 * Every failure returns `undefined` — a malformed or tampered file must never
 * prevent the channel from starting.
 */
export function readStoredProxyUrl(stateDir: string): string | undefined {
  if (typeof stateDir !== 'string' || stateDir === '') return undefined
  const filename = path.join(stateDir, STORED_PROXY_FILENAME)
  try {
    const stat = lstatSync(filename)
    // lstat does not follow links, so a symlink is reported as such here.
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined
    if ((stat.mode & 0o777) !== 0o600) return undefined
    const doc = JSON.parse(readFileSync(filename, 'utf8')) as unknown
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return undefined
    const record = doc as Record<string, unknown>
    if (record.version !== 1) return undefined
    return validateProxyUrl(record.url)
  } catch {
    return undefined
  }
}

/**
 * Effective proxy URL for this process: the admin-managed
 * `network-proxy.json` first, then the legacy env var, else none.
 * Returns `undefined` when the proxy is disabled.
 */
export function resolveProxyUrl(
  proxy: NetworkProxyConfig | undefined,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!proxy?.enabled) return undefined
  return readStoredProxyUrl(stateDir) ?? readProxyUrlFromEnv(proxy.urlEnv, env)
}
