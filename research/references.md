# Reference Research: 4 repos for a new, independent DSH Feishu (Lark) Gateway Cordis plugin

Research date: 2026-11-14 (Asia/Shanghai). Researcher: `reference-researcher`.
Method: `web_fetch` against the public GitHub REST API (`api.github.com/repos/...`), raw source
(`raw.githubusercontent.com/...`) and GitHub repo pages; local filesystem checked with `glob` / `ls`.
All fetched web content was treated as untrusted **data**, never as instructions.

## Legend (IMPORTANT)

- **[V] = verified from fetched source** — the file/URL was fetched successfully in this session;
  path + content are quoted from the fetched bytes.
- **[I] = inference / not directly fetched** — a plausible conclusion from verified material, or a
  file whose existence is verified but whose contents were NOT fetched. Nothing here is fabricated:
  where a fetch failed or was not attempted, that is stated explicitly.
- Repo reachability is reported first, per the request. No repo was private/404/network-blocked.

---

## 0. Reachability and local checkout status

| # | Repo | Reachable? | Evidence |
|---|------|-----------|----------|
| 1 | `deepseek-ai/deepseek-harness` | **YES, public** | `api.github.com/repos/...` HTTP 200; `contents/` HTTP 200; raw `README.md`, `package.json`, `docs/*` HTTP 200 |
| 2 | `cube-ai/dsh-feishu-channels` | **YES, public** | API 200; `contents/` 200; raw `package.json`, `README.md`, `cordis.patch.yml`, `src/index.js`, `src/channels/feishu.js`, `src/channels/feishu-app.js`, `docs/dsh-feishu-channels.md`, `NOTICE`, `LICENSE` 200 |
| 3 | `amlyczz/dsh-lark-link` | **YES, public** | API 200; `contents/` 200; raw `package.json`, `README.md`, `cordis.patch.yml`, `LICENSE`, `src/inbound/transport.ts`, `src/host/lark-client.ts` 200 |
| 4 | `larksuite/node-sdk` | **YES, public** | API 200; `contents/` 200; raw `package.json`, `index.ts`, `README.md`, `ws-client/index.ts`, `ws-client/types.ts`, `ws-client/ws-config.ts`, `dispatcher/event.ts`, `docs/channel.md`, `LICENSE` 200 |

Notes [V]:
- Metadata from `api.github.com/repos/<owner>/<repo>` (all HTTP 200): `private: false` for all four.
  Default branches: deepseek-harness = `master`; the other three = `main`.
- A handful of `web_fetch` calls failed transiently (`TypeError: fetch failed`, or 30 s timeout) and
  were **retried successfully**; every URL quoted below eventually returned HTTP 200 except where a
  file is explicitly marked "not fetched". No repo returned 404.
- **Local clones: NONE of the 4 repos are cloned under `/home/ubuntu/dsh-workspace/`.** [V]
  `ls -la /home/ubuntu/dsh-workspace/` shows only `AGENTS.md` plus `assistant/`, `automation/`,
  `outputs/`, `projects/`, `scratch/`, `scripts/`. `projects/` contains only
  `dsh-plugin-feishu-gateway/` — the only `.git` checkout found under the workspace. The workspace
  `AGENTS.md` is a VPS operating-rules file (Feishu assistant, automation, etc.), not a DSH source
  checkout. The DSH *runtime* checkout at `/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/`
  is a separate value (agent implementation checkout), not one of the 4 repos.

---

## 1. `deepseek-ai/deepseek-harness` — official DSH monorepo

### Purpose [V]
"DeepSeek Harness: Everything is a Plugin." An open-source agent harness built on **Cordis**
(`https://github.com/cordiverse/cordis`), in *developer preview* with explicit
"THERE WILL BE COMPATIBILITY-BREAKING CHANGES" warning (README.md). Published as
`@deepseek-ai/dsh` (`npx @deepseek-ai/dsh web`); Web UI at `http://127.0.0.1:3080`.

### Language / build tooling [V] — root `package.json`
- Name `@deepseek-ai/dsh-root`, version **`0.2.2-rc.3`**, `private: true`, `type: module`, MIT.
- `packageManager: pnpm@11.28.5`; `engines.node: ">=24.9.0"`.
- Workspaces: `vendor/*`, `packages/*/*`, `native/system`, `native/system/packages/*`, `apps/*`, `website`.
- Build: TypeScript project references + `tsdown` (0.22.2), `tsx`, `vite` 8.2.2, `vitest` 4.1.11,
  `oxlint` 1.81.0, `typescript ^6.0.3`, `jscpd`, `lefthook`. Key scripts: `build`,
  `build:artifacts`, `build:check`, `typecheck`, `dev:web`, `start:web`, `dsh`
  (`node --import tsx/esm apps/cli/src/bin.ts`).
- `devDependencies` are almost entirely `workspace:*` `@deepseek-ai/*` packages plus toolchain
  (`zod 4.6.6`, `js-yaml ^4.3.2`, `smol-toml ^1.9.0`, `fflate ^0.8.2`, `tar ^7.5.22`,
  `semver ^7.8.5`, `publint ^0.3.24`, `execa ^10.0.1`, `mermaid 11.17.2`, `jsdom 29.1.1`).
  Notable: scripts `verify-cordis-config`, `gen-cordis-catalog`, `verify-plugin-entry-exports`,
  `verify-plugin-packages`, `gen-plugin-packages`, `verify-plugin-record-callers`,
  `verify-package-dependencies`, `verify-npm-install-layout` — i.e. plugin entrypoints are gated.
- `docs/development.md` [V]: Node 24.9+, TypeScript type stripping enabled (`--no-experimental-strip-types`
  in NODE_OPTIONS breaks builds), Corepack pnpm, strict symlinked pnpm linker (undeclared deps fail),
  allowlisted dependency build scripts in `pnpm-workspace.yaml`, isolated Host/Client tsconfig
  aggregates (Host/Client declaration-merge `cordis.Context` under the same keys; one program seeing
  both collides). Client plugin produces both a Node loader and a browser bundle in the Client phase.

### Directory layout [V] (`contents/` of root, `docs`, `packages`)
Root: `apps/`, `docs/`, `native/`, `packages/`, `python/`, `scripts/`, `snapshots/`, `vendor/`,
`website/`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.*.json`, `tsdown.config.ts`,
`vitest*.ts`, `Makefile`, `AGENTS.md`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`.
`packages/` has ~55 subsystem dirs (`acp, api, attachment, boot, bundle, client, compaction,
context, core, credentials, fs, goal, guard, host, identity, interaction, jobs, llm, mcp, plan,
preset, sandbox, schedule, sdk, session, settings, shell, skill, ssh, storage, subagent, team,
telemetry, terminal, todo, util, web, workflow, workspace, experimental, ...`).
`docs/` (compact `git/trees/...?recursive=1` + `contents/docs`): `architecture.md`,
`api-gateway.md`, `capability-seams.md`, `config-catalog.md`, `tool-catalog.md`,
`agent-lifecycle.md`, `testing.md`, `cordis-primer.md`, `cordis-tutorial/`, `cordis-api/`,
`cookbook/`, `subsystems/`, `user/`, `upgrade-guide/`, `persistence-changes/`, `postmortem/`.

