// Validate local Markdown links in the living docs and archived snapshots.
// No network access and no external dependencies. Run: pnpm run docs:check
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const docs = ['README.md', 'web-admin/README.md']

function collect(dir) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) collect(relative)
    else if (entry.isFile() && entry.name.endsWith('.md')) docs.push(relative)
  }
}
collect('docs')

const missing = []
let inspected = 0
for (const file of docs) {
  const text = readFileSync(path.join(root, file), 'utf8')
  // This intentionally validates path existence, not external URLs or anchors.
  for (const match of text.matchAll(/!?\[[^\]]*\]\((<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1].replace(/^<|>$/g, '')
    if (/^(?:https?:|mailto:|data:|#)/i.test(href)) continue
    const relative = href.split(/[?#]/, 1)[0]
    if (!relative) continue
    const target = path.resolve(root, path.dirname(file), relative)
    inspected += 1
    if ((!target.startsWith(root + path.sep) && target !== root) || !existsSync(target)) {
      missing.push(file + ': ' + href)
    } else if (!statSync(target).isFile() && !statSync(target).isDirectory()) {
      missing.push(file + ': ' + href)
    }
  }
}
if (missing.length) {
  console.error('Broken local documentation links:\n' + missing.join('\n'))
  process.exitCode = 1
} else {
  console.log('Documentation links OK: ' + docs.length + ' Markdown files, ' + inspected + ' local links')
}
