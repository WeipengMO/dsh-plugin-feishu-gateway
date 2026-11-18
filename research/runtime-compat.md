# DSH Runtime Compatibility Investigation — `dsh-plugin-feishu-gateway`

**Author:** teammate `runtime-compat` (read-only investigation)
**Date:** 2026-11-14
**Scope:** READ-ONLY. This report is the single write permitted (`research/runtime-compat.md`).
**Redaction policy:** All credential VALUES, API keys, tokens, App Secrets and any values from
`$DSH_HOME/.credentials.yaml` are deliberately omitted. Only env-var **NAMES**, structural
**ids**, **package names**, and **config keys** are reproduced. Scalar values are marked
`[REDACTED]`. The web profile and the running Web GUI (PID 943668) were NOT modified, copied,
or disturbed; `dsh plugin ...`, `dsh --dump-config` boot, pnpm/npm installs and git mutations
were NOT executed.

---

## 0. Environment facts (verified on disk)

| Item | Value | Source |
|------|-------|--------|
| DSH CLI version | `0.2.2-rc.1` | `/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json` (name `@deepseek-ai/dsh`) |
| `dsh-app-boot` version (source of `getDshRuntimeVersion()`) | `0.2.2-rc.1` | `.../dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json` |
| Bundled `cordis` version | `4.1.0` | `.../dsh/node_modules/@deepseek-ai/cordis/package.json` |
| Plugin `engines.dsh` | `">=0.2.2-rc.1 <0.3.0-0"` | repo `package.json:47` |
| Plugin `engines.node` | `">=24.9.0"` | repo `package.json:46` |
| Plugin `peerDependencies` | `@deepseek-ai/cordis ~4.1.0` | repo `package.json:49-51` |
| Node runtime | v24.22.2 (given) | task context |
| `DSH_HOME` | `/home/ubuntu/.dsh` | task context |

Note: the compatibility evaluator reads the runtime version from the **app-boot package's own
`package.json`**, not from the CLI's (both happen to be `0.2.2-rc.1` here).

---

## 1. How `dsh plugin --profile <name> add <pkg>` works; compatibility verdict; `MISSING_CREDENTIAL`

### 1.1 The `dsh plugin add` call chain

1. `dsh plugin ...` → `lib/plugin-DscIHF4k.js` → `runPlugin(profile, args, packageManager)`
   (`.../dsh/lib/plugin-DscIHF4k.js:64`). It only intercepts the DSH-owned sub-commands
   `allow-version` / `revoke-version` / `version-exemptions`; everything else (including
   `add`) is delegated to pnpm.
2. `runPluginCommand(context, args, options)`
   (`.../dsh-plugin-manager/lib/types/operations.js:616`) takes a file lock on
   `<profile>/package.json`, initializes the profile if missing, then calls
   `runProfilePnpm(...)` (`:315`).
3. `runProfilePnpm` performs a **preflight compatibility check** (`:367-390`): for each
   named install spec it reads the candidate manifest (`namedSpecManifest`, registry `pnpm view`
   or local tarball) and calls `evaluatePluginCompatibility(manifest, exemptions)`. If the
   result is `issue !== undefined && !issue.exempted`, the install is **rejected before pnpm
   runs** ("nothing was installed") and the offending `name@version` is reported so the user
   can run `dsh plugin --profile <p> allow-version ... --accept-risk`.
4. If preflight passes, pnpm runs (`execa`), then a **post-install check** (`:516-575`)
   re-validates every installed package's manifest (and any bundle component manifests) with
   `evaluatePluginCompatibility`; a newly-touched incompatible package triggers a
   restore + reinstall and a non-zero exit.
5. If all checks pass and `activateNewBundles !== false`, `reconcile(...)` activates bundles.

### 1.2 The compatibility evaluator

`.../dsh-app-boot/lib/index.js`:

- `getDshRuntimeVersion()` (`:1089-1093`) validates the app-boot `package.json` version with
  `semver.valid`.
- `satisfies(runtimeVersion, range)` (`:1094-1096`) is
  `range.trim() !== "" && semver.satisfies(runtimeVersion, range, { includePrerelease: true })`.
