# DSH 0.2.2-rc.1 — Official Public API Surface for a Third-Party Cordis Plugin

Research date: 2026-11-14. All evidence comes from the **local installed checkout**, no network.

## 0. Scope, conventions, and path legend

```
$D = /home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh
$B = $D/node_modules/@deepseek-ai
$S = $B/dsh-agent-preset/skills/cordis-plugin-development
```

Short citations such as `host-plugin.md:57-64` and `SKILL.md:8` refer to files under `$S`
(`$S/references/host-plugin.md`, `$S/SKILL.md`, `$S/references/practices.md`);
`cordis-composition-reference/SKILL.md` is
`$B/dsh-agent-preset/skills/cordis-composition-reference/SKILL.md`.

Every claim below cites `<path>:<line>` and a short verbatim snippet. `.d.ts` declarations are
treated as authoritative; `lib/index.js` (built, ships with every package) is used only for
runtime details the declarations leave out. Anything I could not find is explicitly marked
**NOT FOUND / unverified**.

Key installed versions (read from each `package.json`):

| Package | Version | Notes |
|---|---|---|
| `@deepseek-ai/dsh` | `0.2.2-rc.1` | root CLI, `"type": "module"`, `engines.node >=24.9.0` |
| `@deepseek-ai/cordis` | `4.1.0` | `"type": "module"` |
| `@deepseek-ai/schemastery` | `3.19.0` | `"type": "module"` |
| `@deepseek-ai/cordis-plugin-loader` / `-include` | `1.1.0` | |
| `@deepseek-ai/cordis-plugin-timer` | `1.2.0` | |
| all `@deepseek-ai/dsh-*` packages listed below | `0.2.2-rc.1` | all `"type": "module"` |

Running Node here is `v24.22.2`, satisfying `>=24.9.0` (`$D/package.json:178-180`).

---

## 1. Cordis plugin basics

### 1.1 The three supported plugin shapes

`$B/cordis/lib/types/registry.d.ts:47-93`:

```ts
/** Supported plugin entrypoint shapes. */
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>;
export declare namespace Plugin {
    interface Base<T = any> {
        /** Display name used for fiber diagnostics and logger names. */
        name?: string;
        /** Standard-schema validator applied to config before the plugin starts. */
        Config?: StandardSchemaV1<any, T>;
        /** Services the plugin requires; it only loads while all are available. */
        inject?: Inject;
        /** Service name(s) the plugin provides (read by `Service` and by loaders). */
        provide?: string | string[];
        intercept?: Dict<boolean>;
    }
    interface Function<T = any> extends Base<T> { (ctx: Context, config: T): any; }
    interface Constructor<T = any> extends Base<T> { new (ctx: Context, config: T): any; }
    interface Object<T = any> extends Base<T> { apply(ctx: Context, config: T): any; }
}
```

So `export const name`, `export const inject`, `export const Config`, and
`export function apply(ctx, config) {}` are the idiomatic **named** export forms. A class
default export is also valid. `Config` is a **Standard Schema** validator — in DSH that means
`@deepseek-ai/schemastery` (`z.object(...)`), not Zod.

`ctx.plugin()` / `ctx.inject()` (`$B/cordis/lib/types/registry.d.ts:99-122`):

```ts
declare module './context.ts' {
    interface Context {
        inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>;
        plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>;
    }
}
```

`Inject` is `(keyof M)[] | { [K in keyof M]?: M[K] }` (`registry.d.ts:12-15`); the object form
carries per-service intercept config. `ctx.inject(deps, cb)` is shorthand for
`ctx.plugin({ inject, apply: cb })`: the callback unloads and re-runs when a required service
changes (`registry.d.ts:102-111`).

**Real plugins (verbatim):**

* `$B/dsh-sdk-app/lib/index.js:12,14,18,36,45` — full named-export form:
  ```js
  const name = "sdk-app-startup";
  const inject = ["cmdlineArgs"];
  const Config = z.object({ profile: z.string().default("sdk") });
  function apply(ctx, config = {}) { /* ... */ }
  export { Config, SDK_APP_STARTUP_SERVICE, apply, inject, name };
  ```
* `$B/dsh-tool-schedule/lib/index.js:14,18,503,693`:
  ```js
  const name = "tool-schedule";
  const inject = ["tools", "systemPrompt"];
  function apply(ctx) { /* ... */ }
  export { apply, inject, name };
  ```
* `$B/dsh-sdk-jsonrpc-server/lib/index.js:808-810,857`:
  ```js
  const name = "sdk-jsonrpc-server";
  const inject = ["agents", "workingDirectory"];
  const Config = Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) });
  export { Config, HarnessSdkJsonRpcServer, apply, inject, name };
  ```
  Its `.d.ts` header gives a hard rule (`$B/dsh-sdk-jsonrpc-server/lib/types/index.d.ts:5-7`):
  > "Keep named plugin exports with no default export so Loader `unwrapExports` preserves
  > `name`, `inject`, `Config`, and `apply`."
  `Loader.unwrapExports(exports: any): any` exists at
  `$B/cordis-plugin-loader/lib/types/index.d.ts:81-82`.
* `$B/dsh-time-context/lib/types/index.d.ts:17-39` — a typed `Config` + async `apply`:
  ```ts
  export declare const name = "time-context";
  export declare const inject: string[];
  export declare const Config: z<Config>;
  export declare function apply(ctx: Context, config: Config): Promise<void>;
  ```
* `$B/dsh-user-approval/lib/index.js:91-97` — class-as-default-export service:
  ```js
  var ApprovalService = class extends Service {
      static inject = ["sessionProjections"];
      static Config = z.object({ policy: z.union(["ask", "never"]).default("ask") });
      constructor(ctx, config) { super(ctx, "approval"); /* ... */ }
  ```
* Official template `$B/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/index.js:1-2`:
  ```js
  /** Host half of the decoration bundle; the Client module owns the rendering. */
  export function apply() {}
  ```

`$B/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:57-64` is the
authoritative summary:

> "`index.js` exports one of these forms; do not mix them:
> - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
> - A service class as the default export.
>
> Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup.
> A plugin that declares `Config` validates the row's `config` at activation; query
> `Config.listConfigs` for an installed plugin's schema before writing its `config`."

### 1.2 Lifecycle: `ctx.effect`, `ctx.on`, fiber disposal

* `ctx.effect()` is mixed in from `Fiber` (`$B/cordis/lib/types/fiber.d.ts:7-12`):
  ```ts
  declare module './context.ts' {
      interface Context extends Pick<Fiber, 'effect'> {
          /** The fiber (plugin runtime instance) that owns this context. */
          fiber: Fiber;
      }
  }
  ```
* `Fiber.effect()` (`fiber.d.ts:148-163`):
  ```ts
  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>;
  /** Same as above for async effects; the disposer is also awaitable. */
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>;
  ```
  Disposers run in **reverse registration order** when the owning fiber unloads; async
  disposers are awaited (`fiber.d.ts:36-51`). Real use,
  `$B/dsh-sdk-jsonrpc-server/lib/index.js:838-846`:
  ```js
  ctx.effect(() => {
      transport.start();
      return async () => { await server.shutdown(); transport.close(); };
  }, "jsonrpc.serve");
  ```
* `ctx.on()`/`ctx.once()` return a disposer and are **fiber-owned**
  (`$B/cordis/lib/types/events.d.ts:80-98`, `events.d.ts:171-191`):
  ```ts
  on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean;
  ```
  > "Register an event listener owned by the current fiber... The listener is removed
  > automatically when the fiber unloads." (`events.d.ts:174-175`)
* `Fiber.dispose` / `ctx.fiber.dispose()` (`fiber.d.ts:109-110`):
  ```ts
  /** Dispose this fiber: unload the plugin, then settle once cleanup finished. */
  readonly dispose: () => Promise<void>;
  ```
  `ctx.plugin()` returns `Fiber & PromiseLike<Fiber>`; `await root.fiber.dispose()` is the
  documented shutdown (`$B/cordis/README.md:41`). Other lifecycle methods: `fiber.await()`,
  `restart()`, `update(config, noSave?)` (`fiber.d.ts:202-217`). A child fiber created by
  `ctx.plugin()`/`ctx.inject()` is disposed with its parent — the parent owns the child's
  disposer (`$B/cordis/src/fiber.ts:271`).
* Built-in lifecycle **events** in `@deepseek-ai/cordis` 4.1.0
  (`$B/cordis/lib/types/events.d.ts:201-238`) are `internal/plugin`, `internal/status`,
  `internal/service`, `internal/update`, `internal/commit`, `internal/config`,
  `internal/get`, `internal/set`, `internal/listener`, `internal/dispatch`. The loader adds
  `'exit'(signal)`, `'loader/config-update'`, `'loader/entry-init'`,
  `'loader/partial-dispose'`, `'loader/volatile-update'`, `'loader/patch-context'`
  (`$B/cordis-plugin-loader/lib/types/index.d.ts:18-37`).

**NOT FOUND / unverified in this installed Cordis 4.1.0:**

