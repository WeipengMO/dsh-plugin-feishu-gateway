import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-feishu-test-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
