/**
 * Channel-scoped external MCP server registry. It is not a global plugin
 * installer and never edits the source profile. All endpoints and paths are
 * local operator data written under stateDir with private file permissions.
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const EXTERNAL_TOOLS_FILE = 'external-tools.json'
export const EXTERNAL_TOOLS_PATCH = 'extra-plugins.patch.yml'
const HEADER = '# Managed by dsh-plugin-feishu-admin: external MCP servers'
const fail = message => Object.assign(new Error(message), { status: 400 })
const sha = raw => createHash('sha256').update(raw).digest('hex')
const simple = text => JSON.stringify(text) // JSON double-quoted strings are YAML scalars.

export function normalizeExternalServers(raw) {
  if (!Array.isArray(raw) || raw.length > 24) throw fail('invalid MCP server list')
  const used = new Set()
  return raw.map(server => {
    if (!server || typeof server !== 'object' || Array.isArray(server) ||
      Object.keys(server).some(key => !['name', 'enabled', 'transport', 'url', 'command', 'args', 'credentialRef'].includes(key))) {
      throw fail('invalid MCP server')
    }
    const name = server.name
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name) || used.has(name.toLowerCase())) {
      throw fail('invalid or duplicate MCP server name')
    }
    used.add(name.toLowerCase())
    if (typeof server.enabled !== 'boolean') throw fail('invalid MCP enabled flag')
    if (!['streamable-http', 'stdio'].includes(server.transport)) throw fail('invalid MCP transport')
    const result = { name, enabled: server.enabled, transport: server.transport }
    if (server.transport === 'streamable-http') {
      if (typeof server.url !== 'string' || server.url.length > 2048 ||
        /[\s\u0000-\u001f\u007f]/.test(server.url)) throw fail('invalid MCP endpoint URL')
      let u
      try { u = new URL(server.url) } catch { throw fail('invalid MCP endpoint URL') }
      if (!['http:', 'https:'].includes(u.protocol) || !u.hostname ||
        u.username || u.password || u.search || u.hash) throw fail('invalid MCP endpoint URL')
      result.url = server.url
      if (server.credentialRef !== undefined && server.credentialRef !== '') {
        if (typeof server.credentialRef !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(server.credentialRef)) {
          throw fail('invalid MCP credential reference')
        }
        result.credentialRef = server.credentialRef
      }
    } else {
      if (typeof server.command !== 'string' || !/^[^\s\u0000-\u001f\u007f]{1,512}$/.test(server.command)) {
        throw fail('invalid MCP executable')
      }
      const args = server.args ?? []
      if (!Array.isArray(args) || args.length > 24 ||
        args.some(arg => typeof arg !== 'string' || arg.length > 1024 || /[\u0000-\u001f\u007f]/.test(arg))) {
        throw fail('invalid MCP arguments')
      }
      result.command = server.command
      result.args = args
    }
    return result
  })
}

export function renderExternalToolsPatch(servers) {
  const lines = [HEADER, '# Channel-only overlay; edit from Feishu Admin. No credentials are stored here.']
  for (const server of normalizeExternalServers(servers).filter(item => item.enabled)) {
    lines.push('- id: ' + simple('feishu-mcp-' + server.name),
      '  name: ' + simple('@deepseek-ai/dsh-mcp-client'),
      '  config:',
      '    serverName: ' + simple(server.name),
      '    transport: ' + simple(server.transport))
    if (server.transport === 'streamable-http') {
      lines.push('    url: ' + simple(server.url))
      if (server.credentialRef) {
        lines.push('    expandTemplates: true', '    headers:',
          '      Authorization: ' + simple('${credential:' + server.credentialRef + '}'))
      }
    } else {
      lines.push('    command: ' + simple(server.command),
        '    args: ' + JSON.stringify(server.args))
    }
  }
  return lines.join('\n') + '\n'
}

async function readFileStrict(file, max = 128 * 1024) {
  let stat
  try { stat = await fs.lstat(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > max || (stat.mode & 0o077) !== 0) {
    throw Object.assign(new Error('unsafe managed MCP file'), { status: 409 })
  }
  return fs.readFile(file, 'utf8')
}
async function atomicWrite(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' })
    await fs.rename(temp, file)
  } finally {
    await fs.rm(temp, { force: true })
  }
}
export async function readExternalTools(stateDir) {
  const file = path.join(stateDir, EXTERNAL_TOOLS_FILE)
  const patch = path.join(stateDir, EXTERNAL_TOOLS_PATCH)
  const [raw, overlay] = await Promise.all([readFileStrict(file), readFileStrict(patch)])
  if (overlay && !overlay.startsWith(HEADER + '\n')) {
    return { servers: [], revision: 'unmanaged', unmanagedPatch: true }
  }
  if (raw === null) return { servers: [], revision: 'absent', unmanagedPatch: false }
  let doc
  try { doc = JSON.parse(raw) } catch { throw Object.assign(new Error('invalid MCP registry'), { status: 409 }) }
  if (!doc || doc.version !== 1) throw Object.assign(new Error('invalid MCP registry'), { status: 409 })
  let servers
  try { servers = normalizeExternalServers(doc.servers) }
  catch { throw Object.assign(new Error('invalid MCP registry'), { status: 409 }) }
  return { servers, revision: sha(raw), unmanagedPatch: false }
}
export async function writeExternalTools(stateDir, input) {
  if (!input || typeof input !== 'object' ||
    Object.keys(input).some(key => !['servers', 'expectedRevision'].includes(key))) throw fail('invalid MCP update')
  const current = await readExternalTools(stateDir)
  if (current.unmanagedPatch) throw Object.assign(new Error('MCP overlay is operator-managed; edit it manually'), { status: 409 })
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error('MCP registry changed; reload'), { status: 409 })
  const servers = normalizeExternalServers(input.servers)
  const file = path.join(stateDir, EXTERNAL_TOOLS_FILE)
  const patch = path.join(stateDir, EXTERNAL_TOOLS_PATCH)
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const active = servers.filter(server => server.enabled)
  // Do not replace unmanaged content under the overlay file name.
  await atomicWrite(file, JSON.stringify({ version: 1, servers }, null, 2) + '\n')
  if (active.length) await atomicWrite(patch, renderExternalToolsPatch(servers))
  else await fs.rm(patch, { force: true })
  return readExternalTools(stateDir)
}
