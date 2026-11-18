/* Prevent private runtime data and unexpected files from shipping in npm archives. */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ALLOWED_PACKAGES = new Map([
  ['dsh-plugin-feishu-gateway', ['lib/', 'docs/', 'profiles/', 'locale/', 'README.md',
    'LICENSE', 'package.json', 'cordis.patch.yml']],
  ['dsh-plugin-feishu-admin', ['lib/', 'README.md', 'LICENSE',
    'package.json', 'cordis.patch.yml']],
])
const PRIVATE_SEGMENT = /^(?:\.git|\.github|\.ssh|\.aws|\.feishu-gateway|node_modules|coverage|\.npmrc|\.netrc|\.env(?:\..*)?|admin-config\.json|feishu-channel\.env|credentials(?:\.json)?|secrets?(?:\.json)?|id_(?:rsa|ed25519)|known_hosts|authorized_keys)$/i
const PRIVATE_EXTENSION = /\.(?:pem|p12|pfx|key|keystore|sqlite(?:3)?|db|db-wal|db-shm|jsonl(?:\.zstd)?|log|bak|old|swp)$/i
const PRIVATE_WORD = /(?:^|[\/.-])(?:session-history|session-recording|private-key|access-token|secret-backup)(?:[.-]|$)/i

export function validateEntries(packageName, entries) {
  const allowed = ALLOWED_PACKAGES.get(packageName)
  const failures = []
  if (!allowed) return ['unexpected package name']
  if (!entries.length) return ['empty package archive']
  for (const original of entries) {
    if (typeof original !== 'string' || !original) continue
    if (original === 'package/' || original === 'package') continue
    const value = original.replace(/\/+$/, '')
    const parts = value.split('/')
    if (!value.startsWith('package/') || parts.includes('..') ||
        parts.includes('.') || value.includes('\\') ||
        path.posix.normalize(value) !== value) {
      failures.push('unsafe archive path')
      continue
    }
    const inside = value.slice('package/'.length)
    if (!inside) continue
    const sections = inside.split('/')
    if (!allowed.some(prefix => prefix.endsWith('/')
      ? inside.startsWith(prefix) || inside === prefix.slice(0, -1)
      : inside === prefix)) {
      failures.push('unexpected publish path: ' + inside)
      continue
    }
    if (sections.some(segment => PRIVATE_SEGMENT.test(segment) && segment !== '.env.example') ||
        PRIVATE_EXTENSION.test(inside) || PRIVATE_WORD.test(inside)) {
      failures.push('private or suspicious publish path: ' + inside)
    }
  }
  return failures
}

export function scanTarballs(directory) {
  const archives = readdirSync(directory).filter(file => file.endsWith('.tgz'))
  if (archives.length !== ALLOWED_PACKAGES.size) {
    throw Error('Expected exactly two npm packages; got ' + archives.length)
  }
  const seen = new Set()
  for (const name of archives) {
    const file = path.join(directory, name)
    const entries = execFileSync('tar', ['-tzf', file], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    }).trim().split('\n').filter(Boolean)
    const metadata = execFileSync('tar', ['-xOzf', file, 'package/package.json'], {
      encoding: 'utf8', maxBuffer: 512 * 1024,
    })
    const packageName = JSON.parse(metadata).name
    if (seen.has(packageName)) throw Error('Duplicate package archive')
    seen.add(packageName)
    const findings = validateEntries(packageName, entries)
    if (findings.length) {
      throw Error(packageName + ': ' + [...new Set(findings)].join('; '))
    }
    console.log('Archive hygiene OK: ' + packageName + ' (' + entries.length + ' entries)')
  }
  if ([...ALLOWED_PACKAGES.keys()].some(name => !seen.has(name))) {
    throw Error('A required npm package is missing')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    scanTarballs(path.resolve(process.argv[2] || path.join(
      path.dirname(fileURLToPath(import.meta.url)), '../../dist')))
  } catch (error) {
    console.error('Release archive security check failed:', error.message)
    process.exitCode = 1
  }
}
