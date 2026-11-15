import path from 'node:path'
import os from 'node:os'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import type { GatewayConfig } from './types.js'

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

/** A Feishu Agent workspace must not be equal to, inside, or above the DSH
 * host's old workspace. That would load the parent's AGENTS.local.md. */
export function resolveFeishuWorkspace(
  config: Pick<GatewayConfig, 'workspace' | 'stateDir' | 'agentWorkspace'>,
): string {
  const shared = path.resolve(config.workspace)
  const fromState = path.resolve(config.stateDir, 'agent-workspace')
  const fallback = path.resolve(os.homedir(), '.dsh', 'feishu-channel-agent')
  const explicit = config.agentWorkspace?.trim()
  const candidate = explicit ? path.resolve(explicit)
    : (within(shared, fromState) || within(fromState, shared) ? fallback : fromState)

  if (explicit && !path.isAbsolute(explicit)) {
    throw new Error('Feishu agentWorkspace must be an absolute path')
  }
  if (within(shared, candidate) || within(candidate, shared)) {
    throw new Error('Feishu Agent workspace must be separate from the original DSH workspace')
  }
  return candidate
}

/** Prepare the private Feishu working root before any Session is created. */
export async function prepareFeishuWorkspace(
  config: Pick<GatewayConfig, 'workspace' | 'stateDir' | 'agentWorkspace'>,
): Promise<string> {
  const directory = resolveFeishuWorkspace(config)
  // Reject aliases BEFORE mkdir, so a malicious legacy symlink cannot cause
  // us to create even an empty directory inside the ordinary DSH workspace.
  const sharedReal = await realpath(path.resolve(config.workspace)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (sharedReal && (within(sharedReal, directory) || within(directory, sharedReal))) {
    throw new Error('Feishu Agent workspace aliases the original DSH workspace')
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const st = await lstat(directory)
  if (!st.isDirectory() || st.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error('Refusing symlinked Feishu Agent workspace')
  }
  return directory
}
