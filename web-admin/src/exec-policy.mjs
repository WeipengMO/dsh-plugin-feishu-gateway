/**
 * Execution-permission policy for the Feishu-channel profile.
 *
 * A running DSH profile cannot be mutated in place, so the admin dashboard
 * persists a small management overlay patch file under the channel state dir,
 * and the channel start script applies it with `dsh --patch <file>` on boot.
 * A JSON mirror is kept so the UI form round-trips losslessly.
 *
 * The pure helpers are exported for offline tests; fs helpers take explicit
 * paths and never read the process environment.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const EXEC_MODES = ['read-only', 'workspace-write', 'danger-full-access']
export const APPROVAL_POLICIES = ['ask', 'never']
export const EXEC_POLICY_JSON = 'exec-policy.json'
export const EXEC_OVERLAY_FILE = 'exec-policy.patch.yml'

function fail(status, message) { return Object.assign(new Error(message), { status }) }

export function defaultProfilePath(home) {
  return path.join(home, '.dsh', 'profiles', 'feishu-channel', 'cordis.patch.yml')
}

function yamlScalar(value) {
  const s = String(value)
  return /^[A-Za-z0-9_./:@-]+$/.test(s) ? s : "'" + s.replace(/'/g, "''") + "'"
}

/** Validate and normalize an inbound policy update; rejects unknown fields. */
export function normalizeExecPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'policy must be an object')
  for (const key of Object.keys(input)) {
    if (!['mode', 'approvalPolicy', 'additionalWritableRoots'].includes(key))
      throw fail(400, 'unsupported field: ' + key)
  }
  if (!EXEC_MODES.includes(input.mode)) throw fail(400, 'invalid mode')
  if (!APPROVAL_POLICIES.includes(input.approvalPolicy)) throw fail(400, 'invalid approvalPolicy')
  const raw = input.additionalWritableRoots === undefined ? [] : input.additionalWritableRoots
  if (!Array.isArray(raw)) throw fail(400, 'additionalWritableRoots must be an array')
  const seen = new Set()
  const roots = []
  for (const entry of raw) {
    if (typeof entry !== 'string') throw fail(400, 'additionalWritableRoots entries must be strings')
    const p = entry.trim()
    if (p === '') continue
    if (!path.isAbsolute(p) || p.includes('\0')) throw fail(400, 'writable root must be an absolute path')
    if (p.length > 512) throw fail(400, 'writable root path too long')
    if (!seen.has(p)) { seen.add(p); roots.push(p) }
  }
  return { mode: input.mode, approvalPolicy: input.approvalPolicy, additionalWritableRoots: roots }
}

/** Ensure every extra root exists as a real directory (never a symlink). */
export async function assertRootsUsable(roots) {
  for (const root of roots) {
    let st
    try { st = await fs.lstat(root) } catch { throw fail(400, 'writable root does not exist: ' + root) }
    if (st.isSymbolicLink() || !st.isDirectory()) throw fail(400, 'writable root must be a real directory: ' + root)
  }
}

/**
 * Render the management overlay patch applied via `dsh --patch`. It overrides
 * the profile's sandbox-policy (mode + extra roots), the approval policy, and
 * the permission preset default so newly created sessions adopt the same
 * sandbox mode + approval (new sessions are pinned from `defaultPreset`).
 */
export function renderOverlayYaml(policy, workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot))
    throw fail(409, 'workspaceRoot could not be resolved from the active DSH profile')
  const lines = [
    '# Managed by DSH Feishu Admin (执行权限). Applied via `--patch` after the profile layer.',
    '# Edit through 飞书管理 → 执行权限; do not hand-edit unless you also fix the admin copy.',
    '- id: sandbox-policy',
    "  name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    '    mode: ' + policy.mode,
    '    workspaceRoot: ' + yamlScalar(workspaceRoot),
  ]
  if (policy.additionalWritableRoots.length === 0) {
    lines.push('    additionalWritableRoots: []')
  } else {
    lines.push('    additionalWritableRoots:')
    for (const root of policy.additionalWritableRoots) lines.push('      - ' + yamlScalar(root))
  }
  lines.push(
    '- id: approval',
    "  name: '@deepseek-ai/dsh-user-approval'",
    '  config:',
    '    policy: ' + policy.approvalPolicy,
    '- id: permission',
    "  name: '@deepseek-ai/dsh-permission-presets'",
    '  config:',
    '    defaultPreset: managed',
    '    presets:',
    '      read-only: { sandbox: read-only, approval: ask }',
    '      workspace-write: { sandbox: workspace-write, approval: ask }',
    '      danger-full-access: { sandbox: danger-full-access, approval: never }',
    '      feishu-channel: { sandbox: workspace-write, approval: ask }',
    '      managed: { sandbox: ' + policy.mode + ', approval: ' + policy.approvalPolicy + ' }')
  return lines.join('\n') + '\n'
}

/**
 * Best-effort parse of the two relevant rows from a profile cordis.patch.yml
 * (only used to seed the form when no managed overlay exists yet).
 */