- `unmetRequirements(fields, runtimeVersion)` (`:1097-1117`):
  - **If `engines.dsh` is present, it decides ALONE and `peerDependencies` are ignored**
    (`:1099-1103` returns immediately).
  - Otherwise only peers named `@deepseek-ai/dsh` or starting with `@deepseek-ai/dsh-*` are
    checked; `@deepseek-ai/cordis` does **not** match that filter and is therefore skipped.
- `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)` (`:1129-1144`): returns
  `undefined` (compatible) when there are no unmet requirements; otherwise returns
  `{ name, version, runtimeVersion, requirements, exempted }`. Exemptions live in
  `<profile>/compatibility.json` (`PROFILE_COMPATIBILITY_FILENAME`, `:1159`, `:1190-1191`,
  `:1252-1258`).

### 1.3 Verdict: compatibility PASSES with no exemption

Range `">=0.2.2-rc.1 <0.3.0-0"` evaluated against runtime `0.2.2-rc.1` with
`{ includePrerelease: true }`:

- `>=0.2.2-rc.1` → satisfied (version equals the lower bound; the comparator itself carries a
  prerelease at tuple `[0,2,2]`, and `includePrerelease` additionally admits prereleases).
- `<0.3.0-0` → satisfied (`0.2.2` < `0.3.0` at the major/minor/patch level).

Both comparators pass ⇒ `semver.satisfies(...) === true` ⇒ `unmetRequirements` returns `{}` ⇒
`evaluatePluginCompatibility` returns `undefined` ⇒ **compatible, no
`allow-version` / `version-exemptions` / `compatibility.json` needed.**

Corroborating evidence (read-only):
- No `compatibility.json` exists in **either** profile (verified by `find` under
  `~/.dsh/profiles`), so **no exemption has ever been granted**.
- The test profile already contains `dsh-plugin-feishu-gateway` in `node_modules/` and lists it
  in `package.json` dependencies — i.e. a prior `dsh plugin add` of this exact plugin
  **succeeded** despite there being no exemption. (A preflight/compatibility rejection would
  have left "nothing was installed".)
- The plugin's `peerDependencies` (`@deepseek-ai/cordis ~4.1.0`) is irrelevant to the DSH
  compatibility gate (ignored when `engines.dsh` is present, and filtered out otherwise).

> Method note: the verdict is derived from the deterministic `semver.satisfies` semantics above
> plus the on-disk version strings. I did **not** execute `node`/`dsh` to compute it (the brief
> restricts commands to read-only `ls`/`stat`/`grep`/`read`). If the Lead wants an empirical
> one-command confirmation, that is the only outstanding verification step.

### 1.4 Boot-time activation gate (also NOT a blocker)

At profile boot, `reconcileProfilePlugins` (`.../dsh-app-boot/lib/index.js:3105-3124`) calls
`denial(row, base)` → `evaluatePluginCompatibility(manifest, exemptions)` for each Loader row;
**only a compatibility conflict disables a row**. Bundle loading
(`:1798-1819`) does the same per bundle and skips incompatible bundles. Our plugin's
`engines.dsh` passes, so it is **not** disabled/skipped at activation. Compatibility is
therefore **not** the L4 blocker.

### 1.5 Where `MISSING_CREDENTIAL` / LLM adapter errors come from

Two LLM adapter plugins throw a provider-neutral `LlmError` with code `MISSING_CREDENTIAL`:

- `.../dsh-llm-pi-ai/lib/index.js:2934-2940` — `resolveApiKey(provider, profile)`:
  reads `profile.apiKeyEnv` (an env-var **NAME**), resolves it via `ctx.get('credentials')`
  (the credentials service) or `launchEnvironmentOf(ctx)`. If unset it throws
  `LlmError("llm-pi-ai: no credential for provider route \"...\"; its profile resolves
  <ref> ...", "MISSING_CREDENTIAL")`.
- `.../dsh-llm-deepseek-api-key/lib/index.js:53-63` — `resolveApiKey(connection)`:
  `connection.apiKeyEnv` defaults to **`DEEPSEEK_API_KEY`** (`:12`); resolved via the
  credentials service or the launch environment (`:55-62`). If absent it throws
  `LlmError("llm-deepseek: no API key for provider route \"deepseek-official\"; store <ref>
  through the credentials service ... or export <ref> ...", "MISSING_CREDENTIAL")`.