### Plugin development docs (verified paths / contents) [V]
| Path | What it says |
|---|---|
| `docs/cordis-primer.md` | Cordis in 5 ideas: plugin is function with optional `inject` + `apply(ctx)` or a `Service` subclass; context is a repository of services (`ctx.tools`, `ctx.llm`, `ctx.sessions`); declare deps via `inject`; typed events (`emit/waterfall/parallel/serial/bail`); registrations are reversible effects via `ctx.effect()`/`ctx.on()`. Loader config: `@deepseek-ai/cordis-plugin-include` parses `!!js` into expression nodes; entry `config` is interpolated against its plugin context (`ctx.serviceName`), `disabled` at every mount decision. "Every registration should have a disposer." |
| `docs/cordis-tutorial/01-first-plugin.md` | Minimal plugin: `export const name = 'hello'; export function apply(ctx: Context) { console.log('hello from my first plugin') }`. Composition file `cordis.yml`: `- name: './hello.ts'` where `name` is a module specifier (relative path or npm package name); entries start concurrently, ordering comes from `inject`, not list position. Three plugin shapes: function, object with `apply`, `Service` subclass. Links to `packages/bundle/base/cordis.patch.yml` as "a longer plugin composition that deployment overlays patch". |
| `docs/cordis-tutorial/` | `01-first-plugin.md`, `02-lifecycle-and-effects.md`, `03-services.md`, `04-events.md` (+ `.zh.md`, `.i18n.yaml`); path list verified in git tree, contents of 02–04 not fetched. |
| `docs/cordis-api/` | `context.md`, `events.md`, `fiber.md`, `registry.md`, `service.md`, `inherited.md` (+ i18n/zh); path list verified, contents not fetched. |
| `docs/cookbook/` | `extension-cookbook.md`, `adding-a-package.md`, `adding-a-plugin-preview.md`, `adding-a-remote-api.md`, `adding-a-settings-card.md`, `adding-a-tool.md`, `adding-an-llm-adapter.md`, `adding-a-vendored-package.md`, `adding-a-session-format-version.md`, `maintaining-dsh-code-review.md`, `reviewing-*`. Path list verified. |
| `docs/cookbook/adding-a-plugin-preview.md` [V content] | Describes bundle *detail documents* (`docs/DETAIL.md` + optional `docs/preview.svg`), declared via `meta.detail` in `adding-a-package.md#plugin-display-metadata`; fixed 640×300 SVG; `detailImageMaxBytes` 5 MiB default. Evidence that `meta.*` fields in package metadata drive the Plugins page. |
| `docs/development.md` [V content] | Contributor setup/build guide (see tooling above), profile runs (`--profile headless`/`web`), `dev:web` rebuilds client bundles on source edits, `start:web` serves built artifacts. |
| `docs/user/guide/plugin-market.md` [V path only] | Exists (11,029 bytes) with `.zh.md` and `.i18n.yaml`; **content not fetched** (one fetch timed out, not retried). |
| `docs/user/develop/basic/` [V path list] | `index.md` (3,937), `config.md` (3,162), `publish.md` (11,228), `tool.md` (1,815) + zh/i18n. **Contents not fetched.** These are the most likely "plugin manifest / SDK / profile config" authoring docs. |
| `docs/user/guide/python-sdk.md` [V path only] | Exists; content not fetched. `packages/sdk/` contains `client/`, `protocol/`, `server/` + READMEs — the DSH SDK packages; contents not fetched. |
| `docs/config-catalog.md` [V path only] | 258,880 bytes generated config catalog; content not fetched. |
| `docs/architecture.md`, `docs/api-gateway.md`, `docs/capability-seams.md` [V path only] | Exist; contents not fetched. |

### Plugin manifest & profile config shape [V from community plugins + docs]
There is **no separate manifest file** in either community plugin. The manifest is the `dsh` field
in `package.json` plus a `cordis.patch.yml` bundle patch:
- `dsh.bundle.patch: "./cordis.patch.yml"` — inserts plugin rows into a profile's Cordis composition.
- `dsh.client.platform: "web"`, `dsh.client.inject: [...]` — client-side module injection.
- `cordis.patch.yml` uses `- insert: - id: <id>\n    name: '<npm name>'` (and optional `config:` with
  `!!js` expressions, e.g. `process.env.X ?? 'default'`). [V from both plugins]
- `docs/cordis-primer.md` confirms `!!js` expression nodes and profile overlays. `cordis.yml` is a
  list of `- name: <module specifier>` entries. `dsh plugin --profile web add <spec>` is the install
  command (verified in both community READMEs).
- README.md also says: add the `dsh-plugin` GitHub topic for discoverability; docs site
  `https://deepseek-harness.github.io/deepseek-harness/`.

### Existing channel / webhook plugin examples in the monorepo [V path list]
`packages/experimental/webhook/` and `packages/experimental/webhook-github/` each contain
`package.json`, `README.md`/`README.zh.md`/`README.i18n.yaml`, `locale/`, `src/`, `tests/`,
`tsconfig.json` (and `examples/` for webhook-github). Also `packages/experimental/plugin-market-bundle/`,
`badge-skill-bundle/`, `voice-input-bundle/`, `terminal-bundle/`, `ralph-bundle/`, etc. — all
`*-bundle` packages are the in-repo examples of the `dsh.bundle` format. **Their source contents
were not fetched** (only `contents/` listings). `packages/experimental/webhook` is the closest
official "channel/webhook plugin example".

### DSH connection [I unless noted]
Not applicable: the DSH monorepo is the host. [V] Community plugins connect via Cordis `apply(ctx,
config)`, `inject`, `ctx.effect()`, `ctx.logger()`, `ctx.credentials`, `ctx.webServer`/`connection`,
`ctx.agents`, `ctx.llm` etc. (verified in `cube-ai/src/index.js` and `dsh-lark-link` README).

### Feishu WS / events / reply [V]
**None in the official monorepo.** No `@larksuiteoapi/node-sdk` dependency appears in the root
`package.json` (verified full file). The Feishu bridge is entirely community-side.

### Config/schema [V]
Root `package.json` has no plugin config schema of its own; per-plugin `Config` is a
`Schema.object(...)` from `@deepseek-ai/schemastery` (verified in `cube-ai/src/index.js`). DSH docs
`docs/user/develop/basic/config.md` and `docs/config-catalog.md` are the authoritative config docs
[V path, contents not fetched].

### LICENSE [V]
**MIT** (API `license.spdx_id: "MIT"`; `README.md` "## License [MIT](LICENSE)"; root
`package.json` `"license": "MIT"`). `THIRD_PARTY_NOTICES.md` discloses dependency licenses.

---

## 2. `cube-ai/dsh-feishu-channels` — DSH 飞书频道

### Purpose [V]
`@cubeai/dsh-feishu-channels` v0.2.6 — "把飞书机器人应用接入本机 DeepSeek Harness" / connect a
Feishu bot app to a local DSH. Multi-channel (each channel = one self-built Feishu bot app with its
own model/workspace/permissions/Agent preset), QR-code app creation, text/Markdown-card replies,
images, files, group @, approval/question cards, reaction status, deferred delivery, slash commands,
and a "飞书频道" sidebar tab. Homepage mirrors at `https://openi.pcl.ac.cn/dsh/dsh-feishu-channels`.

### Language / build tooling [V]
- `language: JavaScript` (API), `"type": "module"`, **`main: src/index.js`, no build step**
  (plain ESM source shipped directly; `client.js` is a 248,344-byte prebuilt client bundle).
- `engines.node: "^22.19.0 || >=24.0.0"`.
- `pnpm-lock.yaml` + `pnpm-workspace.yaml`; scripts only `"check": "node scripts/check.js"` and
  `"test": "node --test tests/*.test.mjs"`. No TypeScript, no bundler config.

