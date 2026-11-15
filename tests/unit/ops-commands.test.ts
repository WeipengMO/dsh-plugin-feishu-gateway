import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { processOperatorCommands } from '../../src/ops/commands.js'

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ops-command-'))
  const folder = path.join(dir, 'ops-control', 'requests')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  return { dir, folder }
}
async function command(folder: string, kind: string, ref?: string, ts = Date.now()) {
  const id = randomUUID()
  await writeFile(path.join(folder, id + '.json'), JSON.stringify({ version: 1,
    id, ts, type: kind, ...(ref ? { ref } : {}) }), { mode: 0o600 })
  return id
}
describe('at-most-once operator mailbox', () => {
  it('claims a cancel command once and exposes only a narrow result', async () => {
    const { dir, folder } = await setup()
    try {
      const ref = 'ab1234567890cdef'
      const id = await command(folder, 'cancel-task', ref)
      const executed: string[] = []
      const run = () => processOperatorCommands(dir, async cmd => {
        executed.push(cmd.type + ':' + cmd.ref)
        return 'completed'
      })
      expect(await run()).toBe(1)
      expect(await run()).toBe(0)
      expect(executed).toEqual(['cancel-task:' + ref])
      const result = JSON.parse(await readFile(path.join(dir, 'ops-control', 'results', id + '.json'), 'utf8'))
      expect(result).toMatchObject({ version: 1, id, type: 'cancel-task', state: 'completed', ref })
      expect(JSON.stringify(result)).not.toContain('chat')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('does not execute expired or malformed requests', async () => {
    const { dir, folder } = await setup()
    try {
      await command(folder, 'retry-outbox', undefined, Date.now() - 45_000)
      await command(folder, 'dangerous-tool')
      await command(folder, 'cancel-task', 'invalid-id')
      let calls = 0
      expect(await processOperatorCommands(dir, async () => {
        calls += 1
        return 'completed'
      })).toBe(3)
      expect(calls).toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('retries existing outbox queue only as a declared capability', async () => {
    const { dir, folder } = await setup()
    try {
      await command(folder, 'retry-outbox')
      const types: string[] = []
      await processOperatorCommands(dir, async cmd => {
        types.push(cmd.type)
        expect(cmd.ref).toBeUndefined()
        return 'completed'
      })
      expect(types).toEqual(['retry-outbox'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