The code is canonical in `.../dsh-llm/lib/index.js:150-158` (`INVALID_CREDENTIAL_CODE` is
distinct: malformed vs. absent). The actual key resolution happens per request inside
`registerDeepSeekProvider({ resolveAuth })` (`dsh-llm-deepseek-api-key:131`), i.e. when the
agent loop issues its first `ctx.llm.stream()` call.

**Documented, previously verified behaviour** (repo
`profiles/feishu-gateway-test/cordis.patch.yml:11-22`, marked "verified on dsh 0.2.2-rc.1"):
starting a headless task with this profile fails at boot with
`MISSING_CREDENTIAL: llm-deepseek: no API key ...`, **before plugins mount**, because
`dsh-base`'s default model route needs an LLM adapter the profile does not configure.

---

## 2. What `@deepseek-ai/dsh-base` provides; are the `ctx` APIs real?

### 2.1 `dsh-base` is a CONFIG bundle, not a JS runtime API

`.../dsh-base/lib/types/index.d.ts:1-8` states explicitly: *"the package's substance is
`cordis.patch.yml` ... this module carries no runtime API"* (`export {}`).
`.../dsh-base/package.json` declares `dsh.bundle.patch: "./cordis.patch.yml"` and depends on
the full set of `@deepseek-ai/dsh-*` service plugins (all at `0.2.2-rc.1`). The services are
mounted by the **Cordis Loader rows** in that 535-line patch, not by the JS module.