| Requested API | Finding |
|---|---|
| `ctx.on('ready')` | **NOT FOUND.** No `'ready'` member in `Events` (core or loader). A targeted grep for `'ready'(` / `'dispose'(` in every `.d.ts` under `$B` returned zero lifecycle-event hits. Use `apply()` itself, or inject the service you need (the Web profile uses `webStartup`, the SDK profile uses `sdkAppStartup`, `dsh-sdk-app/lib/types/index.d.ts:13-14`), or `ctx.get('loader')?.await()` (`dsh-sdk-jsonrpc-server/lib/index.js:836`). |
| `ctx.on('dispose')` | **NOT FOUND.** Disposal is `ctx.effect()` returning a cleanup function, or `ctx.fiber.dispose()`. `'session/disposed'` / `'agent/disposed'` / `'api-session/removed'` are domain events, not generic plugin teardown. |
| `ctx.scope` | **NOT FOUND** on `Context`. `$B/dsh-scope` provides `ScopeKey`, `Scoped<T>`, `createScope()`, `scopeTarget()`, `bindScopeParent()` (`$B/dsh-scope/lib/types/index.d.ts:10-69`) and scope-filtered **event dispatch**, not a `ctx.scope` property. |
| `Context.service` (static) | **NOT FOUND.** No static `service` on `Context` (`context.d.ts:40-100` lists only `effect`, `filter`, `isolate`, `intercept`, `is`, `extend`, `isolate`, `intercept`). The equivalents are `ctx.provide(name, value)` / `ctx.get(name)` / `ctx.set(name, value)` (`reflect.d.ts:4-67`) and `Service` subclasses. |
| `ctx.fork()` | **NOT FOUND** in Cordis core. "Fork" in this codebase means **Session forking** (`SessionStore.fork()`, `dsh-session/lib/types/index.d.ts:509-524`) or **subagent** creation, not a Cordis context fork. Child contexts come from `ctx.extend()`, `ctx.isolate()`, `ctx.intercept()` (`context.d.ts:61-99`). |

### 1.3 Service injection / declaration

* Service base class (`$B/cordis/lib/types/service.d.ts:9-38`):
  ```ts
  export declare abstract class Service<out T = never> {
      protected ctx: Context;
      constructor(ctx: Context, name: string);
  }
  ```
  > "Calls `ctx.reflect.provide(name, this, this[Service.check])`, so the service is
  > unregistered automatically when the owning fiber unloads." (`service.d.ts:30-37`)
  Real examples: `super(ctx, "agents")` (`$B/dsh-agent/lib/index.js:450`),
  `super(ctx, "sessions")` (`$B/dsh-session/lib/index.js:1748`),
  `super(ctx, "agentLoop")` (`$B/dsh-agent-loop/lib/index.js:1329`),
  `super(ctx, "approval")` (`$B/dsh-user-approval/lib/index.js:97`),
  `super(ctx, "schedule")` (`$B/dsh-schedule/lib/index.js:2116`),
  `super(ctx, "sessionController", { namespace: "session" })`
  (`$B/dsh-api-session-controller/lib/index.js:3791`).
* Declaration of a new typed service is TypeScript module augmentation:
  ```ts
  declare module '@deepseek-ai/cordis' { interface Context { myService: MyService } }
  ```
  (e.g. `$B/dsh-session/lib/types/index.d.ts:26-29` adds `sessions: SessionStore`;
  `$B/dsh-api-session-controller/lib/types/index.d.ts:13-18` adds
  `sessionController: SessionController`).
* `ctx.provide` / `ctx.get` / `ctx.set` (`$B/cordis/lib/types/reflect.d.ts:4-43`):
  ```ts
  get(name: string, strict?: boolean): any;
  set(name: string, value: any): void;
  provide(name: string, value?: any): () => void;
  ```
  `provide` returns a disposer and is fiber-owned. Real use:
  `$B/dsh-sdk-jsonrpc-server/lib/index.js:825` — `ctx.provide("sdkSessionActivation", { ready: true })`.
* `ctx.inject([...], cb)` for **optional** services is the recommended pattern
  (`$B/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:20`):
  > "Put optional services in `inject` or `ctx.inject([...], ...)` so the plugin stays
  > inactive in profiles without them instead of throwing."
  Real use: `$B/dsh-user-approval/lib/index.js:100` — `await this.ctx.inject(["systemPrompt"], (scope) => {...})`.

### 1.4 `Config` schema

`Config` is a Standard-Schema validator; DSH uses `z` from `@deepseek-ai/schemastery`:
`static Config: z<Config>` (`$B/dsh-plugin-manager/lib/types/index.d.ts:55`),
`const Config = z.object({...})`. The Host inspect query `Config.listConfigs` projects a
live plugin's native `Config` into a JSON Schema 2020-12 document
(`$B/dsh-tool-cordis/lib/types/config.d.ts:1-18`):

> "With `entry`, return that entry with its resolved `packageDir` ... and project its native
> Config into one self-contained JSON Schema 2020-12 document whose `$defs` carry the shared
> and `loaderExpression` definitions ... Validators and transform callbacks are not executed."

`$defs` must be followed when consuming that schema
(`host-plugin.md:64`). Schemastery builder methods available include `.required()`,
`.volatile()`, `.hidden()`, `.role(text, extra)`, `.default()`, `.description()`,
`.pattern()`, `.min/.max/.step()` (`$B/schemastery/lib/types/index.d.ts:150-194`).
**There is no `.secret()` builder method** — see §7.

### 1.5 Config persistence from inside a plugin

`$B/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:66-77`:

> "Plugin code never persists configuration by reading, filtering, and rewriting the active
> profile's `cordis.patch.yml` ... To change its own configuration after `apply` returns, a
> plugin uses the config editor:
> ```js
> const entry = ctx.fiber.entry
> const editor = ctx.get('configEditor')
> if (entry === undefined || editor === undefined) throw new Error('Configuration cannot be saved in this profile')
> await editor.edit(entry, current => ({ ...current, field: value }))
> ```
> ... a field declared `.volatile()` updates in place and is read with `config.field.get()`.
> Store secrets ... as `ctx.credentials.modifyRecord()` records, **not configuration**."

`ctx.fiber.entry?: Entry` is declared by the loader
(`$B/cordis-plugin-loader/lib/types/index.d.ts:44-46`); `ConfigEditor.edit(entry, change)`
at `$B/dsh-config-editor/lib/types/index.d.ts:29-34`.

---

## 2. Plugin package manifest, discovery, installation, profile config

### 2.1 What makes a package a DSH plugin / bundle

`$B/dsh-package-manifest/lib/types/types.d.ts:6-39, 57-95` (public author fields):

```ts
export interface DshPackageManifest {
    name: string; version: string;
    description?: string; icon?: string; private?: boolean;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    /** Runtime requirements; DSH compatibility is declarative until a reader enforces it. */
    engines?: DshEnginesManifest;
    dsh?: DshManifest;
}
export interface DshManifest {
    manifestVersion?: 1;
    bundle?: DshBundleManifest;
    profile?: DshProfileManifest;
    client?: DshClientManifest;
}
export interface DshEnginesManifest {
    /** Compatible DSH versions as a SemVer range, including an exact version. */
    dsh?: string;
    node?: string; npm?: string;
    [engine: string]: string | undefined;
}
export interface DshBundleManifest {
    platforms?: string[];
    /** One patch file path, or an ordered list applied in sequence... */
    patch: string | string[];
    listedByDefault?: boolean;
}
export interface DshProfileManifest { bundles?: string[]; }
export interface DshClientManifest {
    platform: string; inject?: string[]; immediately?: boolean; external?: string[];
}
```

The **decisive field is `dsh.bundle.patch`**:
`$B/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:5-27`:

> "A bundle is a package whose `package.json` declares `dsh.bundle.patch`; the YAML patch
> inserts plugin entries... A Host-only bundle needs no dependencies, install scripts, or build tool:
> ```json
> { "name": "@local/my-plugin", "version": "1.0.0", "private": true,
>   "type": "module", "exports": { ".": "./index.js" },
>   "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
> ```
> ```yaml
> - insert:
>     - id: my-plugin
>       name: '@local/my-plugin'
>       config: {}
> ```"

`$B/dsh-package-manifest/README.md:26-40` gives the canonical full example
(`engines: { node: '>=24', dsh: '0.1.5-alpha.1' }`, `dsh.manifestVersion: 1`,
`dsh.bundle.patch`, `dsh.client`). `dsh.client.platform: 'web'` + `window.__ModuleLoader__`
client module is only needed for Web UI; the official client template is at
`$B/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js:1-22`.

**Real manifests inspected:**

* `$B/dsh-sdk-app/package.json:13-37` — `dsh.bundle.patch = "./cordis.patch.yml"`,
  `exports` maps `.`, `./cordis.patch.yml`, `./locale/*.json`, `./package.json`; `files`
  lists the same; `peerDependencies: { "@deepseek-ai/cordis": "~4.1.0" }`.
* `$B/dsh-sdk-minimal/package.json:31-35` — `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`;
  its `lib/types/index.d.ts:1-8` says "The package's substance is `cordis.patch.yml` ... this
  module carries no runtime interface."
* `$B/dsh-schedule/package.json:16-36,48-63` — typical **non-bundle** library plugin:
  `exports` with `./client`, `./typert`, `./remote`, `./locale/*.json`; huge
  `peerDependencies` list on `@deepseek-ai/dsh-*` at `0.2.2-rc.1`; no `dsh` field.
* `$B/dsh-session/package.json:16-36,44-47` — `exports` with `./types`, `./fork`,
  `./surface`, `./locale/*.json`; `peerDependencies: { dsh-scope: 0.2.2-rc.1,
  cordis: ~4.1.0 }`.
* `$B/dsh-tool-schedule/package.json:16-24,31-38` — `exports ./`, `./src/*`, `./locale/*.json`,
  `./package.json`; peers on `cordis`, `dsh-llm`, `dsh-schedule`, `dsh-subagent`,
  `dsh-system-prompt`, `dsh-tools`.

### 2.2 Discovery / installation into a profile

`$B/dsh-app-boot/lib/types/profile.d.ts:5-20` is the authoritative composition description:

