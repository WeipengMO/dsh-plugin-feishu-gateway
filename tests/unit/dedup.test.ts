import { afterEach, describe, expect, it } from 'vitest'
import { DedupIndex } from '../../src/inbox/dedup.js'
import { tempDir } from '../helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(ttlMs = 60_000, maxEntries = 100): Promise<{ dir: string; make: () => DedupIndex }> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return { dir, make: () => new DedupIndex(dir, ttlMs, maxEntries) }
}

describe('DedupIndex', () => {
  it('accepts a new id once and rejects redelivery', async () => {
    const { make } = await fixture()
    const dedup = make()
    await dedup.open()
    expect(await dedup.checkAndRemember('om_1', 1000)).toBe(true)
    expect(await dedup.checkAndRemember('om_1', 1000)).toBe(false)
    expect(dedup.has('om_1')).toBe(true)
  })

  it('survives a restart (durable)', async () => {
    const { make } = await fixture()
    const first = make()
    await first.open()
    await first.checkAndRemember('om_1', 1000)
    const second = make()
    await second.open(1000)
    expect(await second.checkAndRemember('om_1', 1000)).toBe(false)
  })

  it('expires ids past the TTL', async () => {
    const { make } = await fixture(1000)
    const dedup = make()
    await dedup.open(0)
    await dedup.checkAndRemember('om_1', 0)
    expect(await dedup.checkAndRemember('om_1', 1001)).toBe(true)
  })

  it('prunes to the configured maximum, keeping the newest', async () => {
    const { make } = await fixture(60_000, 2)
    const dedup = make()
    await dedup.open(0)
    await dedup.checkAndRemember('a', 1)
    await dedup.checkAndRemember('b', 2)
    await dedup.checkAndRemember('c', 3)
    expect(await dedup.size()).toBe(2)
    expect(dedup.has('a')).toBe(false)
    expect(dedup.has('c')).toBe(true)
  })

  it('ignores an empty message id', async () => {
    const { make } = await fixture()
    const dedup = make()
    await dedup.open()
    expect(await dedup.checkAndRemember('')).toBe(false)
  })

  it('clear() empties the index', async () => {
    const { make } = await fixture()
    const dedup = make()
    await dedup.open()
    await dedup.checkAndRemember('om_1')
    await dedup.clear()
    expect(await dedup.checkAndRemember('om_1')).toBe(true)
  })
})
