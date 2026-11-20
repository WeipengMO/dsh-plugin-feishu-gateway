import { describe, expect, it } from 'vitest'
import { DEFAULT_NO_PROXY, normalizeNoProxy, shouldBypassProxy } from '../../src/util/no-proxy.js'

describe('managed NO_PROXY routing', () => {
  it('normalizes operators separated by commas, spaces and newlines', () => {
    expect(normalizeNoProxy('localhost, 127.0.0.1\n*.internal localhost'))
      .toBe('localhost,127.0.0.1,*.internal')
    expect(DEFAULT_NO_PROXY).toBe('localhost,127.0.0.1,::1')
  })
  it('matches exact hosts, suffixes, IPv4 and IPv6 CIDR ranges without DNS', () => {
    const rules = 'localhost,127.0.0.1,::1,*.internal,198.51.100.0/24,2001:db8::/32'
    expect(shouldBypassProxy('LOCALHOST', 443, rules)).toBe(true)
    expect(shouldBypassProxy('browser.internal', 443, rules)).toBe(true)
    expect(shouldBypassProxy('notinternal', 443, rules)).toBe(false)
    expect(shouldBypassProxy('198.51.100.47', 443, rules)).toBe(true)
    expect(shouldBypassProxy('198.51.101.47', 443, rules)).toBe(false)
    expect(shouldBypassProxy('2001:db8::3', 443, rules)).toBe(true)
    expect(shouldBypassProxy('example.org', 443, rules)).toBe(false)
    expect(shouldBypassProxy('example.org', 443, '*')).toBe(true)
  })
  it('rejects URL, shell fragments and invalid networks instead of storing them', () => {
    for (const value of ['https://example.org', 'example.org;exit', '198.51.100.0/36',
      'bad*host', 'bad\n\u0000host']) {
      expect(() => normalizeNoProxy(value)).toThrow(/invalid noProxy/)
    }
  })
})