> "A profile is a directory under `$DSH_HOME/profiles/<name>` holding a `package.json`
> (out-of-tree plugin dependencies plus the profile manifest `dsh.profile` with its ordered
> `bundles` list) and a `cordis.patch.yml` (the user's own patch layer, applied after every
> bundle layer). Bundles are npm packages whose manifest declares
> `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` ... Module resolution is
> two-anchor by construction: a bundle name resolves first from the dsh installation
> (the launcher's own package), then from the profile directory."

`$D/README.md:37,46`:

> "A profile directory holds a `package.json` (out-of-tree plugin dependencies plus the
> profile manifest `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
> (the user's own patch layer)."
> "Bundles named in `dsh.profile.bundles` resolve from the dsh installation first
> (`@deepseek-ai/dsh-base`, ...), then from the profile's own `node_modules`, where pnpm
> installs out-of-tree plugins."

Installation is `plugin_manager install_bundle` (Host service
`$B/dsh-plugin-manager/lib/types/index.d.ts:194-208`) or the CLI
`dsh plugin --profile <name> <pnpm args>` (`$D/README.md:18`, `$D/lib/types/plugin.d.ts:2-8`).
`installBundle(spec, options?)` accepts "One package spec, including local paths relative to
the invocation directory", `enabled` (default true), `approvedBuilds`, exact-dependency save,
and a registry. `removeBundle`, `setPluginEnabled`, `setBundleEnabled`, `listPlugins`,
`listBundles`, `listVersions`, `updateBundle`, `waitForInstall`, `cancelInstall` are the rest
of the management API (`index.d.ts:119-226`). `listBundles()` reports `availability`,
`enabled`, `installed`, `official`, `installTarget`, `rows[]`, `overrides[]`, `updatable`
(`$B/dsh-plugin-manager/lib/types/types.d.ts:72-117`). HMR can apply a new bundle live;
replacing an installed package requires a restart (`host-plugin.md:79-83`).

**`$D/lib/types/plugin.d.ts` is NOT a plugin-authoring API.** Its whole content
(`$D/lib/types/plugin.d.ts:1-8`) is:

```ts
import { type ProfileContext } from '@deepseek-ai/dsh-app-boot';
export declare function runPlugin(profile: string, args: readonly string[], packageManager?: ProfileContext['packageManager']): Promise<number>;
```

i.e. the CLI's internal "run package management for a profile" helper.

**`$D/lib/types/profile-boot.d.ts`** (`RunProfileOptions`, `prepareProfile`, `runProfile`):

```ts
export declare const PROFILE_ROOT_FILENAME = "cordis.yml";                  // :26
export declare function homePatchPath(): string;                            // :22
export declare function prepareProfile(name: string, userLayer?: boolean, fromDefaultProfile?: string): Profile; // :61
export declare function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }>; // :93-96
```

`runProfile` stacks "bundle layers in `dsh.profile.bundles` order, the profile's own
`cordis.patch.yml`, `--patch` overlays, the telemetry switch" over the profile's empty root
config (`profile-boot.d.ts:1-10`). `PROFILE_ROOT_FILENAME = "cordis.yml"` is the root config
file; it is rewritten empty on every boot and is not where users put plugins
(`profile-boot.d.ts:46-59`).

### 2.3 Profile config (YAML) referencing a plugin and its config

`$B/dsh-agent-preset/skills/cordis-composition-reference/SKILL.md:10-25` is the Loader patch
dialect reference:

> "- `insert: [rows]` appends rows; with an `id` naming an existing `group: true` row, the
> rows are appended inside that group's `config` list.
> - A patch with an `id` and no `insert` targets the existing row with that id. Supplied
> fields replace the row's fields; `config` is replaced wholesale, never deep-merged...
> - A row has `id`, `name` (the plugin package specifier; inserted relative paths are
> anchored beside their patch file), optional `config`, and optional `disabled`, `inject`,
> `intercept`, and `isolate`.
> - `group: true` with `name: cordis:group` makes `config` a nested entry list...
> - `disabled` accepts a boolean, null, or a `!!js` expression...
> - `!!js` scalars are Loader expressions, never `!js`. Inside `config` they are evaluated
> after the row's declared injections activate, against that plugin's context (`ctx.<service>`)...
> - `isolate` maps service names to `true` or a realm label..."

Real example with `config`, `inject`, `disabled`, `!!js`
(`$B/dsh-sdk-app/cordis.patch.yml:11-21`):

```yaml
- insert:
    - id: sdk-app-startup
      name: '@deepseek-ai/dsh-sdk-app'
      config:
        profile: sdk

    - id: sdk-jsonrpc-server
      name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
      inject: [sdkAppStartup, loader]
      config:
        maxTokensAsSuccess: !!js "process.env.DSH_MAX_TOKENS_AS_SUCCESS === undefined ? true : JSON.parse(process.env.DSH_MAX_TOKENS_AS_SUCCESS)"
```

Environment variables inside a patch (`$B/dsh-sdk-minimal/cordis.patch.yml:26-30,172-176`):

```yaml
    - id: llm-deepseek
      name: '@deepseek-ai/dsh-llm-deepseek-api-key'
      config:
        apiKeyEnv: DEEPSEEK_API_KEY
        defaultContextWindow: !!js Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)
...
    - id: sessions
      name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: !!js dshHomePath('sessions')
```

`$B/dsh-web-app/cordis.patch.yml:117-118`:

```yaml
    - id: session-controller
      name: '@deepseek-ai/dsh-api-session-controller'
```

### 2.4 `dsh-plugin-detail`

Reads a bundle's long description without activating it — `locale/<lang>.json`'s
`meta.detail` Markdown path else README; resolves image destinations inside the package
(`$B/dsh-plugin-detail/lib/types/document.d.ts:8-57`, `index.d.ts:1-9`). Consumed by
`PluginManager.readBundleDetail(name, language, options?)` returning a `BundleDetail`
(`$B/dsh-plugin-manager/lib/types/index.d.ts:82-96`). Display metadata (`meta.title`,
`meta.description`, `icon`) comes from exported locale JSON / `package.json.icon`
(`host-plugin.md:29-51`; `$B/dsh-package-manifest/lib/types/types.d.ts:40-55`).

### 2.5 `engines.dsh`, peers, and compatibility version rules

`$B/dsh-app-boot/lib/types/plugin-compatibility.d.ts:16-28`:

```ts
/**
 * Check the plugin's dsh requirements against the runtime. An own `engines.dsh` range decides alone and
 * peerDependencies are ignored; otherwise every @deepseek-ai/dsh or @deepseek-ai/dsh-* peer must match.
 * Prereleases participate in ranges. For peers only, workspace:^, workspace:~, and workspace:* refer to
 * the current runtime; other empty or invalid ranges, including any workspace: `engines.dsh`, are unmet.
 */