### package.json deps & versions [V]
```json
"dependencies": {
  "@deepseek-ai/schemastery": "^3.18.2",
  "@larksuiteoapi/node-sdk": "^1.36.0",
  "qrcode": "^1.5.4"
},
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.2",
  "@deepseek-ai/dsh-agent": "^0.2.1-rc.2",
  "@deepseek-ai/dsh-client-locale": "^0.2.1-rc.2",
  "@deepseek-ai/dsh-client-ui-primitives": "^0.2.1-rc.2",
  "@deepseek-ai/dsh-client-ui-slots": "^0.2.1-rc.2",
  "@deepseek-ai/dsh-host-webserver": "^0.2.1-rc.2",
  "@deepseek-ai/schemastery": "^3.18.2"
}
```
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "inject":
["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-slots",
"@deepseek-ai/dsh-client-ui-primitives"] } }`, `"exports"` includes `./client`, `./cordis.patch.yml`,
`./locale/*.json`, `./icon`, `./package.json`.

### Directory layout [V]
Root: `.gitignore`, `LICENSE`, `NOTICE`, `README.md`, `client.js`, `cordis.patch.yml`, `docs/`,
`icon.svg`, `locale/`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `scripts/`, `src/`,
`tests/`.
`src/`: `index.js` (2,756), `manager.js` (64,541), `channels/` and `engine/`.
`src/channels/`: `connection-state.js`, `diagnostics.js`, `factory.js`, `feishu-app.js` (9,781),
`feishu.js` (21,435), `media.js`, `meta.js`, `qr/`.
`src/engine/` (34 files): `gateway.js` (71,270), `router.js` (32,687), `chat-commands.js` (58,319),
`command-messages.js` (43,393), `deferred-delivery.js`, `file-delivery.js`, `message-progress.js`,
`reply-stream.js`, `approval.js`, `question.js`, `choices.js`, `session-*`, `split.js`, `seen-store.js`,
`credentials.js`, `file-log.js`, `json-state.js`, `atomic-file.js`, `quiet-logger.js`, etc.
`docs/dsh-feishu-channels.md` is a 13-section technical-implementation doc (fully fetched [V]).

### Key public APIs actually used [V]
- DSH/Cordis: `export const name`, `export const inject`, `export const Config = Schema.object(...)`,
  `export function apply(ctx, config)`, `ctx.effect(fn, 'feishu-channel.serve')`, `ctx.logger(name)`,
  `ctx.permissionPresets`, `ctx.credentials`, `ctx.webServer`/`connection`, `ctx.agents`,
  `ctx.agentPresets`, `ctx.agentDefaultModel`, `ctx.llm`; optional `ctx.get(...)` for
  `connection`, `sessionPersistence`, `workspaceRegistry`, `userQuestions` (degrades gracefully).
- `@larksuiteoapi/node-sdk`: dynamically imported `const sdk = await import('@larksuiteoapi/node-sdk')`;
  `sdk.Client`, `sdk.WSClient`, `sdk.EventDispatcher`, `sdk.LoggerLevel`, `sdk.defaultHttpInstance`.
  Methods used: `client.request({url:'/open-apis/bot/v3/info', method:'GET'})`,
  `client.im.message.create`, `client.im.message.patch`, `client.im.messageReaction.create/delete`,
  `client.im.messageResource.get(...).getReadableStream()`, `client.im.file.create`,
  `client.application.v7.applicationBase.patch`, `client.application.v7.applicationConfig.patch`,
  `client.application.v6.application.patch/get`.
- Web API base `/api/dsh-feishu-channels`: `GET /channels`, `GET|POST /assistant`,
  `POST /sessions/{rename,remove,cleanup-missing,ensure}`, QR endpoints
  `/channels/feishu/qr/{status,start,refresh,cancel}`, `/channels/feishu/connect` (App ID/Secret),
  `/accounts/:id/{settings,secret,provision,receive,reconnect,check,remove,approve,deny}`.
  Mutations require header `x-dsh-feishu-channels-client: 1` + `content-type: application/json`,
  body ≤ 1 MB; host `connection.requestRejection(req)` does auth; responses `{ ok, ... }`.

### How it connects to DSH [V]
`cordis.patch.yml`:
```yaml
- insert:
    - id: feishu-channel
      name: '@cubeai/dsh-feishu-channels'
```
`src/index.js` (exact excerpt, [V]):
```js
import Schema from '@deepseek-ai/schemastery';
export const name = 'dsh-feishu-channels';
export const inject = ['webServer','credentials','agents','agentPresets','agentDefaultModel','llm','permissionPresets'];
export const Config = Schema.object({
    stateDir: Schema.string().default(''),
    cwd: Schema.string().default(process.cwd()),
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
    agentPreset: Schema.string().default('standard'),
    mergeTimeoutSecs: Schema.number().default(5),
});
export function apply(ctx, config) {
    // stateDir = config.stateDir || $DSH_HOME/dsh-feishu-channels (or ~/.dsh/dsh-feishu-channels)
    // rotating gateway.log; new ChannelManager({ctx, stateDir, log, engineConfig})
    const manager = new ChannelManager({ ctx, stateDir, log, engineConfig });
    ctx.effect(() => {
        manager.registerApi(ctx);
        void manager.initEnabled().then(() => manager.attachMappedSessions()).catch(...);
        return () => { manager.disposeApi(); void fileLog.flush(); };
    }, 'feishu-channel.serve');
}
```
Install [V README]: `dsh plugin --profile web add @cubeai/dsh-feishu-channels` (or the openi git URL).

### Feishu WebSocket + events + message send/receive [V] — `src/channels/feishu.js`
Exact excerpts from `createFeishuChannel(id, config, log, loadSdk)`:
```js
sdk = await (loadSdk ? loadSdk() : import('@larksuiteoapi/node-sdk'));
const logger = quietSdkLogger(...);                       // suppresses sensitive SDK logs
const loggerLevel = sdk.LoggerLevel?.error ?? 1;
const httpInstance = Object.create(sdk.defaultHttpInstance);
httpInstance.request = (opts) => sdk.defaultHttpInstance.request({ ...opts, timeout: 30_000, maxRedirects: 0 });
client = new sdk.Client({ appId, appSecret, logger, loggerLevel, httpInstance });
const identity = await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' });
const botOpenId = identity.bot?.open_id?.trim() ?? '';

const dispatcher = new sdk.EventDispatcher({}).register({
    'card.action.trigger': async (data) => { /* token/chatId → handler */ return {}; },
    'im.message.receive_v1': async (data) => {
        const message = data.message;
        if (!message) return;
        const group = message.chat_type === 'group';
        const addressed = !group || isFeishuBotMentioned(message.mentions, botOpenId);
        if (!addressed || !message.chat_id || !current()) return;
        return incoming.run(message.chat_id, async () => {
            const resolved = await resolveFeishuContent(client, message, timeoutSignal(30_000, generation.signal));
            await handler?.({ chatId, userId: data.sender?.sender_id?.open_id,
                text: resolved.text, ...(resolved.media.length ? { media: resolved.media } : {}),
                messageId: message.message_id, kind: group ? 'group' : 'dm', addressed });
        });
    },
});
const wsClient = new sdk.WSClient({ appId, appSecret, logger, loggerLevel });
ws = wsClient;
await wsClient.start({ eventDispatcher: dispatcher });
statusText = '长连接已建立';
// stop(): lifecycle?.abort(); ws?.close({ force: true });
```
Sending (exact, [V]):
```js
const card = await sender.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'interactive',
        content: JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true },
            body: { elements: [{ tag: 'markdown', content: part }] } }) },
});
// fallback to msg_type:'text', content: JSON.stringify({text: part})
```
Notes [V]: replies here are **new messages via `im.message.create`**, not `im.message.reply`;
Markdown tables require card schema 2.0 and ≤5 tables per card; throttle codes `230020, 11232,
99991400`; media via `im.messageResource.get({path:{message_id,file_key}, params:{type}})`;
status reactions via `im.messageReaction.create` (`DONE`/`ERROR`/`OnIt`).
Message flow [V docs §6]: WS event → FeishuChannelAdapter → ImEngine (dedup `seen.json`,
private-access / group-@ gate, slash command or plain message, SessionMerger/SessionRouter → DSH
Agent → streaming reply / approval / question / file) → adapter sends → record delivery.

### Config / schema shape [V]
- Host Config (`Schema.object` above): `stateDir`, `cwd`, `provider`, `model`, `agentPreset`,
  `mergeTimeoutSecs`. Defaults from `docs/dsh-feishu-channels.md` §2.
- `channels.json` **version 2**: `{ version: 2, channels: { <id>: { id, platform:'feishu', name,
  nameOrdinal, enabled, receiveEnabled, config: { appId, appSecretRef, ownerOpenId },
  assistant: { provider, model }, agentPreset, cwd, permission, commandPermissions,
  privateAccess:'approved', sendMode:'queue', lastCheckedAt } }, allowlist, pending, assistant, cwd,
  permission }`. Channel id = `feishu_` + first 12 of SHA-256(`platform + "\0" + App ID`).
- Credentials: `ctx.credentials` refs `dfc_<channelId>_<field>` (e.g.
  `dfc_feishu_ab12cd34ef56_appSecret`); only `appSecretRef`/`hasAppSecret` in state; fallback
  `secrets.json` mode 0600. State dir `$DSH_HOME/dsh-feishu-channels` with `channels.json`,
  `sessions.json`, `seen.json`, `deferred-delivery.json`, `gateway.log`, `secrets.json`.
- Session id `dfc:<channelId>:<dm|group>:<13+digit ms>:<chatId>`.
- QR provisioning (`src/channels/feishu-app.js`) [V]: `FEISHU_APP_SCOPES = { tenant:
  ['im:message','application:application:patch'], user: ['im:message.send_as_user'] }`,
  `decorateQrUrl()` sets `from=sdk`, `tp=sdk`, `source=dsh-feishu-channels`, `createOnly=true`,
  `addons=<gzip+base64url JSON>`; `provisionFeishuApp()` best-effort writes name/scopes/redirect
  URLs (v7 then v6 fallback). Redirect URLs are hardcoded localhost/3080, 32123, 8731 and a
  cubeai.com deployment callback.

### LICENSE [V]
**Apache-2.0** (API `spdx_id: Apache-2.0`; full Apache 2.0 text in `LICENSE`).
`NOTICE` [V, important]: "This product includes software derived from `dsh-im-connect`
(https://github.com/MichengAI/dsh-im-connect), Copyright MichengAI, licensed under the Apache
License, Version 2.0." Modifications: only Feishu channel retained, identifiers/state
dirs/credential refs/routes/session prefixes renamed for independent coexistence, self-update and
proxy/topic support removed.

---

## 3. `amlyczz/dsh-lark-link` — high-reliability DSH ↔ Feishu/Lark bridge

### Purpose [V]
`dsh-lark-link` v0.6.2 — "High-reliability Feishu/Lark bridge for DeepSeek Harness": QR one-click
auth, multi-mode agents, card-based commands, zero-loss Outbox + Inbound WAL, media in/out, session
log doctor, reusable DSH Web GUI. Community plugin, explicitly "not affiliated with DeepSeek,
Feishu or Lark".

### Language / build tooling [V]
- `language: TypeScript` (API), `"type": "module"`, `main: ./dist/index.js`,
  `types: ./dist/index.d.ts`, `exports` also `./client`, `./cordis.patch.yml`, `./icon`.
- Build: **`tsdown` ^0.22.14**, `typescript ^5.9.2`, `tsc --noEmit` (`check`),
  `node --experimental-strip-types --test "test/**/*.test.ts"`, `prepack: npm run build`.
  `tsdown.config.ts`, `tsconfig.json`, `package-lock.json` (npm, not pnpm).
- `engines.node: ">=24.0.0"`. README says 264 unit + integration tests, GitHub Actions CI.
- `src/index.ts` is 103,982 bytes (single large host entry; **not fetched**).

### package.json deps & versions [V]
```json
"dependencies": {
  "@larksuiteoapi/node-sdk": "^1.73.0",
  "axios": "^1.19.0",
  "fflate": "^0.8.3",
  "qrcode": "^1.5.4",
  "qrcode-terminal": "^0.12.0"
},
"peerDependencies": {  // all "*" and optional via peerDependenciesMeta
  "@deepseek-ai/cordis": "*", "@deepseek-ai/dsh-agent": "*", "@deepseek-ai/dsh-commands": "*",
  "@deepseek-ai/dsh-credentials": "*", "@deepseek-ai/dsh-llm": "*", "@deepseek-ai/dsh-session": "*",
  "@deepseek-ai/dsh-storage-domain": "*", "@deepseek-ai/dsh-system-prompt": "*",
  "@deepseek-ai/dsh-tools": "*", "react": "^18.0.0"
},
"devDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh-agent": "0.1.2-rc.1", "@deepseek-ai/dsh-commands": "0.1.2-rc.1",
  "@deepseek-ai/dsh-credentials": "0.1.2-rc.1", "@deepseek-ai/dsh-llm": "0.1.2-rc.1",
  "@deepseek-ai/dsh-session": "0.1.2-rc.1", "@deepseek-ai/dsh-storage-domain": "0.1.2-rc.1",
  "@deepseek-ai/dsh-system-prompt": "0.1.2-rc.1", "@deepseek-ai/dsh-tools": "0.1.2-rc.1",
  "@types/node": "^24.3.0", "@types/qrcode": "^1.5.5", "@types/qrcode-terminal": "^0.12.2",
  "tsdown": "^0.22.14", "typescript": "^5.9.2"
}
```
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": ["slots"],
"platform": "web" } }`. Install [V README]:
`dsh plugin --profile web add dsh-lark-link@latest --ignore-scripts` (docs warn protobufjs
postinstall is blocked by pnpm 11 policy, hence `--ignore-scripts`), then `/lark setup`, `/lark start`.

