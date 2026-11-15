import { readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireStateDirOwnerLock } from '../../src/storage/owner-lock.js'
import { silentLogger } from '../../src/util/logger.js'
import { tempDir } from '../helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(): Promise<string> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return dir
}

describe('stateDir owner lock', () => {
  it('acquires an exclusive lock and releases it on stop', async () => {
    const dir = await fixture()
    const lock = await acquireStateDirOwnerLock(dir, silentLogger)
    const raw = JSON.parse(await readFile(path.join(dir, '.owner.lock'), 'utf8')) as { pid: number; owner: string }
    expect(raw.pid).toBe(process.pid)
    expect(raw.owner).toBeTruthy()
    await lock.release()
    await expect(readFile(path.join(dir, '.owner.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a second live owner (would double-execute the same message)', async () => {
    const dir = await fixture()
    const first = await acquireStateDirOwnerLock(dir, silentLogger)
    await expect(acquireStateDirOwnerLock(dir, silentLogger)).rejects.toThrow(/already owned by a running Feishu gateway/)
    // The first owner must still hold its lock.
    expect(JSON.parse(await readFile(path.join(dir, '.owner.lock'), 'utf8'))).toBeDefined()
    await first.release()
  })

  it('takes over a stale lock left by a dead process (crash / SIGKILL restart)', async () => {
    const dir = await fixture()
    await writeFile(path.join(dir, '.owner.lock'), JSON.stringify({
      owner: 'dead-owner', pid: 2_147_483_647, host: os.hostname(), acquiredAt: 0,
    }), 'utf8')
    const lock = await acquireStateDirOwnerLock(dir, silentLogger)
    const raw = JSON.parse(await readFile(path.join(dir, '.owner.lock'), 'utf8')) as { owner: string }
    expect(raw.owner).not.toBe('dead-owner')
    await lock.release()
  })

  it('release() never deletes a lock belonging to a newer owner', async () => {
    const dir = await fixture()
    const first = await acquireStateDirOwnerLock(dir, silentLogger)
    const firstOwner = (JSON.parse(await readFile(path.join(dir, '.owner.lock'), 'utf8')) as { owner: string }).owner
    // Simulate a stale take-over: replace the lock with a different owner.
    await rm(path.join(dir, '.owner.lock'), { force: true })
    await writeFile(path.join(dir, '.owner.lock'), JSON.stringify({
      owner: 'new-owner', pid: process.pid, host: os.hostname(), acquiredAt: 0,
    }), 'utf8')
    await first.release()
    expect((JSON.parse(await readFile(path.join(dir, '.owner.lock'), 'utf8')) as { owner: string }).owner).toBe('new-owner')
    expect(firstOwner).not.toBe('new-owner')
  })
})

describe('concurrent stale-lock takeover', () => {
  it('allows exactly one winner even when both contend for a stale owner', async () => {
    const dir = await fixture()
    await writeFile(path.join(dir, '.owner.lock'), JSON.stringify({
      owner: 'dead-owner', pid: 2_147_483_647, host: os.hostname(), acquiredAt: 0,
    }))
    const attempts = await Promise.allSettled([
      acquireStateDirOwnerLock(dir, silentLogger),
      acquireStateDirOwnerLock(dir, silentLogger),
    ])
    const winners = attempts.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireStateDirOwnerLock>>> => x.status === 'fulfilled')
    expect(winners).toHaveLength(1)
    expect(attempts.filter((x) => x.status === 'rejected')).toHaveLength(1)
    await winners[0]!.value.release()
  })
})
