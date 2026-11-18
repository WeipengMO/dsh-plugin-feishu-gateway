import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROXY_URL_ENV,
  MAX_PROXY_URL_LENGTH,
  readProxyUrlFromEnv,
  readStoredProxyUrl,
  redactProxyUrl,
  resolveProxyUrl,
  STORED_PROXY_FILENAME,
  validateProxyUrl,
} from '../../src/util/proxy-url.js'
import { tempDir } from '../helpers.js'

const cleanup: Array<() => Promise<void>> = []
const savedEnv: Array<[string, string | undefined]> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
  for (const [key, value] of savedEnv.splice(0)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** Set a process env var for one test and restore it afterwards. */
function setEnv(key: string, value: string | undefined): void {
  savedEnv.push([key, process.env[key]])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function stateDir(): Promise<string> {
  const d = await tempDir()
  cleanup.push(d.cleanup)
  return d.dir
}

async function writeStoredProxy(dir: string, body: string, mode = 0o600): Promise<string> {
  const file = path.join(dir, STORED_PROXY_FILENAME)
  await writeFile(file, body, { encoding: 'utf8', mode })
  await chmod(file, mode)
  return file
}

describe('validateProxyUrl', () => {
  it('accepts http/https proxies with optional userinfo, port and bare slash', () => {
    for (const url of [
      'http://127.0.0.1:7890',
      'https://proxy.example.com:8443',
      'http://proxy.internal',
      'http://proxy.internal/',
      'http://user:pass@100.75.51.18:2080',
      'http://host:1',
      'http://host:65535',
      `http://host:8080`,
    ]) {
      expect(validateProxyUrl(url)).toBe(url)
    }
  })

  it('rejects non-http schemes, bad ports, paths, query and fragment', () => {
    for (const url of [
      'ftp://proxy:21',
      'socks5://proxy:1080',
      'http://host:0',
      'http://host:65536',
      'http://host:99999',
      'http://host:8080/path',
      'http://host:8080/?x=1',
      'http://host:8080?x=1',
      'http://host:8080#frag',
      'http://',
      'not-a-url',
      '',
      '   ',
    ]) {
      expect(() => validateProxyUrl(url), url).toThrow()
    }
    expect(() => validateProxyUrl(123 as unknown as string)).toThrow(/string/)
  })

  it('rejects embedded whitespace/control characters the URL parser would hide', () => {
    expect(() => validateProxyUrl('http://ho\nst:8080')).toThrow(/whitespace/)
    expect(() => validateProxyUrl('http://ho st:8080')).toThrow(/whitespace/)
    expect(() => validateProxyUrl('http://host\t:8080')).toThrow(/whitespace/)
    expect(() => validateProxyUrl(' http://host:8080')).toThrow(/whitespace/)
    expect(() => validateProxyUrl('http://host:8080 ')).toThrow(/whitespace/)
  })

  it(`rejects URLs longer than ${MAX_PROXY_URL_LENGTH} characters`, () => {
    const long = `http://${'a'.repeat(MAX_PROXY_URL_LENGTH)}:8080`
    expect(() => validateProxyUrl(long)).toThrow(/at most/)
    expect(() => validateProxyUrl(`http://${'a'.repeat(100)}:8080`)).not.toThrow()
  })

  it('never echoes the URL or its userinfo in the error message', () => {
    const secret = 'http://admin:pass@proxy.internal:8080/path'
    try {
      validateProxyUrl(secret)
      throw new Error('expected validation to fail')
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain('admin')
      expect(message).not.toContain('pass')
      expect(message).not.toContain('proxy.internal')
      expect(message).not.toContain(secret)
    }
  })
})

describe('redactProxyUrl', () => {
  it('drops userinfo and keeps scheme/host/port', () => {
    expect(redactProxyUrl('http://user:pass@100.75.51.18:2080')).toBe('http://100.75.51.18:2080')
    expect(redactProxyUrl('https://user@proxy.internal:8443')).toBe('https://proxy.internal:8443')
    expect(redactProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('never throws and never leaks the original string', () => {
    const redacted = redactProxyUrl('user:pass@not a url')
    expect(redacted).toBe('(invalid proxy url)')
    expect(redacted).not.toContain('pass')
  })
})

describe('readProxyUrlFromEnv', () => {
  it('reads and validates the named env var, defaulting to the legacy name', () => {
    setEnv('FEISHU_TEST_PROXY_URL', 'http://env-proxy:3128')
    expect(readProxyUrlFromEnv('FEISHU_TEST_PROXY_URL')).toBe('http://env-proxy:3128')
    setEnv(DEFAULT_PROXY_URL_ENV, 'http://legacy-proxy:8080')
    expect(readProxyUrlFromEnv(undefined)).toBe('http://legacy-proxy:8080')
    // env files often carry trailing whitespace/newlines; trim before validating.
    setEnv('FEISHU_TEST_PROXY_URL', '  http://env-proxy:3128\n')
    expect(readProxyUrlFromEnv('FEISHU_TEST_PROXY_URL')).toBe('http://env-proxy:3128')
  })

  it('returns undefined for an unset, blank or invalid value', () => {
    setEnv('FEISHU_TEST_PROXY_URL', '   ')
    expect(readProxyUrlFromEnv('FEISHU_TEST_PROXY_URL')).toBeUndefined()
    setEnv('FEISHU_TEST_PROXY_URL', 'http://host:8080/path')
    expect(readProxyUrlFromEnv('FEISHU_TEST_PROXY_URL')).toBeUndefined()
    setEnv('FEISHU_TEST_PROXY_URL', 'ftp://host:21')
    expect(readProxyUrlFromEnv('FEISHU_TEST_PROXY_URL')).toBeUndefined()
  })

  it('ignores an invalid env var name instead of reading an arbitrary variable', () => {
    setEnv('not a name', 'http://env-proxy:3128')
    setEnv(DEFAULT_PROXY_URL_ENV, 'http://legacy-proxy:8080')
    expect(readProxyUrlFromEnv('not a name')).toBe('http://legacy-proxy:8080')
  })
})

describe('readStoredProxyUrl', () => {
  it('reads a 0600 network-proxy.json with version 1', async () => {
    const dir = await stateDir()
    await writeStoredProxy(dir, JSON.stringify({ version: 1, url: 'http://managed-proxy:2080' }))
    expect(readStoredProxyUrl(dir)).toBe('http://managed-proxy:2080')
  })

  it('returns undefined for a missing file or directory', async () => {
    const dir = await stateDir()
    expect(readStoredProxyUrl(dir)).toBeUndefined()
    expect(readStoredProxyUrl(path.join(dir, 'does-not-exist'))).toBeUndefined()
  })

  it('rejects a file that is not mode 0600', async () => {
    const dir = await stateDir()
    await writeStoredProxy(dir, JSON.stringify({ version: 1, url: 'http://managed-proxy:2080' }), 0o644)
    expect(readStoredProxyUrl(dir)).toBeUndefined()
    await chmod(path.join(dir, STORED_PROXY_FILENAME), 0o640)
    expect(readStoredProxyUrl(dir)).toBeUndefined()
  })

  it('rejects a symlink even when the target is a valid 0600 file', async () => {
    const dir = await stateDir()
    const target = path.join(dir, 'real-proxy.json')
    await writeFile(target, JSON.stringify({ version: 1, url: 'http://managed-proxy:2080' }), { mode: 0o600 })
    await chmod(target, 0o600)
    await symlink(target, path.join(dir, STORED_PROXY_FILENAME))
    expect(readStoredProxyUrl(dir)).toBeUndefined()
  })

  it('rejects a directory in place of the file', async () => {
    const dir = await stateDir()
    await mkdir(path.join(dir, STORED_PROXY_FILENAME))
    expect(readStoredProxyUrl(dir)).toBeUndefined()
  })

  it('returns undefined for malformed JSON, wrong version or a bad URL', async () => {
    const dir = await stateDir()
    await writeStoredProxy(dir, '{bad json')
    expect(readStoredProxyUrl(dir)).toBeUndefined()
    await writeStoredProxy(dir, JSON.stringify({ version: 2, url: 'http://managed-proxy:2080' }))
    expect(readStoredProxyUrl(dir)).toBeUndefined()
    await writeStoredProxy(dir, JSON.stringify({ url: 'http://managed-proxy:2080' }))
    expect(readStoredProxyUrl(dir)).toBeUndefined()
    await writeStoredProxy(dir, JSON.stringify({ version: 1, url: 'http://managed-proxy:2080/path' }))
    expect(readStoredProxyUrl(dir)).toBeUndefined()
    await writeStoredProxy(dir, JSON.stringify({ version: 1, url: 42 }))
    expect(readStoredProxyUrl(dir)).toBeUndefined()
    await writeStoredProxy(dir, JSON.stringify(['version', 1]))
    expect(readStoredProxyUrl(dir)).toBeUndefined()
  })
})

describe('resolveProxyUrl', () => {
  it('prefers the managed file over the env var', async () => {
    const dir = await stateDir()
    await writeStoredProxy(dir, JSON.stringify({ version: 1, url: 'http://managed-proxy:2080' }))
    setEnv('FEISHU_TEST_PROXY_URL', 'http://env-proxy:3128')
    expect(resolveProxyUrl(
      { enabled: true, urlEnv: 'FEISHU_TEST_PROXY_URL', fallbackDirect: true }, dir,
    )).toBe('http://managed-proxy:2080')
  })

  it('falls back to the env var when no managed URL is stored', async () => {
    const dir = await stateDir()
    setEnv('FEISHU_TEST_PROXY_URL', 'http://env-proxy:3128')
    expect(resolveProxyUrl(
      { enabled: true, urlEnv: 'FEISHU_TEST_PROXY_URL', fallbackDirect: true }, dir,
    )).toBe('http://env-proxy:3128')
  })

  it('ignores both sources when the proxy is disabled', async () => {
    const dir = await stateDir()
    await writeStoredProxy(dir, JSON.stringify({ version: 1, url: 'http://managed-proxy:2080' }))
    setEnv('FEISHU_TEST_PROXY_URL', 'http://env-proxy:3128')
    expect(resolveProxyUrl(
      { enabled: false, urlEnv: 'FEISHU_TEST_PROXY_URL', fallbackDirect: true }, dir,
    )).toBeUndefined()
    expect(resolveProxyUrl(undefined, dir)).toBeUndefined()
  })

  it('falls back to the env var when the stored file is invalid', async () => {
    const dir = await stateDir()
    await writeStoredProxy(dir, '{bad', 0o644)
    setEnv('FEISHU_TEST_PROXY_URL', 'http://env-proxy:3128')
    expect(resolveProxyUrl(
      { enabled: true, urlEnv: 'FEISHU_TEST_PROXY_URL', fallbackDirect: true }, dir,
    )).toBe('http://env-proxy:3128')
  })

  it('returns undefined when neither source is configured', async () => {
    const dir = await stateDir()
    setEnv('FEISHU_TEST_PROXY_URL', undefined)
    expect(resolveProxyUrl(
      { enabled: true, urlEnv: 'FEISHU_TEST_PROXY_URL', fallbackDirect: true }, dir,
    )).toBeUndefined()
  })
})