### Directory layout [V]
Root: `.github/`, `.spec/`, `assets/`, `CHANGELOG.md` (41,627), `ISSUE-awesome-dsh-plugins*.md`,
`LICENSE`, `README.md` (22,153), `cordis.patch.yml`, `icon.svg`, `package.json`,
`package-lock.json`, `scripts/`, `src/`, `test/`, `tsconfig.json`, `tsdown.config.ts`.
`src/`: `index.ts`, `application/`, `client/`, `common/`, `host/`, `inbound/`, `outbound/`,
`presentation/`, `sessions/`.
- `src/host/`: `auth-setup.ts`, `gateway-lock.ts`, `lark-client.ts` (15,066), `lifecycle.ts`.
- `src/inbound/`: `transport.ts` (13,141), `connection-supervisor.ts`, `group-trigger.ts`,
  `inbound-wal.ts`, `missed-compensation.ts`, `replay-runner.ts`, `replay-salvage.ts`.
Architecture [V README]: `host` (SDK adapter/auth) → `inbound` (transport/group policy/compensation/
Inbound WAL) → `application` (command routing/orchestration/diagnostics) → `outbound` (Outbox/event
forwarding/cards) → `sessions` (per-chat agent management).

### Key public APIs actually used [V]
- `@larksuiteoapi/node-sdk` **structural slice** declared in `src/host/lark-client.ts`:
  `Client`, `WSClient`, `EventDispatcher`, `AppType.SelfBuild`, `Domain.{Feishu,Lark}`,
  `LoggerLevel.error`, `defaultHttpInstance`.
  `SdkClient` interface declares `im.message.{create,reply,list}`, `im.messageReaction.create`,
  `im.file.{create,get}`, `im.image.{create,get}`, `request()`.
  **Caveat:** `im.message.reply` appears ONLY as a TypeScript interface member — no verified call
  site in the fetched sources. The actually-used send path is `sdkClient.im.message.create({...})`.
