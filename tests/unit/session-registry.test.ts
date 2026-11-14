import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../src/session/session-registry.js'
import { chatKey } from '../../src/util/id.js'
import { tempDir } from '../helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(): Promise<() => SessionRegistry> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return () => new SessionRegistry(dir)
}

describe('SessionRegistry', () => {
  it('binds one native Session id per chat and persists it', async () => {
    const make = await fixture()
    const first = make()
    await first.open()
    const key = chatKey('default', 'oc_1')
    await first.bind(key, 'feishu-default-oc_1', 1000)
    expect(first.get(key)?.sessionId).toBe('feishu-default-oc_1')

    const second = make()
    await second.open()
    expect(second.get(key)?.sessionId).toBe('feishu-default-oc_1')
    expect(second.bindings()).toHaveLength(1)
  })

  it('keeps createdAt but updates lastActiveAt on touch', async () => {
    const make = await fixture()
    const registry = make()
    await registry.open()
    const key = chatKey('default', 'oc_1')
    await registry.bind(key, 'session-1', 1000)
    await registry.touch(key, 5000)
    expect(registry.get(key)).toMatchObject({ createdAt: 1000, lastActiveAt: 5000, persisted: true })
  })

  it('rebinds to a new id without changing createdAt', async () => {
    const make = await fixture()
    const registry = make()
    await registry.open()
    const key = chatKey('default', 'oc_1')
    await registry.bind(key, 'session-1', 1000)
    await registry.bind(key, 'session-2', 3000)
    expect(registry.get(key)).toMatchObject({ sessionId: 'session-2', createdAt: 1000, lastActiveAt: 3000 })
  })
})