Relevant base rows (ids → plugin names), all present by default:
`llm` → `@deepseek-ai/dsh-llm`; `session` → `@deepseek-ai/dsh-session`;
`agent` → `@deepseek-ai/dsh-agent`; `agent-loop` → `@deepseek-ai/dsh-agent-loop`;
`agent-default-model` → `@deepseek-ai/dsh-agent-default-model`;
`llm-pi-ai` → `@deepseek-ai/dsh-llm-pi-ai` (**:128-136 — "mounted dormant: zero routes"**);
`llm-deepseek` → `@deepseek-ai/dsh-llm-deepseek-api-key` (**:531-532 — "No key or endpoint is
inlined ... key comes from the credential store"**); `llm-deepseek-account`;
`credentials` → `@deepseek-ai/dsh-credentials-local`; `deepseek-llm-api-extensions`;
`llm-retry`; `session-persistence-jsonl` (`root: dshHomePath('sessions')`).
`agent-default-model` default config: `provider: deepseek-official`, `model: deepseek-flash`
(**:90-94**). `agent-loop` default `agents: []` (**:517-520**). Base patch references env-var
name **`DEEPSEEK_API_KEY`** for `web-search-deepseek` / `web-deepseek-api` (**:476, :481**).

### 2.2 The four `ctx` services are REAL in this runtime

| Service | Declared in | Type |
|---------|-------------|------|
| `ctx.agents` | `.../dsh-agent/lib/types/index.d.ts:19-23` | `AgentRegistry` |
| `ctx.agentLoop` | `.../dsh-agent-loop/lib/types/index.d.ts:13-15` | `AgentLoop` |
| `ctx.sessions` | `.../dsh-session/lib/types/index.d.ts:26-29` | `SessionStore extends Service` |
| `ctx.llm` | `.../dsh-llm/lib/types/index.d.ts:28-31` | `LlmRuntime` |

All four are Cordis `Context` interface augmentations (`declare module '@deepseek-ai/cordis'`).
The plugin's own `src/index.ts:18` and its bundle patch `cordis.patch.yml:13` declare
`inject: [agents, agentLoop, sessions, llm]` — i.e. the plugin requires exactly these services.

### 2.3 Specifically requested APIs — all REAL

- **`ctx.agents.create()`** — YES. `AgentRegistry.create(options: CreateAgentOptions):
  Promise<AgentHandle>` (`dsh-agent/.../index.d.ts:292`), plus `resume(...)` (`:300`),
  `get(id)` (`:357`), `register(...)` (`:320`). "Create and publish a new agent through the
  registered factory ... constructs the agent and its session" (`:284-292`).
  `dsh-subagent/.../child-agent.d.ts:48,63` also documents `ctx.agents.create()`.
- **`ctx.sessions.create()`** — YES. `SessionStore.create(id?, options?): Session`
  (`dsh-session/.../index.d.ts:422`), "already entered and announced"; the `Session` class is
  described as "create live instances via `ctx.sessions.create()`" (`:135`).
- **`session/event`** — YES, a real Cordis event. Declared in
  `dsh-session/.../index.d.ts:53-63` (`'session/event'(session, event)`), alongside
  `session/created`, `session/disposed`, `session/flush`. "Post-commit, fire-and-forget append
  feed".
- **`agent/assistant-stream`** — YES, a real Cordis event. Declared in
  `dsh-agent/.../runtime-types.d.ts:392-404` (`'agent/assistant-stream'(payload: { agent,
  frame })`), "Process-local assistant-stream publication" (start/chunk/end frames). Related
  real agent events: `agent/created`, `agent/status`, `agent/request`, `agent/request-error`,
  `agent/turn-stopping`, `agent/error`. `dsh-llm` export `assistant-stream.ts` and
  `dsh-agent-loop/lib/types/assistant-stream.d.ts` also exist.
- **`llm/stream`** — YES, `dsh-llm/.../index.d.ts:45` (waterfall event around every streaming
  model call).

### 2.4 How the plugin uses them (confirms they are the intended native path)

`src/session/dsh-session-bridge.ts:40-53` documents "Official path A":
`ctx.agents.create / resume`, `agent.followup(...)`, `ctx.on('session/event')`,
`ctx.on('agent/assistant-stream')`, `AgentHandle.dispose()`. It resolves the registry through
`ctx.get('agents')` as a structural port (`:66-69`), calls `agents.create({ sessionId, meta,
agentOptions })` (`:108-112`), and if the service is missing it reports
`"DSH service 'agents' is not mounted in this profile; native Sessions are disabled"`
(`:87-91`). So the API surface is real and the plugin is built to use it.

### 2.5 `dsh-headless`

`.../dsh-headless/lib/types/startup.d.ts` — the one-shot app parses a task positional, session
identity, permission/output options, and provides `headlessStartup`. Source confirms a bare
boot errors with **"a task is required"** (`dsh-headless/lib/startup.js:82,84`,
`lib/index.js:321`). The CLI exposes `dsh headless "<task>"` (`bin.js:44`). Booting a headless
profile therefore requires a task argument.

---

## 3. Web profile — working LLM route structure (REDACTED, ids + env-var NAMES only)

**DO NOT MODIFY.** Backs the running Web GUI at `http://100.96.140.49:3080/`
(process `dsh web --no-open`, PID 943668). I read only `cordis.patch.yml`, `package.json`,
`cordis.yml`.

- `cordis.yml`: `[]` (empty root; tree is composed from bundle + patch layers).
- `package.json` `dsh.profile.bundles` (package NAMES only):
  `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`,
  `@deepseek-ai/dsh-experimental-agent-team-profile`,
  `@deepseek-ai/dsh-experimental-plugin-market-bundle`,
  `@deepseek-ai/dsh-experimental-auto-review`,
  `@deepseek-ai/dsh-experimental-session-titles-bundle`,
  `@michengai/dsh-archive-manager`. (Also has a `dependencies` entry for
  `@michengai/dsh-archive-manager`.)
- `cordis.patch.yml` — a top-level YAML array of **id-targeted** config overrides. Row ids:
  1. `ui-settings-general` → `@deepseek-ai/dsh-client-ui-settings-general` (config key
     `welcomeNoticeVersion`: `[REDACTED]`).
  2. **`llm-pi-ai`** → `@deepseek-ai/dsh-llm-pi-ai`. Config: `providers` map with one
     provider id **`magpie`** whose keys include `apiKeyEnv` → env-var **NAME
     `MAGPIE_API_KEY`**, `api` → `openai-completions`, `baseURL` → `[REDACTED]` (an internal
     HTTP endpoint value, not reproduced), and `models` with ids `group/deepseek` and
     `group/hy4-free` (names/context/maxTokens values `[REDACTED]`).
  3. **`agent-default-model`** → `@deepseek-ai/dsh-agent-default-model`. Config keys
     `provider` → `magpie`, `model` → `group/hy4-free`.

**Env-var NAMES referenced (VALUES never printed):** `MAGPIE_API_KEY` (web patch, via
`apiKeyEnv`). The base bundle additionally uses `DEEPSEEK_API_KEY`. The prompt's third id
`llm-deepseek` is a **base-bundle row** (`name @deepseek-ai/dsh-llm-deepseek-api-key`), not
present in the web `cordis.patch.yml`.

How a working route is composed: base provides the dormant `llm-pi-ai` adapter row; the user
patch supplies a `llm-pi-ai:` `providers` profile (`apiKeyEnv` + `baseURL` + models) and points
`agent-default-model` at that provider/model. The credential value is **not** in this file —
it is resolved by `ctx.get('credentials')` from the managed `$DSH_HOME/.credentials.yaml`
(206 bytes, mode 600; **contents NOT read**) or from the launch environment at request time.

---

## 4. Test profile — current structure (REDACTED) and exact backup list

Existing profile: `/home/ubuntu/.dsh/profiles/feishu-gateway-test/` (created by an earlier
run). Its config MUST be backed up before any mutation.

- `cordis.yml`: `[]` (empty root, comments only).
- `package.json`: `name: dsh-profile-feishu-gateway-test`, `private: true`;
  `dependencies` → `dsh-plugin-feishu-gateway: file:<repo>/dist/dsh-plugin-feishu-gateway-0.1.0.tgz`;
  `dsh.profile.bundles` → `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-headless`,
  `dsh-plugin-feishu-gateway`.
- `cordis.patch.yml` (28 lines): ONE id-targeted override, id **`feishu-gateway`**.
  Config keys (values `[REDACTED]` except env-var NAMES and the noted offline flag):
  `bots` (list: `id: default`, `enabled`, `domain: feishu`,
  `appIdEnv` → env-var NAME `FEISHU_GATEWAY_DEFAULT_APP_ID`,
  `appSecretEnv` → env-var NAME `FEISHU_GATEWAY_DEFAULT_APP_SECRET`),
  `allowlist`, `allowGroups`, `workspace`, `stateDir`, `dedupTtlMs`, `maxTextLength`,
  `replyTimeoutMs`, `sendRetries`, `autoConnect`, **`offline: true`**, `diagnoseOnStart`.
  Header comment: "SAFE/DEFAULT OFFLINE configuration: no Feishu credentials are needed and no
  network socket is opened" and "NEVER put app secrets in this file".
  **No `llm-pi-ai`, `llm-deepseek`, or `agent-default-model` row. No LLM credential env-var
  name. No version exemption.**
- `pnpm-workspace.yaml`: keys `packages: ['.']`, `allowBuilds: { esbuild: true, protobufjs: true }`.
- `node_modules/`: top-level symlink `dsh-plugin-feishu-gateway`; `.pnpm/` store present
  (includes `@deepseek-ai+cordis@4.1.0`). The `dsh-base` / `dsh-headless` **bundles themselves
  are NOT listed as profile npm dependencies here** — bundles resolve from the CLI install
  anchor (`resolveBundleDir`), which is why a real boot reaches the LLM-route startup check.
- `.plugin-manager/logs/`: two `operation-*/pnpm.log` files, both **0 bytes** (no diagnostics).
- `compatibility.json`: **absent** (no exemption granted).

### 4.1 Exact files/dirs to back up before the Lead mutates this profile

All of the following live under `/home/ubuntu/.dsh/profiles/feishu-gateway-test/`:

1. `cordis.patch.yml`  ← **primary file that would be edited** (add LLM route rows)
2. `cordis.yml`
3. `package.json`      ← `dsh plugin add/remove` rewrites this + lockfile
4. `pnpm-lock.yaml`
5. `pnpm-workspace.yaml`
6. `.plugin-manager/`  (dir; operation logs)
7. `node_modules/`     (dir; installed tree; regenerable but back up if a clean restore matters)
8. `compatibility.json` — does **not** currently exist; created only by `allow-version`.
   (Since compatibility passes, this file is NOT expected and need not be created.)

Repo-side template (read-only reference, also worth preserving):
`profiles/feishu-gateway-test/{cordis.patch.yml, cordis.yml, package.json, pnpm-workspace.yaml}`.

---

## 5. What Agent / Session / LLM services are actually available RIGHT NOW

- **No dedicated test runtime is running.** The only active DSH process is the Web GUI
  (web profile, PID 943668), which is out of scope and must not be touched. There is no
  headless/`feishu-gateway-test` runtime process I can attach to.
- **Service CODE/APIs exist** (§2): a real `dsh-base` boot would provide `ctx.agents`,
  `ctx.agentLoop`, `ctx.sessions`, `ctx.llm`. But **no such runtime is currently booted** for
  the test profile, so no service instance is live for it.
- `~/.dsh/sessions/` — directories (names only; these are Web-GUI workspace session stores):
  `--home-ubuntu-dsh-workspace--`,
  `--home-ubuntu-dsh-workspace-projects--`,
  `--home-ubuntu-dsh-workspace-projects-dsh-plugin-feishu--`,
  `--home-ubuntu-dsh-workspace-projects-dsh-plugin-feishu-gateway--`.
- `~/.dsh/storages/` — `workspace.json`; `session_projcache/sessions/` with several
  `*.json` session-projection files (names/UUIDs only). These belong to the Web GUI.
- **LLM API key env vars: ABSENT (names only, no values).** A scan of env-var **NAMES**
  containing key/token/secret/credential/api returned **none**. Explicit PRESENT/ABSENT check:

  | Env-var NAME | Presence |
  |--------------|----------|
  | `DEEPSEEK_API_KEY` | ABSENT |
  | `MAGPIE_API_KEY` | ABSENT |
  | `FEISHU_GATEWAY_DEFAULT_APP_ID` | ABSENT |
  | `FEISHU_GATEWAY_DEFAULT_APP_SECRET` | ABSENT |
  | `OPENAI_API_KEY` | ABSENT |
  | `ANTHROPIC_API_KEY` | ABSENT |

  The managed `$DSH_HOME/.credentials.yaml` exists (206 bytes, mode 600) and backs the web
  profile's LLM route; **its contents were NOT read** and its values are out of bounds.

### 5.1 Can a dedicated test LLM route be configured safely WITHOUT reusing production credentials?

**Structurally yes, but NOT with the credentials currently provisioned.** Reasoning:

- An LLM route needs a credential **value**. Adapters resolve `apiKeyEnv` (an env-var NAME)
  via `ctx.get('credentials')` (`$DSH_HOME/.credentials.yaml`, global to `DSH_HOME`, shared
  across profiles) or the launch environment.
- The only working LLM credential in this environment is the **production** one backing the
  running Web GUI (referenced as `MAGPIE_API_KEY` / `DEEPSEEK_API_KEY`). Adding a `llm-pi-ai`
  row to the test profile that reuses those names would resolve the **same** production
  credential — i.e. reusing production credentials, which the brief asks to avoid.
- **No independent, non-production LLM key exists** in the ambient environment (all names
  ABSENT) and no separate test value is provisioned. I am forbidden from reading/copying the
  production value.
- Therefore a *safe* dedicated test route (distinct `apiKeyEnv` name + distinct test-only key
  value, or a mock/local unauthenticated endpoint) is **conditionally feasible** only if a
  **separate test credential/endpoint is provisioned first**. Whether a credential-free local
  mock endpoint is available is **UNKNOWN** (the web patch's `baseURL` value is redacted and
  not assumed).

---

## 6. `~/.dsh/feishu-gateway-test-state/` contents

- Single file: `dedup.json` (16 bytes, mode 600).
- Structure (keys/shape only, values not sensitive but omitted for consistency):
  `{ "seen": {} }` — a top-level `seen` object (currently empty), the plugin's dedup state.
  No other files/dirs.

---

## 7. Conclusion — is L4 "real DSH runtime activation with native Session" feasible here?

### Verdict: **BLOCKED as currently provisioned** (conditionally feasible only after
### provisioning a non-production LLM credential). Compatibility is NOT the blocker.

**What is NOT blocking:**
- `engines.dsh ">=0.2.2-rc.1 <0.3.0-0"` **passes** on `0.2.2-rc.1` with
  `{ includePrerelease: true }` — no `allow-version` / version exemption needed (§1.3).
- `dsh plugin add` preflight/post-install/boot gates all pass; the plugin is already installed
  with no `compatibility.json` (§1.1, §1.4).
- The native APIs are real: `ctx.agents.create()`, `ctx.sessions.create()`, `session/event`,
  `agent/assistant-stream`, `llm/stream` all exist (§2). The plugin is built to use them.
- `dsh-base` + `dsh-headless` bundles resolve and mount those services in a real boot.

**Precise blocking reason (L4):**
1. Booting the real DSH runtime with the `feishu-gateway-test` (headless) profile **fails at
   startup with `MISSING_CREDENTIAL`** before plugins mount. Cause: `dsh-base`'s default model
   route (`agent-default-model`: `deepseek-official`/`deepseek-flash` → `llm-deepseek` →
   `@deepseek-ai/dsh-llm-deepseek-api-key`, whose `apiKeyEnv` defaults to `DEEPSEEK_API_KEY`)
   has **no LLM adapter route and no credential configured** in the test profile's
   `cordis.patch.yml`; `llm-pi-ai` is dormant (zero routes). The `resolveApiKey` throw is in
   `dsh-llm-deepseek-api-key/lib/index.js:63` / `dsh-llm-pi-ai/lib/index.js:2940`. This is
   documented as verified on `0.2.2-rc.1` in the repo template
   (`profiles/feishu-gateway-test/cordis.patch.yml:11-22`). Because the failure happens before
   the `feishu-gateway` plugin mounts, `ctx.agents` / native `Session` creation never become
   usable in a booted runtime — so L4 end-to-end activation cannot be demonstrated.
2. `DEEPSEEK_API_KEY` and `MAGPIE_API_KEY` are **ABSENT** from the environment, and there is
   **no independent (non-production) LLM credential** available (§5). The only working key is
   the production one in `$DSH_HOME/.credentials.yaml` (must not be reused/modified/read).
   Hence the minimal fix cannot be applied "safely without reusing production credentials"
   with what exists today.
3. Secondary: `dsh headless` requires a task argument (bare boot → "a task is required").

### Minimal configuration steps (files / ids / env-var NAMES only — NO secrets)

1. **Back up** all test-profile files listed in §4.1 first.
2. Edit **only** `/home/ubuntu/.dsh/profiles/feishu-gateway-test/cordis.patch.yml` to add, by
   **id**, two rows structurally copied from the web profile `cordis.patch.yml` (read-only
   reference):
   - `llm-pi-ai` → `@deepseek-ai/dsh-llm-pi-ai` with a `providers` profile and
     `apiKeyEnv: <TEST_KEY_NAME>` (a **distinct** env-var NAME), `api`, `baseURL`, `models`;
     **OR** configure the `llm-deepseek` row with a `llm-deepseek:` settings section and set
     `DEEPSEEK_API_KEY`.
   - `agent-default-model` → `@deepseek-ai/dsh-agent-default-model` with `provider` + `model`
     pointing at the chosen route.
3. Provide the key **value** through a **distinct, test-only** env var / credentials-store entry
   (NOT the production `MAGPIE_API_KEY` / `DEEPSEEK_API_KEY` value). This requires
   provisioning a separate non-production credential or mock endpoint first — currently
   UNKNOWN/unavailable.
4. Boot with a task positional: `dsh --profile feishu-gateway-test "<task>"` (equivalently
   `dsh headless "<task>"`). Keep `offline: true` in `feishu-gateway` config so no Feishu
   socket/credentials are needed.
5. **Do NOT** touch the web profile, `.credentials.yaml`, the running Web GUI / `dsh-web`, or
   DSH Core. Do **not** grant any version exemption (none is needed).

### Important caveat about proof of activation

`dsh --dump-config` (and `--dump-default-config` / `--dump-config-schema`) **compose config
layers only** — `lib/dump-config-D97dwXdd.js:6-12` states it runs "without booting or
evaluating `!!js`", and `bin.js:86` describes it as "print the composed profile tree and
exit". It therefore **does NOT prove plugin activation** or that `ctx.agents` / native Sessions
work. Real L4 activation requires an actual `dsh --profile ... "<task>"` boot that gets past
the `MISSING_CREDENTIAL` startup check.

---

## 8. UNKNOWNs (not guessed)

- The exact **value** of `MAGPIE_API_KEY` / `DEEPSEEK_API_KEY` and the contents of
  `$DSH_HOME/.credentials.yaml` — deliberately NOT read; out of scope.
- Whether the web patch's `baseURL` points at a credential-free/mock endpoint that a test
  profile could reuse without any key — the value was redacted; not assumed.
- Whether a distinct test-only LLM key/endpoint can be provisioned in this environment —
  not observed; requires an explicit provisioning step by the Lead.
- The precise internal throw-path ordering that makes `MISSING_CREDENTIAL` surface "before
  plugins mount" at boot — the empirical failure is documented as verified in the repo
  template; I confirmed the source-level origin (adapter `resolveApiKey`) but did not boot a
  runtime to re-trace it (booting is forbidden).
- Whether the running Web GUI injects `MAGPIE_API_KEY` into its own process environment (vs.
  resolving it purely from `.credentials.yaml`) — I only inspected my own shell env; the web
  process was not inspected (out of scope).

---

## 9. Key file references (read-only)

- `.../dsh/lib/plugin-DscIHF4k.js:64` — `runPlugin` CLI entry
- `.../dsh-plugin-manager/lib/types/operations.js:315-609,616-627` — `runProfilePnpm` /
  `runPluginCommand`
- `.../dsh-app-boot/lib/index.js:1089-1144` — `satisfies`, `unmetRequirements`,
  `evaluatePluginCompatibility`; `:1159,1190,1252` exemptions; `:1798-1819` bundle load;
  `:3105-3124` boot activation gate
- `.../dsh-llm-pi-ai/lib/index.js:2934-2940` — `MISSING_CREDENTIAL`
- `.../dsh-llm-deepseek-api-key/lib/index.js:12,53-63,131` — default `DEEPSEEK_API_KEY`,
  `MISSING_CREDENTIAL`
- `.../dsh-llm/lib/index.js:150-158` — credential error codes
- `.../dsh-base/lib/types/index.d.ts:1-8`, `.../dsh-base/cordis.patch.yml` — config bundle
- `.../dsh-agent/lib/types/index.d.ts:19-23,292,300,357` — `ctx.agents` / `create()`
- `.../dsh-agent-loop/lib/types/index.d.ts:13-15` — `ctx.agentLoop`
- `.../dsh-session/lib/types/index.d.ts:26-29,43-71,386-422` — `ctx.sessions`, `session/event`,
  `create()`
- `.../dsh-agent/lib/types/runtime-types.d.ts:392-404` — `agent/assistant-stream`
- `.../dsh-llm/lib/types/index.d.ts:28-46` — `ctx.llm`, `llm/stream`
- `.../dsh-headless/lib/startup.js:82,84`, `lib/index.js:321` — task required
- `.../dsh/lib/dump-config-D97dwXdd.js:6-12` — dump-config is boot-free
- Repo `src/index.ts:18`, `cordis.patch.yml:10-24`, `src/session/dsh-session-bridge.ts:40-112` —
  plugin `inject` and native-API usage
- Repo `profiles/feishu-gateway-test/cordis.patch.yml:11-22` — documented startup caveats

---

## 10. POST-SCRIPT by Lead — L4 verdict updated after the mock-route probe

This report's §7 verdict ("L4 BLOCKED as provisioned") remains correct **for the default,
production-credential-only environment**: a bare `dsh --profile feishu-gateway-test "<task>"`
still exits 1 with `MISSING_CREDENTIAL`, and the only working LLM credential is the production
`MAGPIE_API_KEY` / `DEEPSEEK_API_KEY` value, which must not be reused.

However, the Lead subsequently demonstrated that a **safe independent model route CAN be
configured** using **Mock credentials only**, in a fully isolated temporary `DSH_HOME`
(a copy of the test Profile + `llm-pi-ai`/`agent-default-model` rows pointing at a local
OpenAI-compatible SSE Mock LLM with a placeholder `FEISHU_GATEWAY_TEST_LLM_KEY`). With that
route, `dsh --profile feishu-gateway-test "<task>"` **booted successfully (exit 0)**, the plugin
`apply()` ran (proved by `stateDir/dedup.json` being written), and native Session infrastructure
was live. A test-only probe plugin then drove real inbound messages through the real
`DshSessionBridge` (details in `research/TEST-REPORT.md` §五), which uncovered and led to fixes
for two real defects (missing default `agentOptions.provider/model`, and reuse of a detached
Session handle). **No production credential was read, copied, or used; the `web` Profile and
DSH Core were untouched.**

So: L4 real runtime activation is **ACHIEVED with a Mock-only route**, while activation without
provisioning a non-production credential remains **BLOCKED**. `--dump-config` still does not
prove activation by itself.
