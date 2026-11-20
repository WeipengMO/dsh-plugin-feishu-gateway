import { BlockList, isIP } from 'node:net'

/** The historic launcher default. Unconfigured deployments retain this behavior. */
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1'
const LIMIT = 4096

/** A NO_PROXY list is configuration data, never a proxy URL or a shell fragment. */
export function normalizeNoProxy(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > LIMIT || /[\u0000-\u001f\u007f]/.test(raw.replace(/[\r\n\t]/g, ''))) {
    throw new Error('invalid noProxy configuration')
  }
  const entries = raw.split(/[,\s]+/).filter(Boolean)
  if (entries.length > 128) throw new Error('invalid noProxy configuration')
  for (const entry of entries) {
    if (entry === '*') continue
    const cidr = /^(.+)\/(\d{1,3})$/.exec(entry)
    if (cidr) {
      const family = isIP(cidr[1]!)
      const prefix = Number(cidr[2])
      if (family === 0 || prefix > (family === 4 ? 32 : 128)) throw new Error('invalid noProxy configuration')
      continue
    }
    if (isIP(entry)) continue
    const host = entry.startsWith('*.') ? entry.slice(2) : entry.startsWith('.') ? entry.slice(1) : entry
    if (!/^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/.test(host) || host.length > 253 ||
      (entry.includes('*') && !entry.startsWith('*.'))) {
      throw new Error('invalid noProxy configuration')
    }
  }
  return [...new Set(entries)].join(',')
}

/** Hostname is supplied by the WebSocket HTTP Agent, not a hard-coded API endpoint. */
export function shouldBypassProxy(hostname: string, port: number | string | undefined, list: string): boolean {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return false
  const hostFamily = isIP(host)
  for (const raw of String(list || '').split(/[,\s]+/)) {
    const rule = raw.toLowerCase().trim()
    if (!rule) continue
    if (rule === '*') return true
    const cidr = /^(.+)\/(\d{1,3})$/.exec(rule)
    if (cidr && hostFamily && isIP(cidr[1]!) === hostFamily) {
      try {
        const block = new BlockList()
        block.addSubnet(cidr[1]!, Number(cidr[2]), hostFamily === 4 ? 'ipv4' : 'ipv6')
        if (block.check(host, hostFamily === 4 ? 'ipv4' : 'ipv6')) return true
      } catch { /* Ignore invalid inherited environment rules. */ }
      continue
    }
    const suffix = rule.startsWith('*.') ? rule.slice(1) : rule.startsWith('.') ? rule : null
    if (suffix) {
      if (host.endsWith(suffix) || (rule.startsWith('.') && host === suffix.slice(1))) return true
    } else if (host === rule.replace(/\.$/, '')) {
      return true
    }
  }
  return false
}