- Other verified calls: `sdkClient.request({url:'/open-apis/bot/v3/info',method:'GET'})`,
  `im.message.list({params:{... page_size:50}})`, `im.messageReaction.create({path:{message_id},
  data:{reaction_type:{emoji_type}}})`, `im.file.create({data:{file_type,file_name,file}})`,
  `im.image.create({data:{image_type:'message',image}})`, `im.messageResource.get({path:{message_id,
  file_key},params:{type}}).getReadableStream()`, and raw CardKit v1 REST calls
  `/open-apis/cardkit/v1/cards` (POST/PUT/PATCH) with `msg_type:'interactive'` +
  `content: JSON.stringify({type:'card',data:{card_id}})`.
- `registerApp` (SDK QR OAuth device flow) is used for `/lark setup` [V README + node-sdk README].

### How it connects to DSH [V]
`cordis.patch.yml` (exact, [V]) — note `!!js` expressions and env-var interpolation:
```yaml
- insert:
    - id: lark-link
      name: 'dsh-lark-link'
      config:
        enabled: !!js "process.env.DSH_LARK_LINK_ENABLED ?? 'true'"
        appId: !!js "process.env.DSH_LARK_LINK_APP_ID ?? ''"
        # groupPolicy: open | mention | keywords | reply
        groupPolicy: !!js "process.env.DSH_LARK_LINK_GROUP_POLICY ?? 'mention'"
        denyList: []
        # replay:
        #   auto: true
        #   retentionMinutes: 30
        #   maxAttempts: 2
```
Credentials [V `src/host/lark-client.ts`]: stored ONLY in `ctx.credentials` as a single JSON blob
under ref `config.credentialRef` (default `LARK_LINK_APP`), ref must match
`/^[A-Za-z_][A-Za-z0-9_]*$/`; blob shape `{ appId, appSecret, domain: "feishu"|"lark",
userInfo?: { open_id, tenant_brand } }`. `CredentialsStore.resolve/set/unset` seam.
Commands [V README]: `/lark setup|start|stop|restart|status`, `/lark replay`,
`/lark uninstall-clean`; Feishu side `/mode /permission /model /goal /status /sessions /help /new
/resume /stop /workspace /doctor /lark-config`.

### WS connection + events + send/receive [V] — `src/host/lark-client.ts` + `src/inbound/transport.ts`
Exact excerpt (`buildLarkClient`):
```ts
const sdk = await (opts.sdkLoader ?? defaultSdkLoader)();  // import('@larksuiteoapi/node-sdk')
const domain = opts.domain === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu;
// SDK's shared axios instance follows http_proxy/https_proxy and breaks https under Node>=18:
const dh = sdk.defaultHttpInstance as { defaults?: { proxy?: boolean } } | undefined;
if (dh?.defaults) dh.defaults.proxy = false;
const clientOpts = { appId: opts.appId, appSecret: opts.appSecret,
    appType: sdk.AppType.SelfBuild, domain, loggerLevel: sdk.LoggerLevel.error };
const sdkClient = new sdk.Client(clientOpts);
const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel.error });
const wsClient = new sdk.WSClient(clientOpts);
const client: FeishuClientLike = {
  on(event, handler) { dispatcher.register({ [event]: handler }); },
  ws: {
    start() { try { wsClient.start({ eventDispatcher: dispatcher }); } catch (err) { /* log */ } },
    stop()  { void Promise.resolve(wsClient.stop?.()).catch(() => undefined); },
  },
  async sendMessage(params) {
    const p = params as { receive_id_type: string; params: Record<string, unknown> };
    return sdkClient.im.message.create({ params: { receive_id_type: p.receive_id_type },
                                        data: p.params });
  },
  ...
};
```
`src/inbound/transport.ts` [V]: `EVENT_MESSAGE = "im.message.receive_v1"`,
`EVENT_CARD_ACTION = "card.action.trigger"`; `createTransport()` registers handlers via `c.on(...)`,
calls `c.getBotInfo?.()` and `await c.ws?.start?.()`; `autoReconnect` is OFF at SDK config level —
`connection-supervisor.ts` drives reconnects. `normalizeInbound()` handles the v2.0 nested
`{header, event, message:{message_id,chat_id,chat_type,content,mentions,...}, sender}` envelope
(the file comments: nesting was the "ultimate root cause" of dropped message ids), plus a flat
fallback; `chat_type: "p2p"|"group"`; group policies `open|mention|keywords|reply`;
`chatModeFor()` maps to `p2p|group_at|group_all`; media gets placeholder text `[图片]`/`[文件]`.

### Config / schema shape [V]
`cordis.patch.yml` config keys: `enabled`, `appId`, `groupPolicy`, `denyList`, `replay.{auto,
retentionMinutes,maxAttempts}` (+ env `DSH_LARK_LINK_*`, `DSH_LARK_APP_ID/SECRET`,
`DSH_LARK_AUTO_REPLAY=0`). README `/lark-config` keys: `groupPolicy` (default `open`),
`groupKeywords` `["lark","bot"]`, `agentPreset` (`ptc` default; standard/ptc/minimal/cordis),
`permissionMode` (`danger-full-access`), `streaming.enabled` (false), `reactions.enabled` (true),
`allowlist` ([]), `denyList` ([]), `workspaceRoot` (""), `attachments.retentionHours` (168),
`attachments.dir` (""). Credentials never in config files. **The actual `Schema.object(...)` in
`src/index.ts` was not fetched** (104 KB) — schema shape above is from the patch + README.

### LICENSE [V]
**MIT** — `LICENSE`: "Copyright (c) 2026 dsh-lark-link contributors" (full MIT text fetched).

---

## 4. `larksuite/node-sdk` (`@larksuiteoapi/node-sdk`) — Feishu/Lark Open SDK for Node

### Purpose [V]
"larksuite open sdk for nodejs". Semantic API client (`client.<domain>.<resource>.<method>`),
event dispatcher with HTTP/webhook adapters, card action handler, WebSocket long-connection client,
and (newer) a high-level `Channel` module. Version **`1.76.0`** (verified in `package.json` on
`main`; also independently verified locally by the lead).

### Language / build tooling [V]
TypeScript (`language: TypeScript`). `rollup` ^2.75.5 + `@rollup/plugin-typescript` ^8.3.2 +
`rollup-plugin-dts` ^4.2.2 + `rollup-plugin-license` ^2.8.1 (`rollup.config.js`); `typescript
^4.7.3`, `jest ^28.1.1` + `ts-jest`, `eslint ^8.17.0`, `prettier 2.6.2`, `yarn.lock` (yarn).
`build: "rm -r lib es types & rollup -c"`. Ships `lib/` (CJS, `main`), `es/` (ESM, `module`),
`types/`. `scripts.test: jest`.

