import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * A tiny atomic JSON document store. Writes go to a temp file in the same
 * directory and are renamed into place, so a crash can never leave a half
 * written state file. No native dependency, no SQLite, no schema migration.
 */
export class JsonStore<T> {
  private readonly file: string
  private chain: Promise<unknown> = Promise.resolve()
  private cache: T | undefined

  constructor(private readonly directory: string, private readonly name: string, private readonly fallback: T) {
    this.file = path.join(directory, `${name}.json`)
  }

  get path(): string {
    return this.file
  }

  /** Serialize all mutations so concurrent handlers cannot lose updates. */
  private serialize<R>(work: () => Promise<R>): Promise<R> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async readFromDisk(): Promise<T> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt state must not crash the gateway; quarantine and start clean.
        try {
          await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
        } catch {
          // the original file is left in place for manual inspection
        }
      }
      return structuredClone(this.fallback)
    }
    return parsed as T
  }

  private async writeToDisk(value: T): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await rename(temp, this.file)
    this.cache = value
  }

  async load(): Promise<T> {
    return this.serialize(async () => {
      if (this.cache === undefined) this.cache = await this.readFromDisk()
      return this.cache
    })
  }

  async save(value: T): Promise<void> {
    return this.serialize(async () => {
      await this.writeToDisk(value)
    })
  }

  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const current = this.cache ?? (await this.readFromDisk())
      const next = await mutator(current)
      await this.writeToDisk(next)
      return next
    })
  }

  /** Drop the in-memory cache so the next `load()` re-reads the file. */
  invalidate(): void {
    this.cache = undefined
  }

  /** Used by tests to remove state completely. */
  async remove(): Promise<void> {
    await rm(this.file, { force: true })
    await rm(`${this.file}.${process.pid}.tmp`, { force: true })
    this.cache = undefined
  }
}
