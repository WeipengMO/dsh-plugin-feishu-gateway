import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ApprovalStore, approvalRef, commandRoot, commandSummary,
} from '../../src/channel/approval-store.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'approval-store-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('commandRoot / commandSummary', () => {
  it('extracts a conservative executable root for permanent scopes', () => {
    expect(commandRoot('lark-cli calendar +agenda --as user')).toBe('lark-cli')
    expect(commandRoot('TOKEN=x env lark-cli im +send')).toBe('lark-cli')
    expect(commandRoot('sudo /usr/bin/git status')).toBe('git')
    expect(commandRoot('/opt/tools/tool --flag')).toBe('tool')
    expect(commandRoot('python3 scripts/a.py')).toBe('python3')
    expect(commandRoot('   ')).toBeUndefined()
    expect(commandRoot('TOKEN=1')).toBeUndefined()
    expect(commandRoot(undefined)).toBeUndefined()
  })

  it('bounds and flattens the audit command summary', () => {
    expect(commandSummary('a\nb\tc')).toBe('a b c')
    expect(commandSummary('x'.repeat(400))!.length).toBe(200)
    expect(commandSummary('')).toBeNull()
    expect(commandSummary(undefined)).toBeNull()
  })
})

describe('ApprovalStore', () => {
  it('persists a narrow permanent rule and exposes only hashed creator ids', async () => {
    const dir = await stateDir()
    const store = new ApprovalStore({ stateDir: dir })
    await store.load()
    const rule = await store.remember({ tool: 'bash', root: 'lark-cli', createdBy: 'ou_alice', now: 1000 })
    expect(rule).toMatchObject({ tool: 'bash', commandRoot: 'lark-cli', label: 'bash · lark-cli*', createdAt: 1000 })
    expect(rule!.createdByRef).toBe(approvalRef('ou_alice'))
    expect(store.ruleFor('bash', 'lark-cli')).toMatchObject({ ref: rule!.ref })
    expect(store.ruleFor('bash', 'git')).toBeUndefined()
    expect(store.ruleFor('web_fetch', undefined)).toBeUndefined()

    // The same scope is idempotent: a repeated permanent click never duplicates.
    const again = await store.remember({ tool: 'bash', root: 'lark-cli', createdBy: 'ou_alice', now: 2000 })
    expect(again!.ref).toBe(rule!.ref)
    expect(store.rulesView()).toHaveLength(1)

    const doc = JSON.parse(await readFile(path.join(dir, 'approvals.json'), 'utf8'))
    expect(doc).toMatchObject({ version: 1 })
    expect(doc.rules).toHaveLength(1)
    expect(JSON.stringify(doc)).not.toContain('ou_alice')
    expect((await stat(path.join(dir, 'approvals.json'))).mode & 0o777).toBe(0o600)
  })

  it('refuses bash rules without a command root and rejects unsafe tool names', async () => {
    const dir = await stateDir()
    const store = new ApprovalStore({ stateDir: dir })
    await store.load()
    expect(await store.remember({ tool: 'bash', root: undefined, createdBy: 'ou_alice' })).toBeUndefined()
    expect(await store.remember({ tool: 'bash; rm -rf /', root: 'x', createdBy: 'ou_alice' })).toBeUndefined()
  })

  it('auto-allow usage bumps counters and revocation removes the rule', async () => {
    const dir = await stateDir()
    const store = new ApprovalStore({ stateDir: dir })
    await store.load()
    const rule = (await store.remember({ tool: 'bash', root: 'git', createdBy: 'ou_alice' }))!
    await store.touch(rule.ref, 5000)
    expect(store.ruleFor('bash', 'git')).toMatchObject({ lastUsedAt: 5000, uses: 1 })
    expect(await store.revoke(rule.ref)).toMatchObject({ ref: rule.ref })
    expect(await store.revoke(rule.ref)).toBeUndefined()
    expect(store.ruleFor('bash', 'git')).toBeUndefined()
  })

  it('publishes a bounded read model with newest-first records and hashed chat refs', async () => {
    const dir = await stateDir()
    const store = new ApprovalStore({ stateDir: dir })
    await store.load()
    await store.remember({ tool: 'bash', root: 'lark-cli', createdBy: 'ou_alice' })
    const chatRef = approvalRef('oc_chat')
    await store.record({ ts: 10, tool: 'bash', command: 'lark-cli a', decision: 'requested',
      botId: 'default', chatRef, ruleRef: null, elapsedMs: null })
    await store.record({ ts: 20, tool: 'bash', command: 'lark-cli a', decision: 'allowed-once',
      botId: 'default', chatRef, ruleRef: null, elapsedMs: 12 })
    await store.publish([], 600_000)
    const model = JSON.parse(await readFile(path.join(dir, 'ops-approvals.json'), 'utf8'))
    expect(model).toMatchObject({ version: 1, available: true, timeoutMs: 600_000, recordLimit: 200 })
    expect(model.rules).toHaveLength(1)
    expect(model.records.map((r: { decision: string }) => r.decision)).toEqual(['allowed-once', 'requested'])
    expect(model.records[0]).toMatchObject({ chatRef, elapsedMs: 12, ruleRef: null })
    expect(JSON.stringify(model)).not.toContain('oc_chat')
    expect((await stat(path.join(dir, 'ops-approvals.json'))).mode & 0o777).toBe(0o600)
  })

  it('fails closed for corrupt or symlinked rule files', async () => {
    const dir = await stateDir()
    const store = new ApprovalStore({ stateDir: dir })
    await store.load()
    await writeFile(path.join(dir, 'approvals.json'), '{not json', { mode: 0o600 })
    const corrupt = new ApprovalStore({ stateDir: dir })
    await corrupt.load()
    expect(corrupt.ruleFor('bash', 'lark-cli')).toBeUndefined()

    const target = path.join(dir, 'real-rules.json')
    await writeFile(target, JSON.stringify({ version: 1, rules: [{
      ref: 'abcdef1234567890', tool: 'bash', commandRoot: 'lark-cli', label: 'bash · lark-cli*',
      createdAt: 1, createdByRef: 'abcdef1234567890', lastUsedAt: null, uses: 0,
    }] }), { mode: 0o600 })
    // The reader only reads approvals.json; a symlink there must be ignored.
    await rm(path.join(dir, 'approvals.json'))
    await symlink(target, path.join(dir, 'approvals.json'))
    const symlinked = new ApprovalStore({ stateDir: dir })
    await symlinked.load()
    expect(symlinked.ruleFor('bash', 'lark-cli')).toBeUndefined()
  })
})
