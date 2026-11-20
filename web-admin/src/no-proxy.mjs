import { isIP } from 'node:net'

// Managed bypass entries contain hostnames and networks only, never credentials.
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1'
export function normalizeManagedNoProxy(input) {
  if (typeof input !== 'string' || input.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(input.replace(/[\r\n\t]/g, ''))) {
    throw Object.assign(new Error('invalid noProxy configuration'), { status: 400 })
  }
  const entries = input.split(/[,\s]+/).filter(Boolean)
  if (entries.length > 128) throw Object.assign(new Error('invalid noProxy configuration'), { status: 400 })
  for (const entry of entries) {
    if (entry === '*') continue
    const cidr = /^(.+)\/(\d{1,3})$/.exec(entry)
    if (cidr) {
      const family = isIP(cidr[1])
      if (family === 0 || Number(cidr[2]) > (family === 4 ? 32 : 128)) {
        throw Object.assign(new Error('invalid noProxy configuration'), { status: 400 })
      }
      continue
    }
    if (isIP(entry)) continue
    const hostname = entry.startsWith('*.') ? entry.slice(2) : entry.startsWith('.') ? entry.slice(1) : entry
    if (!/^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/.test(hostname) ||
      hostname.length > 253 || (entry.includes('*') && !entry.startsWith('*.'))) {
      throw Object.assign(new Error('invalid noProxy configuration'), { status: 400 })
    }
  }
  return [...new Set(entries)].join(',')
}
