#!/usr/bin/env node
// Offline prerelease gate: validate the two installable tarballs. Never publish.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const specs = [
  { dir: '.', name: 'dsh-plugin-feishu-gateway', required: [
    'lib/index.js', 'lib/types/index.d.ts', 'lib/testing/index.js',
    'lib/types/testing/index.d.ts', 'lib/channel/lark-transport.js',
    'cordis.patch.yml', 'README.md', 'LICENSE',
  ] },
  { dir: 'web-admin', name: 'dsh-plugin-feishu-admin', required: [
    'lib/index.mjs', 'lib/client.js', 'lib/ops-read.mjs',
    'lib/session-organizer.mjs', 'lib/skills-manager.mjs',
    'lib/usage-read.mjs', 'cordis.patch.yml', 'README.md',
  ] },
]
const fail = message => { throw Error('Release preflight: ' + message) }
const tar = (archive, flags, file) => execFileSync('tar',
  file ? [flags, archive, file] : [flags, archive],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const packedFile = (archive, file) => tar(archive, '-xOzf', 'package/' + file)
const requireFile = (entries, name, file) => {
  if (!entries.has('package/' + file)) fail(name + ': missing packed file ' + file)
}
function entriesFor(archive) {
  const entries = new Set(tar(archive, '-tzf').trim().split('\n').map(s => s.replace(/^\.\//, '')))
  if (!entries.size) fail(path.basename(archive) + ' is empty')
  for (const entry of entries) {
    if (!entry.startsWith('package/') || entry.split('/').includes('..'))
      fail('unsafe archive entry: ' + entry)
    if (/(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|id_rsa|sessions\.json|admin-config\.json|network-proxy\.json|[^/]+\.(?:pem|key))$/i.test(entry))
      fail('possible secret or state file in package: ' + entry)
    if (entry.startsWith('package/node_modules/') || entry.startsWith('package/.feishu-gateway/'))
      fail('unexpected private directory in package: ' + entry)
  }
  return entries
}
function verifyExports(pkg, entries) {
  const targets = [pkg.main, pkg.types]
  const visit = obj => {
    if (typeof obj === 'string') targets.push(obj)
    else if (obj && typeof obj === 'object') Object.values(obj).forEach(visit)
  }
  visit(pkg.exports)
  for (const target of targets.filter(Boolean)) {
    if (!target.includes('*')) requireFile(entries, pkg.name, target.replace(/^\.\//, ''))
  }
}
function verifyRelativeImports(archive, entries, name) {
  let checked = 0
  for (const entry of entries) {
    if (!/^package\/lib\/.+\.(?:mjs|js)$/.test(entry) || entry === 'package/lib/client.js') continue
    const code = packedFile(archive, entry.slice('package/'.length))
    const imports = /\bfrom\s*['"](\.{1,2}\/[^'"\s]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"\s]+)['"]\s*\)|\bimport\s*['"](\.{1,2}\/[^'"\s]+)['"]/g
    for (const match of code.matchAll(imports)) {
      const relative = (match[1] || match[2] || match[3]).split(/[?#]/, 1)[0]
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), relative))
      if (!entries.has(target)) fail(name + ': ' + entry + ' imports missing ' + target)
      checked++
    }
  }
  return checked
}

try {
  mkdirSync(dist, { recursive: true })
  const packages = []
  let sharedEngines
  for (const spec of specs) {
    const pkg = JSON.parse(readFileSync(path.join(root, spec.dir, 'package.json'), 'utf8'))
    if (pkg.name !== spec.name) fail('unexpected package name: ' + pkg.name)
    if (!/^\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+(?:\+[\w.-]+)?$/.test(pkg.version))
      fail(pkg.name + ': use a prerelease version, not a stable version')
    if (!pkg.dsh?.bundle?.patch || !pkg.engines?.dsh || !pkg.engines?.node)
      fail(pkg.name + ': missing DSH manifest or engine constraints')
    const engines = JSON.stringify(pkg.engines)
    if (sharedEngines && engines !== sharedEngines)
      fail('Gateway and Admin engine constraints differ')
    sharedEngines = engines

    const file = pkg.name + '-' + pkg.version + '.tgz'
    const archive = path.join(dist, file)
    let bytes
    try { bytes = readFileSync(archive) } catch { fail(file + ' missing: run pnpm run pack') }
    const entries = entriesFor(archive)
    const published = JSON.parse(packedFile(archive, 'package.json'))
    if (published.name !== pkg.name || published.version !== pkg.version)
      fail(file + ': package name/version do not match source')
    if (published.engines?.dsh !== pkg.engines.dsh || published.dsh?.bundle?.patch !== pkg.dsh.bundle.patch)
      fail(file + ': DSH compatibility metadata changed after packing')
    for (const required of spec.required) requireFile(entries, pkg.name, required)
    verifyExports(published, entries)
    const checkedImports = verifyRelativeImports(archive, entries, pkg.name)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    packages.push({ name: pkg.name, version: pkg.version, file, sha256,
      bytes: bytes.byteLength, entryCount: entries.size, checkedImports })
    console.log('PASS ' + pkg.name + '@' + pkg.version + ': ' + entries.size +
      ' entries; ' + checkedImports + ' imports checked')
  }
  writeFileSync(path.join(dist, 'release-manifest.json'),
    JSON.stringify({ schemaVersion: 1, channel: 'prerelease', packages }, null, 2) + '\n')
  writeFileSync(path.join(dist, 'SHA256SUMS'),
    packages.map(pkg => pkg.sha256 + '  ' + pkg.file).join('\n') + '\n')
  console.log('PASS: two tarballs verified; release manifest and SHA256SUMS generated. No publish performed.')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