export declare function evaluatePluginCompatibility(manifest: object, exemptions?: Readonly<Record<string, readonly string[]>>, runtimeVersion?: string): PluginCompatibility | undefined;
```

`PluginCompatibility` carries `name`, `version`, `runtimeVersion`,
`requirements: Record<string, string>` keyed `engines.dsh` or DSH peer package name, and
`exempted` (`plugin-compatibility.d.ts:3-10`). `getDshRuntimeVersion()` reads app-boot's own
version (`plugin-compatibility.d.ts:16`).

`$D/README.md:39`:

> "Installation and profile startup enforce the declared `engines.dsh` range, or DSH peer
> ranges when it is absent, against the same runtime version shown by `dsh --version`.
> Incompatible plugins require an explicitly acknowledged exact-version exemption."

`$B/dsh-plugin-manager/README.md:77-83` (section "Version compatibility and exemptions"):

> "An install command that names packages (`add`, or `install` with specs) is checked before
> pnpm runs: a local path is read from its own `package.json`, and a registry spec is resolved
> through pnpm's registry lookup for the version its range selects and the `engines` and
> `peerDependencies` that version declares. An unmet DSH requirement rejects the operation
> before pnpm runs... Startup checks run independently...
>
> An exemption is an exact `package-name@version` mapped to a list of exact DSH runtime
> versions in the profile's own `compatibility.json`, beside `package.json` and
> `cordis.patch.yml`... Neither plugin upgrades nor DSH upgrades inherit permission. Use
> `plugin_manager` with `list_version_exemptions` ... then `set_version_exemption` with
> `target`, `runtimeVersion`, and `enabled`. Granting also requires `acceptRisk: true`,
> only after warning the user that incompatible plugins may cause crashes or data loss...
>
> The CLI exposes `dsh plugin --profile <profile> version-exemptions`,
> `allow-version <package@version> --dsh-version <runtime> --accept-risk`, and
> `revoke-version <package@version> --dsh-version <runtime>`. A grant prints a risk warning
> before saving. A compatibility refusal carries the `incompatible-version` code..."

`$D/lib/plugin-DscIHF4k.js:15-17,31,37,48,96`:

```js
if (command !== "allow-version" && command !== "revoke-version" && command !== "version-exemptions") return void 0;
...
if (packageVersion === void 0 || runtimeVersion === void 0) throw new Error(`usage: dsh plugin ${command} <package@version> --dsh-version <exact>${command === "allow-version" ? " --accept-risk" : ""}`);
...
if (command === "allow-version") process.stderr.write("dsh: warning: allowing incompatible plugin versions can break the application or corrupt data. Approval applies only to the exact package and DSH versions.\n");
...
await setProfileVersionExemption(dir, request.packageVersion, request.runtimeVersion, command === "allow-version", acceptRisk);
...
for (const { name, version, runtimeVersion } of result.incompatible ?? []) process.stderr.write(`dsh: to accept the risk, run: dsh plugin --profile ${profile} allow-version ${name}@${version} --dsh-version ${runtimeVersion} --accept-risk\n`);
```

`setProfileVersionExemption(profileDir, packageVersion, runtimeVersion, enabled, acceptRisk)`
requires both identities to be **canonical exact SemVer** and `acceptRisk` true for grants
(`$B/dsh-app-boot/lib/types/profile-compatibility.d.ts:3-13,39-49`);
`PROFILE_COMPATIBILITY_FILENAME = "compatibility.json"` (`:2`).
`pluginCompatibilityWarning()`'s text (`$B/dsh-app-boot/lib/index.js:1153`):

> "Plugin ... is incompatible with dsh ...: requirements .... Running it may cause crashes or
> data loss. ... To accept this risk explicitly, grant the exact-version exemption ... with
> `dsh plugin allow-version` or the plugin manager, then retry ..."

Refusal code / shapes: `ManagementError.code = 'incompatible-version'` with `incompatible?:
IncompatiblePlugin[]` (`$B/dsh-plugin-manager/lib/types/types.d.ts:30-44,143-145`);
`PluginMarket` exposes `MarketCompatibility` (`$B/dsh-plugin-market/lib/types/types.d.ts:72-86`).

**On "the plugin compatibility check that forbids `allow-version`":** I found **no rule that
literally forbids the `allow-version` command** — it exists and is the *only* documented
remedy. What the check forbids is any other bypass:

* install/activation is refused with `incompatible-version` before pnpm runs;
* an exemption must be for the **exact** `package@version` + **exact** runtime version
  (ranges, prefixes, whitespace, malformed versions rejected — `profile-compatibility.d.ts:3-13`);
* grants require explicit `--accept-risk` / `acceptRisk: true` plus a user warning about
  crashes/data loss;
* the grant lives in the **profile's** `compatibility.json`, not in the plugin manifest —
  **a plugin cannot self-grant an exemption from its own code**;
* "Version exemptions do not authorize dependency scripts" and "Neither plugin upgrades nor
  DSH upgrades inherit permission" (`plugin-manager/README.md:77-83`);
* `set_version_exemption` is a privileged tool action: "Every `plugin_manager` action ...
  also needs approval without Full access" (`host-plugin.md:10`), and the tool description says
  "Version exemptions risk crashes and data loss: warn the user and obtain explicit permission
  for the exact plugin and runtime versions before granting one."
* In this session, approval prompts are disabled, so an automatic grant would be rejected.

Practical consequence for a v0.1.0 plugin: **declare `engines.dsh` explicitly**. Because an
own `engines.dsh` "decides alone and peerDependencies are ignored"
(`plugin-compatibility.d.ts:18-19`), declaring it avoids accidental interaction between your
`peerDependencies` on `@deepseek-ai/dsh-*` packages and the runtime version check.

**Observed reality:** only **4** packages in the whole installed tree declare `engines` at
all (`libreoffice-kit`, `libreoffice-kit-wasm`, `node-addon-system`,
`node-addon-system-linux-x64`), and **none** declares `engines.dsh`. So `engines.dsh` is a
public but, in this build, unused-by-shipped-packages field; the shipped packages instead
rely on exact `0.2.2-rc.1` peers on `@deepseek-ai/dsh-*`.

---

## 3. Session API — create / send / subscribe / resume / close

### 3.1 Service names (all are `declare module '@deepseek-ai/cordis' { interface Context { ... } }`)

| Service (`ctx.<name>`) | Declared at | Purpose |
|---|---|---|
| `sessions: SessionStore` | `$B/dsh-session/lib/types/index.d.ts:26-29` | In-memory event-sourced session store |
| `agents: AgentRegistry` | `$B/dsh-agent/lib/types/index.d.ts:19-23` | Live agent registry + creation factory |
| `agentLoop: AgentLoop` | `$B/dsh-agent-loop/lib/types/index.d.ts:13-16` | Concrete agent factory / driver |
| `sessionController: SessionController` | `$B/dsh-api-session-controller/lib/types/index.d.ts:13-18` | Host business API + Typert Remote namespace `ctx.remote.session` |
| `sessionProjections: SessionProjectionRegistry` | `$B/dsh-session-projection/lib/types/index.d.ts:23-27` | Pure folds over committed events |
| `sessionQuery: SessionQueryEngine` | `$B/dsh-session-query/lib/types/index.d.ts:23-27` | Cold reads / full-text search |
| `sessionPersistence: SessionPersistence` | `$B/dsh-session-persistence/lib/types/index.d.ts:83-87` | Durable append-only log |

### 3.2 CREATE + SEND + SUBSCRIBE + RESUME + CLOSE — exact signatures

**(A) `ctx.agents` — the in-process path used by DSH's own SDK server**

`$B/dsh-agent/lib/types/index.d.ts:283-300`:

```ts
/**
 * Create and publish a new agent through the registered factory. ...
 * @returns the handle after setup, rollback-covered publication, and loop start complete.
 */
create(options: CreateAgentOptions): Promise<AgentHandle>;
/**
 * Load a persisted session and resume an agent on it through the registered factory...
 */
resume(options: ResumeAgentOptions): Promise<AgentHandle>;
```

`CreateAgentOptions` (`index.d.ts:49-106`): `sessionId` (required, `SessionId` brand),
`parentAgent?`, `meta?: { cwd?, parentSession?, isSeeded?, origin?, delegationDepth?, agentPreset? }`,
`inheritedEventCount?`, `seed?`, `agentOptions?: AgentOptions`, `signal?`, `setup?: AgentSetup`.
`ResumeAgentOptions` (`:111-130`): `resumeSessionId`, `parentAgent?`, `agentOptions?`, `signal?`, `setup?`.
`AgentHandle` (`:145-148`):

```ts
export interface AgentHandle {
    agent: Agent;
    dispose(): Promise<void>;
}
```
> "The disposer is a CAPABILITY: among consumers, only the holder can tear this agent down."
> and `dispose()` "stops the loop, awaits its exit, unregisters the agent, **removes its session
> from the store**, and finally unwinds its scoped world" (`:132-143`).

`AgentOptions` — the model/workspace binding (`$B/dsh-agent/lib/types/runtime-types.d.ts:27-36`):

```ts
export interface AgentOptions {
    provider?: string; model?: string;
    reasoningEffort?: ReasoningEffortId | undefined; maxTokens?: number;
}
```

`Agent` live face (`runtime-types.d.ts:163-237`), verbatim key methods:

```ts
interface Agent {
    readonly options: AgentOptions;
    readonly session: Session;
    readonly model: Model;
    readonly inbox: Inbox;
    readonly status: AgentStatus;      // 'idle' | 'running'
    readonly ctx: Context;
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    whenIdle(): Promise<void>;
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    /** Queue an ordinary follow-up turn and wake the driver. */
    followup(message: UserMessage): void;
    steer(message: UserMessage): void;
    inject(message: UserMessage): void;
}
```

`SEND`: `agent.followup(message)` — "Queue an ordinary follow-up turn and wake the driver"
(`runtime-types.d.ts:214-219`). `message` is a `UserMessage` built by
`createUserMessage({ content, source })` from `@deepseek-ai/dsh-llm`
(`$B/dsh-llm/lib/types/message.d.ts:213-217`; `NewUserMessage = Omit<UserMessage,'id'|'role'>`
at `:179`, `MessageBase.source: MessageSource` at `:124-133`, `MessageSourceMap.user =
{ kind: 'user' }` at `:101-104`, `TextBlock = { type:'text'; text:string }` at
`$B/dsh-llm/lib/types/types.d.ts:53-56`). Official usage,
`$B/dsh-sdk-jsonrpc-server/lib/index.js:503-518`:

```js
async prompt(params) {
    const rec = await this.getOrCreateSession(params.sessionId);
    ...
    const message = createUserMessage({ content, source: { kind: "user" } });
    rec.handle.agent.followup(message);
    return { messageId: message.id };
}
```

`CLOSE`: `await handle.dispose()` (above). For a bare `ctx.sessions.create()` session,
`SessionStore` has **no public `close`/`dispose` method** — only `create`, `prepare`, `enter`,
`announce`, `flush`, `get`, `list`, `fork` (`$B/dsh-session/lib/types/index.d.ts:386-527`);
`detachEntered` is `private` (`:467-468`). Ownership is via the calling fiber:
> "Create a session owned by the calling fiber: disposing that fiber stops event notification
> and removes the session from the store." (`index.d.ts:401-403`)

`SUBSCRIBE` — two event feeds plus a projection registry:

* Durable event feed (`$B/dsh-session/lib/types/index.d.ts:53-71`):
  ```ts
  'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;   // emit
  'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void;        // parallel
  'session/created'(...): void;  'session/disposed'(...): void;
  ```
  Known durable event types in `$B/dsh-session/lib/types/types.d.ts`: `'user/message'` (`:300`),
  `'assistant/message'` (`:338`), `'assistant/attempt'` (`:352`), `'tool/result'` (`:382`),
  `'turn/start'` (`:268`), `'turn/end'` (`:279`).
* Live token stream (`$B/dsh-agent/lib/types/runtime-types.d.ts:393-404`):
  ```ts
  'agent/assistant-stream'(this: Scoped<Agent>, payload: {
      agent: Agent; frame: AssistantStreamFrame;
  }): void;                                                    // emit
  ```
  `AssistantStreamFrame` is `start | chunk | end` (`:131-162`); chunk frames are **transient** —
  the loop commits one final `assistant/message` / `assistant/attempt` with the same stream
  (`:394-396`). `practices.md:28` advises:
  > "Wait on durable events such as `turn/end`, `assistant/message`, or `tool/result`;
  > render live tokens from `agent/assistant-stream`."
* `$B/dsh-session-projection/lib/types/index.d.ts:181-257` — `ctx.sessionProjections.register(def)`
  returns `Promise<ProjectionHandle<S>>` with `stateOf(session)`, `readerFor(session)`,
  `dispose()`; `onChanged(listener)`, `onEventChanged(listener)`, `snapshot(session, keys?)`.
  `ProjectionDefinition` requires `key`, `stateSchema` (Zod), `init`, pure `apply`,
  `stateVersion`, optional `wire.view()` (`:62-112`). **Do NOT subscribe to `session/event` and
  rescan `session.events`** for per-session state (`practices.md:26`).
* `$B/dsh-session-query/lib/types/index.d.ts:41-118` — `ctx.sessionQuery.observeSession(id, options?)`,
  `readSession(id)`, `listSessions(signal?)`, `listEvents(id)`, `filterEvents(id, filters)`,
  `searchSessions`, `searchEvents`, `readTitle`, etc. Cold reads only.
* `$B/dsh-session-persistence/lib/types/index.d.ts:108-140` — `ctx.sessionPersistence.create(header, options?)`,
  `open(id, 'read'|'write', options?)`, `flush`, `stat`, `list`; `SessionHandle` is the
  per-session write/read handle (`handle.ts` types re-exported at `:15`).

`RESUME`: `ctx.agents.resume({ resumeSessionId, agentOptions, setup })`
(`dsh-agent/lib/types/index.d.ts:293-300`), or `SessionController` methods below (they
"explicitly resume" a Session internally).

**(B) `ctx.sessionController` — the Web Host business API (Web profile only)**

Mounted by `$B/dsh-web-app/cordis.patch.yml:117-118`; **not** in `dsh-base` or the SDK
profiles. It is a `TypertRemoteService` whose methods are also the generated
`ctx.remote.session` namespace (`$B/dsh-api-session-controller/lib/types/index.d.ts:43`,
super call `super(ctx, "sessionController", { namespace: "session" })` at
`$B/dsh-api-session-controller/lib/index.js:3791`). Its `static inject` requires a large Web
assembly: `["agentDefaultModel","agents","attachments","fileUploads","fs","llm",
"remoteAccess","sessions","sessionProjections","sessionQuery","typert","typertGateway",
"workspaceRegistry"]` (`$B/dsh-api-session-controller/lib/index.js:3752-3765`).

Verbatim method signatures (`$B/dsh-api-session-controller/lib/types/index.d.ts:94-259`):

```ts
list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue>;
create(request: SessionCreateRequest): Promise<SessionCreateValue>;                 // :100
selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue>;
fork(request: SessionForkRequest): Promise<SessionForkValue>;
/** Admit one prompt after explicitly resuming its Session. */
prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>; // :170
cancel(request: SessionCancelRequest): SessionCancelValue;                        // :188
events(request: SessionPageRequest, signal: AbortSignal): Promise<SessionEventsPage>;   // :203
/** Subscribe to Session events without reading a snapshot. */
observeEvent(request: SessionObserveEventRequest, signal: AbortSignal): AsyncIterable<SessionEventFrame>; // :210
observeProjections(request: SessionProjectionsRequest, signal: AbortSignal): AsyncIterable<SessionProjectionFrame>;
state(request: SessionStateRequest, signal: AbortSignal): Promise<SessionState>;
observeState(request: SessionStateRequest, signal: AbortSignal): AsyncIterable<SessionState>;
/** Wait for Session quiescence or pending input with bounded assistant output. */
wait(request: SessionWaitRequest, signal: AbortSignal): Promise<SessionWaitValue>;  // :238
/** Follow one Session log from its opening or resume cursor. */
follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>; // :246
control(signal: AbortSignal): AsyncIterable<SessionControlFrame>;
```

Request/response shapes (`$B/dsh-api-session-controller/lib/types/types.d.ts`):

```ts
export interface SessionCreateRequest {                                    // :264-273
    readonly workspaceId?: WorkspaceId; readonly cwd?: string;
    readonly sessionId?: SessionId; readonly agentPreset?: string;
}
export interface SessionCreateValue { readonly sessionId: SessionId; readonly agentPreset?: string; }  // :275-280
export interface SessionPromptRequest {                                    // :312-320
    readonly requestId: SessionRequestId; readonly sessionId: SessionId;
    readonly mode: 'queue' | 'steer';
    readonly content: readonly PromptContentPart[]; readonly clientTimeZone?: string;
}
export interface SessionPromptValue { readonly accepted: true; }             // :322-324
export type PromptContentPart =                                              // :67-78
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string }
    | { readonly type: 'file'; readonly receiptId: Branded<'file-upload-receipt-id'> };
