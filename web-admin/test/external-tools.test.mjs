import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, lstat, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeExternalServers, renderExternalToolsPatch,
  readExternalTools, writeExternalTools } from '../src/external-tools.mjs'
import { normalizeManagedNoProxy } from '../src/no-proxy.mjs'

test('managed NO_PROXY stores only normalized hostname and address rules', () => {
  assert.equal(normalizeManagedNoProxy('localhost, *.internal\n198.51.100.0/24'),
    'localhost,*.internal,198.51.100.0/24')
  assert.throws(() => normalizeManagedNoProxy('https://example.org'), /invalid noProxy/)
})

test('MCP configs use DSH client rows and never inline credentials', () => {
  const servers = normalizeExternalServers([
    { name: 'browser', enabled: true, transport: 'streamable-http',
      url: 'https://mcp.example.org/api', credentialRef: 'MCP_TEST_TOKEN' },
    { name: 'local', enabled: true, transport: 'stdio', command: '/usr/bin/example-mcp',
      args: ['--mode', 'read only'] },
    { name: 'offline', enabled: false, transport: 'streamable-http', url: 'http://localhost:8080/mcp' },
  ])
  const patch = renderExternalToolsPatch(servers)
  assert.match(patch, /@deepseek-ai\/dsh-mcp-client/)
  assert.match(patch, /serverName: "browser"/)
  assert.match(patch, /transport: "stdio"/)
  assert.match(patch, /\$\{credential:MCP_TEST_TOKEN\}/)
  assert.doesNotMatch(patch, /offline/)
  assert.doesNotMatch(patch, /token-secret/)
  assert.throws(() => normalizeExternalServers([
    { name: 'A', enabled: true, transport: 'streamable-http', url: 'https://mcp.example.org' },
    { name: 'a', enabled: true, transport: 'streamable-http', url: 'https://mcp.example.org' },
  ]), /duplicate/)
  assert.throws(() => normalizeExternalServers([
    { name: 'x', enabled: true, transport: 'streamable-http', url: 'https://user:token@mcp.example.org/mcp' },
  ]), /invalid MCP endpoint/)
})

test('save/load MCP state with private files and protect manual patch files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mcp-test-'))
  try {
    let state = await readExternalTools(dir)
    assert.equal(state.revision, 'absent')
    const data = [{ name: 'remote', enabled: true, transport: 'streamable-http',
      url: 'https://mcp.example.org/mcp' }]
    state = await writeExternalTools(dir, { servers: data, expectedRevision: 'absent' })
    assert.equal(state.servers.length, 1)
    assert.equal((await lstat(path.join(dir, 'external-tools.json'))).mode & 0o777, 0o600)
    assert.equal((await lstat(path.join(dir, 'extra-plugins.patch.yml'))).mode & 0o777, 0o600)
    assert.match(await readFile(path.join(dir, 'extra-plugins.patch.yml'), 'utf8'),
      /@deepseek-ai\/dsh-mcp-client/)
    await assert.rejects(writeExternalTools(dir, { servers: [], expectedRevision: 'absent' }), /changed/)
    await writeExternalTools(dir, { servers: [], expectedRevision: state.revision })
    const patch = path.join(dir, 'extra-plugins.patch.yml')
    await writeFile(patch, '- id: operator-plugin\n', { mode: 0o600 })
    assert.equal((await readExternalTools(dir)).unmanagedPatch, true)
    await assert.rejects(writeExternalTools(dir, { servers: data, expectedRevision: 'unmanaged' }), /operator-managed/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
