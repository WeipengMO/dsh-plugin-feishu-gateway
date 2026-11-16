import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  normalizeExecPolicy, renderOverlayYaml, parseProfileExecPolicy,
  readExecPolicy, writeExecPolicy, assertRootsUsable,
  EXEC_POLICY_JSON, EXEC_OVERLAY_FILE,
} from '../src/exec-policy.mjs'

const PROFILE = `# profile
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers: {}
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: /home/ubuntu/dsh-workspace
    additionalWritableRoots:
      - /home/ubuntu/.lark-cli
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask
`

test('normalizeExecPolicy accepts valid and dedupes roots', () => {
  const p = normalizeExecPolicy({ mode: 'workspace-write', approvalPolicy: 'ask',
    additionalWritableRoots: [' /home/ubuntu/.lark-cli ', '/home/ubuntu/.lark-cli', ''] })
  assert.deepEqual(p, { mode: 'workspace-write', approvalPolicy: 'ask', additionalWritableRoots: ['/home/ubuntu/.lark-cli'] })
})

test('normalizeExecPolicy rejects bad input', () => {
  assert.throws(() => normalizeExecPolicy({ mode: 'nope', approvalPolicy: 'ask' }), /invalid mode/)
  assert.throws(() => normalizeExecPolicy({ mode: 'read-only', approvalPolicy: 'maybe' }), /invalid approvalPolicy/)
  assert.throws(() => normalizeExecPolicy({ mode: 'read-only', approvalPolicy: 'ask', additionalWritableRoots: ['rel/path'] }), /absolute/)
  assert.throws(() => normalizeExecPolicy({ mode: 'read-only', approvalPolicy: 'ask', extra: 1 }), /unsupported field/)
})

test('renderOverlayYaml emits sandbox, approval and a matching managed preset', () => {
  const yaml = renderOverlayYaml({ mode: 'danger-full-access', approvalPolicy: 'never',
    additionalWritableRoots: ['/home/ubuntu/.lark-cli'] })
  assert.match(yaml, /- id: sandbox-policy/)
  assert.match(yaml, /mode: danger-full-access/)
  assert.match(yaml, /- \/home\/ubuntu\/\.lark-cli/)
  assert.match(yaml, /- id: approval/)
  assert.match(yaml, /policy: never/)
  assert.match(yaml, /defaultPreset: managed/)
  assert.match(yaml, /managed: \{ sandbox: danger-full-access, approval: never \}/)
})

test('renderOverlayYaml writes an empty list when no roots', () => {
  const yaml = renderOverlayYaml({ mode: 'read-only', approvalPolicy: 'ask', additionalWritableRoots: [] })
  assert.match(yaml, /additionalWritableRoots: \[\]/)
})

test('parseProfileExecPolicy reads the profile rows', () => {
  const p = parseProfileExecPolicy(PROFILE)
  assert.equal(p.mode, 'workspace-write')
  assert.equal(p.workspaceRoot, '/home/ubuntu/dsh-workspace')
  assert.equal(p.approvalPolicy, 'ask')
  assert.deepEqual(p.additionalWritableRoots, ['/home/ubuntu/.lark-cli'])
})

test('readExecPolicy falls back to the profile when no managed mirror exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'execpol-'))
  const profilePath = path.join(dir, 'cordis.patch.yml')
  await fs.writeFile(profilePath, PROFILE)
  const r = await readExecPolicy({ stateDir: dir, profilePath })
  assert.equal(r.source, 'profile')
  assert.equal(r.policy.mode, 'workspace-write')
  assert.deepEqual(r.policy.additionalWritableRoots, ['/home/ubuntu/.lark-cli'])
})

test('writeExecPolicy writes mirror + overlay and round-trips; assertRootsUsable rejects missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'execpol-'))
  const profilePath = path.join(dir, 'cordis.patch.yml')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'writable-'))
  await fs.writeFile(profilePath, PROFILE)
  const policy = { mode: 'workspace-write', approvalPolicy: 'ask', additionalWritableRoots: [root] }
  await writeExecPolicy({ stateDir: dir, profilePath }, policy)
  const json = JSON.parse(await fs.readFile(path.join(dir, EXEC_POLICY_JSON), 'utf8'))
  assert.deepEqual(json, policy)
  const overlay = await fs.readFile(path.join(dir, EXEC_OVERLAY_FILE), 'utf8')
  assert.match(overlay, /mode: workspace-write/)
  const r = await readExecPolicy({ stateDir: dir, profilePath })
  assert.equal(r.source, 'managed')
  assert.deepEqual(r.policy, policy)
  await assert.rejects(() => assertRootsUsable(['/no/such/dir/xyz']), /does not exist/)
})

test('writeExecPolicy rejects a workspace-write root that is not a real dir', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'execpol-'))
  await assert.rejects(() => writeExecPolicy({ stateDir: dir },
    { mode: 'workspace-write', approvalPolicy: 'ask', additionalWritableRoots: ['/no/such/dir/xyz'] }), /does not exist/)
})