export type SessionAddress =                                                // :386-394
    | { readonly kind: 'session'; readonly sessionId: SessionId }
    | { readonly kind: 'subagent'; readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: ... };
export interface SessionFollowRequest extends Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'> { // :467-473
    readonly address: SessionAddress;
    readonly activate?: boolean;
    readonly assistantStream?: true;
}
export type SessionFollowFrame =                                            // :526-537
    | { readonly type: 'snapshot'; header; cursor; records; hasMore; projections; assistantStream? }
    | SessionEventEntry
    | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame };
export interface SessionWaitRequest extends SessionStateRequest {           // :594-600
    readonly timeoutMs?: number; readonly afterSeq?: number; readonly maxMessages?: number;
}
export interface SessionWaitValue {                                         // :608-612
    readonly reason: 'idle' | 'input-required' | 'timeout';
    readonly state: SessionState; readonly output: SessionWaitOutput;
}
export interface SessionCancelRequest { readonly sessionId: SessionId; }     // :348-350
```

`resolveAgent(sessionId)` — "Resolve or resume one ordinary Session for another Host API
domain" (`:74-78`). **There is NO public `close()`/`dispose()` method on `SessionController`**
— NOT FOUND in `index.d.ts:44-260`. `cancel()` only cancels an active turn
(`:182-188`); `$B/dsh-api-session-controller/lib/types/types.d.ts:184` even has a
`'session/agent-busy'` error. To close, call the owning `AgentHandle.dispose()` (path A), or
dispose the fiber that owns the session.

**(C) SDK — an out-of-process profile, not an in-process plugin entry**

`$B/dsh-sdk-minimal/lib/types/index.d.ts:1-8`: "The package's substance is
`cordis.patch.yml` ... this module carries no runtime interface." `$D/README.md:5`:
> "SDK and ACP are profiles, not separate public bins."

`$B/dsh-sdk-protocol/lib/types/types.d.ts:196-229` is the newline-delimited JSON-RPC stdio
wire (`HarnessSdkRequestMap`):

```ts
'initialize': { params: InitializeParams; result: InitializeResult };
'session/prompt': { params: SessionPromptParams; result: SessionPromptResult };
'session/query': { params: SessionQueryParams; result: SessionQueryResult };
'session/resume': { params: SessionResumeParams; result: Record<string, never> };
'session/wait': { params: SessionWaitParams; result: Record<string, never> };
'session/working-directory/get' | '/set': ...;
'shutdown': { params: undefined; result: Record<string, never> };
```
Notifications: `'session.event'`, `'session.status'`, `'session.query.completed'`,
`'subagent.started'`, `'subagent.finished'`, `'user-question.cancelled'` (`:181-194`).
`SessionPromptParams = { sessionId: string; contentBlocks: SdkPromptContentBlock[] }`
(`:71-77`); an unknown `sessionId` "lazily creates the agent+session pair" (`:73`).
`SessionResumeParams = { sessionId }` (`:115-119`). `InitializeParams` carries `cwd`,
`provider`, `model`, `approvalRequests?`, `capabilities?` (`:16-33`).

Server implementation: `$B/dsh-sdk-jsonrpc-server/lib/types/server.d.ts:45-102` —
`initialize`, `prompt`, `query`, `resume`, `wait`, `getWorkingDirectory`,
`setWorkingDirectory`, `shutdown`, `handleRequest`. Its session creation
(`$B/dsh-sdk-jsonrpc-server/lib/index.js:765-790`) uses exactly path A:

```js
const rec = {
    handle: await (resume ? this.ctx.agents.resume({ resumeSessionId: brandString(sessionId), agentOptions, setup: ... })
                          : this.ctx.agents.create({ sessionId: brandString(sessionId), meta: { cwd: this.cwd }, agentOptions })),
    failure: void 0
};
```

`@deepseek-ai/dsh-sdk-client` is **NOT installed** in this checkout (only a
`devDependency` of `$D/package.json`), so a JS SDK client API is **NOT FOUND / unverified**
here. For a plugin running *inside* the DSH process, paths A/B above are the public entries;
the SDK is for driving DSH from another process.

### 3.3 Capability matrix (create / send / subscribe / resume / close)

| Action | Path A (`ctx.agents`) | Path B (`ctx.sessionController`, Web) | SDK (out-of-process) |
|---|---|---|---|
| CREATE | `await ctx.agents.create({ sessionId, meta:{cwd}, agentOptions })` | `await ctx.sessionController.create({ cwd?, sessionId?, agentPreset? })` | `session/prompt` with unknown id lazily creates |
| SEND | `handle.agent.followup(createUserMessage({content, source:{kind:'user'}}))` | `await ctx.sessionController.prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text}] }, signal)` | `session/prompt` / `session/query` |
| SUBSCRIBE | `ctx.on('session/event', ...)`, `ctx.on('agent/assistant-stream', ...)`, `ctx.sessionProjections.register(...)` | `ctx.sessionController.follow({ address, assistantStream:true }, signal)` → `AsyncIterable<SessionFollowFrame>`; `observeEvent`, `observeState`, `wait` | `session.event` / `session.status` notifications |
| RESUME | `await ctx.agents.resume({ resumeSessionId, agentOptions })` | `prompt`/`selectModel`/`fork` "explicitly resume"; `resolveAgent(sessionId)` | `session/resume` |
| CLOSE | `await handle.dispose()` (removes session from store) | **NOT FOUND** (no `close`); `cancel()` only cancels a turn | `shutdown` disposes the whole runtime |

---

## 4. Agent API (brief — do not build a second agent system)

* `ctx.agents` (`AgentRegistry`) is a **registry + factory delegation**, not a driver:
  > "Agent service: live registry, factory delegation, and process-local initiator scope.
  > Concrete creation and driving belong to the loop."
  > (`$B/dsh-agent/lib/types/index.d.ts:1-6`; `setFactory(factory)` at `:269-280`).
* `ctx.agentLoop` (`AgentLoop extends Service implements AgentFactory`) is the concrete
  driver; it registers itself via `setFactory` (`index.d.ts:84-160`). `Config.agents[]` can
  declaratively create/resume agents at startup with `{ id, sessionId?, cwd?,
  resumeSessionId?, provider?, model? }` (`index.d.ts:65-82`).
* An agent is bound to **session** by the shared `sessionId`; to **workspace** by
  `meta.cwd` / `CreateAgentOptions.meta.cwd` (validated absolute path —
  `$B/dsh-session/lib/types/index.d.ts:415-421`); to **model** by `AgentOptions`
  `{ provider, model, reasoningEffort?, maxTokens? }` or `agent.model.select(selection)`
  (`runtime-types.d.ts:47-64`); to **preset** by `meta.agentPreset` /
  `SessionCreateRequest.agentPreset`; and to an **agent-scoped context** by `agent.ctx`
  (`runtime-types.d.ts:175-176`).
* `$B/dsh-agent-preset/lib/types/index.d.ts:6-18` — `AgentPreset` default-export class
  registers a declarative `PresetDefinition` plugin row (child plugin configuration), it does
  **not** own Agents. `$B/dsh-agent-preset-registry/lib/types/mount.d.ts:65-76` —
  `mountPreset(ctx, id, plugins)` mounts a preset's entry list.
* Practical rule (`practices.md:19`): register per-agent behavior on `agent.ctx` obtained in
  an `agent/created` listener, and keep that disposer in your plugin's own effect too.
  `agent.inject()` does **not** wake the driver; `agent.followup()` does
  (`practices.md:29`).

---

## 5. Approval API

### 5.1 The asker side (`ctx.approval`)

`$B/dsh-user-approval/lib/types/index.d.ts:19-23,65-89,105-138`:

```ts
declare module '@deepseek-ai/cordis' { interface Context { approval: ApprovalService; } }
export interface ApprovalRequest extends ApprovalRequestEvent {
    readonly agent: Agent; readonly toolName: string;
    readonly callId?: ToolCallId; readonly reason?: string; readonly signal?: AbortSignal;
}
export declare class ApprovalService extends Service {
    static inject: string[];                 // ["sessionProjections"]
    static Config: z<Config>;
    setPolicy(agent: Agent, policy: ApprovalPolicy): void;
    request(req: ApprovalRequest): Promise<ApprovalOutcome>;
}
```

`ApprovalPolicy = 'ask' | 'never'` (`:44-54`); `'ask'` with no answerers fails closed to
`'unavailable'`; `'never'` auto-rejects. `ApprovalOutcome` (`types.d.ts:23-26`):

```ts
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
```

`request()` logs a durable `approval/asked` + `approval/decided` audit pair on the agent's
session (`$B/dsh-user-approval/lib/types/types.d.ts:27-53`) and requires an **open turn**
(`$B/dsh-user-approval/lib/index.js:155`). Real asker:
`$B/dsh-tools/lib/pipeline.js:624` — `const outcome = await approval.request({ ... })`.

### 5.2 The answerer / bridge side (this is where a Feishu channel plugs in)

`$B/dsh-user-approval/lib/types/types.d.ts:72-83`:

```ts
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Ask composed answerers for one decision. Return an outcome to claim the
         * request or call `next()` to delegate. Scope-filtered dispatch...
         * @mode waterfall
         */
        'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
    }
}
```

`ApprovalRequestEvent` = `{ agent, toolName, callId?, reason?, displayReason?, signal? }`
(`types.d.ts:54-71`). The service dispatches with a bail-out default
(`$B/dsh-user-approval/lib/index.js:201`):

```js
const answer = Promise.resolve().then(() => this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))).then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable", () => "unavailable");
```

**Bridge implementations found (copy these patterns):**

* Web UI: `$B/dsh-client-ui-approval/lib/client.js:475-477`:
  ```js
  ctx.remote.$on("approval/request", function(request, next) {
      return answerApproval(ctx, this, request, next, registerPendingInteraction);
  });
  ```
* Out-of-process SDK: `$B/dsh-sdk-jsonrpc-server/lib/index.js:381-393`:
  ```js
  this.disposers.push(ctx.on("approval/request", async (request, next) => {
      if (!this.approvalRequests || !this.ownsAgent(request.agent)) return next();
      const params = { sessionId: request.agent.session.id, toolName: request.toolName, ... };
      const signal = ...;
      const result = await this.transport.request("approval/request", params, signal);
      ... return result.outcome;
  }));
  ```
  Wire types `$B/dsh-sdk-protocol/lib/types/types.d.ts:230-252`:
  ```ts
  export interface ApprovalRequestParams {
      sessionId: string; toolName: string; callId?: string; reason?: string;
  }
  export interface ApprovalRequestResult {
      /** Only allowed-once permits the operation. */
      outcome: 'allowed-once' | 'rejected' | 'cancelled';
  }
  'approval/request': { params: ApprovalRequestParams; result: ApprovalRequestResult };
  ```
  Enabled by `InitializeParams.approvalRequests?: boolean` (`:19-20`).
* ACP bridge: `$B/dsh-acp/lib/index.js:1093-1110` sends `optionId: "allow-once"` /
  `"reject-once"` over its own transport.
* `$B/dsh-api-remotes/lib/index.js:24-28` forwards `'approval/request'` as a **waterfall**
  Remote event (so a browser client can answer).

So a Feishu gateway would register `ctx.on('approval/request', async (req, next) => {...})`,
push an interactive card, await the user's button, and return
`'allowed-once' | 'rejected' | 'cancelled'`; call `next()` for agents/channels it does not
own. Abort via `req.signal`. Note `$B/dsh-sdk-app/README.md:38` "The default
workspace-write/ask policy needs a client approval responder: enable `approvalRequests` and
handle `approval/request` ... Without one, the operation is refused as unavailable."

**NOT FOUND:** any Feishu/Lark-specific approval adapter in this checkout.

---

## 6. Schedule API (proactive triggers)

`$B/dsh-schedule/lib/types/index.d.ts:13-27,57-98`:

```ts
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** Restore a reminder's Session through its embedding's owning controller.
         *  Call next() to use the Web Session controller. @mode waterfall */
        'schedule/resolve-agent'(sessionId: SessionId, next: () => Promise<Agent>): Promise<Agent>;
    }
    interface Context { schedule: ScheduleService; }
}
export declare class ScheduleService extends TypertRemoteService {
    static inject: string[];   // ["agents","sessions","storageDomain","sessionPersistence"] — lib/index.js:2091-2096
    static Config: z<Config>;
    create(request: ScheduleCreateRequest, actorSessionId?: SessionId, signal?: AbortSignal): Promise<ScheduleCatalogEntry>;
    remoteCreate(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry>;
    list(request?: ScheduleListRequest): Promise<ScheduleListResult>;
    view(request: ScheduleViewRequest): Promise<ScheduleViewResult>;
    history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult>;
    run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult>;
    deleteInactive(): Promise<ScheduleDeleteInactiveResult>;
    edit(request: ScheduleEditRequest, actorSessionId?: SessionId, signal?: AbortSignal): Promise<ScheduleEditResult>;
}
```

`ScheduleCreateRequest` (`$B/dsh-schedule/lib/types/types.d.ts:418-428`) and timing/target:

```ts
export interface ScheduleCreateRequest {
    readonly title: string;      // ≤120 chars, non-empty after trim
    readonly prompt: string;     // instruction sent at each occurrence
    readonly timing: ScheduleTiming;
    readonly target?: ScheduleTargetRequest;   // omission ⇒ new_once
}
export type ScheduleTiming =                                     // :278-300
    | { kind:'after'; after_seconds:number } | { kind:'at'; at:AtInput }
    | { kind:'every'; every_seconds:number } | { kind:'daily'; daily:DailyInput }
    | { kind:'weekly'; weekly:WeeklyInput } | { kind:'cron'; cron:CronInput }
    | { kind:'rrule'; rrule:string };
export type ScheduleTargetRequest =                              // :328-343
    | { kind:'session'; sessionId:SessionId }
    | { kind:'new_once'; create?:ScheduleSessionCreateSpec }
    | { kind:'new'; create?:ScheduleSessionCreateSpec };
export interface ScheduleSessionCreateSpec {                    // :302-307
    readonly cwd?: string; readonly agentPreset?: string;
}
```

`ScheduleEditRequest` (`:466-478`) supports `title?`, `prompt?`, `timing?`, `target?`,
`active?` plus delete; `expectedUpdatedAt` gives `schedule_conflict` on mismatch.
`'schedule/changed'(): void` emit event (`:550-558`) signals durable task-set changes.
`ScheduleService.run()` "Deliver one task now without consuming or moving its scheduled
occurrence" (`index.d.ts:135-143`).

**How it proactively triggers**: delivery creates or resumes a DSH Session and injects the
task prompt into its inbox (`$B/dsh-schedule/lib/types/index.d.ts:50-56`; `ScheduleDeliveryReceipt`
at `types.d.ts:344-354` is "durable Session inbox delivery acknowledgment"). A plugin can
customize resolution via the `'schedule/resolve-agent'` waterfall — the SDK server does exactly
this (`$B/dsh-sdk-jsonrpc-server/lib/index.js:399-410`). So a plugin is triggered indirectly
through the agent/session it owns, e.g. by `target: { kind:'session', sessionId }` pointing
at a session your plugin observes via `session/event`.

`$B/dsh-tool-schedule` is only the **model-facing tool** wrapper:
`$B/dsh-tool-schedule/lib/types/index.d.ts:1-24` — register `schedule_create`,
`schedule_list`, `schedule_view`, `schedule_edit` tools over `ctx.schedule`;
`inject = ["tools","systemPrompt"]` (`lib/index.js:18`). `$B/dsh-schedule/package.json:3`
describes the Host service as "durable reminders with shared management and delivery to
existing or new Sessions".

For in-process timers (not durable reminders), `@deepseek-ai/cordis-plugin-timer` mixes
disposal-aware helpers onto `ctx` (`$B/cordis-plugin-timer/lib/types/index.d.ts:2-28`):
```ts
interface Context extends Pick<TimerService, 'interval'|'timeout'|'throttle'|'debounce'|'setTimeout'|'setInterval'> { timer: TimerService }
timeout(callback: () => void, delay: number): () => void;
timeout(delay: number): Promise<void>;
interval(callback: () => void, delay: number): () => void;
interval<R = any>(delay: number): AsyncIterableIterator<void, R, void>;
```
`practices.md:29` — "A timer that starts work calls `agent.followup()`, which wakes the agent;
`agent.inject()` does not wake it... Clear the timer in the owning effect."

---

## 7. Config / secrets

### 7.1 Schemastery config fields

`Config` is declared as `export const Config = z.object({...})` (§1.4). Meta builder methods
`$B/schemastery/lib/types/index.d.ts:98-124,150-194` include `.hidden(value?)`,
`.role(text, extra?)`, `.volatile()`, `.default()`, `.description()`, `.pattern()`,
`.required()`, `.loose()`. `Meta.role?: string` (`:112`) is a **renderer role**, not an
encryption primitive. **NOT FOUND:** any `.secret()` builder method, or built-in "secret"
schema type in `@deepseek-ai/schemastery` 3.19.0. `$B/dsh-client-ui-secret-mask` only masks
credential-shaped text drawn in the Web UI; it does not store secrets
(`$B/dsh-client-ui-secret-mask/README.md:12`, `:28`).

### 7.2 The official rule: secrets are NOT configuration

`$B/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:77`:

> "Store secrets, such as a token from an in-app sign-in or binding flow, as
> `ctx.credentials.modifyRecord()` records, **not configuration**; declare `credentials` in
> `inject` or read it with `ctx.get('credentials')`, and see the
> `@deepseek-ai/dsh-credentials` README for record keys."

`$B/dsh-credentials/README.md:12,30-32,48-58,63-80` — verbatim:

```ts
const ref = credentialRef('DEEPSEEK_API_KEY')          // POSIX shell identifier, branded
const hit = await ctx.credentials.resolve(ref)         // { value, source } | undefined
const info = await ctx.credentials.describe(ref)       // { configured, source?, writable } — never the value
await ctx.credentials.set(ref, 'sk-…')
await ctx.credentials.unset(ref)
```
```ts
const key = credentialKey('llm-pi-ai', 'openai-codex')   // <owner>/<id>
const hit = await ctx.credentials.readRecord(key)
await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { token: '…' } }))
await ctx.credentials.deleteRecord(key)
```
> "`modifyRecord` is the only write path... Key values never appear in configuration UIs or
> diagnostics" (`:78-99`). "If you only need one fixed environment variable, read that
> variable directly and skip the store." (`:32`)

### 7.3 Env-var patterns actually used in this checkout

* Named env-var **reference** in YAML config (not the value):
  `$B/dsh-sdk-minimal/cordis.patch.yml:26-29` — `config: { apiKeyEnv: DEEPSEEK_API_KEY, ... }`.
  `$B/dsh-credentials/README.md:84-88` explains: "A settings section or `cordis.yml` entry
  names a key instead of containing it — an LLM adapter, for example, takes `apiKeyEnv`".
* `!!js process.env...` Loader expressions evaluated against the plugin context:
  `$B/dsh-sdk-app/cordis.patch.yml:21` (`maxTokensAsSuccess`), `:34-44`
  (`DSH_PRIMARY_RUNTIME`, `DSH_BUNDLED_OFFICE_*`); `$B/dsh-sdk-minimal/cordis.patch.yml:30`
  (`DSH_CONTEXT_WINDOW`), `:118` (`DSH_SYSTEM_PROMPT`).
* Direct `process.env` reads inside plugin JS: `$B/dsh-sdk-jsonrpc-server/lib/index.js:819-820`
  uses `process.stdin` / `process.stdout`; the DSH CLI itself reads `DSH_HOME`
  (`$D/lib/types/profile-boot.d.ts:17-21`).
* `!!js` is **only** valid in Loader patch config, "never `!js`"
  (`cordis-composition-reference/SKILL.md:22`).

**Security notes:** a stored credential outranks the launching environment
(`dsh-credentials/README.md:94-95`); empty strings cannot be stored (`:96`); an empty
config value is different from a stored record (`:78`). Never log config values.

---

## 8. Version compatibility, engines, ESM, TypeScript

| Item | Evidence |
|---|---|
| Runtime version to match | `@deepseek-ai/dsh` = `@deepseek-ai/dsh-app-boot` = **`0.2.2-rc.1`**; `dsh --version` value is the check target (`$D/README.md:39`; `getDshRuntimeVersion()` at `$B/dsh-app-boot/lib/types/plugin-compatibility.d.ts:16`) |
| Node engine | `"engines": { "node": ">=24.9.0" }` (`$D/package.json:178-180`); running Node is `v24.22.2`. Cordis README says "Cordis is ESM-first... the scaffolder requires Node 22 or newer" (`$B/cordis/README.md:14-16`) but the **dsh CLI** dictates >=24.9.0 |
| ESM-only | Every inspected package has `"type": "module"` and `exports` with `"default": "./lib/index.js"`; e.g. `$B/cordis/package.json:9-19`, `$B/dsh-sdk-app/package.json:13,16-25`. Built output is `lib/index.js` + `lib/types/**/*.d.ts` (`SKILL.md:32`) |
| TypeScript requirement | **NOT required for a bundle.** `host-plugin.md:7`: "A Host-only bundle needs no dependencies, install scripts, or build tool". Official templates are plain `.js` (`templates/decoration/index.js`, `client.js`). `.d.ts` are shipped with every package for optional TS consumers; `dsh-package-manifest` is type-only (`$B/dsh-package-manifest/lib/types/index.d.ts:1-5`: "Public package manifest and plugin display types, with no runtime exports") |
| `engines.dsh` | `DshEnginesManifest.dsh?: string` — "Compatible DSH versions as a SemVer range, including an exact version" (`$B/dsh-package-manifest/lib/types/types.d.ts:56-66`); `$B/dsh-package-manifest/README.md:47-49` notes it "sits beside `engines.node` and `engines.npm`". See §2.5 for enforcement |
| Peer dependencies | `peerDependencies?: Record<string,string>` — "Compatible versions of packages supplied by the consuming project" (`types.d.ts:22-23`). In the installed tree, `@deepseek-ai/cordis: "~4.1.0"` is the universal peer; `@deepseek-ai/dsh-*` peers are exact `0.2.2-rc.1`. Profiles resolve shipped packages from the dsh installation, so a Host-only bundle declares no dependency on them (`SKILL.md:18`) |
| `allow-version` | See §2.5 — the only sanctioned exact-version exemption; gated by `--accept-risk` / `acceptRisk: true` and explicit user warning; not usable by plugin code to self-exempt |
| Compatibility refusal code | `'incompatible-version'` (`$B/dsh-plugin-manager/lib/types/types.d.ts:40`) with `IncompatiblePlugin[]` (`:30-37`); CLI exit code 1 (`$B/dsh-plugin-manager/lib/types/operations.d.ts:64`) |
| Exemption file | `PROFILE_COMPATIBILITY_FILENAME = "compatibility.json"` (`$B/dsh-app-boot/lib/types/profile-compatibility.d.ts:2`) in the profile directory |

---

## 9. MINIMAL VIABLE v0.1.0 RECIPE

Goal: a Host plugin that, on an inbound Feishu message, creates a DSH session (one per
chat), sends the user's text, and streams the assistant reply back. Uses **path A**
(`ctx.agents`), because it is the exact pattern DSH's own SDK server uses
(`$B/dsh-sdk-jsonrpc-server/lib/index.js:765-790,503-518`) and works in `web`, `base`,
`sdk`, and `sdk-minimal` profiles. `ctx.sessionController` (path B) is Web-only (§3.2).

### 9.1 `package.json`

```json
{
  "name": "@local/dsh-plugin-feishu-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json" },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": {
    "node": ">=24.9.0",
    "dsh": ">=0.2.2-rc.1 <0.3.0"
  }
}
```

Notes: no `dependencies` (shipped packages resolve from the dsh installation —
`SKILL.md:18`); no build step. If `">=0.2.2-rc.1 <0.3.0"` is rejected by the
compatibility preflight, pin the exact `"dsh": "0.2.2-rc.1"` — `engines.dsh` accepts an
exact version (`types.d.ts:58-59`) and an own `engines.dsh` range "decides alone and
peerDependencies are ignored" (`plugin-compatibility.d.ts:18-19`). Add locale files with
`meta.title` / `meta.description` and an `icon` before shipping (`host-plugin.md:29-51`).

### 9.2 `cordis.patch.yml`

```yaml
- insert:
    - id: feishu-gateway
      name: '@local/dsh-plugin-feishu-gateway'
      config:
        cwd: !!js process.cwd()
