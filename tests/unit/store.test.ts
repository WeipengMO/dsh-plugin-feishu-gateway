import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonStore } from '../../src/storage/json-store.js'
import { tempDir } from '../helpers.js'

interface Doc { readonly values: number[] }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(): Promise<{ dir: string; store: JsonStore<Doc> }> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return { dir, store: new JsonStore<Doc>(dir, 'doc', { values: [] }) }
}

describe('JsonStore', () => {
  it('returns the fallback for a missing file and persists updates atomically', async () => {
    const { dir, store } = await fixture()
    expect(await store.load()).toEqual({ values: [] })
    await store.update((current) => ({ values: [...current.values, 1] }))
    await store.update((current) => ({ values: [...current.values, 2] }))
    expect(await store.load()).toEqual({ values: [1, 2] })
    const raw = await readFile(path.join(dir, 'doc.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual({ values: [1, 2] })
  })

  it('serializes concurrent updates without lost writes', async () => {
    const { store } = await fixture()
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.update((c) => ({ values: [...c.values, i] }))))
    expect((await store.load()).values).toHaveLength(20)
  })

  it('quarantines corrupt durable state and refuses to silently lose it', async () => {
    const { dir, store } = await fixture()
    await writeFile(path.join(dir, 'doc.json'), '{not json', 'utf8')
    await expect(store.load()).rejects.toThrow(/manual recovery required/)
    const { readdir } = await import('node:fs/promises')
    const backup = (await readdir(dir)).find((name) => name.startsWith('doc.json.corrupt-'))
    expect(backup).toBeTruthy()
    expect(await readFile(path.join(dir, backup!), 'utf8')).toBe('{not json')
    expect(await store.load()).toEqual({ values: [] }) // only after operator recovery/restart
  })

  it('never leaves a temp file behind', async () => {
    const { dir, store } = await fixture()
    await store.save({ values: [1] })
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('two stores in one process do not share a colliding temp file', async () => {
    // Regression: the old `${pid}.tmp` name meant instance A's rename could
    // observe instance B's half-written buffer (ENOENT / lost state).
    const { dir } = await fixture()
    const a = new JsonStore<Doc>(dir, 'shared', { values: [] })
    const b = new JsonStore<Doc>(dir, 'shared', { values: [] })
    await Promise.all([a.load(), b.load()])
    await Promise.all([a.save({ values: [1] }), b.save({ values: [2] })])
    const raw = await readFile(path.join(dir, 'shared.json'), 'utf8')
    expect([1, 2]).toContain((JSON.parse(raw) as Doc).values[0])
  })
})