export function parseProfileExecPolicy(yamlText) {
  const result = { mode: undefined, approvalPolicy: undefined, additionalWritableRoots: [], workspaceRoot: undefined }
  let section = null
  let readingRoots = false
  for (const raw of String(yamlText || '').split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ')
    const idMatch = /^- id:\s*(\S+)\s*$/.exec(line)
    if (idMatch) {
      section = idMatch[1] === 'sandbox-policy' ? 'sandbox' : idMatch[1] === 'approval' ? 'approval' : null
      readingRoots = false
      continue
    }
    if (/^- /.test(line)) { section = null; readingRoots = false; continue }
    if (section === 'sandbox') {
      let m
      if ((m = /^\s+mode:\s*(\S+)/.exec(line))) { result.mode = m[1].replace(/^['"]|['"]$/g, ''); readingRoots = false; continue }
      if ((m = /^\s+workspaceRoot:\s*(\S+)/.exec(line))) { result.workspaceRoot = m[1].replace(/^['"]|['"]$/g, ''); readingRoots = false; continue }
      if (/^\s+additionalWritableRoots:/.test(line)) {
        readingRoots = true
        const inline = /^\s+additionalWritableRoots:\s*\[(.*)\]\s*$/.exec(line)
        if (inline) {
          for (const part of inline[1].split(',')) {
            const v = part.trim().replace(/^['"]|['"]$/g, '')
            if (v) result.additionalWritableRoots.push(v)
          }
          readingRoots = false
        }
        continue
      }
      if (readingRoots) {
        const rm = /^\s+-\s*(\S+)/.exec(line)
        if (rm) { result.additionalWritableRoots.push(rm[1].replace(/^['"]|['"]$/g, '')); continue }
        if (/^\s+\S/.test(line)) readingRoots = false
      }
    } else if (section === 'approval') {
      const m = /^\s+policy:\s*(\S+)/.exec(line)
      if (m) result.approvalPolicy = m[1].replace(/^['"]|['"]$/g, '')
    }
  }
  return result
}

function coerceExecPolicy(value) {
  const src = value && typeof value === 'object' ? value : {}
  const roots = Array.isArray(src.additionalWritableRoots)
    ? src.additionalWritableRoots.filter(x => typeof x === 'string' && path.isAbsolute(x)) : []
  return {
    mode: EXEC_MODES.includes(src.mode) ? src.mode : 'workspace-write',
    approvalPolicy: APPROVAL_POLICIES.includes(src.approvalPolicy) ? src.approvalPolicy : 'ask',
    additionalWritableRoots: roots,
  }
}

async function atomicWrite(filename, content, mode) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temp = filename + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
  try {
    const handle = await fs.open(temp, 'wx', mode)
    try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
    await fs.rename(temp, filename)
    await fs.chmod(filename, mode)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

/** Read the effective policy: managed JSON if present, else the profile rows. */
export async function readExecPolicy({ stateDir, profilePath, home }) {
  const jsonPath = path.join(stateDir, EXEC_POLICY_JSON)
  try {
    const doc = JSON.parse(await fs.readFile(jsonPath, 'utf8'))
    return { policy: coerceExecPolicy(doc), source: 'managed' }
  } catch (error) {
    if (error && error.code !== 'ENOENT') { /* corrupt mirror: fall back to profile */ }
  }
  const profile = profilePath || defaultProfilePath(home || '')
  let parsed = { additionalWritableRoots: [] }
  try { parsed = parseProfileExecPolicy(await fs.readFile(profile, 'utf8')) } catch { /* no profile file */ }
  return {
    policy: {
      mode: EXEC_MODES.includes(parsed.mode) ? parsed.mode : 'workspace-write',
      approvalPolicy: APPROVAL_POLICIES.includes(parsed.approvalPolicy) ? parsed.approvalPolicy : 'ask',
      additionalWritableRoots: Array.isArray(parsed.additionalWritableRoots) ? parsed.additionalWritableRoots : [],
    },
    source: 'profile',
    workspaceRoot: parsed.workspaceRoot,
  }
}

/** Persist the policy: JSON mirror for the form + overlay patch applied on boot. */
export async function writeExecPolicy({ stateDir, profilePath, home }, policy) {
  if (policy.mode === 'workspace-write') await assertRootsUsable(policy.additionalWritableRoots)
  let workspaceRoot
  const profile = profilePath || defaultProfilePath(home || '')
  try {
    const parsed = parseProfileExecPolicy(await fs.readFile(profile, 'utf8'))
    if (parsed.workspaceRoot) workspaceRoot = parsed.workspaceRoot
  } catch { /* validation below rejects unknown active workspace */ }
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot))
    throw fail(409, 'active DSH profile workspaceRoot not found; configure it before editing permissions')
  const jsonPath = path.join(stateDir, EXEC_POLICY_JSON)
  const overlayPath = path.join(stateDir, EXEC_OVERLAY_FILE)
  // Stage the policy mirror first; rollback on overlay write failure so the UI
  // does not report a policy that was never applied to the next process.
  let previous
  try { previous = await fs.readFile(jsonPath, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await atomicWrite(jsonPath, JSON.stringify(policy, null, 2) + '\n', 0o600)
  try {
    await atomicWrite(overlayPath, renderOverlayYaml(policy, workspaceRoot), 0o600)
  } catch (error) {
    try {
      if (previous === undefined) await fs.rm(jsonPath, { force: true })
      else await atomicWrite(jsonPath, previous, 0o600)
    } catch { throw fail(503, 'execution permission update failed and policy mirror needs manual recovery') }
    throw error
  }
  return { workspaceRoot }
}