```

(`config` is validated by `Config` at activation; `!!js` is a Loader expression —
`cordis-composition-reference/SKILL.md:22`.)

### 9.3 `index.js`

```js
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'feishu-gateway'
export const inject = ['agents', 'agentLoop', 'sessions', 'llm']

export const Config = z.object({
  cwd: z.string().default(process.cwd()),
  // NEVER put a Feishu app secret here. See §7: use
  // ctx.credentials.resolve(credentialRef('FEISHU_APP_SECRET')) or process.env.
})

/** Map one Feishu chat id to one owned DSH AgentHandle. */
export function apply(ctx, config) {
  const handles = new Map()

  // ---- SUBSCRIBE: durable output + live tokens -------------------------------
  // ctx.on registrations are owned by this fiber (auto-removed on unload).
  ctx.on('session/event', (session, event) => {
    if (!isOurs(session.id)) return
    if (event.type === 'assistant/message') {
      // event.data is the durable, deeply-frozen assistant payload.
      sendToFeishu(chatOf(session.id), String(event.data?.content ?? ''))
    } else if (event.type === 'turn/end') {
      sendToFeishu(chatOf(session.id), '[turn complete]')
    }
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!isOurs(agent.session.id) || frame.type !== 'chunk') return
    // frame.chunk is a StreamChunk; render incrementally (transient, not durable).
    sendToFeishuDelta(chatOf(agent.session.id), frame.chunk)
  })

  // ---- CLOSE: dispose owned agents/sessions on plugin unload ----------------
  ctx.effect(() => async () => {
    await Promise.allSettled([...handles.values()].map(rec => rec.handle.dispose()))
    handles.clear()
  }, 'feishu-gateway.sessions')

  // ---- Public service other plugins / the Feishu listener can call ----------
  // NOTE: apply() must NOT return an object. Fiber._execute throws
  // TypeError('Invalid effect') for a non-null, non-disposer, non-iterable
  // return value ($B/cordis/src/fiber.ts:362-405).
  ctx.provide('feishuGateway', {
    /** CREATE on first message, SEND on every message. */
    async onMessage(chatId, text) {
      let rec = handles.get(chatId)
      if (!rec) {
        const sessionId = brandString(`feishu-${chatId}`)
        // CREATE (agent + session under one caller-supplied identity).
        const handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: config.cwd },
          // agentOptions: { provider: 'deepseek', model: 'deepseek-chat' }
          //   ^ omit to inherit the profile's configured model route.
        })
        rec = { handle, sessionId }
        handles.set(chatId, rec)
      }
      // SEND: queue an ordinary follow-up turn and wake the driver.
      rec.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      return rec.sessionId
    },

    /** RESUME an existing persisted session into a live agent. */
    async resume(chatId, sessionId) {
      const handle = await ctx.agents.resume({
        resumeSessionId: brandString(sessionId),
      })
      handles.set(chatId, { handle, sessionId: brandString(sessionId) })
    },

    /** CLOSE one chat's session. */
    async close(chatId) {
      const rec = handles.get(chatId)
      if (!rec) return
      handles.delete(chatId)
      await rec.handle.dispose()
    },
  })

  // ---- Feishu event subscription (your transport) ---------------------------
  // ctx.effect(() => { const sub = larkEventSubscribe(...); return () => sub.close() },
  //            'feishu-gateway.transport')

  function isOurs(sessionId) {
    for (const rec of handles.values()) if (String(rec.sessionId) === String(sessionId)) return true
    return false
  }
  function chatOf(sessionId) {
    for (const [chatId, rec] of handles) if (String(rec.sessionId) === String(sessionId)) return chatId
    return undefined
  }
}

