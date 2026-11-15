#!/usr/bin/env node
/**
 * Create an ISOLATED DSH_HOME + test profile for the real-LLM / real-Feishu E2E.
 *
 * Nothing here touches `$HOME/.dsh` (the real DSH home), the `web` profile,
 * `dsh-web.service`, DSH Core or any production credential.
 *
 *   node scripts/e2e/setup.mjs --home /tmp/x --host daemon --llm real --feishu live
 *
 * Prints a JSON descriptor on stdout (safe: no credential values).
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPatch, bundlesFor } from './lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')

export function parseArgs(argv) {
  const args = { home: '', host: 'oneshot', llm: 'mock', feishu: 'offline', port: 18080, daemonPort: 18091, stateDir: '', workspace: '', allowlist: [], tgz: '', skipInstall: false, replyTimeoutMs: 30000 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--home') args.home = argv[++i]
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--llm') args.llm = argv[++i]
    else if (a === '--feishu') args.feishu = argv[++i]
    else if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--daemon-port') args.daemonPort = Number(argv[++i])
    else if (a === '--state-dir') args.stateDir = argv[++i]
    else if (a === '--workspace') args.workspace = argv[++i]
    else if (a === '--allowlist') args.allowlist = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--tgz') args.tgz = argv[++i]
    else if (a === '--skip-install') args.skipInstall = true
    else if (a === '--reply-timeout-ms') args.replyTimeoutMs = Number(argv[++i])
  }
  return args
}

/** Locate the built plugin tarball. */
export async function findTarball(explicit) {
  if (explicit) return explicit
  const dist = path.join(REPO, 'dist')
  const files = (await readdir(dist).catch(() => [])).filter((f) => f.endsWith('.tgz')).sort()
  if (files.length === 0) throw new Error('no .tgz in dist/ — run `pnpm run build && pnpm run pack` first')
  return path.join(dist, files[files.length - 1])
}

/**
 * Resolve the CLI's own @deepseek-ai/dsh-llm so the plugin's optional
 * `createUserMessage` import works inside the profile.
 */
async function findDshLlm() {
  const candidates = [
    '/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm',
    path.join(path.dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm'),
  ]
  for (const c of candidates) {
    try {
      await readdir(c)
      return c
    } catch { /* keep looking */ }
  }
  return undefined
}

export async function setupProfile(opts) {
  const home = opts.home
  if (!home) throw new Error('--home is required')
  const profileDir = path.join(home, 'profiles', 'feishu-gateway-test')
  const stateDir = opts.stateDir || path.join(home, 'state')
  const workspace = opts.workspace || path.join(home, 'workspace')

  await mkdir(profileDir, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await mkdir(workspace, { recursive: true })

  // 1. Base template (bundles/deps are rewritten below).
  await cp(path.join(REPO, 'profiles/feishu-gateway-test'), profileDir, { recursive: true })

  // 2. Bundles for the chosen host mode.
  const pkgPath = path.join(profileDir, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = bundlesFor(opts.host)
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  // 3. Generated patch layer (env-var NAMES only, never values).
  const patch = buildPatch({
    llmMode: opts.llm,
    feishuMode: opts.feishu,
    hostMode: opts.host,
    mockLlmPort: opts.port,
    daemonPort: opts.daemonPort,
    stateDir,
    workspace,
    allowlist: opts.allowlist,
    baseURL: process.env.FEISHU_GATEWAY_TEST_LLM_BASE_URL || '',
    modelId: process.env.FEISHU_GATEWAY_TEST_LLM_MODEL || 'test-model',
    probeEnabled: opts.host !== 'daemon',
    replyTimeoutMs: opts.replyTimeoutMs,
  })
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), patch, 'utf8')

  // 4. Test-only plugin sources.
  await cp(path.join(REPO, 'scripts/real-runtime/native-session-probe.mjs'), path.join(profileDir, 'native-session-probe.mjs'))
  await cp(path.join(REPO, 'scripts/e2e/e2e-daemon.mjs'), path.join(profileDir, 'e2e-daemon.mjs'))

  // 5. Install the built plugin into the profile (official command).
  const tgz = await findTarball(opts.tgz)
  if (!opts.skipInstall) {
    execFileSync('dsh', ['plugin', '--profile', 'feishu-gateway-test', 'add', `file:${tgz}`], {
      env: { ...process.env, DSH_HOME: home },
      stdio: 'pipe',
    })
  }

  // 6. Make @deepseek-ai/dsh-llm resolvable from the profile.
  const llm = await findDshLlm()
  if (llm) {
    const target = path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-llm')
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(llm, target).catch(() => undefined)
  }

  return { home, profileDir, stateDir, probeStateDir: `${stateDir}-probe`, workspace, tgz, hostMode: opts.host, llmMode: opts.llm, feishuMode: opts.feishu }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2))
  const info = await setupProfile(opts)
  console.log(JSON.stringify({ ok: true, ...info }, null, 2))
}