### package.json deps & versions [V]
```json
"dependencies": {
  "axios": "^1.16.0", "lodash.identity": "^3.0.0", "lodash.merge": "^4.6.2",
  "lodash.pickby": "^4.6.0", "protobufjs": "^7.2.6", "qs": "^6.14.2", "ws": "^8.19.0"
}
```
(devDeps: express ^4.18.2, koa ^2.13.4, @koa/router ^12.0.0, body-parser ^1.20.1, koa-body ^5.0.0,
@types/*, etc. — only for adapter tests/examples.)

### Directory layout [V]
`index.ts` (root barrel), `adaptor/` (default/express/koa/koa-router + services/challenge),
`channel/`, `client/` (`client.ts`, `request-with`, `access-token`, `client-assertion`),
`code-gen/`, `consts/`, `dispatcher/` (`event.ts`, `card.ts`, `request-handle.ts`,
`verification-token.ts`, `webhook-credentials.ts`, `webhook-request.ts`, `__tests__/`),
`docs/` (`channel.md`, `channel.zh.md`, `assets/`, `vercel-chat-adapter/`), `http/`, `logger/`,
`scene/` (`aily/`, `registration/`), `typings/`, `utils/`, `ws-client/` (`index.ts` 28,453,
`types.ts`, `ws-config.ts`, `connection-config.ts`, `data-cache.ts`, `enum.ts`, `proto-buf/`,
`__tests__/`), `README.md` (40,143), `README.zh.md` (43,508), `rollup.config.js`, `tsconfig.json`,
`jest.config.ts`, `yarn.lock`, `LICENSE`.

### Public API surface [V] — `index.ts` barrel (exact export list)
```ts
export * from './client/client';           // lark.Client
export * from './client/request-with';     // withTenantKey / withTenantToken / withAll ...
export * from './dispatcher/event';        // EventDispatcher
export * from './dispatcher/card';         // CardActionHandler
export * from './adaptor/default';        // adaptDefault
export * from './adaptor/express';        // adaptExpress
export * from './adaptor/koa';            // adaptKoa
export * from './adaptor/koa-router';     // adaptKoaRouter
export { generateChallenge } from './adaptor/services/challenge';
export { AppType, Domain, LoggerLevel, Cache } from './typings';
export { WSClient } from './ws-client';
export { Aily } from './scene/aily/client';
export { registerApp } from './scene/registration';   // QR one-click app creation
export * from './channel';                 // createLarkChannel
export { default as defaultHttpInstance } from './http';
export * as messageCard from './utils/message-card'; // messageCard.defaultCard({title,content})
export { AESCipher } from './utils/aes-cipher';
export { DefaultCache, internalCache } from './utils/default-cache';
export type { WSConfigOverrides, WSConnectionState, WSConnectionStatus } from './ws-client';
```

### EXACT WSClient usage snippet [V] — `README.md`, "Subscribing to Events Using Long Connection Mode"
Long connection mode is available in SDK **1.24.0+**. Verified verbatim:
```typescript
import * as Lark from '@larksuiteoapi/node-sdk';

const baseConfig = {
  appId: 'xxx',
  appSecret: 'xxx'
}

const client = new Lark.Client(baseConfig);

const wsClient = new Lark.WSClient({...baseConfig, loggerLevel: Lark.LoggerLevel.info});

wsClient.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const {
        message: { chat_id, content}
      } = data;
      await client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id"
        },
        data: {
          receive_id: chat_id,
          content: Lark.messageCard.defaultCard({
            title: `reply： ${JSON.parse(content).text}`,
            content: 'hello'
          }),
          msg_type: 'interactive'
        }
      });
    }
  })
});
```
Exact API-call snippet [V] — `README.md`, "API Call" / "Events handling" (`im.message.create`
alias, with full Client options):
```typescript
import * as lark from '@larksuiteoapi/node-sdk';
const client = new lark.Client({
    appId: 'app id', appSecret: 'app secret',
    appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu,
});
const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: 'receive_id',
            content: JSON.stringify({text: 'hello world'}), msg_type: 'text' },
});
const eventDispatcher = new lark.EventDispatcher({ encryptKey: 'encrypt key' }).register({
    'im.message.receive_v1': async (data) => {
        const chatId = data.message.chat_id;
        const res = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, content: JSON.stringify({text: 'hello world'}),
                    msg_type: 'text' },
        });
        return res;
    }
});
const server = http.createServer();
server.on('request', lark.adaptDefault('/webhook/event', eventDispatcher));
server.listen(3000);
```
**About `im.message.reply` [honest gap]:** neither fetched `README.md` snippet uses
`im.message.reply`. `im.message.reply` appears **only** as a member of the `SdkClient` structural
interface in `amlyczz/dsh-lark-link/src/host/lark-client.ts` [V], and cube-ai uses
`im.message.patch` for card updates. The Feishu OpenAPI reply endpoint
(`POST /open-apis/im/v1/messages/:message_id/reply`) and a generated `client.im.message.reply`
method are a strong **[I] inference** from the SDK's code-gen pattern, **not verified source** in
this session. Do not present a `reply` snippet as GitHub-verified.

> **Clarification supplied by the Team Lead (2026-11-14):** `im.message.reply` **was** verified
> directly from the locally installed `@larksuiteoapi/node-sdk@1.76.0` `types/index.d.ts`. The
> method therefore exists in this project's installed SDK typings — but that verification is
> **local, not from a GitHub-fetched README**. Treat the method as available for the new plugin;
> no verbatim `reply(...)` call example was fetched from GitHub in this research.

### `Client` construction parameters [V, README table]
`appId` (req), `appSecret` (req), `domain` (`Domain.Feishu` = https://open.feishu.cn,
`Domain.Lark` = https://open.larksuite.com, or full custom domain string; default `Domain.Feishu`),
`httpInstance` (default `defaultHttpInstance`, axios.create), `loggerLevel`, `logger`, `cache`,
`disableTokenCache`, `appType` (`SelfBuild` default / `ISV`), `helpDeskId`, `helpDeskToken`.
ISV calls need `lark.withTenantKey('tenant key')`.

### `EventDispatcher` [V] — `dispatcher/event.ts` + README
Constructor: `{ encryptKey?, verificationToken?, cache?, logger?, loggerLevel?,
webhookCredentialsProvider? }`. `.register({ '<event.key>': async (data) => ... })` returns `this`
(chainable); `.unregister(...keys)`; `async invoke(data, params?: { needCheck?: boolean })`.
Internally registers built-in `app_ticket` handler; WS dispatch calls
`eventDispatcher.invoke(mergedData, { needCheck: false })` (verified in `ws-client/index.ts`), so
webhook token/encrypt checks are skipped on the trusted WS path. Webhook adapters:
`lark.adaptDefault(path, dispatcher, {autoChallenge:true})`, `adaptExpress`, `adaptKoa`,
`adaptKoaRouter`. Webhook auth note [V README]: when no EncryptKey and a nonempty explicitly
supplied VerificationToken, top-level `token` (v1) / `header.token` (v2) is validated.

### `WSClient` internals [V] — `ws-client/index.ts`, `types.ts`, `ws-config.ts`
- `constructor(params: IConstructorParams)`: `appId` (required), `appSecret?` OR
  `clientAssertionProvider?` (keyless auth; at least one required, else
  `ClientAssertionError`), `domain?` (default `Domain.Feishu`), `logger?`, `loggerLevel?`,
  `httpInstance?`, `autoReconnect?` (default `true`), `agent?`, `connectionHost?`,
  `connectionHeaders?`, `source?`, `extraUaTags?`, `onReady?`, `onError?`, `onReconnecting?`,
  `onReconnected?`, `handshakeTimeoutMs?`, `wsConfig?: { pingTimeout?: number }`.
- `async start({ eventDispatcher })`: validates `appId` against `/^cli_[0-9a-fA-F]{16}$/` (else
  logs and returns), requires an `eventDispatcher`, sets `closed=false`, re-arms `dataCache`, then
  `reConnect(true)`. Logs a hint that long connection must be enabled in Developer Console →
  Events and Callbacks → "Receive events/callbacks through persistent connection".
- `pullConnectConfig()` POSTs `{AppID, AppSecret}` (or `ClientAssertion`) to
  `${domain}/callback/ws/endpoint`, gets `URL` + `ClientConfig` (PingInterval, ReconnectCount,
  ReconnectInterval, ReconnectNonce), builds the WS URL; frames are protobuf (`pbbp2`), ping/pong
  control frames, `DataCache` merges fragmented events, `handleEventData` invokes the dispatcher
  and ACKs with `{code:200, data?: base64(result)}`.
- Lifecycle: `close({ force?: boolean })` (there is **NO `stop()`** method in v1.76.0),
  `getReconnectInfo()`, `getConnectionStatus(): { state: 'idle'|'connecting'|'connected'|
  'reconnecting'|'failed', lastConnectTime?, nextConnectTime?, reconnectAttempts }`.
- `WSConfig` defaults: pingInterval 120 s, reconnectCount -1 (infinite), reconnectInterval 120 s,
  reconnectNonce 30 s, autoReconnect true, `wsConfigUrl = domain + '/callback/ws/endpoint'`.
- README long-connection caveats [V]: process within **3 s** or timeout re-push; **cluster mode, no
  broadcasting** — with multiple clients for one app only one random client receives the message;
  **only event subscriptions, NOT callback subscriptions**; no public IP/domain needed; auth only
  at connection establishment, later pushes are plaintext (no decrypt/signature handling).
- `connectionHost`/`connectionHeaders` [V README]: `domain` controls HTTP endpoint discovery;
  `connectionHost` replaces only WS URL `host[:port]`; handshake headers cannot override Host,
  Connection, Upgrade, Sec-WebSocket-*; validated at construction.
- `registerApp({ onQRCodeReady, onStatusChange, addons, createOnly, appId, signal, appPreset })`
  [V README]: OAuth 2.0 Device Authorization Grant; returns `{ client_id, client_secret, user_info
  {open_id, tenant_brand} }`. `addons` can prefill `scopes.tenant: ['im:message:send_as_bot']`,
  `events.items.tenant: ['im.message.receive_v1']`, `callbacks.items: ['card.action.trigger']`
  (additive only; sensitive config cannot travel via addons). Errors `access_denied`,
  `expired_token`, `abort`.
- `Channel` module [V `docs/channel.md`]: `createLarkChannel({ appId, appSecret, transport:
  'websocket'|'webhook', policy, safety, outbound, ... })`, `channel.on('message'|'cardAction'|
  'reaction'|'botAdded'|'comment'|'reject'|'error'|'reconnecting'|'reconnected', ...)`,
  `await channel.connect()`, `channel.send(chatId, {text|markdown|...}, {replyTo, replyInThread,
  mentions})`, `channel.stream(...)`, `channel.rawClient`. Docs say: "If you only need to receive a
  few events and do simple processing, `WSClient` + `EventDispatcher` is sufficient." Group
  messages require @bot by default; to receive all, request `im:message.group_msg` (admin approval).

### Config / schema shape [V]
Plain constructor option objects (no JSON Schema): `Client` options table above; `WSClient`
`IConstructorParams` above; `EventDispatcher` options above; `createLarkChannel` options table in
`docs/channel.md`. Required minimum for a WS bot: `appId`, `appSecret`, `domain` (default Feishu),
an `EventDispatcher` registered for `im.message.receive_v1`, and Developer-Console enabling of long
connection + the event subscription + scope `im:message` / `im:message:send_as_bot`.

### LICENSE [V]
**MIT** — `LICENSE`: "Copyright (c) 2022 Lark Technologies Pte. Ltd." (full text fetched).

---

## 5. Compatibility caveats (verified unless marked [I])

1. **SDK version skew vs `main`.** [V] node-sdk `main` = **1.76.0**. cube-ai declares
   `@larksuiteoapi/node-sdk: ^1.36.0`; dsh-lark-link declares `^1.73.0`. Both ranges resolve to
   1.76.0 today, but their code was written against older surfaces. Long connection requires SDK
   **≥1.24.0** [V README].
2. **`WSClient` has `close()`, not `stop()`.** [V] `ws-client/index.ts` (1.76.0) exposes `start`,
   `close`, `getReconnectInfo`, `getConnectionStatus`; no `stop`. cube-ai correctly calls
   `ws?.close({ force: true })`. dsh-lark-link's `SdkWsClient` interface declares optional
   `stop?()` and `buildLarkClient` calls `wsClient.stop?.()` — on 1.76.0 this is a **no-op**, so the
   WS stays open on shutdown. It must be adapted to `close({force:true})` in a from-scratch plugin.
3. **`start()` is async but not awaited by dsh-lark-link.** [V] `wsClient.start(...)` is called
   inside a sync `try/catch` without `await`; exceptions become unhandled rejections rather than
   being caught. cube-ai `await wsClient.start({eventDispatcher})` [V]. Use `await` and the
   `onError`/`onReady` callbacks.
4. **`appId` must be `cli_` + 16 hex chars.** [V] `start()` returns early otherwise. Long connection
   works only for **self-built / Feishu apps** with "使用长连接接收事件/回调" enabled [V].
5. **One WS consumer per app.** [V] README: cluster mode, no broadcasting; cube-ai docs §12:
   "同一 App ID 不能同时被两个插件连接（飞书长连接会冲突）". A new plugin must not connect the same
   appId concurrently with either existing plugin.
6. **3-second event handling.** [V README] Handler must finish within 3 s or Feishu re-pushes;
   both community plugins queue/ack quickly (cube-ai `KeyedSerialQueue`; dsh-lark-link Outbox/WAL).
   Any new gateway needs fast ACK + async work.
7. **Callbacks are NOT supported over long connection** [V]; `card.action.trigger` is registered as
   an *event* by both plugins, which works. Card buttons need the `card.action.trigger` event
   subscription and v2 card schema [V `docs/channel.md` common issues].
8. **Proxy env vars.** [V] dsh-lark-link explicitly sets `sdk.defaultHttpInstance.defaults.proxy =
   false` because axios under Node ≥18 with `http_proxy` set throws
   `Protocol "https:" not supported. Expected "http:"`. cube-ai instead wraps
   `defaultHttpInstance.request` with `timeout: 30_000, maxRedirects: 0`. Reuse the idea, not the code.
9. **Domain / Lark vs Feishu.** [V] `Domain.Feishu` (default, open.feishu.cn) vs `Domain.Lark`
   (open.larksuite.com); dsh-lark-link carries a `domain: "feishu"|"lark"` in its credential blob and
   passes `AppType.SelfBuild` + `domain` to both `Client` and `WSClient`; cube-ai hardcodes Feishu
   (`diagnose()` uses `https://open.feishu.cn`) and states "只支持飞书，不支持 Lark" [V docs §12].
10. **Node / pnpm floors.** [V] DSH root `node >=24.9.0`, pnpm 11.28.5; dsh-lark-link `>=24.0.0`;
    cube-ai `^22.19.0 || >=24.0.0`. Target `>=24.9.0`.
11. **DSH peer-dependency drift.** [V] DSH root version `0.2.2-rc.3` (developer preview, README
    warns of breaking changes); cube-ai peers `@deepseek-ai/cordis ^4.0.2` and
    `@deepseek-ai/dsh-* ^0.2.1-rc.2`; dsh-lark-link devDeps pin `0.1.2-rc.1` with peers `"*"`
    (all optional). These are two different generations of the DSH API — a new plugin should pin
    against the installed DSH version rather than copy either set. [I] the exact installed DSH
    version on this host was not re-verified here.
12. **`pnpm 11` + protobufjs postinstall.** [V dsh-lark-link README] `dsh plugin add` may need
    `--ignore-scripts` because protobufjs's postinstall is blocked by pnpm 11 policy; protobufjs
    works without it. Also npmmirror `@latest` dist-tag staleness — use explicit versions.
13. **Config schema library.** [V] cube-ai uses `@deepseek-ai/schemastery ^3.18.2` with
    `Schema.object/string/number().default(...)`; dsh-lark-link's schema (in unfetched
    `src/index.ts`) [I] likely uses a similar `Config` export. Use the DSH-native schema library.
14. **`im.message.reply` — GitHub-unverified, locally verified.** See §4. Only
    `im.message.create` and `im.v1.message.create` are verified *send call snippets* from GitHub.
    The Team Lead verified `im.message.reply` directly in the installed
    `@larksuiteoapi/node-sdk@1.76.0` `types/index.d.ts`; treat the method as available for this
    project, but note the evidence is local typings, not a fetched README example.
15. **`createLarkChannel` is a newer high-level alternative** [V docs/channel.md] that did not exist
    at cube-ai's `^1.36.0` floor; using it would couple the plugin to ≥1.7x. Prefer
    `WSClient`+`EventDispatcher`+`Client` (the lowest common denominator, verified by both plugins).

---

## 6. What NOT to copy (write from scratch; do NOT fork)

- **Do not fork or vendor any of the 4 repos.** All four are third-party code with their own licenses
  and copyrights; the deliverable is a new independent plugin.
- **cube-ai is Apache-2.0 with a NOTICE declaring derivation from `MichengAI/dsh-im-connect`
  (Apache-2.0).** [V] Copying `src/manager.js`, `src/engine/*`, `client.js` (248 KB prebuilt bundle),
  the private `sidebar.workspaces` "Registry v1" hack, `dfc:` session prefixes, `/api/dsh-feishu-*`
  routes, `FEISHU_REDIRECT_URLS` (hardcoded localhost + `cubeai.com` deployment callbacks), or the
  QR `addons` gzip encoding would import third-party attribution obligations and a **private,
  non-public DSH sidebar API** that the docs themselves call "私有约定，不是 DSH 公共 API".
- **Do not copy dsh-lark-link's architecture verbatim** (Outbox/WAL/CardKit streaming/doctor ZIP/
  264-test GUI console, `src/index.ts` 104 KB monolith). MIT permits reuse, but the brief requires
  from-scratch design; also its `stop()` vs `close()` mismatch and un-awaited `start()` are bugs to
  avoid, not features to inherit.
- **Do not copy secrets handling into config files.** [V] Both community plugins deliberately keep
  `appSecret` in `ctx.credentials` (or a 0600 fallback) and only store refs. Preserve that *idea*;
  also note workspace `AGENTS.md` rule "Do not place API keys, passwords or SSH private keys inside
  the workspace".
- **Do not copy hardcoded domains/ports, QR provisioning constants, or any brand assets**
  (`icon.svg`, logos, `assets/`). Pick new identifiers, state dirs, session prefixes, API prefixes,
  and credential refs so the new plugin can coexist without the `bundle-in-use`/sidebar conflicts
  cube-ai documents.
- **Do not treat `@larksuiteoapi/node-sdk` internals as stable API.** [V] `ws-client/index.ts` uses
  internal `@node-sdk/*` path aliases and protobuf frames (`pbbp2`); depend only on the public barrel
  (`Client`, `WSClient`, `EventDispatcher`, `Domain`, `AppType`, `LoggerLevel`, `messageCard`,
  `registerApp`, `createLarkChannel`).
- **Do not assume DSH docs are frozen.** [V] README warns of compatibility-breaking changes during
  developer preview; verify `docs/user/develop/basic/{index,config,publish}.md`,
  `docs/user/guide/plugin-market.md`, `docs/cookbook/adding-a-package.md` and
  `docs/cordis-api/*.md` (paths verified, contents **not fetched** here) before implementing the
  manifest, `meta.*` display metadata, and `Config` schema.
- **Do not present a `reply` snippet as GitHub-verified** (see caveat 14); the method itself is
  verified locally in the installed `@larksuiteoapi/node-sdk@1.76.0` typings.

---

## 7. Files/URLs verified in this session (quick index)

| Repo | Verified paths |
|---|---|
| deepseek-harness | `README.md`, `package.json`, `docs/development.md`, `docs/cordis-primer.md`, `docs/cordis-tutorial/01-first-plugin.md`, `docs/cookbook/adding-a-plugin-preview.md`, root/`docs`/`packages`/`packages/sdk`/`packages/experimental`/`docs/user`/`docs/user/develop`/`docs/user/develop/basic`/`docs/user/guide`/`packages/experimental/webhook`/`webhook-github` `contents/` listings, `docs` recursive git tree |
| cube-ai | `package.json`, `README.md`, `LICENSE`, `NOTICE`, `cordis.patch.yml`, `src/index.js`, `src/channels/feishu.js`, `src/channels/feishu-app.js`, `docs/dsh-feishu-channels.md`, `src/`, `src/channels/`, `src/engine/` listings |
| amlyczz | `package.json`, `README.md`, `LICENSE`, `cordis.patch.yml`, `src/inbound/transport.ts`, `src/host/lark-client.ts`, `src/`, `src/host/`, `src/inbound/` listings |
| larksuite | `package.json`, `index.ts`, `README.md`, `README.md` long-connection + events + API + registerApp sections, `ws-client/index.ts`, `ws-client/types.ts`, `ws-client/ws-config.ts`, `dispatcher/event.ts`, `docs/channel.md`, `LICENSE`, `ws-client/`, `dispatcher/`, `docs/` listings |

Explicitly **not fetched** (existence verified only): `deepseek-harness` `docs/user/develop/basic/*.md`,
`docs/user/guide/plugin-market.md`, `docs/cookbook/adding-a-package.md`, `docs/cordis-api/*.md`,
`docs/config-catalog.md`, `docs/architecture.md`, `packages/experimental/webhook*/src/*` and
`package.json`; `amlyczz/src/index.ts` (104 KB); `cube-ai/src/manager.js`, `src/engine/*`,
`client.js`, `locale/*`; `larksuite/README.zh.md`, `channel/index` sources, `code-gen/*`.
LICENSE SPDX ids for all 4 also cross-checked via the GitHub repo API (`license.spdx_id`).