// Stubs — replace with lark-cli / Feishu OpenAPI calls.
function sendToFeishu(chatId, text) { console.log('[feishu]', chatId, text) }
function sendToFeishuDelta(chatId, chunk) { console.log('[feishu:chunk]', chatId, chunk) }
```

### 9.4 Alternative: Web-profile-only `ctx.sessionController` path (path B)

Only if the plugin is guaranteed to run in the `web` profile
(`$B/dsh-web-app/cordis.patch.yml:117-118`); add `'sessionController'` to `inject`:

```js
export const inject = ['sessionController']

export function apply(ctx) {
  ctx.inject(['sessionController'], async (scope) => {
    const ac = new AbortController()
    scope.effect(() => () => ac.abort())

    // CREATE
    const { sessionId } = await scope.sessionController.create({ cwd: process.cwd() })

    // SUBSCRIBE (open BEFORE the prompt so no frames are missed)
    const stream = scope.sessionController.follow({
      address: { kind: 'session', sessionId },
      assistantStream: true,          // typed `true`, not boolean
    }, ac.signal)
    const reader = (async () => {
      for await (const frame of stream) {
        if (frame.type === 'event' && frame.event.type === 'assistant/message') {
          console.log('[feishu]', JSON.stringify(frame.event.data))
        } else if (frame.type === 'assistant-stream' && frame.frame.type === 'chunk') {
          console.log('[feishu:chunk]', JSON.stringify(frame.frame.chunk))
        } else if (frame.type === 'snapshot') {
          console.log('[feishu] cursor', frame.cursor)
        }
      }
    })()

    // SEND
    await scope.sessionController.prompt({
      requestId: crypto.randomUUID(),  // Branded<'session-request-id'>; a plain string is the runtime shape
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Hello from Feishu' }],
    }, ac.signal)

    // Wait for quiescence (or use `wait({ sessionId, timeoutMs })`).
    // CLOSE: cancel + abort the stream; SessionController has no close() (§3.2).
    scope.sessionController.cancel({ sessionId })
    ac.abort()
    await reader
  })
}
```

Verified signatures: `SessionCreateRequest`, `SessionPromptRequest`, `SessionFollowRequest`,
`SessionFollowFrame`, `SessionCancelRequest` at
`$B/dsh-api-session-controller/lib/types/types.d.ts:264-280,312-324,467-473,526-537,348-350`;
`follow()`/`prompt()`/`cancel()` at
`$B/dsh-api-session-controller/lib/types/index.d.ts:170,210,246,188`.

### 9.5 Install (do NOT hand-edit the profile)

Use `plugin_manager` `action: install_bundle`, `target: <absolute package dir>`, with
`enabled` default true (`SKILL.md:8-10`, `$B/dsh-plugin-manager/lib/types/index.d.ts:194-208`).
For this session, `plugin_manager` actions require Full access; with approval prompts disabled
they would be rejected automatically. CLI equivalent:
`dsh plugin --profile <name> add <absolute package dir>` (`$D/README.md:18`).

### 9.6 Guardrails for v0.1.0

1. **Do not build a second agent system** — always go through `ctx.agents.create/resume`
   (§4). Never write `Session.append()` events of a new `type`; unknown event types make the
   log unreadable (`practices.md:21`, `$B/dsh-session/lib/types/known-event-types.d.ts:7-20`).
2. Register everything in `apply` via `ctx.effect` / `ctx.on` / `ctx.provide`; `apply` must
   return nothing (§9.3 note).
3. Secrets: `process.env.FEISHU_APP_SECRET` or `ctx.credentials` records, **never** `Config`
   (§7).
4. Approval bridge: `ctx.on('approval/request', (req, next) => ...)` returning one of the four
   `ApprovalOutcome` values, or `next()` (§5).
5. Proactive triggers: `ctx.schedule.create({ title, prompt, timing, target })` with
   `target: { kind: 'session', sessionId }`, or `ctx.timeout(...)` from
   `@deepseek-ai/cordis-plugin-timer` (§6).
6. Pin `engines.dsh` and do not rely on `allow-version` — an exemption requires explicit user
   risk acceptance and cannot be granted by plugin code (§2.5).

---

## 10. Explicit NOT FOUND / unverified list

| Item | Status |
|---|---|
| `Context.service` static, `ctx.scope`, `ctx.on('ready')`, `ctx.on('dispose')`, `ctx.fork()` | **NOT FOUND** in installed `@deepseek-ai/cordis` 4.1.0 (§1.2). Replacements documented there. |
| `SessionController.close()` / `dispose()` | **NOT FOUND** (`$B/dsh-api-session-controller/lib/types/index.d.ts:44-260`). Use `AgentHandle.dispose()` or fiber disposal. |
| Public `SessionStore.close()` / `dispose()` | **NOT FOUND** (`$B/dsh-session/lib/types/index.d.ts:386-527`; detach is private). |
| Schemastery `.secret()` / built-in secret schema type | **NOT FOUND** (`$B/schemastery/lib/types/index.d.ts:98-194`). Use `ctx.credentials` + env vars (§7). |
| Any Feishu/Lark-specific DSH adapter | **NOT FOUND** in this checkout. |
| `@deepseek-ai/dsh-sdk-client` JS package | **NOT INSTALLED** here (only a devDependency of `$D/package.json`); its API is **unverified**. |
| A rule literally "forbidding `allow-version`" | **NOT FOUND**; it exists as the sole documented exact-version exemption, gated by `--accept-risk`/`acceptRisk` (§2.5). |
| Any shipped package that actually declares `engines.dsh` | **NONE** in this installed tree (§2.5). |
| `dsh.plugin.d.ts` as plugin-authoring API | It is only `runPlugin()` CLI helper (§2.2). |
| Runtime behavior of `Context.extend/isolate/intercept` details | Declared (`context.d.ts:61-99`) but not exercised in this report; unverified in practice. |
