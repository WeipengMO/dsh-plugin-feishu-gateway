# DSH Cordis Plugin Examples — Research Report

**Purpose:** concrete, verified examples of real installable DSH Cordis plugins from the
local checkout, to scaffold a brand-new third-party **Feishu/Lark channel gateway** (an
external network service that pushes messages into DSH).

**Scope / method (all read-only):**

- `BASE = /home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
- Runtime checkout: `/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/` (the `dsh` CLI).
- Active profile: `web`, at `/home/ubuntu/.dsh/profiles/web/` (`DSH_HOME=/home/ubuntu/.dsh`).
- Only file reads, `find`/`ls`, and the three safe CLI invocations `dsh --help`,
  `dsh plugin --help`, `dsh plugin --profile web --help` were executed. **No install,
  no config edit, no `pnpm`/`dsh plugin add`, no network.** Only `--help` commands were
  run against the CLI; everything else was reading files.
- Every claim below is traceable to a file path and line numbers. Items that could not be
  verified are listed explicitly in §6 ("Unverified / not found").

**Key discovery:** this installation ships an authoritative, first-party scaffolding guide
inside the `dsh-agent-preset` package — the skill `cordis-plugin-development` with two ready
templates (`decoration`, `mcp`). It is far more definitive than reverse-engineering a
shipped plugin, and its skeleton is reproduced verbatim in §2.5 and Appendix A.

---

## 0. TL;DR — what a new third-party plugin needs

1. One npm package, ESM (`"type": "module"`), whose **main entry** exports a Cordis plugin:
   either `export function apply(ctx, config) {}` (+ optional `export const inject`,
   `export const Config`) **or** a `Service` subclass as the **default export**. Do not mix.
2. `package.json` must carry `dsh.bundle.patch: "./cordis.patch.yml"`. **The manifest IS
   `package.json`** — there is no separate manifest file. `@deepseek-ai/dsh-package-manifest`
   is a *types-only* package (`lib/index.js` is literally `export {};`).
3. A `cordis.patch.yml` containing `- insert: - id: <unique> name: '<pkg>' config: {...}`.
4. `peerDependencies` on `@deepseek-ai/cordis` (`~4.1.0`), and `engines.dsh` as a semver
   range matching the runtime (`0.2.2-rc.1`) — otherwise the plugin manager refuses
   installation with `incompatible-version`.
5. Install for local testing with
   `dsh plugin --profile web add <absolute-path-to-package-dir>` (or `add ./relative/path`,
   resolved against the caller's cwd), or with the in-app `plugin_manager` tool's
   `install_bundle` action using the absolute directory as `target`.
6. Enablement = the package appears in the profile's `package.json` `dependencies` **and**
   in `dsh.profile.bundles`. Config is passed by a `config:` block on the plugin row in
   `cordis.patch.yml` (bundle patch or the profile's own user patch).

---

## 1. The three chosen representative plugins

### Why these three

| # | Package | Version | Size | Why chosen |
|---|---------|---------|------|------------|
| 1 | `@michengai/dsh-archive-manager` | 1.3.5 | ~320 KB, 250-line entry | **The only real third-party (non-`@deepseek-ai`) installable Cordis plugin present in the checkout**, and it is *actually installed and enabled* in the running `web` profile. It is the single best model for a brand-new third-party plugin's package shape, manifest, locale, icon, and install command. |
| 2 | `@deepseek-ai/dsh-otel` | 0.2.2-rc.1 | 112 KB, 409-line entry | Small Cordis `Service` plugin that owns **long-lived outbound network transports** (OTLP over HTTP) and implements careful **cleanup/unload**. Best model for the "connect to a network service" half. |
| 3 | `@deepseek-ai/dsh-tool-schedule` | 0.2.2-rc.1 | 108 KB, 693-line entry | Small **plain-object plugin** (`export { name, inject, apply }`), the minimal Host-plugin shape; shows `ctx.inject(...)`, service consumption, and tool registration. |

**Supplementary deep-dive (§1.4):** `@deepseek-ai/dsh-schedule` — the canonical
`static Config` (schemastery) + `static inject` + `ctx.effect` teardown pattern, and the
exact code that **pushes a user message into a DSH Session** (`agent.inject(createUserMessage(...))`).
This is the closest first-party analogue to a channel gateway's delivery side.

**Rejected candidates (verified present but not chosen):**

- `dsh-webhook`, `dsh-webhook-github` — **NOT INSTALLED** anywhere on this machine. They
  appear only as two rows in the shipped catalog
  `dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:237-238`
  ("Fire-and-forget webhook rule runtime that creates Workspace-backed DeepSeek Harness
  Sessions" / "Signed GitHub HTTP webhook adapter"). **Unverified — see §6.** This is a
  shame because `dsh-webhook` would be the ideal example; the catalog line is all the
  evidence available locally.
- `dsh-http-proxy` — explicitly **a library, not a plugin**: `lib/types/index.d.ts:9-10`
  says *"This is a library, not a plugin: transport policy has one answer per process, so
  there is nothing for a composition to mount, swap, or scope."* Its `lib/index.js` only
  exports four functions (`clearedProxyEnv`, `installProxyFromEnvironment`,
  `proxyEnvironmentForChild`, `proxyRouteFor`), no `apply`/`Service`.
- `dsh-plugin-manager`, `dsh-plugin-detail`, `dsh-package-manifest` — utility/service
  packages, not representative plugin entries (but they are the sources used in §2/§3).
- `node_modules/bundle-name` — unrelated npm helper (macOS bundle identifiers), **not** a
  DSH bundle.

---

### 1.1 `@michengai/dsh-archive-manager` (real third-party plugin)

**Location:** `/home/ubuntu/.dsh/profiles/web/node_modules/@michengai/dsh-archive-manager/`
Installed via pnpm into the `web` profile; recorded as
`"@michengai/dsh-archive-manager": "^1.3.5"` in the profile's `package.json` and listed
in `dsh.profile.bundles`.

#### Full `package.json`

```json
{
  "name": "@michengai/dsh-archive-manager",
  "version": "1.3.5",
  "description": "归档、恢复、收藏和永久删除会话，并诊断损坏的会话日志。 · Archive, restore, favorite, and permanently delete sessions, and diagnose damaged session logs.",
  "type": "module",
  "packageManager": "pnpm@11.22.0",
  "engines": {
    "node": "^22.19.0 || >=24.0.0",
    "dsh": ">=0.2.0-rc.1 <0.3.0-0"
  },
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./workspace": "./lib/workspace.js",
    "./projcache": "./lib/projcache.js",
    "./host": "./lib/host-install.js",
    "./client": "./lib/client.js",
    "./icon": "./assets/icon.svg",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": [
    "lib",
    "assets",
    "locale",
    "cordis.patch.yml",
    "README.md",
    "README.en.md",
    "README.ja.md",
    "README.es.md",
    "README.fr.md",
    "README.de.md",
    "README.ru.md",
    "README.pt.md",
    "README.zh-CN.md",
    "LICENSE",
    "CHANGELOG.md",
    "CHANGELOG.zh-CN.md"
  ],
  "scripts": {
    "build": "pnpm typecheck && node scripts/build.mjs && node scripts/check-package.mjs",
    "test": "pnpm build && node --import tsx --test test/*.test.mjs",
    "test:matrix": "pnpm build && node scripts/test-version-matrix.mjs",
    "test:latest": "pnpm build && node scripts/test-latest-compatibility.mjs",
    "test:compat": "pnpm build && pnpm test:matrix",
    "pack:check": "pnpm pack --dry-run",
    "verify": "pnpm test && pnpm test:compat && pnpm pack:check && node scripts/check-generated.mjs",
    "release:preflight": "pwsh -NoProfile -File scripts/release-preflight.ps1",
    "prepublishOnly": "pnpm verify",
    "prepack": "pnpm build",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.1 <5.0.0",
    "@deepseek-ai/dsh-client-connection": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-client-locale": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-client-ui-conversation": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-client-ui-primitives": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-client-ui-sidebar": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-client-ui-workspace": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-host-webserver": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-session": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-session-format-catalog": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-session-projection-cache": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-spill-local": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-storage-domain": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-typert-protocol": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-typert-registry": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-workspace": ">=0.2.0-rc.1 <0.3.0-0"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/dsh-session-format-catalog": {
      "optional": true
    }
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.1.0",
    "@deepseek-ai/dsh-api-gateway": "0.2.2-rc.2",
    "@deepseek-ai/dsh-client-connection": "0.2.2-rc.2",
    "@deepseek-ai/dsh-client-locale": "0.2.2-rc.2",
    "@deepseek-ai/dsh-client-store": "0.2.2-rc.2",
    "@deepseek-ai/dsh-client-ui-conversation": "0.2.2-rc.2",
    "@deepseek-ai/dsh-client-ui-primitives": "0.2.2-rc.2",
    "@deepseek-ai/dsh-client-ui-renderer": "0.2.2-rc.2",
    "@deepseek-ai/dsh-client-ui-sidebar": "0.2.2-rc.2",
    "@deepseek-ai/dsh-client-ui-slots": "0.2.2-rc.2",
    "@deepseek-ai/dsh-client-ui-workspace": "0.2.2-rc.2",
    "@deepseek-ai/dsh-error": "0.2.2-rc.2",
    "@deepseek-ai/dsh-host-webserver": "0.2.2-rc.2",
    "@deepseek-ai/dsh-scope": "0.2.2-rc.2",
    "@deepseek-ai/dsh-session": "0.2.2-rc.2",
    "@deepseek-ai/dsh-session-format-catalog": "0.2.2-rc.2",
    "@deepseek-ai/dsh-session-persistence": "0.2.2-rc.2",
    "@deepseek-ai/dsh-session-projection": "0.2.2-rc.2",
    "@deepseek-ai/dsh-session-projection-cache": "0.2.2-rc.2",
    "@deepseek-ai/dsh-spill": "0.2.2-rc.2",
    "@deepseek-ai/dsh-spill-local": "0.2.2-rc.2",
    "@deepseek-ai/dsh-storage": "0.2.2-rc.2",
    "@deepseek-ai/dsh-storage-domain": "0.2.2-rc.2",
    "@deepseek-ai/dsh-typert-protocol": "0.2.2-rc.2",
    "@deepseek-ai/dsh-typert-registry": "0.2.2-rc.2",
    "@deepseek-ai/dsh-workspace": "0.2.2-rc.2",
    "@types/node": "^22.20.4",
    "@types/react": "^18.3.31",
    "@types/react-dom": "^18.0.0",
    "esbuild": "0.25.0",
    "immer": "10.1.1",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "semver": "7.7.2",
    "tsx": "^4.23.13",
    "typescript": "5.9.3",
    "zustand": "4.4.7"
  },
  "license": "Apache-2.0",
  "author": "MichengAI",
  "dsh": {
    "manifestVersion": 1,
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-workspace",
        "@deepseek-ai/dsh-typert-registry",
        "@deepseek-ai/dsh-client-connection"
      ],
      "platform": "web"
    }
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/MichengAI/dsh-archive-manager.git"
  },
  "homepage": "https://github.com/MichengAI/dsh-archive-manager#readme",
  "bugs": {
    "url": "https://github.com/MichengAI/dsh-archive-manager/issues"
  },
  "keywords": [
    "deepseek",
    "dsh",
    "dsh-plugin",
    "archive",
    "session-management",
    "diagnose",
    "favorites",
    "restore",
    "cordis",
    "typert",
    "workspace",
    "nodejs",
    "esm"
  ],
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "icon": "assets/icon.svg"
}
```

#### Full directory tree

```text
@michengai/dsh-archive-manager/
  CHANGELOG.md
  CHANGELOG.zh-CN.md
  LICENSE
  README.de.md
  README.en.md
  README.es.md
  README.fr.md
  README.ja.md
  README.md
  README.pt.md
  README.ru.md
  README.zh-CN.md
  cordis.patch.yml
  package.json
  assets/
  assets/icon.png
  assets/icon.svg
  assets/branding/
  assets/branding/banner.txt
  assets/branding/dsh-banner-en.webp
  assets/branding/dsh-banner.webp
  assets/screenshots/
  assets/screenshots/archived-sessions.webp
  assets/screenshots/main-view-panel.webp
  assets/screenshots/session-move-menu.webp
  assets/screenshots/unarchived-sessions.webp
  assets/screenshots/workspace-context-menu.webp
  lib/
  lib/api-base.js
  lib/archive-discovery.js
  lib/archive-experience.js
  lib/archive-organizer.js
  lib/cache-rebuild-client.js
  lib/cache-rebuild-contract.js
  lib/cache-rebuild.js
  lib/client.js
  lib/contracts.js
  lib/explorer-path-policy.js
  lib/host-install.js
  lib/index.js
  lib/native-explorer.js
  lib/plugin-settings.js
  lib/projcache.js
  lib/session-move.js
  lib/sidebar-entry.js
  lib/workspace.js
  locale/
  locale/de.json
  locale/en.json
  locale/es.json
  locale/fr.json
  locale/ja.json
  locale/pt.json
  locale/ru.json
  locale/zh.json
```

#### `cordis.patch.yml` (the bundle's manifest patch)

```yaml
    1  # 不替换官方 workspace / session-projection-cache。
    2  # 这两个服务分别撑着 workspaceController 和会话投影。
    3  # 禁用本插件时如果把它们关掉，官方实现又不会回来，侧栏工作区会消失，
    4  # 创建工作区会报 workspaceController unavailable。
    5  # 归档能力由 ui-workspace-archive-manager 这一条入口装上，停用时卸下。
    6  # 不要再插入单独的 host 行：插件页可以只关掉那一行，界面还在，诊断就会 404。
    7  # 自定义侧栏通过优先级覆盖插槽；发布后的安装命令：
    8  #   dsh plugin --profile web add @michengai/dsh-archive-manager
    9  #
   10  # DSH 0.2.1-rc.1 起官方已无 ui-settings-unarchive-sessions 入口；
   11  # 再 disable 会在 dump-config 告警「entry not found」，故不再写入该补丁。
   12  - id: ui-workspace
   13    disabled: false
   14  - insert:
   15      - id: ui-workspace-archive-manager
   16        name: '@michengai/dsh-archive-manager'
```

Note line 8 — the plugin's own authors document the exact install command:

```
#   dsh plugin --profile web add @michengai/dsh-archive-manager
```

#### Main entry `lib/index.js` (full, with line numbers)

```js
    1  import { getEntryLocation, getSidebarFavoriteStarMode, setEntryLocation, setSidebarFavoriteStarMode } from "./plugin-settings.js";
    2  import { symbols } from "@deepseek-ai/cordis";
    3  import { apply as installHost, inject as hostInject } from "./host-install.js";
    4  import { authorizeExplorerPath } from "./explorer-path-policy.js";
    5  import { revealPathInSystem } from "./native-explorer.js";
    6  const inject = ["webServer", ...hostInject];
    7  const SIDEBAR_ENTRY_ENDPOINT = "/api/michengai/dsh-archive-manager/sidebar-entry";
    8  const SIDEBAR_FAVORITE_STAR_ENDPOINT = "/api/michengai/dsh-archive-manager/sidebar-favorite-star";
    9  const OPEN_IN_EXPLORER_ENDPOINT = "/api/michengai/dsh-archive-manager/open-in-explorer";
   10  const TRUSTED_MUTATION_HEADER = "x-michengai-archive-settings";
   11  function header(request, name) {
   12    const value = request.headers?.[name];
   13    return Array.isArray(value) ? value[0] : value;
   14  }
   15  function isLoopbackAddress(value) {
   16    const address = value?.toLowerCase().replace(/^\[|\]$/g, "");
   17    return address === "localhost" || address === "localhost." || address === "::1" || address?.startsWith("127.") === true || address?.startsWith("::ffff:127.") === true;
   18  }
   19  function isTrustedLocalRequest(request) {
   20    if (header(request, TRUSTED_MUTATION_HEADER) !== "1") return false;
   21    if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
   22    const site = header(request, "sec-fetch-site");
   23    if (site !== void 0 && site !== "same-origin") return false;
   24    const host = header(request, "host");
   25    if (host === void 0 || host === "") return false;
   26    const origin = header(request, "origin");
   27    if (origin === void 0 || origin === "") {
   28      try {
   29        return isLoopbackAddress(new URL(`http://${host}`).hostname);
   30      } catch {
   31        return false;
   32      }
   33    }
   34    try {
   35      const url = new URL(origin);
   36      return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackAddress(url.hostname) && url.host === host;
   37    } catch {
   38      return false;
   39    }
   40  }
   41  const managedRoutes = Symbol.for("dsh-archive-manager.managed-routes");
   42  function managedRouteBag(server) {
   43    const owner = server;
   44    return owner[managedRoutes] ?? (owner[managedRoutes] = /* @__PURE__ */ new Map());
   45  }
   46  function rawService(service) {
   47    const original = Reflect.get(service, symbols.original);
   48    return original !== null && typeof original === "object" ? original : service;
   49  }
   50  function releaseManagedRoute(server, path) {
   51    const raw = rawService(server);
   52    const bag = managedRouteBag(raw);
   53    const owned = bag.get(path);
   54    if (owned !== void 0) {
   55      bag.delete(path);
   56      owned();
   57    }
   58    for (const key of ["exact", "prefixes"]) {
   59      const table = Reflect.get(raw, key);
   60      if (table instanceof Map && table.has(path)) table.delete(path);
   61    }
   62  }
   63  function sendJson(response, statusCode, value) {
   64    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
   65    response.end(JSON.stringify(value));
   66  }
   67  function readJsonBody(request) {
   68    return new Promise((resolve) => {
   69      const chunks = [];
   70      let bytes = 0;
   71      request.on("data", (chunk) => {
   72        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
   73        bytes += buffer.length;
   74        if (bytes > 64 * 1024) return;
   75        chunks.push(buffer);
   76      });
   77      request.on("end", () => {
   78        try {
   79          const raw = Buffer.concat(chunks).toString("utf8");
   80          const parsed = JSON.parse(raw);
   81          resolve(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
   82        } catch {
   83          resolve(null);
   84        }
   85      });
   86      request.on("error", () => resolve(null));
   87    });
   88  }
   89  function registerSettingsRoutes(ctx) {
   90    const server = rawService(ctx.webServer);
   91    releaseManagedRoute(server, SIDEBAR_ENTRY_ENDPOINT);
   92    releaseManagedRoute(server, SIDEBAR_FAVORITE_STAR_ENDPOINT);
   93    releaseManagedRoute(server, OPEN_IN_EXPLORER_ENDPOINT);
   94    const disposeSidebar = ctx.webServer.register({
   95      kind: "exact",
   96      path: SIDEBAR_ENTRY_ENDPOINT,
   97      handler: async (request, response) => {
   98        if (request.method === "GET" || request.method === "HEAD") {
   99          const location = await getEntryLocation();
  100          sendJson(response, 200, { ok: true, location, enabled: location !== "settings" });
  101          return;
  102        }
  103        if (request.method === "POST") {
  104          if (!isTrustedLocalRequest(request)) {
  105            sendJson(response, 403, { ok: false, error: "\u5DF2\u62D2\u7EDD\u975E\u672C\u673A\u540C\u6E90\u8BF7\u6C42\u3002" });
  106            return;
  107          }
  108          const body = await readJsonBody(request);
  109          if (!body) {
  110            sendJson(response, 400, { ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u80FD\u4E3A\u7A7A" });
  111            return;
  112          }
  113          if (typeof body.location === "string") {
  114            if (body.location !== "both" && body.location !== "sidebar" && body.location !== "settings") {
  115              sendJson(response, 400, { ok: false, error: "location \u5FC5\u987B\u662F both\u3001sidebar \u6216 settings" });
  116              return;
  117            }
  118            const location = await setEntryLocation(body.location);
  119            sendJson(response, 200, { ok: true, location, enabled: location !== "settings" });
  120            return;
  121          }
  122          if (typeof body.enabled === "boolean") {
  123            const location = await setEntryLocation(body.enabled ? "both" : "settings");
  124            sendJson(response, 200, { ok: true, location, enabled: location !== "settings" });
  125            return;
  126          }
  127          sendJson(response, 400, { ok: false, error: "\u7F3A\u5C11\u5408\u6CD5\u7684 location \u6216 enabled \u53C2\u6570" });
  128          return;
  129        }
  130        response.writeHead(405, { allow: "GET, HEAD, POST" });
  131        response.end();
  132      }
  133    });
  134    const disposeFavoriteStar = ctx.webServer.register({
  135      kind: "exact",
  136      path: SIDEBAR_FAVORITE_STAR_ENDPOINT,
  137      handler: async (request, response) => {
  138        if (request.method === "GET" || request.method === "HEAD") {
  139          const mode = await getSidebarFavoriteStarMode();
  140          sendJson(response, 200, { ok: true, mode, enabled: mode !== "none" });
  141          return;
  142        }
  143        if (request.method === "POST") {
  144          if (!isTrustedLocalRequest(request)) {
  145            sendJson(response, 403, { ok: false, error: "\u5DF2\u62D2\u7EDD\u975E\u672C\u673A\u540C\u6E90\u8BF7\u6C42\u3002" });
  146            return;
  147          }
  148          const body = await readJsonBody(request);
  149          if (!body) {
  150            sendJson(response, 400, { ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u80FD\u4E3A\u7A7A" });
  151            return;
  152          }
  153          let targetMode;
  154          if (typeof body.mode === "string") {
  155            if (body.mode !== "all" && body.mode !== "favorites" && body.mode !== "none") {
  156              sendJson(response, 400, { ok: false, error: "mode \u5FC5\u987B\u662F all\u3001favorites \u6216 none" });
  157              return;
  158            }
  159            targetMode = body.mode;
  160          } else if (typeof body.enabled === "boolean") {
  161            targetMode = body.enabled ? "all" : "none";
  162          } else {
  163            sendJson(response, 400, { ok: false, error: "\u7F3A\u5C11\u5408\u6CD5\u7684 mode \u6216 enabled \u53C2\u6570" });
  164            return;
  165          }
  166          const mode = await setSidebarFavoriteStarMode(targetMode);
  167          sendJson(response, 200, { ok: true, mode, enabled: mode !== "none" });
  168          return;
  169        }
  170        response.writeHead(405, { allow: "GET, HEAD, POST" });
  171        response.end();
  172      }
  173    });
  174    const disposeOpenExplorer = ctx.webServer.register({
  175      kind: "exact",
  176      path: OPEN_IN_EXPLORER_ENDPOINT,
  177      handler: async (request, response) => {
  178        if (request.method !== "POST") {
  179          response.writeHead(405, { allow: "POST" });
  180          response.end();
  181          return;
  182        }
  183        if (!isTrustedLocalRequest(request)) {
  184          sendJson(response, 403, { ok: false, error: "\u5DF2\u62D2\u7EDD\u975E\u672C\u673A\u540C\u6E90\u8BF7\u6C42\u3002" });
  185          return;
  186        }
  187        const body = await readJsonBody(request);
  188        const path = typeof body?.path === "string" ? body.path : "";
  189        const registry = ctx.get("workspaceRegistry");
  190        const registeredPaths = typeof registry?.list === "function" ? registry.list().map((w) => w.path) : [];
  191        const authorizedPath = authorizeExplorerPath(path, registeredPaths);
  192        if (authorizedPath === void 0) {
  193          sendJson(response, 403, { ok: false, error: "\u4EC5\u5141\u8BB8\u6253\u5F00\u5DF2\u6CE8\u518C\u7684\u5DE5\u4F5C\u533A\u76EE\u5F55\u3002" });
  194          return;
  195        }
  196        try {
  197          const result = await revealPathInSystem(authorizedPath);
  198          sendJson(response, 200, { ok: true, opened: true, via: result.via });
  199        } catch (error) {
  200          ctx.logger?.warn?.(`open in explorer failed: ${String(error)}`);
  201          sendJson(response, 500, { ok: false, error: "\u6253\u5F00\u7CFB\u7EDF\u8D44\u6E90\u7BA1\u7406\u5668\u5931\u8D25\u3002" });
  202        }
  203      }
  204    });
  205    return () => {
  206      try {
  207        disposeSidebar();
  208      } catch {
  209      }
  210      try {
  211        disposeFavoriteStar();
  212      } catch {
  213      }
  214      try {
  215        disposeOpenExplorer();
  216      } catch {
  217      }
  218    };
  219  }
  220  async function apply(ctx, _config) {
  221    let disposeSettingsRoutes = () => {
  222    };
  223    try {
  224      disposeSettingsRoutes = registerSettingsRoutes(ctx);
  225    } catch (error) {
  226      ctx.logger?.warn?.(`archive-manager: settings routes skipped: ${String(error)}`);
  227    }
  228    let disposeHost;
  229    try {
  230      disposeHost = await installHost(ctx);
  231    } catch (error) {
  232      disposeSettingsRoutes();
  233      throw error;
  234    }
  235    return async () => {
  236      try {
  237        disposeSettingsRoutes();
  238      } finally {
  239        await disposeHost();
  240      }
  241    };
  242  }
  243  export {
  244    OPEN_IN_EXPLORER_ENDPOINT,
  245    SIDEBAR_FAVORITE_STAR_ENDPOINT,
  246    apply,
  247    inject,
  248    isTrustedLocalRequest,
  249    registerSettingsRoutes
  250  };
```

#### `lib/host-install.js` (the Host half; small, full)

```js
    1  import { bindArchiveManagerRemote, installArchiveWorkspace } from "./workspace.js";
    2  const inject = ["workspaceRegistry", "sessionPersistence", "typert"];
    3  async function apply(ctx) {
    4    const registry = ctx.workspaceRegistry;
    5    const uninstallWorkspace = installArchiveWorkspace(registry);
    6    let unbindRemote = () => {
    7    };
    8    const dispose = async () => {
    9      try {
   10        unbindRemote();
   11      } finally {
   12        uninstallWorkspace();
   13      }
   14    };
   15    try {
   16      unbindRemote = bindArchiveManagerRemote(ctx);
   17    } catch (error) {
   18      await dispose();
   19      throw error;
   20    }
   21    return dispose;
   22  }
   23  export {
   24    apply,
   25    inject
   26  };
```

#### How it declares the Cordis plugin / mechanism analysis

- **Export form:** the *plain-object* form. `lib/index.js:243-250` exports
  `apply`, `inject` (and a few helpers). There is **no `name` constant and no `Config`**
  schema — the row's `id` in `cordis.patch.yml` supplies the Cordis identity. This is the
  minimal Host plugin shape described in `references/host-plugin.md:59-64`.
- **`name`:** not declared in code. The plugin row is
  `- id: ui-workspace-archive-manager / name: '@michengai/dsh-archive-manager'`
  (`cordis.patch.yml:15-16`), so the Loader resolves the module by package name and gives
  it that id.
- **`inject`:** `lib/index.js:6` → `const inject = ["webServer", ...hostInject];` where
  `host-install.js:2` adds `["workspaceRegistry", "sessionPersistence", "typert"]`.
  Cordis waits for these services before calling `apply`.
- **Config / schema:** **none**. `apply(ctx, _config)` (`:220`) accepts but ignores the
  second argument — it has no `export const Config`, so the row's `config` is unvalidated.
  Settings are instead persisted by the plugin itself to
  `$DSH_HOME/archive-manager/settings.json` (`lib/plugin-settings.js:18-20`). Note this is
  *plugin-owned state*, not profile config; `references/host-plugin.md:66-77` says profile
  config changes should go through `ctx.get('configEditor').edit(entry, ...)`.
- **`apply`:** registers three HTTP routes on `ctx.webServer.register({kind,path,handler})`
  (`:94`, `:134`, `:174`), then calls `installHost(ctx)` (`:230`). It uses
  `ctx.get("workspaceRegistry")` for optional services (`:189`) and `ctx.logger?.warn?.(...)`
  for diagnostics.
- **Registers services:** it does **not** `provide()` a new Cordis service. It *consumes*
  `webServer`, `workspaceRegistry`, `sessionPersistence`, `typert`, and installs a Typert
  Remote binding via `installHost`. For a gateway that must expose a service, use the
  `Service` default-export form (§1.2) or `ctx.provide(...)`.
- **Cleanup on unload:** **`apply` returns a disposer function** — `lib/index.js:235-241`
  returns `async () => { try { disposeSettingsRoutes(); } finally { await disposeHost(); } }`.
  Each route's `register()` returns its own disposer, collected at `:205-218`. On any
  failure during setup it unwinds already-acquired resources (`:225-234`). This is the
  canonical "return your cleanup from `apply`" pattern.
- **Manifest / bundle:** yes. `package.json:117-133` declares
  `dsh.manifestVersion: 1`, `dsh.bundle.patch: "./cordis.patch.yml"`, and `dsh.client`
  (Web UI half). `package.json:161` also declares top-level `"icon": "assets/icon.svg"`,
  and `exports` maps `"./icon"`, `"./locale/*.json"`, `"./client"`, `"./host"`, etc.
  `files` (`:22-39`) ships `lib`, `assets`, `locale`, `cordis.patch.yml`, all READMEs,
  CHANGELOGs, LICENSE.
- **Compatibility gate:** `engines` (`:7-10`) declares
  `"node": "^22.19.0 || >=24.0.0"` and `"dsh": ">=0.2.0-rc.1 <0.3.0-0"`.
  `peerDependencies` (`:53-70`) list cordis plus every `@deepseek-ai/dsh-*` package it
  touches; `peerDependenciesMeta` marks one optional (`:71-75`).

---


### 1.2 `@deepseek-ai/dsh-otel` (small network `Service` plugin)

**Location:** `BASE/dsh-otel/`

#### Full `package.json`

```json
{
  "name": "@deepseek-ai/dsh-otel",
  "description": "Cordis service for independent ordinary-event and byte-bounded Session-log OTLP channels",
  "version": "0.2.2-rc.1",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/telemetry/otel"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": [
    "locale/*.json",
    "lib/index.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "dependencies": {
    "@opentelemetry/api": "^1.9.1",
    "@opentelemetry/api-logs": "0.222.0",
    "@opentelemetry/otlp-exporter-base": "0.222.0",
    "@opentelemetry/resources": "2.11.0",
    "@opentelemetry/sdk-logs": "0.222.0",
    "@opentelemetry/core": "2.11.0",
    "@opentelemetry/otlp-transformer": "0.222.0",
    "got": "^14.6.6"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/dsh-session": "0.2.2-rc.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/dsh-session": "0.2.2-rc.1"
  }
}
```

#### Full directory tree

```text
@deepseek-ai/dsh-otel/
  LICENSE
  README.i18n.yaml
  README.md
  README.zh.md
  package.json
  lib/
  lib/index.js
  lib/types/
  lib/types/event-log.d.ts
  lib/types/event-transport.d.ts
  lib/types/index.d.ts
  lib/types/session-log.d.ts
  lib/types/transport.d.ts
  locale/
  locale/de.json
  locale/en.json
  locale/es.json
  locale/fr.json
  locale/ja.json
  locale/pt.json
  locale/ru.json
  locale/zh.json
```

#### Main entry `lib/index.js` (full, with line numbers)

```js
    1  import { Service } from "@deepseek-ai/cordis";
    2  import { addAbortListener } from "node:events";
    3  import { SeverityNumber } from "@opentelemetry/api-logs";
    4  import { ExportResultCode } from "@opentelemetry/core";
    5  import { resourceFromAttributes } from "@opentelemetry/resources";
    6  import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
    7  import { gzipSync } from "node:zlib";
    8  import got from "got";
    9  import { OTLPExporterBase, createOtlpNetworkExportDelegate, getSharedConfigurationDefaults, mergeOtlpSharedConfigurationWithDefaults } from "@opentelemetry/otlp-exporter-base";
   10  import { JsonLogsSerializer, LogsExporterMetricsHelper } from "@opentelemetry/otlp-transformer";
   11  import { createOtlpHttpExportDelegate, createOtlpHttpExporterMetrics, getSharedConfigurationFromEnvironment, httpAgentFactoryFromOptions } from "@opentelemetry/otlp-exporter-base/node-http";
   12  //#region lib/types/transport.js
   13  /** Explicit OTLP JSON transport for feedback-authorized Session logs. */
   14  /** `otel.component.type` reported by OTLP HTTP log exporter self-observability metrics. */
   15  const OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE = "otlp_http_log_exporter";
   16  /**
   17  * Create an SDK JSON exporter without inheriting another collector's headers or TLS identity.
   18  * @param options - explicit endpoint, headers, agent, and SDK transport settings.
   19  * @returns the exporter owned by one independent log pipeline.
   20  */
   21  function createLogExporter(options) {
   22  	return new OTLPExporterBase(createOtlpHttpExportDelegate(logTransportOptions(options), JsonLogsSerializer, OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE, LogsExporterMetricsHelper, void 0));
   23  }
   24  /**
   25  * Create one log exporter's self-observability metrics; without a meter provider they record nothing.
   26  * @param url - collector endpoint recorded as the metrics server address and port.
   27  * @returns the metrics recorder required by an OTLP HTTP log export delegate.
   28  */
   29  function createLogExporterMetrics(url) {
   30  	return createOtlpHttpExporterMetrics(OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE, LogsExporterMetricsHelper, url, void 0);
   31  }
   32  /**
   33  * Resolve collector-local headers and agents with shared SDK timeout and compression defaults.
   34  * @param options - explicit endpoint and SDK HTTP settings.
   35  * @returns resolved transport settings without ambient credentials.
   36  */
   37  function logTransportOptions(options) {
   38  	return {
   39  		...mergeOtlpSharedConfigurationWithDefaults(options, getSharedConfigurationFromEnvironment("LOGS"), getSharedConfigurationDefaults()),
   40  		url: options.url,
   41  		headers: async () => ({
   42  			"Content-Type": "application/json",
   43  			...typeof options.headers === "function" ? await options.headers() : options.headers
   44  		}),
   45  		agentFactory: typeof options.httpAgentOptions === "function" ? options.httpAgentOptions : httpAgentFactoryFromOptions({
   46  			keepAlive: options.keepAlive ?? true,
   47  			...options.httpAgentOptions
   48  		}),
   49  		...options.userAgent === void 0 ? {} : { userAgent: options.userAgent }
   50  	};
   51  }
   52  //#endregion
   53  //#region lib/types/event-transport.js
   54  /**
   55  * Create a channel-owned exporter whose cancellation releases requests and retry timers.
   56  * @param options - explicit collector and SDK HTTP settings.
   57  * @param signal - channel cancellation, shared by current and future batch exports.
   58  * @returns the SDK exporter; shutdown also destroys its owned HTTP agent.
   59  */
   60  function createEventLogExporter(options, signal) {
   61  	const config = logTransportOptions(options);
   62  	let agent;
   63  	const exporter = new OTLPExporterBase(createOtlpNetworkExportDelegate(config, JsonLogsSerializer, createLogExporterMetrics(config.url), {
   64  		async send(data, timeoutMillis) {
   65  			signal.throwIfAborted();
   66  			agent ??= config.agentFactory(new URL(config.url).protocol);
   67  			const selectedAgent = await agent;
   68  			const headers = await config.headers();
   69  			signal.throwIfAborted();
   70  			const compressed = config.compression === "gzip";
   71  			const request = got.post(config.url, {
   72  				body: compressed ? gzipSync(data) : Buffer.from(data),
   73  				headers: {
   74  					...headers,
   75  					...compressed ? { "content-encoding": "gzip" } : {},
   76  					...config.userAgent === void 0 ? {} : { "user-agent": config.userAgent }
   77  				},
   78  				agent: new URL(config.url).protocol === "https:" ? { https: selectedAgent } : { http: selectedAgent },
   79  				signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMillis)]),
   80  				followRedirect: false,
   81  				retry: {
   82  					limit: 5,
   83  					methods: ["POST"],
   84  					statusCodes: [
   85  						429,
   86  						502,
   87  						503,
   88  						504
   89  					],
   90  					errorCodes: [],
   91  					backoffLimit: 5e3
   92  				},
   93  				responseType: "buffer"
   94  			});
   95  			request.on("downloadProgress", ({ transferred }) => {
   96  				if (transferred > 4 * 1024 * 1024) request.cancel();
   97  			});
   98  			const response = await request;
   99  			if (response.statusCode >= 300) throw new Error(`OTLP collector returned HTTP ${response.statusCode}`);
  100  			return {
  101  				status: "success",
  102  				data: response.body
  103  			};
  104  		},
  105  		shutdown() {}
  106  	}));
  107  	let shutdown;
  108  	return {
  109  		export: (records, callback) => {
  110  			exporter.export(records, callback);
  111  		},
  112  		forceFlush: () => exporter.forceFlush(),
  113  		shutdown() {
  114  			shutdown ??= (async () => {
  115  				try {
  116  					await exporter.shutdown();
  117  				} finally {
  118  					(await agent)?.destroy();
  119  				}
  120  			})();
  121  			return shutdown;
  122  		}
  123  	};
  124  }
  125  //#endregion
  126  //#region lib/types/event-log.js
  127  /** One caller-owned ordinary-event queue, independent of every Session-log queue. */
  128  var EventLogReporter = class {
  129  	exporter;
  130  	provider;
  131  	logger;
  132  	cancellation = new AbortController();
  133  	/** @param options - explicit transport, resource, scope, queue, and diagnostic settings. */
  134  	constructor(options) {
  135  		const exporter = createEventLogExporter(options.exporter, this.cancellation.signal);
  136  		this.exporter = exporter;
  137  		this.provider = new LoggerProvider({
  138  			resource: resourceFromAttributes(options.resourceAttributes),
  139  			processors: [new BatchLogRecordProcessor({
  140  				...options.processor,
  141  				exporter: {
  142  					export: (records, callback) => {
  143  						exporter.export(records, (result) => {
  144  							if (result.code !== ExportResultCode.SUCCESS) options.onFailure("Product telemetry export failed", result.error);
  145  							callback(result);
  146  						});
  147  					},
  148  					forceFlush: () => exporter.forceFlush(),
  149  					shutdown: () => exporter.shutdown()
  150  				}
  151  			})]
  152  		});
  153  		this.logger = this.provider.getLogger(options.scope.name, options.scope.version);
  154  	}
  155  	/**
  156  	* Enqueue caller-selected analytics fields without acknowledging delivery.
  157  	* @param record - the ordinary event to report.
  158  	*/
  159  	emit(record) {
  160  		const severityNumber = record.severityNumber ?? SeverityNumber.INFO;
  161  		this.logger.emit({
  162  			...record,
  163  			observedTimestamp: Date.now(),
  164  			severityNumber,
  165  			severityText: SeverityNumber[severityNumber]
  166  		});
  167  	}
  168  	/**
  169  	* Drain the queue and release its transport, cancelling remaining exports when the caller aborts.
  170  	* @param signal - optional shutdown deadline; abort discards pending exports and cancels retry waits.
  171  	* @returns completion of SDK shutdown and transport cleanup.
  172  	*/
  173  	async shutdown(signal) {
  174  		const abort = () => {
  175  			this.cancellation.abort(signal?.reason);
  176  		};
  177  		const listener = signal === void 0 ? void 0 : addAbortListener(signal, abort);
  178  		if (signal?.aborted) abort();
  179  		try {
  180  			await this.provider.shutdown();
  181  		} finally {
  182  			try {
  183  				await this.exporter.shutdown();
  184  			} finally {
  185  				listener?.[Symbol.dispose]();
  186  			}
  187  		}
  188  	}
  189  };
  190  //#endregion
  191  //#region lib/types/session-log.js
  192  /** Collector request ceiling in uncompressed UTF-8 bytes, including the OTLP envelope. */
  193  const SESSION_LOG_MAX_REQUEST_BYTES = 4e6;
  194  /**
  195  * Validate byte and queue settings before constructing an SDK pipeline.
  196  * @param options - Session-specific limits supplied by the owning composition.
  197  * @returns the resolved collector request limit.
  198  */
  199  function resolveSessionLogLimits(options) {
  200  	const limit = options.maxRequestBytes ?? 4e6;
  201  	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4e6) throw new Error(`session log maxRequestBytes must be an integer between 1 and ${SESSION_LOG_MAX_REQUEST_BYTES}`);
  202  	for (const key of [
  203  		"maxQueueSize",
  204  		"maxExportBatchSize",
  205  		"scheduledDelayMillis",
  206  		"exportTimeoutMillis"
  207  	]) {
  208  		const value = options.processor?.[key];
  209  		if (value !== void 0 && (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)) throw new Error(`session log processor.${key} must be a positive integer no greater than 2147483647`);
  210  	}
  211  	const queue = options.processor?.maxQueueSize ?? 2048;
  212  	if ((options.processor?.maxExportBatchSize ?? 512) > queue) throw new Error("session log maxExportBatchSize must not exceed maxQueueSize");
  213  	return limit;
  214  }
  215  /** Byte/count batching with one transport request in flight, including after a watchdog warning. */
  216  var SessionLogProcessor = class {
  217  	exporter;
  218  	limit;
  219  	config;
  220  	warn;
  221  	queue = [];
  222  	bytes = 0;
  223  	timer;
  224  	active;
  225  	shutdownPromise;
  226  	stopped = false;
  227  	constructor(exporter, limit, config, warn) {
  228  		this.exporter = exporter;
  229  		this.limit = limit;
  230  		this.config = config;
  231  		this.warn = warn;
  232  	}
  233  	onEmit(record) {
  234  		if (this.stopped) return;
  235  		if (this.queue.length >= this.config.maxQueueSize) {
  236  			this.warn("Session log queue is full; record rejected");
  237  			return;
  238  		}
  239  		let bytes;
  240  		try {
  241  			const serialized = JsonLogsSerializer.serializeRequest([record]);
  242  			if (serialized === void 0) throw new Error("Session log serialization produced no request");
  243  			bytes = serialized.byteLength;
  244  		} catch (error) {
  245  			this.warn("Session log serialization failed; record rejected", error instanceof Error ? error : new Error(String(error)));
  246  			return;
  247  		}
  248  		if (bytes > this.limit) {
  249  			this.warn("Session log record rejected; content was not truncated", /* @__PURE__ */ new Error(`Session log record exceeds maxRequestBytes: ${bytes} > ${this.limit}`));
  250  			return;
  251  		}
  252  		this.queue.push({
  253  			record,
  254  			bytes
  255  		});
  256  		this.bytes += bytes;
  257  		if (this.active !== void 0) return;
  258  		if (this.queue.length >= this.config.maxExportBatchSize || this.bytes >= this.limit) this.forceFlush();
  259  		else if (this.timer === void 0) {
  260  			this.timer = setTimeout(() => {
  261  				this.forceFlush();
  262  			}, this.config.scheduledDelayMillis);
  263  			this.timer.unref();
  264  		}
  265  	}
  266  	forceFlush() {
  267  		clearTimeout(this.timer);
  268  		this.timer = void 0;
  269  		if (this.active !== void 0) return this.active;
  270  		if (this.queue.length === 0) return Promise.resolve();
  271  		this.active = this.drain();
  272  		return this.active;
  273  	}
  274  	async drain() {
  275  		try {
  276  			while (!this.stopped && this.queue.length > 0) {
  277  				let bytes = 0;
  278  				let count = 0;
  279  				for (const entry of this.queue) {
  280  					if (count === this.config.maxExportBatchSize || bytes + entry.bytes > this.limit) break;
  281  					bytes += entry.bytes;
  282  					count++;
  283  				}
  284  				const records = this.queue.splice(0, count).map((entry) => entry.record);
  285  				this.bytes -= bytes;
  286  				await this.send(records);
  287  				await this.exporter.forceFlush();
  288  			}
  289  		} finally {
  290  			this.active = void 0;
  291  		}
  292  	}
  293  	send(records) {
  294  		return new Promise((resolve) => {
  295  			const timer = setTimeout(() => {
  296  				this.warn("Session log request exceeded exportTimeoutMillis; waiting for transport settlement");
  297  			}, this.config.exportTimeoutMillis);
  298  			timer.unref();
  299  			const finish = (error) => {
  300  				clearTimeout(timer);
  301  				if (error !== void 0) this.warn("Session log export failed", error);
  302  				resolve();
  303  			};
  304  			try {
  305  				this.exporter.export(records, (result) => {
  306  					finish(result.code === ExportResultCode.SUCCESS ? void 0 : result.error ?? /* @__PURE__ */ new Error("Session log HTTP export failed"));
  307  				});
  308  			} catch (error) {
  309  				finish(error instanceof Error ? error : new Error(String(error)));
  310  			}
  311  		});
  312  	}
  313  	stopPending() {
  314  		this.stopped = true;
  315  		this.queue.length = 0;
  316  		this.bytes = 0;
  317  		clearTimeout(this.timer);
  318  		this.timer = void 0;
  319  	}
  320  	shutdown() {
  321  		this.shutdownPromise ??= this.forceFlush().then(() => this.exporter.shutdown());
  322  		return this.shutdownPromise;
  323  	}
  324  };
  325  /** Owns feedback-authorized Session logs; no product-event provider or queue is mounted. */
  326  var SessionLogReporter = class {
  327  	provider;
  328  	processor;
  329  	logger;
  330  	/** @param options - explicit transport, resource identity, queue limits, and diagnostics. */
  331  	constructor(options) {
  332  		const limit = resolveSessionLogLimits(options);
  333  		this.processor = new SessionLogProcessor(createLogExporter(options.exporter), limit, {
  334  			maxQueueSize: options.processor?.maxQueueSize ?? 2048,
  335  			maxExportBatchSize: options.processor?.maxExportBatchSize ?? 512,
  336  			scheduledDelayMillis: options.processor?.scheduledDelayMillis ?? 1e3,
  337  			exportTimeoutMillis: options.processor?.exportTimeoutMillis ?? 3e4
  338  		}, options.onFailure);
  339  		this.provider = new LoggerProvider({
  340  			logRecordLimits: {
  341  				attributeValueLengthLimit: Infinity,
  342  				attributeCountLimit: Infinity
  343  			},
  344  			resource: resourceFromAttributes(options.resourceAttributes),
  345  			processors: [this.processor]
  346  		});
  347  		this.logger = this.provider.getLogger(options.scope.name, options.scope.version);
  348  	}
  349  	/**
  350  	* Enqueue one complete event without acknowledging network delivery.
  351  	* @param record - event with redacted data and its original Session id.
  352  	*/
  353  	reportSessionLog(record) {
  354  		const severityNumber = record.severityNumber ?? SeverityNumber.INFO;
  355  		this.logger.emit({
  356  			eventName: "session-log",
  357  			body: "session-log",
  358  			timestamp: record.event.time,
  359  			observedTimestamp: record.event.time,
  360  			severityNumber,
  361  			severityText: SeverityNumber[severityNumber],
  362  			attributes: {
  363  				...record.attributes,
  364  				sessionId: record.sessionId,
  365  				content: JSON.stringify(record.event)
  366  			}
  367  		});
  368  	}
  369  	/** Stop queued requests after the owning backend's shutdown deadline; an active transport may still settle. */
  370  	stopPending() {
  371  		this.processor.stopPending();
  372  	}
  373  	/**
  374  	* Drain queued requests and release the SDK transport.
  375  	* @returns completion after queued requests settle and the SDK transport shuts down.
  376  	*/
  377  	shutdown() {
  378  		return this.provider.shutdown();
  379  	}
  380  };
  381  //#endregion
  382  //#region lib/types/index.js
  383  /** Cordis entry for independent ordinary-event and Session-log OTLP channels. */
  384  /** Shared transport provider. Mounting creates no queue, identity, or network connection. */
  385  var OTel = class extends Service {
  386  	constructor(ctx) {
  387  		super(ctx, "otel");
  388  	}
  389  	/**
  390  	* Create an independent ordinary-event channel with count-based batching.
  391  	* The injected consumer must drain it during its fiber disposal.
  392  	* @param options - transport, scope, resource, queue, and diagnostic settings selected by the consumer.
  393  	* @returns the caller-owned channel; no state is shared with other channels.
  394  	*/
  395  	createEventReporter(options) {
  396  		return new EventLogReporter(options);
  397  	}
  398  	/**
  399  	* Create an independent byte-bounded Session-log channel.
  400  	* Authorization and redaction precede reporting; the consumer owns shutdown and its outer deadline.
  401  	* @param options - transport, scope, resource, queue, and diagnostic settings selected by the consumer.
  402  	* @returns the caller-owned channel, preserving complete accepted events within the request byte ceiling.
  403  	*/
  404  	createSessionLogReporter(options) {
  405  		return new SessionLogReporter(options);
  406  	}
  407  };
  408  //#endregion
  409  export { OTel as default };
```

#### `lib/types/index.d.ts` (shows the Cordis `Context` augmentation)

```ts
    1  /** Cordis entry for independent ordinary-event and Session-log OTLP channels. */
    2  import { Context, Service } from '@deepseek-ai/cordis';
    3  import { EventLogReporter, type EventLogOptions } from './event-log.ts';
    4  import { SessionLogReporter, type SessionLogOptions } from './session-log.ts';
    5  declare module '@deepseek-ai/cordis' {
    6      interface Context {
    7          otel: OTel;
    8      }
    9  }
   10  /** Shared transport provider. Mounting creates no queue, identity, or network connection. */
   11  export default class OTel extends Service {
   12      constructor(ctx: Context);
   13      /**
   14       * Create an independent ordinary-event channel with count-based batching.
   15       * The injected consumer must drain it during its fiber disposal.
   16       * @param options - transport, scope, resource, queue, and diagnostic settings selected by the consumer.
   17       * @returns the caller-owned channel; no state is shared with other channels.
   18       */
   19      createEventReporter(options: EventLogOptions): EventLogReporter;
   20      /**
   21       * Create an independent byte-bounded Session-log channel.
   22       * Authorization and redaction precede reporting; the consumer owns shutdown and its outer deadline.
   23       * @param options - transport, scope, resource, queue, and diagnostic settings selected by the consumer.
   24       * @returns the caller-owned channel, preserving complete accepted events within the request byte ceiling.
   25       */
   26      createSessionLogReporter(options: SessionLogOptions): SessionLogReporter;
   27  }
   28  export type { EventLogOptions, OTelEventRecord, OTelEventScalar, EventLogReporter } from './event-log.ts';
   29  export type { SessionLogProcessorOptions, SessionLogRecord, SessionLogOptions, SessionLogReporter } from './session-log.ts';
   30  export type { LogExporterOptions } from './transport.ts';
   31  //# sourceMappingURL=index.d.ts.map
```

#### How it declares the Cordis plugin / mechanism analysis

- **Export form:** a **`Service` subclass as the default export** —
  `lib/index.js:385-407` defines `var OTel = class extends Service`, and `:409` does
  `export { OTel as default };`. `lib/types/index.d.ts:11` shows
  `export default class OTel extends Service`.
- **`name`:** `super(ctx, "otel")` at `lib/index.js:387` — that is the service name
  other plugins inject. `lib/types/index.d.ts:5-9` augments the Cordis `Context`
  interface with `otel: OTel` via `declare module '@deepseek-ai/cordis'`.
- **`Config` / schema:** **none**. It declares no `static Config` and no `apply`. All
  endpoint/queue/scope options are supplied per channel by the *consumer* through
  `createEventReporter(options)` / `createSessionLogReporter(options)` (`:395`, `:404`),
  not by the profile. `README.md:26` confirms: *"Options explicitly supply endpoint,
  scope, resource attributes, queue settings, and a diagnostic callback; the service has
  no deployment defaults or automatic collection policy of its own."*
- **`inject`:** none (it is a provider, not a consumer). The base bundle mounts it;
  `README.md:26` — *"Independent compositions must mount it before consumers that inject
  `otel`."*
- **Registers services:** mounting the plugin itself registers the `otel` service on the
  context (that is what `Service` does). It additionally creates network transports:
  `createLogExporter` (`:21-23`), `createEventLogExporter` (`:60-126`) using
  `@opentelemetry/otlp-exporter-base`, and an HTTP agent; `EventLogReporter` (`:128-197`)
  and `SessionLogReporter` (`:326-380`) own `LoggerProvider` + batch processors.
  **Mounting alone creates no connection** (`:384`, `README.md:12`).
- **Reads config:** not from the profile. Read from the `options` object passed by the
  consumer — e.g. `options.exporter`, `options.processor?.exportTimeoutMillis` (`:333-337`),
  `options.onFailure` (`:144`).
- **Cleanup on unload:** ownership is inverted and explicit — the *consumer* owns the
  channel and must drain it inside its own fiber disposal. See
  `EventLogReporter.shutdown()` (`:169-197`), `SessionLogReporter.shutdown()` (`:373-379`),
  `stopPending()` (`:369-371`), and `README.md:28`: *"Register shutdown with the
  consumer's Cordis fiber and bound the complete drain with its configured deadline. …
  Do not retain a channel after its consumer unloads."* `lib/index.js:55-58` notes the
  cancellation signal owned by the channel releases requests and retry timers.
  **For our gateway:** this is the right model — create the network client in `apply`,
  register its `close()`/`AbortController` with `ctx.effect(() => () => close())`, and
  return/await the disposer.
- **Manifest / bundle:** **no `dsh` field**. It is a plain library-style Cordis plugin
  enabled by a row in `dsh-base/cordis.patch.yml` (or by another bundle). It ships
  `locale/*.json` and exports `"./locale/*.json"` for display metadata, but is not itself
  a bundle.
- **Package shape:** `type: module`, `main: lib/index.js`, `types: lib/types/index.d.ts`,
  `exports["."] = {types, default}`, `"./src/*"`, `"./package.json"`,
  `"./locale/*.json"`; `files = ["locale/*.json", "lib/index.js", "lib/types/**/*.d.ts"]`.
  `peerDependencies`: `@deepseek-ai/cordis ~4.1.0`,
  `@deepseek-ai/dsh-session 0.2.2-rc.1`. No `engines` field.

---


### 1.3 `@deepseek-ai/dsh-tool-schedule` (small plain-object plugin)

**Location:** `BASE/dsh-tool-schedule/`

#### Full `package.json`

```json
{
  "name": "@deepseek-ai/dsh-tool-schedule",
  "description": "Model-facing scheduled task tools (schedule_create, schedule_list, schedule_view, schedule_edit) over the Host ctx.schedule service",
  "version": "0.2.2-rc.1",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/schedule/tool-schedule"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json"
  },
  "files": [
    "locale/*.json",
    "lib/index.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/dsh-llm": "0.2.2-rc.1",
    "@deepseek-ai/dsh-schedule": "0.2.2-rc.1",
    "@deepseek-ai/dsh-subagent": "0.2.2-rc.1",
    "@deepseek-ai/dsh-system-prompt": "0.2.2-rc.1",
    "@deepseek-ai/dsh-tools": "0.2.2-rc.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/dsh-agent": "0.2.2-rc.1",
    "@deepseek-ai/dsh-llm": "0.2.2-rc.1",
    "@deepseek-ai/dsh-ptc-runtime": "0.2.2-rc.1",
    "@deepseek-ai/dsh-schedule": "0.2.2-rc.1",
    "@deepseek-ai/dsh-scope": "0.2.2-rc.1",
    "@deepseek-ai/dsh-session": "0.2.2-rc.1",
    "@deepseek-ai/dsh-subagent": "0.2.2-rc.1",
    "@deepseek-ai/dsh-system-prompt": "0.2.2-rc.1",
    "@deepseek-ai/dsh-tool-executor-ptc": "0.2.2-rc.1",
    "@deepseek-ai/dsh-tool-testkit": "0.2.2-rc.1",
    "@deepseek-ai/dsh-tools": "0.2.2-rc.1",
    "@deepseek-ai/dsh-agent-preset-registry": "0.2.2-rc.1"
  }
}
```

#### Full directory tree

```text
@deepseek-ai/dsh-tool-schedule/
  LICENSE
  README.i18n.yaml
  README.md
  README.zh.md
  package.json
  lib/
  lib/index.js
  lib/types/
  lib/types/index.d.ts
  locale/
  locale/de.json
  locale/en.json
  locale/es.json
  locale/fr.json
  locale/ja.json
  locale/pt.json
  locale/ru.json
  locale/zh.json
```

#### Main entry `lib/index.js` (full, with line numbers)

```js
    1  import { delegationDepthOf } from "@deepseek-ai/dsh-subagent";
    2  import { defineTool } from "@deepseek-ai/dsh-tools";
    3  import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, ScheduleId, ScheduleInputError, formatScheduleLocalTime } from "@deepseek-ai/dsh-schedule";
    4  //#region lib/types/index.js
    5  /**
    6  * Model-facing `schedule_create`, `schedule_list`, `schedule_view`, and
    7  * `schedule_edit` tools over the Host `ctx.schedule` service. Mounting the
    8  * plugin registers them in the mounting scope, so a preset decides which
    9  * agents receive them. Tasks belong to the Host, not to a Session: the tools
   10  * read and change any task by id, and only the delivery target names a Session.
   11  * @module @deepseek-ai/dsh-tool-schedule
   12  */
   13  /** Plugin name registered with the Loader. */
   14  const name = "tool-schedule";
   15  /** Host services this plugin consumes. The Schedule service is resolved per
   16  * scope, so a preset that declares this plugin stays inert while the shipped
   17  * composition keeps that service off. */
   18  const inject = ["tools", "systemPrompt"];
   19  const SESSION_CREATE_SCHEMA = {
   20  	type: "object",
   21  	additionalProperties: false,
   22  	properties: {
   23  		cwd: { type: "string" },
   24  		agentPreset: { type: "string" }
   25  	}
   26  };
   27  const TARGET_SCHEMA = { oneOf: [
   28  	{
   29  		type: "object",
   30  		additionalProperties: false,
   31  		properties: {
   32  			kind: {
   33  				type: "string",
   34  				required: true,
   35  				const: "session"
   36  			},
   37  			sessionId: {
   38  				type: "string",
   39  				required: true
   40  			}
   41  		}
   42  	},
   43  	{
   44  		type: "object",
   45  		additionalProperties: false,
   46  		properties: {
   47  			kind: {
   48  				type: "string",
   49  				required: true,
   50  				const: "new_once"
   51  			},
   52  			sessionId: {
   53  				type: "string",
   54  				required: true
   55  			},
   56  			create: {
   57  				...SESSION_CREATE_SCHEMA,
   58  				required: true
   59  			}
   60  		}
   61  	},
   62  	{
   63  		type: "object",
   64  		additionalProperties: false,
   65  		properties: {
   66  			kind: {
   67  				type: "string",
   68  				required: true,
   69  				const: "new"
   70  			},
   71  			create: {
   72  				...SESSION_CREATE_SCHEMA,
   73  				required: true
   74  			}
   75  		}
   76  	}
   77  ] };
   78  const DELIVERY_SCHEMA = {
   79  	type: "object",
   80  	additionalProperties: false,
   81  	properties: {
   82  		scheduledAt: {
   83  			type: "string",
   84  			required: true
   85  		},
   86  		deliveredAt: {
   87  			type: "string",
   88  			required: true
   89  		},
   90  		targetSessionId: {
   91  			type: "string",
   92  			required: true
   93  		}
   94  	}
   95  };
   96  const TASK_PROPERTIES = {
   97  	type: "object",
   98  	additionalProperties: false,
   99  	properties: {
  100  		id: {
  101  			type: "string",
  102  			required: true
  103  		},
  104  		title: {
  105  			type: "string",
  106  			required: true
  107  		},
  108  		prompt: {
  109  			type: "string",
  110  			required: true
  111  		},
  112  		scheduledAt: {
  113  			type: "string",
  114  			required: true
  115  		},
  116  		scheduledAtLocal: {
  117  			type: "string",
  118  			required: true
  119  		},
  120  		target: {
  121  			...TARGET_SCHEMA,
  122  			required: true
  123  		},
  124  		status: {
  125  			type: "string",
  126  			required: true,
  127  			enum: [
  128  				"active",
  129  				"paused",
  130  				"ended"
  131  			]
  132  		},
  133  		updatedAt: { type: "string" },
  134  		lastDelivery: DELIVERY_SCHEMA
  135  	}
  136  };
  137  const TASK_SCHEMA = { oneOf: [
  138  	{
  139  		...TASK_PROPERTIES,
  140  		properties: {
  141  			...TASK_PROPERTIES.properties,
  142  			kind: {
  143  				type: "string",
  144  				required: true,
  145  				const: "rrule"
  146  			},
  147  			rrule: {
  148  				type: "string",
  149  				required: true
  150  			}
  151  		}
  152  	},
  153  	{
  154  		...TASK_PROPERTIES,
  155  		properties: {
  156  			...TASK_PROPERTIES.properties,
  157  			kind: {
  158  				type: "string",
  159  				required: true,
  160  				const: "cron"
  161  			},
  162  			expression: {
  163  				type: "string",
  164  				required: true
  165  			},
  166  			timeZone: {
  167  				type: "string",
  168  				required: true
  169  			}
  170  		}
  171  	},
  172  	{
  173  		...TASK_PROPERTIES,
  174  		properties: {
  175  			...TASK_PROPERTIES.properties,
  176  			kind: {
  177  				type: "string",
  178  				required: true,
  179  				const: "every"
  180  			},
  181  			everySeconds: {
  182  				type: "integer",
  183  				required: true
  184  			}
  185  		}
  186  	},
  187  	{
  188  		...TASK_PROPERTIES,
  189  		properties: {
  190  			...TASK_PROPERTIES.properties,
  191  			kind: {
  192  				type: "string",
  193  				required: true,
  194  				const: "after"
  195  			},
  196  			afterSeconds: {
  197  				type: "integer",
  198  				required: true
  199  			}
  200  		}
  201  	},
  202  	{
  203  		...TASK_PROPERTIES,
  204  		properties: {
  205  			...TASK_PROPERTIES.properties,
  206  			kind: {
  207  				type: "string",
  208  				required: true,
  209  				const: "at"
  210  			}
  211  		}
  212  	},
  213  	{
  214  		...TASK_PROPERTIES,
  215  		properties: {
  216  			...TASK_PROPERTIES.properties,
  217  			kind: {
  218  				type: "string",
  219  				required: true,
  220  				const: "daily"
  221  			},
  222  			time: {
  223  				type: "string",
  224  				required: true
  225  			},
  226  			timeZone: {
  227  				type: "string",
  228  				required: true
  229  			}
  230  		}
  231  	},
  232  	{
  233  		...TASK_PROPERTIES,
  234  		properties: {
  235  			...TASK_PROPERTIES.properties,
  236  			kind: {
  237  				type: "string",
  238  				required: true,
  239  				const: "weekly"
  240  			},
  241  			time: {
  242  				type: "string",
  243  				required: true
  244  			},
  245  			timeZone: {
  246  				type: "string",
  247  				required: true
  248  			},
  249  			weekdays: {
  250  				type: "array",
  251  				required: true,
  252  				items: { type: "integer" }
  253  			}
  254  		}
  255  	}
  256  ] };
  257  const LIST_PAGE_SCHEMA = {
  258  	type: "object",
  259  	additionalProperties: false,
  260  	properties: {
  261  		items: {
  262  			type: "array",
  263  			required: true,
  264  			items: TASK_SCHEMA
  265  		},
  266  		shown: {
  267  			type: "integer",
  268  			required: true
  269  		},
  270  		total: {
  271  			type: "integer",
  272  			required: true
  273  		},
  274  		limit: {
  275  			type: "integer",
  276  			required: true
  277  		},
  278  		offset: {
  279  			type: "integer",
  280  			required: true
  281  		}
  282  	}
  283  };
  284  const NOT_FOUND_SCHEMA = {
  285  	type: "object",
  286  	additionalProperties: false,
  287  	properties: {
  288  		id: {
  289  			type: "string",
  290  			required: true
  291  		},
  292  		code: {
  293  			type: "string",
  294  			required: true,
  295  			const: "schedule_not_found"
  296  		}
  297  	}
  298  };
  299  const DELETED_SCHEMA = {
  300  	type: "object",
  301  	additionalProperties: false,
  302  	properties: {
  303  		id: {
  304  			type: "string",
  305  			required: true
  306  		},
  307  		deleted: {
  308  			type: "boolean",
  309  			required: true,
  310  			const: true
  311  		}
  312  	}
  313  };
  314  const CONFLICT_SCHEMA = {
  315  	type: "object",
  316  	additionalProperties: false,
  317  	properties: {
  318  		id: {
  319  			type: "string",
  320  			required: true
  321  		},
  322  		code: {
  323  			type: "string",
  324  			required: true,
  325  			const: "schedule_conflict"
  326  		}
  327  	}
  328  };
  329  /** Errors every tool can return: a delegated caller and a withheld failure. */
  330  const CALLER_ERRORS = ["subagent_session", "internal_error"];
  331  /** Errors of a new title, prompt, or recurrence. */
  332  const CREATE_ERRORS = [
  333  	"invalid_prompt",
  334  	"invalid_rule",
  335  	"invalid_time_zone",
  336  	"not_future",
  337  	"frequency_too_high",
  338  	...CALLER_ERRORS
  339  ];
  340  /** Errors of an invalid page request. */
  341  const LIST_ERRORS = ["invalid_rule", ...CALLER_ERRORS];
  342  /** Errors of a changed field or an invalid field combination. */
  343  const EDIT_ERRORS = ["invalid_selector", ...CREATE_ERRORS];
  344  /** Build the exact two-field error schema of one tool from the codes it can return. */
  345  function errorSchema(codes) {
  346  	return {
  347  		type: "object",
  348  		additionalProperties: false,
  349  		properties: {
  350  			code: {
  351  				type: "string",
  352  				required: true,
  353  				enum: codes
  354  			},
  355  			message: {
  356  				type: "string",
  357  				required: true
  358  			}
  359  		}
  360  	};
  361  }
  362  const CREATE_OUTPUT_SCHEMA = { oneOf: [TASK_SCHEMA, errorSchema(CREATE_ERRORS)] };
  363  const LIST_OUTPUT_SCHEMA = { oneOf: [LIST_PAGE_SCHEMA, errorSchema(LIST_ERRORS)] };
  364  const VIEW_OUTPUT_SCHEMA = { oneOf: [
  365  	TASK_SCHEMA,
  366  	NOT_FOUND_SCHEMA,
  367  	errorSchema(CALLER_ERRORS)
  368  ] };
  369  const EDIT_OUTPUT_SCHEMA = { oneOf: [
  370  	TASK_SCHEMA,
  371  	DELETED_SCHEMA,
  372  	NOT_FOUND_SCHEMA,
  373  	CONFLICT_SCHEMA,
  374  	errorSchema(EDIT_ERRORS)
  375  ] };
  376  const MANAGEMENT_AUTHORIZATION = "Only create or modify scheduled tasks at the user's explicit request; prior explicit user authorization for the running scheduled task remains valid.";
  377  const CREATE_DESCRIPTION = "Create a scheduled task. At each occurrence of rrule, prompt is delivered to the target session as a scheduled message from the user. The result includes the task id and the next occurrence as scheduledAt in UTC and scheduledAtLocal in the zone of rrule. After downtime, only the latest missed occurrence is delivered. Delivery can repeat after a crash.";
  378  const LIST_DESCRIPTION = "List scheduled tasks, including tasks created from other sessions. Active tasks come first, ordered by scheduledAt.";
  379  const VIEW_DESCRIPTION = "View one scheduled task by id.";
  380  const EDIT_DESCRIPTION = "Update, pause, resume, or delete one scheduled task by id. Deleting does not retract queued messages.";
  381  const TITLE_HELP = `Task name of at most ${MAX_TITLE_LENGTH} characters in the user's language: action plus object. Omit timing, status, ids, and bracketed suffixes.`;
  382  const RRULE_HELP = "Supported RFC 5545 subset: one DTSTART line, a newline, and one RRULE line. DTSTART ends in Z for UTC or carries TZID with an IANA time zone; a fixed offset such as UTC+5 is Etc/GMT-5, with the sign reversed. DTSTART must name an existing local time. A TZID rule keeps local clock time across daylight-saving changes; generated nonexistent local times are skipped, and repeated ones occur once, at the earlier instant. DTSTART may be in the past; delivery starts with the first occurrence after creation. A one-time delivery is RRULE:FREQ=DAILY;COUNT=1. No SECONDLY; BYSECOND takes one value. COUNT is at most 1000; use UNTIL for longer rules. MINUTELY and HOURLY accept no BY parts, so select clock times with DAILY or WEEKLY plus BYHOUR and BYMINUTE. BYMONTHDAY and ordinal BYDAY require MONTHLY or YEARLY; BYYEARDAY and BYWEEKNO require YEARLY. Ordinal BYDAY cannot combine with BYWEEKNO. Each FREQ period allows at most 10080 candidates before BYSETPOS, which accepts at most 31 values. UNTIL is a UTC instant ending in Z. Example: \"DTSTART;TZID=Asia/Singapore:20260901T080000\\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1\"";
  383  const TARGET_CHOICES = [
  384  	"this_session",
  385  	"new_once",
  386  	"new"
  387  ];
  388  /**
  389  * Describe the target choices, naming the configured spacing of `new` deliveries when it exceeds the one-minute
  390  * spacing of every task.
  391  * @param newSessionIntervalSeconds - Effective `newSessionIntervalSeconds` of the Host Schedule service.
  392  * @returns The `target` parameter description.
  393  */
  394  function targetHelp(newSessionIntervalSeconds) {
  395  	return `this_session delivers to this session; new_once delivers to the same new session every time, opened at the first delivery; new opens a different new session for every delivery${newSessionIntervalSeconds <= MIN_EVERY_INTERVAL_SECONDS ? "" : newSessionIntervalSeconds % 60 === 0 ? `, at most once every ${newSessionIntervalSeconds / 60} minutes` : `, at most once every ${newSessionIntervalSeconds} seconds`}. New sessions use this session's working directory and preset. With this_session or new_once, a delivery waits until the previous one finishes, and only the latest occurrence that passed meanwhile is delivered. Use this_session for reminders and for follow-ups to this conversation; use new_once or new for independent work, such as a recurring report, and whenever the user asks for a new conversation.`;
  396  }
  397  /** Edit parameters that only an update accepts. */
  398  const PATCH_FIELDS = [
  399  	"title",
  400  	"prompt",
  401  	"rrule",
  402  	"target",
  403  	"active"
  404  ];
  405  /** Deterministic model content for every canonical Schedule value. */
  406  function renderValue(_args, value) {
  407  	return [{
  408  		type: "text",
  409  		text: JSON.stringify(value)
  410  	}];
  411  }
  412  /** Preserve timing, destination, and edit revision while withholding Host bookkeeping. */
  413  function modelTask(task) {
  414  	const { involvedSessionIds: _involved, createdAt: _created, executionActive: _execution, deliveryFloorEndsAt: _floor, lastDelivery, ...record } = task;
  415  	return {
  416  		...record,
  417  		scheduledAtLocal: formatScheduleLocalTime(task, task.scheduledAt),
  418  		...lastDelivery === void 0 ? {} : { lastDelivery: {
  419  			scheduledAt: lastDelivery.scheduledAt,
  420  			deliveredAt: lastDelivery.deliveredAt,
  421  			targetSessionId: lastDelivery.targetSessionId
  422  		} }
  423  	};
  424  }
  425  /** Pure generic pending card. */
  426  function present(title, kind, rawInput) {
  427  	return {
  428  		card: "generic",
  429  		title,
  430  		kind,
  431  		...rawInput === void 0 ? {} : { rawInput }
  432  	};
  433  }
  434  /** Stable error for failures not safe to expose. */
  435  function internalError() {
  436  	return {
  437  		code: "internal_error",
  438  		message: "The schedule operation failed."
  439  	};
  440  }
  441  /**
  442  * Run one Schedule operation for the root Agent that dispatched the call.
  443  *
  444  * A delegated subagent cannot use scheduled tasks, so every tool refuses it here even when its preset exposes the
  445  * tool. An input error keeps its code when the tool declares that code; every other failure becomes `internal_error`.
  446  * @param exec - Run context of the call.
  447  * @param codes - Error codes of the tool.
  448  * @param operation - Service call for the calling Agent.
  449  * @returns The operation result, or an error with a declared code.
  450  */
  451  async function runForCaller(exec, codes, operation) {
  452  	const agent = exec.agent;
  453  	if (agent === void 0) return internalError();
  454  	if (delegationDepthOf(agent) > 0) return {
  455  		code: "subagent_session",
  456  		message: "A delegated subagent cannot use scheduled tasks."
  457  	};
  458  	try {
  459  		return await operation(agent);
  460  	} catch (error) {
  461  		if (error instanceof ScheduleInputError) {
  462  			const code = codes.find((code) => code === error.code);
  463  			if (code !== void 0) return {
  464  				code,
  465  				message: error.message
  466  			};
  467  		}
  468  		return internalError();
  469  	}
  470  }
  471  /**
  472  * Resolve one model target choice to a delivery destination.
  473  *
  474  * A created Session uses the caller's working directory and current composed preset; a preset selection in an
  475  * empty Session changes that composition without rewriting the Session header.
  476  * @param agent - Calling root Agent.
  477  * @param target - Model target choice.
  478  * @returns Destination request for the Schedule service.
  479  */
  480  function targetFor(agent, target) {
  481  	if (target === "this_session") return {
  482  		kind: "session",
  483  		sessionId: agent.session.id
  484  	};
  485  	const cwd = agent.session.header.cwd;
  486  	const agentPreset = agent.ctx.get("agentPresets")?.composedPreset(agent.ctx);
  487  	return {
  488  		kind: target,
  489  		create: {
  490  			...cwd === void 0 ? {} : { cwd },
  491  			...agentPreset === void 0 ? {} : { agentPreset }
  492  		}
  493  	};
  494  }
  495  /**
  496  * Register the four Schedule tools and shared guidance in the mounting scope.
  497  *
  498  * Each call acts for the Agent that dispatched it, so a mount outside an
  499  * agent scope still registers the tools but every call without a caller Agent
  500  * is refused as an internal failure.
  501  * @param ctx - Context owning the tool and system-prompt registries and the Host Schedule service.
  502  */
  503  function apply(ctx) {
  504  	ctx.inject(["schedule"], registerScheduleTools);
  505  }
  506  /**
  507  * Register the tools and shared guidance in the scope that resolved Schedule.
  508  * @param ctx - Scope whose `schedule` service the tools act through.
  509  */
  510  function registerScheduleTools(ctx) {
  511  	ctx.systemPrompt.section({
  512  		name: "tool:schedule",
  513  		order: ctx.systemPrompt.getSectionOrder("TOOL_SCHEDULE"),
  514  		text: ({ scope }) => ctx.tools.get("schedule_create", scope) !== void 0 || ctx.tools.get("schedule_edit", scope) !== void 0 ? MANAGEMENT_AUTHORIZATION : ""
  515  	});
  516  	const targetDescription = targetHelp(ctx.schedule.deliveryLimits().newSessionIntervalSeconds);
  517  	ctx.tools.register(defineTool({
  518  		name: "schedule_create",
  519  		description: CREATE_DESCRIPTION,
  520  		parameters: {
  521  			title: {
  522  				type: "string",
  523  				required: true,
  524  				description: TITLE_HELP
  525  			},
  526  			prompt: {
  527  				type: "string",
  528  				required: true,
  529  				description: "Instruction delivered at each occurrence."
  530  			},
  531  			rrule: {
  532  				type: "string",
  533  				required: true,
  534  				description: RRULE_HELP
  535  			},
  536  			target: {
  537  				type: "string",
  538  				required: true,
  539  				enum: TARGET_CHOICES,
  540  				description: targetDescription
  541  			}
  542  		},
  543  		output: {
  544  			schema: CREATE_OUTPUT_SCHEMA,
  545  			render: renderValue
  546  		},
  547  		execute(args, exec) {
  548  			return runForCaller(exec, CREATE_ERRORS, (agent) => ctx.schedule.create({
  549  				title: args.title,
  550  				prompt: args.prompt,
  551  				timing: {
  552  					kind: "rrule",
  553  					rrule: args.rrule
  554  				},
  555  				target: targetFor(agent, args.target)
  556  			}, agent.session.id, exec.signal).then(modelTask));
  557  		},
  558  		presentCall: (args) => present("Create scheduled task", "other", args.title)
  559  	}));
  560  	ctx.tools.register(defineTool({
  561  		name: "schedule_list",
  562  		description: LIST_DESCRIPTION,
  563  		parameters: {
  564  			active: {
  565  				type: "boolean",
  566  				description: "true for active tasks only; false for paused and ended tasks only; omitted for all tasks."
  567  			},
  568  			limit: {
  569  				type: "integer",
  570  				description: `Page size from 1 to ${MAX_LIST_LIMIT}; defaults to ${DEFAULT_LIST_LIMIT}.`
  571  			},
  572  			offset: {
  573  				type: "integer",
  574  				description: "Number of tasks to skip; defaults to 0."
  575  			}
  576  		},
  577  		output: {
  578  			schema: LIST_OUTPUT_SCHEMA,
  579  			render: renderValue
  580  		},
  581  		execute({ active, limit, offset }, exec) {
  582  			return runForCaller(exec, LIST_ERRORS, () => ctx.schedule.list({
  583  				...active === void 0 ? {} : { active },
  584  				...limit === void 0 ? {} : { limit },
  585  				...offset === void 0 ? {} : { offset }
  586  			}).then((page) => ({
  587  				...page,
  588  				items: page.items.map(modelTask)
  589  			})));
  590  		},
  591  		presentCall: () => present("List scheduled tasks", "read")
  592  	}));
  593  	ctx.tools.register(defineTool({
  594  		name: "schedule_view",
  595  		description: VIEW_DESCRIPTION,
  596  		parameters: { id: {
  597  			type: "string",
  598  			required: true,
  599  			description: "Task id."
  600  		} },
  601  		output: {
  602  			schema: VIEW_OUTPUT_SCHEMA,
  603  			render: renderValue
  604  		},
  605  		execute(args, exec) {
  606  			return runForCaller(exec, CALLER_ERRORS, () => ctx.schedule.view({ id: ScheduleId(args.id) }).then((result) => "kind" in result ? modelTask(result) : result));
  607  		},
  608  		presentCall: (args) => present("View scheduled task", "read", args.id)
  609  	}));
  610  	ctx.tools.register(defineTool({
  611  		name: "schedule_edit",
  612  		description: EDIT_DESCRIPTION,
  613  		parameters: {
  614  			id: {
  615  				type: "string",
  616  				required: true,
  617  				description: "Task id."
  618  			},
  619  			action: {
  620  				type: "string",
  621  				required: true,
  622  				enum: ["update", "delete"],
  623  				description: "update applies the provided fields, at least one; delete removes the task."
  624  			},
  625  			title: {
  626  				type: "string",
  627  				description: TITLE_HELP
  628  			},
  629  			prompt: {
  630  				type: "string",
  631  				description: "New instruction delivered at each occurrence."
  632  			},
  633  			rrule: {
  634  				type: "string",
  635  				description: "New recurrence in the schedule_create rrule format."
  636  			},
  637  			target: {
  638  				type: "string",
  639  				enum: TARGET_CHOICES,
  640  				description: "Omit to retain the destination and its creation settings. Providing target replaces them; new_once reserves a different Session. New targets capture this Session's working directory and preset. Choices are the same as schedule_create."
  641  			},
  642  			active: {
  643  				type: "boolean",
  644  				description: "false pauses the task; true resumes only if its timing has a future occurrence. Otherwise provide a new rrule."
  645  			},
  646  			expectedUpdatedAt: {
  647  				type: "string",
  648  				description: "updatedAt from the latest result that returned this task; if the task changed after that result, the result is schedule_conflict and nothing changes."
  649  			}
  650  		},
  651  		output: {
  652  			schema: EDIT_OUTPUT_SCHEMA,
  653  			render: renderValue
  654  		},
  655  		execute(args, exec) {
  656  			return runForCaller(exec, EDIT_ERRORS, (agent) => {
  657  				const id = ScheduleId(args.id);
  658  				const expected = args.expectedUpdatedAt === void 0 ? {} : { expectedUpdatedAt: args.expectedUpdatedAt };
  659  				let request;
  660  				if (args.action === "delete") {
  661  					if (PATCH_FIELDS.some((field) => args[field] !== void 0)) throw new ScheduleInputError("invalid_selector", "delete accepts only id, action, and expectedUpdatedAt.");
  662  					request = {
  663  						id,
  664  						action: "delete",
  665  						...expected
  666  					};
  667  				} else {
  668  					const patch = {
  669  						...args.title === void 0 ? {} : { title: args.title },
  670  						...args.prompt === void 0 ? {} : { prompt: args.prompt },
  671  						...args.rrule === void 0 ? {} : { timing: {
  672  							kind: "rrule",
  673  							rrule: args.rrule
  674  						} },
  675  						...args.target === void 0 ? {} : { target: targetFor(agent, args.target) },
  676  						...args.active === void 0 ? {} : { active: args.active }
  677  					};
  678  					if (Object.keys(patch).length === 0) throw new ScheduleInputError("invalid_selector", "update requires at least one of title, prompt, rrule, target, or active.");
  679  					request = {
  680  						id,
  681  						action: "update",
  682  						patch,
  683  						...expected
  684  					};
  685  				}
  686  				return ctx.schedule.edit(request, agent.session.id, exec.signal).then((result) => "kind" in result ? modelTask(result) : result);
  687  			});
  688  		},
  689  		presentCall: (args) => present(args.action === "delete" ? "Delete scheduled task" : "Edit scheduled task", "other", args.id)
  690  	}));
  691  }
  692  //#endregion
  693  export { apply, inject, name };
```

#### `lib/types/index.d.ts`

```ts
    1  /**
    2   * Model-facing `schedule_create`, `schedule_list`, `schedule_view`, and
    3   * `schedule_edit` tools over the Host `ctx.schedule` service. Mounting the
    4   * plugin registers them in the mounting scope, so a preset decides which
    5   * agents receive them. Tasks belong to the Host, not to a Session: the tools
    6   * read and change any task by id, and only the delivery target names a Session.
    7   * @module @deepseek-ai/dsh-tool-schedule
    8   */
    9  import type { Context } from '@deepseek-ai/cordis';
   10  /** Plugin name registered with the Loader. */
   11  export declare const name = "tool-schedule";
   12  /** Host services this plugin consumes. The Schedule service is resolved per
   13   * scope, so a preset that declares this plugin stays inert while the shipped
   14   * composition keeps that service off. */
   15  export declare const inject: string[];
   16  /**
   17   * Register the four Schedule tools and shared guidance in the mounting scope.
   18   *
   19   * Each call acts for the Agent that dispatched it, so a mount outside an
   20   * agent scope still registers the tools but every call without a caller Agent
   21   * is refused as an internal failure.
   22   * @param ctx - Context owning the tool and system-prompt registries and the Host Schedule service.
   23   */
   24  export declare function apply(ctx: Context): void;
   25  //# sourceMappingURL=index.d.ts.map
```

#### How it declares the Cordis plugin / mechanism analysis

- **Export form:** the **plain-object form, complete**: `lib/index.js:14`
  `const name = "tool-schedule";`, `:18` `const inject = ["tools", "systemPrompt"];`,
  `:503-505` `function apply(ctx) { ctx.inject(["schedule"], registerScheduleTools); }`,
  and `:693` `export { apply, inject, name };`. Its `.d.ts:11-24` declares exactly
  `name`, `inject`, `apply(ctx: Context): void`.
- **`name`:** a real constant exported (`"tool-schedule"`), unlike the third-party plugin.
  This is the Cordis plugin name registered with the Loader.
- **`Config` / schema:** **none**. No `static Config`, no `export const Config`; the
  plugin takes no row config. Tool input schemas are declared as JSON Schema objects
  (`CREATE_OUTPUT_SCHEMA`, `LIST_OUTPUT_SCHEMA`, etc., `:362-374`) — those are *tool
  parameter* schemas, not plugin config.
- **`inject` (two levels):** the export `inject = ["tools", "systemPrompt"]` gates
  `apply`; inside `apply`, `ctx.inject(["schedule"], registerScheduleTools)` (`:504`)
  defers registration until the `schedule` service resolves in that scope.
  `README.md:16` explains the scope behavior: *"a preset that declares this plugin stays
  inert while the shipped composition keeps that service off."*
- **Registers services:** it registers **tools** via `ctx.tools.register(defineTool({...}))`
  (`:517`, `:560`, and two more) and a system-prompt section via
  `ctx.systemPrompt.section(...)` (`:511-515`). It does not `provide()` a service.
- **Reads config:** none from the profile. It reads runtime values from the injected
  service, e.g. `ctx.schedule.deliveryLimits().newSessionIntervalSeconds` (`:516`) and
  `ctx.tools.get("schedule_create", scope)` (`:514`).
- **Cleanup on unload:** **implicit** — no disposer is returned. `apply` returns `void`.
  `ctx.tools.register` and `ctx.systemPrompt.section` are scope-bound registries: Cordis
  unregisters their contributions when the mounting fiber disposes. `references/host-plugin.md:64`
  states the general rule: *"Register every resource inside `apply` with `ctx.effect` or
  `ctx.on` and return its cleanup."* For network sockets/timers (our gateway), an
  **explicit** disposer is required; the third-party plugin (§1.1) shows that.
- **Manifest / bundle:** **no `dsh` field**, no `cordis.patch.yml`. It is enabled by a
  row in a preset/bundle patch (`README.md:28`: *"Add the row below to a preset's plugin
  list"*). Ships `locale/*.json` and exports `"./locale/*.json"`.
- **Package shape:** same uniform shape as §1.2. `peerDependencies` list cordis plus
  five `@deepseek-ai/dsh-*` packages at `0.2.2-rc.1`; a large `devDependencies` block
  mirrors them (test/build time only).

---


### 1.4 Supplementary: `@deepseek-ai/dsh-schedule` — `Config`, `inject`, teardown, and pushing a message into DSH

**Location:** `BASE/dsh-schedule/` (2,630-line bundled `lib/index.js`; not reproduced in
full here — the declaration-relevant regions are quoted with real line numbers).

This is the first-party plugin closest to our use case: it is a Host service that, at each
scheduled occurrence, **injects a user message into a DSH Session**.

#### Plugin declaration: `static inject`, `static Config`, constructor, `ctx.effect` teardown

`lib/index.js:2091-2175`:

```js
  2091  static inject = [
  2092      "agents",
  2093      "sessions",
  2094      "storageDomain",
  2095      "sessionPersistence"
  2096  ];
  2097  static Config = z.object({
  2098      deliveryHistoryDays: z.number().step(1).min(1).max(3650).default(DEFAULT_DELIVERY_HISTORY_DAYS),
  2099      deliveryHistoryRecords: z.number().step(1).min(1).max(1e4).default(DEFAULT_DELIVERY_HISTORY_RECORDS),
  2100      newSessionIntervalSeconds: z.number().step(1).min(60).max(604800).default(DEFAULT_NEW_SESSION_INTERVAL_SECONDS)
  2101  });
  2115  constructor(ctx, config) {
  2116      super(ctx, "schedule");
  2117      ctx.inject(["sessionController"], (webCtx) => {
  2118          webCtx.effect(() => {
  2119              this.resolveWebAgent = async (sessionId) => { /* ... */ };
  2124              this.runtime?.requestDrive();
  2125              return () => { this.resolveWebAgent = void 0; };
  2127          });
  2129      });
  2130      this.limits = {
  2132          days: config.deliveryHistoryDays ?? DEFAULT_DELIVERY_HISTORY_DAYS,
  2133          records: config.deliveryHistoryRecords ?? DEFAULT_DELIVERY_HISTORY_RECORDS
  2135          newSessionIntervalMs: (config.newSessionIntervalSeconds ?? DEFAULT_NEW_SESSION_INTERVAL_SECONDS) * 1e3
  2136      };
  2150      this.initialized = ctx.effect(async () => {
  2151          const domain = await this.ready;
  2153          cleanup = ctx.effect(() => async () => {
  2155              this.stopping = true;
  2156              await this.runtime?.dispose();
  2157              await this.chain;
  2158              await this.notifications;
  2159              await domain.close();
  2160          });
  2166      const tasks = domain.table("tasks");
  2167      this.runtime = new ScheduleRuntime(ctx, /* ... */);
  2175      });
```

Export at `lib/index.js:2630`:

```js
  2630  export { ..., ScheduleService, ScheduleService as default, ... };
```

Key import at `lib/index.js:3-5`:

```js
     3  import z from "@deepseek-ai/schemastery";
     4  import { Service } from "@deepseek-ai/cordis";
     5  import { createUserMessage } from "@deepseek-ai/dsh-llm";
```

**What this teaches us:**

- `static Config = z.object({...})` is where a **`Service`-form plugin declares its
  schema**; `z` is the default export of `@deepseek-ai/schemastery` (3.19.0). The Loader
  validates the row's `config` at activation (`references/host-plugin.md:64`). For the
  plain-object form, the equivalent is `export const Config = z.object({...})` and
  `apply(ctx, config)`.
- `static inject = [...]` declares hard service dependencies; `ctx.inject([...], cb)`
  declares optional/scope-dependent ones.
- `constructor(ctx, config)` receives the **validated** config and reads it directly
  (`:2130-2136`) — that is how config is read.
- **`ctx.effect(() => async () => { ... })`** (`:2150-2160`) is the cleanup-on-unload
  mechanism for a `Service`: return an async disposer that stops timers/runtime, drains
  queues, and closes the storage domain. `references/host-plugin.md:64` confirms
  `ctx.effect`/`ctx.on` + returned cleanup.
- `super(ctx, "schedule")` names the provided service; other code reaches it as
  `ctx.schedule`.

#### The exact "push a message into DSH" pattern

`lib/index.js:2541-2567` — `notify()` injects a user message into every involved Session:

```js
  2541  async notify(task, actorSessionId, change) {
  2542      const text = [ /* "[SCHEDULE CHANGE]", ... */ ].join("\n");
  2550      for (const sessionId of task.involvedSessionIds) {
  2551          if (sessionId === actorSessionId) continue;
  2552          const agent = this.ctx.agents.get(sessionId);
  2553          if (agent === void 0) continue;
  2554          try {
  2555              const needsFlush = agent.status === "idle";
  2556              agent.inject(createUserMessage({
  2557                  content: [{
  2558                      type: "text",
  2559                      text
  2560                  }],
  2561                  source: { kind: "schedule" }
  2562              }));
  2563              if (needsFlush && !await this.ctx.sessions.flush(agent.session)) throw new Error("Session persistence did not acknowledge the schedule notice");
  2564          } catch (error) {
  2565              this.ctx.logger.warn(`schedule: could not notify Session "${sessionId}": ${String(error)}`);
  2566          }
  2567      }
  2568  }
```

So a channel gateway would: resolve the target agent via `ctx.agents.get(sessionId)`
(or create a Session through the session/workspace services), build the inbound message
with `createUserMessage({ content: [...], source: { kind: "feishu" } })` from
`@deepseek-ai/dsh-llm`, call `agent.inject(...)`, and `await ctx.sessions.flush(agent.session)`
when the agent was idle. `static inject` would therefore include at least `agents` and
`sessions`.

> **Unverified:** the precise API for *creating a brand-new Session* from an external event
> (rather than injecting into an existing one) was not inspected in depth. The catalog
> entry for the missing `@deepseek-ai/dsh-webhook` — "creates Workspace-backed DeepSeek
> Harness Sessions" — is the intended reference but is not installed (§6).

---


## 2. The EXACT npm package shape for a third-party plugin

### 2.1 Authoritative type source: `@deepseek-ai/dsh-package-manifest`

`BASE/dsh-package-manifest/lib/index.js` is one line: `export {};` — **types only, no
runtime**. The full declarations are in `lib/types/types.d.ts`:

```ts
    1  /**
    2   * Shared declarations for package.json fields and plugin display metadata.
    3   * Each reader owns JSON validation and resolved defaults.
    4   * @module @deepseek-ai/dsh-package-manifest/types
    5   */
    6  /** Package identity and metadata; local profile readers may accept a partial declaration. */
    7  export interface DshPackageManifest {
    8      /** Published npm package name. */
    9      name: string;
   10      /** Published npm package version. */
   11      version: string;
   12      /** Package summary for discovery and display. */
   13      description?: string;
   14      /** SVG, PNG, JPEG, or WebP file relative to this manifest's directory, at most 256 KiB and contained there after realpath resolution. */
   15      icon?: string;
   16      /** Prevent npm publication, for example for local profile projects. */
   17      private?: boolean;
   18      /** Packages installed alongside this package. */
   19      dependencies?: Record<string, string>;
   20      /** Packages that may be absent when installation or platform checks skip them. */
   21      optionalDependencies?: Record<string, string>;
   22      /** Compatible versions of packages supplied by the consuming project. */
   23      peerDependencies?: Record<string, string>;
   24      /** Runtime requirements; DSH compatibility is declarative until a reader enforces it. */
   25      engines?: DshEnginesManifest;
   26      /** DSH-specific author declarations. */
   27      dsh?: DshManifest;
   28  }
   29  /** Public author fields under `package.json.dsh`; a package may declare several roles. */
   30  export interface DshManifest {
   31      /** Manifest format version, independent of the npm package and Session format versions. */
   32      manifestVersion?: 1;
   33      /** Bundle metadata consumed by the profile launcher. */
   34      bundle?: DshBundleManifest;
   35      /** Profile metadata consumed by the profile launcher. */
   36      profile?: DshProfileManifest;
   37      /** Client module loading and build metadata. */
   38      client?: DshClientManifest;
   39  }
   40  /** Literal text or translations indexed by lowercase language id, with a required English fallback. */
   41  export type LocalizedText = string | {
   42      readonly en: string;
   43      readonly [locale: string]: string;
   44  };
   45  /** Validated plugin display fields and diagnostics from exported locales, manifests, or icon files. */
   46  export interface PluginLocalizedMeta {
   47      /** Display title; omission preserves the consumer's technical-name fallback. */
   48      readonly title?: LocalizedText;
   49      /** Display introduction after locale and package-field fallback. */
   50      readonly description?: LocalizedText;
   51      /** Base64 image data URL from a package root's manifest icon or an exported `<specifier>/icon`; render as an image, not inline markup. */
   52      readonly icon?: string;
   53      /** Unmodified local metadata diagnostic; the plugin remains manageable. */
   54      readonly error?: string;
   55  }
   56  /** Runtime version requirements under `package.json.engines`. */
   57  export interface DshEnginesManifest {
   58      /** Compatible DSH versions as a SemVer range, including an exact version. */
   59      dsh?: string;
   60      /** Compatible Node.js versions. */
   61      node?: string;
   62      /** Compatible npm versions. */
   63      npm?: string;
   64      /** Requirements for additional runtimes or package managers. */
   65      [engine: string]: string | undefined;
   66  }
   67  /** The configuration layer exported by a bundle package. */
   68  export interface DshBundleManifest {
   69      /** Supported Node Host platform names; omission allows every operating system. */
   70      platforms?: string[];
   71      /** One patch file path, or an ordered list applied in sequence, each relative to the declaring package root. */
   72      patch: string | string[];
   73      /** Show the bundle in GUI lists before the profile enables or installs it; omission means true. */
   74      listedByDefault?: boolean;
   75  }
   76  /** The bundle composition declared by a profile directory. */
   77  export interface DshProfileManifest {
   78      /** Ordered bundle layer list, using installed package names. */
   79      bundles?: string[];
   80  }
   81  /** Client module declaration read by client-modules and the client build. */
   82  export interface DshClientManifest {
   83      /** Client platform identifier; the Web consumer selects `web`. */
   84      platform: string;
   85      /** Informational package-name dependencies, not Cordis service injection. */
   86      inject?: string[];
   87      /** Boot phase-one registration barrier; absent means the shared application batch. */
   88      immediately?: boolean;
   89      /**
   90       * Exact module-table requests beyond the implicit client baseline, including
   91       * subpaths such as `<pkg>/client`; absent means baseline externals only.
   92       * Type-only imports are erased and create no module request.
   93       */
   94      external?: string[];
   95  }
   96  //# sourceMappingURL=types.d.ts.map
```

### 2.2 Field-by-field answer

| Field | Required? | Exact value / rule | Evidence |
|---|---|---|---|
| `type` | **yes** | `"module"` (ESM). Every observed plugin uses it; `import`/`export` in `lib/index.js` requires it. | all `package.json`s; `templates/decoration/package.json:5` |
| `main` | recommended | `"lib/index.js"` for a published package; `"./index.js"` for a local template. | `dsh-otel`, `dsh-tool-schedule`, third-party |
| `exports` | **yes** | At minimum `".": "./lib/index.js"` (or `{ "types": ..., "default": ... }`) and `"./package.json": "./package.json"`. Add `"./locale/*.json"`, `"./icon"`, `"./cordis.patch.yml"` when shipping those. A **config-only bundle needs no `"."` export at all**. | `dsh-otel`, third-party, `templates/mcp/package.json:6` |
| `files` | **yes** | Must list `lib/index.js`, `lib/types/**/*.d.ts`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`, READMEs. **Local directory installation links the checkout and does not filter by `files`** — a packed/published bundle does. | `references/host-plugin.md:35` |
| `engines` | recommended | `engines.node` (runtime) and `engines.dsh` (semver range of compatible DSH). Example: `"node": "^22.19.0 \|\| >=24.0.0"`, `"dsh": ">=0.2.0-rc.1 <0.3.0-0"`. | third-party `package.json:7-10`; `DshEnginesManifest` |
| `peerDependencies` | **yes** | At minimum `"@deepseek-ai/cordis": "~4.1.0"` (third-party uses `">=4.0.1 <5.0.0"`). Add every `@deepseek-ai/dsh-*` package whose API you import. Do **not** bundle them as `dependencies`. | all plugins; `dsh-otel`, `dsh-tool-schedule` |
| `dsh` field | **yes to be a *bundle*** | `dsh.bundle.patch: "./cordis.patch.yml"`. Optional `dsh.manifestVersion: 1`, `dsh.bundle.platforms`, `dsh.bundle.listedByDefault`, `dsh.client` (Web UI half), `dsh.profile.bundles` (profile packages only). | `DshManifest`; `bundleManifest()` in `dsh-plugin-manager/lib/index.js:399-402` |
| separate manifest file | **NO** | There is no `manifest.json`/`plugin.yml`. The manifest is `package.json` + the referenced `cordis.patch.yml`. `dsh-package-manifest` is only shared TS types. | `dsh-package-manifest/lib/index.js:1`; `host-plugin.md:5-27` |
| `private` | for local | `true` prevents npm publication; used by the official templates and the profile `package.json`. | `templates/decoration/package.json:4`; profile `package.json:3` |
| `icon` | optional | Top-level path (e.g. `"assets/icon.svg"`) OR `exports["./icon"]`. SVG/PNG/JPEG/WebP, <=256 KiB, must stay inside the package. | `DshPackageManifest.icon`; `host-plugin.md:51` |
| `publishConfig` | for publishing | `{"access": "public", "registry": "https://registry.npmjs.org/"}`. | all `@deepseek-ai` plugins |
| `scripts` | optional | No build step is required for a plain-JS bundle. If you author TS, see section 4. | `templates/*/package.json` has no `scripts` |

**Is a `dsh` field strictly required?** `dsh-plugin-manager/lib/index.js:399-402`
(`bundleManifest()`) returns `undefined` when `manifest.dsh?.bundle?.patch` is absent —
i.e. the package is not recognised as a **bundle** and will not be auto-selected into
`dsh.profile.bundles`. It is still *loadable* if a profile `insert` row names the package
directly (that is how `dsh-otel` and `dsh-tool-schedule`, which have no `dsh` field, are
mounted by `dsh-base` and presets). **For a self-contained third-party plugin, declare
`dsh.bundle.patch`** — that is what makes `install_bundle` / `dsh plugin add` activate it.

### 2.3 Compatibility enforcement — why `engines.dsh` matters

`BASE/dsh-app-boot/lib/index.js:1094-1143` (`evaluatePluginCompatibility`):

```js
  1094  function satisfies(runtimeVersion, range) {
  1095      return range.trim() !== "" && semver.satisfies(runtimeVersion, range, { includePrerelease: true });
  1096  }
  1097  function unmetRequirements(fields, runtimeVersion) {
  1098      const engines = Object.hasOwn(fields, "engines") ? objectOf$1(fields.engines, "Plugin manifest engines") : {};
  1099      if (Object.hasOwn(engines, "dsh")) {
  1100          const range = engines.dsh;
  1101          if (typeof range !== "string") throw new Error("Plugin manifest engines.dsh must be a string");
  1102          return satisfies(runtimeVersion, range) ? {} : { "engines.dsh": range };
  1103      }
  1104      if (!Object.hasOwn(fields, "peerDependencies")) return {};
  1105      const dependencies = objectOf$1(fields.peerDependencies, "Plugin manifest peerDependencies");
  1107      for (const [name, range] of Object.entries(dependencies)) {
  1109          if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
  1110          if (!satisfies(runtimeVersion, [...].includes(range) ? runtimeVersion : range)) unmet[name] = range;
  1111      }
  1116      return unmet;
  1117  }
```

Rule (`lib/index.js:1119-1122`): *"An own `engines.dsh` range decides alone and
peerDependencies are ignored; otherwise every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`
peer must match. Prereleases participate in ranges."* An unmet requirement produces
`incompatible-version` and the install is refused, unless the exact-version exemption
`dsh plugin allow-version <pkg@version> --dsh-version <exact> --accept-risk` is granted
(`lib/index.js:1153`, `dsh-plugin-manager/lib/index.js:314-321`). Since the running
runtime is the prerelease `0.2.2-rc.1`, use a range that admits prereleases, e.g.
`">=0.2.0-rc.1 <0.3.0-0"` (as the real third-party plugin does).

### 2.4 Host plugin export forms (authoritative)

`SK/references/host-plugin.md:57-77` (verbatim, line numbers):

```text
    57  ## Host plugin export forms
    58
    59  `index.js` exports one of these forms; do not mix them:
    60
    61  - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
    62  - A service class as the default export.
    63
    64  Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation; query `Config.listConfigs` for an installed plugin's schema before writing its `config`, and follow `$defs` references in the returned document.
```

### 2.5 The recommended `package.json` skeleton (first-party template, verbatim)

`SK/templates/decoration/package.json`:

```json
    1  {
    2    "name": "@local/my-decoration",
    3    "version": "1.0.0",
    4    "private": true,
    5    "type": "module",
    6    "exports": {
    7      ".": "./index.js",
    8      "./client": "./client.js",
    9      "./locale/*.json": "./locale/*.json",
   10      "./icon": "./icon.svg"
   11    },
   12    "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
   13    "dsh": {
   14      "bundle": { "patch": "./cordis.patch.yml" },
   15      "client": {
   16        "platform": "web",
   17        "immediately": true,
   18        "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
   19      }
   20    }
   21  }
```

`SK/templates/mcp/package.json` (config-only bundle — closest to a gateway that only
needs a patch row and no Host JS):

```json
    1  {
    2    "name": "@local/demo-mcp",
    3    "version": "1.0.0",
    4    "private": true,
    5    "type": "module",
    6    "exports": { "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
    7    "files": ["cordis.patch.yml", "locale/*.json", "icon.svg"],
    8    "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
    9  }
```

`SK/references/host-plugin.md:5-27` gives the canonical minimal Host-only bundle:

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

---


## 3. Canonical PROFILE configuration format and local test install

### 3.1 Where profiles live

`$DSH_HOME` defaults to `~/.dsh` (`hostPatchPath()` in
`dsh/lib/profile-boot-e2mS45fC.js:116-118` uses `resolveDshHome()`); profiles are under
`$DSH_HOME/profiles/<name>/` (`dsh-app-boot/lib/index.js:1325` `PROFILES_DIR = "profiles"`).
In this session: `DSH_HOME=/home/ubuntu/.dsh`, `DSH_PROFILE=web`,
`DSH_PROFILE_DIR=/home/ubuntu/.dsh/profiles/web` (from `env`). `~/.config/dsh` **does not
exist** on this machine.

The `web` profile directory contains: `package.json`, `cordis.patch.yml`, `cordis.yml`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, `node_modules/`, `.plugin-manager/`.

### 3.2 The composition model — `dsh/lib/profile-boot.js`

`dsh/lib/profile-boot.js` is a 2-line re-export shim; the implementation is
`dsh/lib/profile-boot-e2mS45fC.js` (330 lines). The header comment at lines 74-85 states:

```text
    75  /**
    76  * Shared profile boot for every `dsh` surface: resolve the profile, stack its
    77  * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
    78  * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
    79  * tree over the profile's empty root config, and wire fail-loud plus bounded shutdown.
```

Exact layer order (`profile-boot-e2mS45fC.js:224-230`, `composeProfile`):

1. bundle layers, in **`package.json` -> `dsh.profile.bundles`** order;
2. the profile's own **`cordis.patch.yml`** (the user layer);
3. the **home-level user layer** `$DSH_HOME/cordis.patch.yml` (machine-local, outranks the
   per-profile layer);
4. `--patch <file>` overlays, in argv order;
5. the telemetry switch.

The root config `cordis.yml` is **always rewritten to `[]`** on boot
(`profile-boot-e2mS45fC.js:122-128`, `:217-223`, `:239`): *"Edit cordis.patch.yml, not
this file."* Verified in the live profile — `cordis.yml` is literally `[]` with a comment.

### 3.3 The live `web` profile (verbatim, with line numbers)

`/home/ubuntu/.dsh/profiles/web/package.json` — how a user **enables** plugins:

```json
    1  {
    2    "name": "dsh-profile-web",
    3    "private": true,
    4    "dependencies": {
    5      "@michengai/dsh-archive-manager": "^1.3.5"
    6    },
    7    "dsh": {
    8      "profile": {
    9        "bundles": [
   10          "@deepseek-ai/dsh-base",
   11          "@deepseek-ai/dsh-web-app",
   12          "@deepseek-ai/dsh-experimental-agent-team-profile",
   13          "@deepseek-ai/dsh-experimental-plugin-market-bundle",
   14          "@deepseek-ai/dsh-experimental-auto-review",
   15          "@deepseek-ai/dsh-experimental-forge-bundle",
   16          "@deepseek-ai/dsh-experimental-session-titles-bundle",
   17          "@michengai/dsh-archive-manager"
   18        ]
   19      }
   20    }
   21  }
```

The `dsh.profile.bundles` array (lines 9-18) is the ordered list of enabled bundles;
`dependencies` (line 4-6) records installed packages. The real third-party plugin is both
a dependency and the last bundle.

`/home/ubuntu/.dsh/profiles/web/cordis.patch.yml` — how a user **passes config**:

```yaml
    1  # Your patch layer for this dsh profile, applied after every bundle layer:
    2  # a top-level YAML array of loader patch entries (id-targeted config
    3  # overrides, disables, and insert lists; `!!js` expressions allowed).
    4  - id: ui-settings-general
    5    name: "@deepseek-ai/dsh-client-ui-settings-general"
    6    config:
    7      welcomeNoticeVersion: 2026-09-28.1
    8  - id: llm-pi-ai
    9    name: "@deepseek-ai/dsh-llm-pi-ai"
   10    config:
   11      providers:
   12        magpie:
   13          apiKeyEnv: MAGPIE_API_KEY
   14          api: openai-completions
   15          baseURL: http://100.96.96.81:3425/v1
   16          models:
   17            - id: group/deepseek
   18              name: Deepseek · routing group
   19              contextWindow: 1048576
   20              maxTokens: 384000
   21            - id: group/hy4-free
   22              name: hy4-free · routing group
   23              contextWindow: 960000
   24              maxTokens: 64000
   25  - id: agent-default-model
   26    name: "@deepseek-ai/dsh-agent-default-model"
   27    config:
   28      provider: magpie
   29      model: group/hy4-free
```

Each entry is an **override by `id`**: `- id: <row-id> name: '<pkg>' config: {...}`.
Note the header comment (lines 1-3): *"a top-level YAML array of loader patch entries
(id-targeted config overrides, disables, and insert lists; `!!js` expressions allowed)"*.

`/home/ubuntu/.dsh/profiles/web/cordis.yml`:

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

### 3.4 Loader patch dialect (authoritative)

`BASE/dsh-agent-preset/skills/cordis-composition-reference/SKILL.md:10-25` (verbatim):

```text
    10  ## Loader patch dialect
    11
    12  A profile composes an ordered list of patch layers over the bundle entry lists. Each patch is a mapping:
    13
    14  - `insert: [rows]` appends rows; with an `id` naming an existing `group: true` row, the rows are appended inside that group's `config` list.
    15  - A patch with an `id` and no `insert` targets the existing row with that id. Supplied fields replace the row's fields; `config` is replaced wholesale, never deep-merged, so restate every field the row needs. A truthy `name` asserts the existing plugin name rather than renaming it.
    16  - Non-insert patches without a nonempty `id`, and targets that match no row, are warned about and skipped.
    17
    18  A row has `id`, `name` (the plugin package specifier; inserted relative paths are anchored beside their patch file), optional `config`, and optional `disabled`, `inject`, `intercept`, and `isolate`.
    19
    20  - `group: true` with `name: cordis:group` makes `config` a nested entry list and allows patches to insert into it by id. `cordis:include` loads a literal YAML or JSON entry list from `config.path`.
    21  - `disabled` accepts a boolean, null, or a `!!js` expression evaluated against the Loader context at every mount decision. A disabled row omits required `config` unless `group: true` forces activation.
    22  - `!!js` scalars are Loader expressions, never `!js`. Inside `config` they are evaluated after the row's declared injections activate, against that plugin's context (`ctx.<service>`), so `!!js dshHomePath('sessions')` and `!!js "!ctx.get('profileContext')"` are valid. Other row metadata stays literal.
    23  - `isolate` maps service names to `true` or a realm label; a preset plugin that provides a service isolates the provider and all consumers together. Scope controls contributions and event visibility; `isolate` controls service instances.
    24
    25  `plugin_manager` `list_plugins` reports each row's `enabled` flag and `fiberPhase`; `set_plugin` and `set_bundle` answer `overridden` when a higher-priority layer wins.
```

Additional notes: `dsh/lib/types/args.d.ts:29-45` and
`profile-boot-e2mS45fC.js:290-313` document `dsh --dump-config`,
`--dump-config-schema`, `--dump-default-config` (print the composed tree / JSON Schemas /
bundle-only layers without mounting). These are **documented; not executed** here — see §6.

### 3.5 Real bundle patches (verbatim)

`SK/templates/mcp/cordis.patch.yml` — config-only bundle, shows `config:` passing:

```yaml
    1  - insert:
    2      - id: demo-mcp
    3        name: '@deepseek-ai/dsh-mcp-client'
    4        config:
    5          serverName: demo
    6          transport: streamable-http
    7          url: http://127.0.0.1:3000/mcp
    8          failOnStartupError: true
```

`SK/templates/decoration/cordis.patch.yml` — Host plugin bundle:

```yaml
    1  - insert:
    2      - id: my-decoration
    3        name: '@local/my-decoration'
```

`BASE/dsh-experimental-plugin-market-bundle/cordis.patch.yml` — `!!js` + multiple rows:

```yaml
    1  # Custom plugin indexes: the Host service that reads the index sources the
    2  # user configures and the Web Discover tab of the Plugins page. The
    3  # `plugin_market` tool row in the Creator preset registers its tool only
    4  # while this service is mounted.
    5  - insert:
    6      - id: plugin-market
    7        name: '@deepseek-ai/dsh-plugin-market'
    8        disabled: !!js "!ctx.get('profileContext')"
    9      - id: ui-plugin-market
   10        name: '@deepseek-ai/dsh-client-ui-plugin-market'
```

`BASE/dsh-sdk-app/cordis.patch.yml:1-27` (excerpt) shows override-by-id, `disabled`,
`inject`, and a `!!js` expression in `config`:

```yaml
- id: system-prompt
  config:
    personaPrefix: >-
      You are a coding agent powered by the {{model}} model.

- id: session-title-llm
  disabled: true

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

- id: hmr
  disabled: true
```

`BASE/dsh-base/cordis.patch.yml:60-70` shows a `config:` block on an inserted row:

```yaml
    - id: session-title
      name: '@deepseek-ai/dsh-session-title'
      config:
        fallbackMaxWords: 5
        fallbackMaxBytes: 40
        maxTitleBytes: 80
```

### 3.6 Installing a LOCAL (unpublished) plugin for testing

**Verified CLI help (executed, all exit code 0, no state changes):**

`dsh --help` (excerpt, from `dsh/lib/bin.js:39-49` `HELP_EXAMPLES`):

```text
Examples:
  dsh web                                   boot the web profile (same as: dsh --profile web)
  ...
  dsh plugin --profile tui add <package>    install a plugin into the tui profile
```

`dsh plugin --help` / `dsh plugin --profile web --help` (identical output):

```text
Usage: dsh plugin [options] [args...]

manage a profile's plugins by forwarding the remaining arguments to pnpm in the
profile directory

Arguments:
  args              pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>,
                    why <pkg>, ...)

Options:
  --profile <name>  the profile whose plugins to manage (initialized on first
                    use)
  -h, --help        show this help
```

`dsh/lib/bin.js:115-120`: `plugin` is a subcommand that **forwards the remaining
arguments verbatim to pnpm inside the profile directory**.
`dsh/lib/types/args.d.ts:46-52` (`PluginInvocation`): *"Raw pnpm arguments, verbatim."*
`dsh/lib/types/plugin.d.ts:8`: `runPlugin(profile, args, packageManager)`.

**Therefore the local test install command is:**

```sh
# from the workspace containing your plugin package directory
dsh plugin --profile web add /home/ubuntu/dsh-workspace/projects/dsh-plugin-feishu-gateway
# or with a relative path (resolved against the CALLER's cwd, not the profile dir):
dsh plugin --profile web add ./dsh-plugin-feishu-gateway
# or explicitly as a link (pnpm records it as file:/link: relative to the profile):
dsh plugin --profile web add link:/absolute/path/to/dsh-plugin-feishu-gateway
```

Evidence that relative paths work:
`dsh-plugin-manager/lib/types/operations.d.ts:38-43` — *"Resolve relative package specs
against the caller's directory"* — and `dsh-plugin-manager/lib/index.js:388-392`:

```js
   388  function anchorPathSpec(argument, cwd) {
   389      const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument);
   390      if (match?.groups?.path === void 0) return argument;
   391      return `${match.groups.prefix ?? ""}${resolve(cwd, match.groups.path)}`;
   392  }
```

`dsh-plugin-manager/lib/types/install-spec.d.ts:41-48` and `lib/index.js:161-206`
(`parseInstallSpec`): a path spec may be `file:`, `link:`, or a bare absolute path;
**relative paths are rejected by the service path** ("a local path must be absolute"),
which is why the in-app tool wants an absolute directory. `dependencySpec()`
(`lib/index.js:223-232`) converts recorded `file:`/`link:` values back to absolute paths
when re-installing.

**In-app alternative (preferred by the first-party skill):**
`SK/SKILL.md:8` says: *"use ordinary workspace files to author a bundle, then
`plugin_manager` with `action: install_bundle` and the absolute package directory as
`target` to install it in the current profile. Changes affect every session in that
profile and survive restart."* And `SK/SKILL.md:10`: *"Do not write the profile's
`package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in
the profile directory: `install_bundle` performs those steps"* — i.e. the tool also adds
the package to `dsh.profile.bundles` (see `reconcile()` / `activateNewBundles` in
`operations.d.ts:26`, `:56-69`).

> **Important:** do NOT run `dsh plugin add` in this research session — it is a state
> change and was explicitly out of scope. Only `--help` was executed. The commands above
> are derived from source + the third-party plugin's own documented install line and are
> **not verified by execution**.

**After installing:** check `plugin_manager` results — `SK/references/host-plugin.md:79-83`
says to read `application` and `warnings`; `failed` needs diagnosis, `overridden` means a
higher-priority layer wins, `restart-required` means the change is not live; a *new*
bundle can activate through HMR, but *replacing* an installed package requires a restart
to load a fresh JS module generation.

### 3.7 Enabling / passing config once installed

- Enable: the package name must appear in `dependencies` **and** in
  `dsh.profile.bundles` of `$DSH_HOME/profiles/<name>/package.json`; disable with
  `set_bundle`/`set_plugin` or `disabled: true` on the row.
- Pass config: add a `config:` mapping to the plugin's `insert` row in your bundle's
  `cordis.patch.yml`, or add an override row by `id` in the profile's own
  `cordis.patch.yml` (remember `config` is **replaced wholesale**, not deep-merged).
- Query the schema first: `Config.listConfigs` (with `name` = package, then query the
  `entry` id) returns the installed plugin's Config JSON Schema —
  `SK/SKILL.md:30`, `SK/references/host-plugin.md:64`.
- Secrets: `SK/references/host-plugin.md:77` — *"Store secrets, such as a token from an
  in-app sign-in or binding flow, as `ctx.credentials.modifyRecord()` records, not
  configuration"*; declare `credentials` in `inject` or `ctx.get('credentials')`.
  For a Feishu app secret / encrypt key this matters.
- Ambient credentials are scrubbed; `SK/references/mcp-bundle.md:7` says to *"reference
  existing credentials with Loader `!!js` rather than copying secrets into conversation
  text."*

---


## 4. Test patterns, build tooling, and TS/vitest versions

### 4.1 What is actually shipped in published packages

**No test files or test configs are shipped.** A scan of all
`BASE/*` package directories at depth <= 3 for
`*.test.ts`, `*.test.js`, `*.test.mjs`, `vitest.config.*`, `tsconfig*.json`,
`tsup.config.*`, `tsdown.config.*`, `vite.config.*` returned **0 files**. Published
`@deepseek-ai/dsh-*` packages contain only built `lib/*.js`, `lib/types/**/*.d.ts`,
`locale/*.json`, `README*`, `LICENSE`, and (for bundles) `cordis.patch.yml` + `icon.svg`.

`SK/SKILL.md:32` confirms: *"installed packages ship built `lib/index.js` and
`lib/types/**/*.d.ts` with JSDoc under that same `packageDir`, not `src/`; a source
checkout of DSH has `packages/<group>/<name>/src`."* READMEs reference source-tree
tests that are **not** in the tarball — e.g. `dsh-sdk-minimal/README.md:61` cites
`tests/sdk-minimal.spec.ts`, and `dsh-otel/README.md:41` says *"Composition tests
exercise independent channels and service removal"*. Those files are **unverified / not
present** in this installation.

### 4.2 Build tooling used by plugins

`scripts` across all package.json files (counted):

```
 83  bundle: tsdown
 83  watch: tsdown --watch
  1  build: vite build
  1  dev: vite
  1  watch: vite build --watch --no-emptyOutDir
  1  build:js: tsc -b
  1  render:app-icons: tsx scripts/render-app-icons.ts
```

So the first-party build tool is **`tsdown`** (not `tsup`, not `vite`, not plain `tsc`).
Examples: `dsh-api-gateway/package.json` has
`"bundle": "tsdown"`, `"watch": "tsdown --watch"`. **`tsdown` itself is NOT installed**
in the runtime `node_modules` — it is a source-checkout/build-time dependency.
`dsh-otel`, `dsh-tool-schedule`, `dsh-schedule`, `dsh-package-manifest` have **no
`scripts` at all** in their published manifests.

Exact build/test dependency versions declared (only these packages declare them):

| Tool | Version | Declaring package(s) |
|---|---|---|
| `vitest` | `^4.1.11` | `@deepseek-ai/dsh-web-frontend` |
| `typescript` | `^6.0.3` | `@deepseek-ai/dsh-web-frontend` |
| `vite` | `^6.4.3` | `@deepseek-ai/dsh-web-frontend` |
| `@types/node` | `^22.20.1` | `@deepseek-ai/dsh-web-frontend` |
| `esbuild` | `^0.28.2` | `@deepseek-ai/dsh-hmr` |
| `tsx` | `^4.23.13` | 3 packages (e.g. `dsh-host-directory-picker-native`) |

None of `vitest`, `typescript`, `tsup`, `tsdown`, `vite`, `esbuild`, `tsx` are installed
in `dsh/node_modules` — they are build-time only.

### 4.3 The real third-party plugin's toolchain (most relevant precedent)

`@michengai/dsh-archive-manager/package.json:40-52, 76-114`:

```json
"scripts": {
  "build": "pnpm typecheck && node scripts/build.mjs && node scripts/check-package.mjs",
  "test": "pnpm build && node --import tsx --test test/*.test.mjs",
  "test:matrix": "pnpm build && node scripts/test-version-matrix.mjs",
  "test:latest": "pnpm build && node scripts/test-latest-compatibility.mjs",
  "test:compat": "pnpm build && pnpm test:matrix",
  "pack:check": "pnpm pack --dry-run",
  "verify": "pnpm test && pnpm test:compat && pnpm pack:check && node scripts/check-generated.mjs",
  "prepublishOnly": "pnpm verify",
  "prepack": "pnpm build",
  "typecheck": "tsc --noEmit"
}
```

devDependencies include `typescript 5.9.3`, `esbuild 0.25.0`, `tsx ^4.23.13`,
`@types/node ^22.20.4`, `react 18.3.1`, `semver 7.7.2`, plus pinned `0.2.2-rc.2`
`@deepseek-ai/*` dev peers. It uses **Node's built-in test runner
(`node --import tsx --test test/*.test.mjs`)**, not vitest, and a hand-written
`scripts/build.mjs` (esbuild) rather than tsdown/tsup. Its `scripts/` and `test/`
directories are **not shipped** in the installed package (verified by the tree in §1.1),
so those test sources are **unverified**.

### 4.4 Practical recommendation for our plugin

- Plain-JS ESM (`lib/index.js`) needs **no build step at all** — the official templates
  have no `scripts` and no `devDependencies`. This is the lowest-risk scaffold.
- If TypeScript is desired: author `src/index.ts`, use `tsdown` (first-party choice) or
  `tsc --noEmit` + `esbuild` (third-party precedent), emit `lib/index.js` +
  `lib/types/index.d.ts`, and keep `exports["."].types` pointing at the `.d.ts`.
- Tests: `node --import tsx --test` (no vitest dependency needed at runtime), or vitest
  `^4.1.11` if following `dsh-web-frontend`. No test config files exist locally to copy.

---

## 5. Exact installed versions

Read from each package's `package.json` in `BASE` and from `node -v` / `pnpm -v`:

| Package | Exact installed version |
|---|---|
| `@deepseek-ai/cordis` | **4.1.0** |
| `@deepseek-ai/schemastery` | **3.19.0** |
| `@deepseek-ai/dsh-session` | **0.2.2-rc.1** |
| `@deepseek-ai/dsh-sdk-app` | **0.2.2-rc.1** |
| `@deepseek-ai/dsh-sdk-minimal` | **0.2.2-rc.1** |
| `@deepseek-ai/dsh-package-manifest` | **0.2.2-rc.1** |
| `@deepseek-ai/dsh` (CLI / runtime) | **0.2.2-rc.1** |
| `@deepseek-ai/dsh-app-boot` (context) | **0.2.2-rc.1** |
| `@deepseek-ai/dsh-llm` (context) | **0.2.2-rc.1** |
| `@deepseek-ai/dsh-typert-protocol` (context) | **0.2.2-rc.1** |

Runtime:

```
node -v      -> v24.22.2
pnpm -v      -> 12.18.0
npm -v       -> 11.13.0
corepack -v  -> 0.36.0
```

The `web` profile's `node_modules/.modules.yaml:13` records
`"packageManager": "pnpm@12.18.0"`; the installed third-party plugin declares
`"packageManager": "pnpm@11.22.0"` in its own `package.json:6` (its authoring toolchain,
not the profile's).

Peer/dependency ranges observed (use these in a new plugin):

```
"@deepseek-ai/cordis": "~4.1.0"          (all first-party plugins)
"@deepseek-ai/schemastery": "~3.19.0"    (dsh-api-gateway, dsh-sdk-app dependencies)
"@deepseek-ai/cordis": ">=4.0.1 <5.0.0" (third-party plugin's looser peer)
```

`cordis@4.1.0` itself has optional peers `@deepseek-ai/cordis-plugin-include ~1.1.0`
and `@deepseek-ai/cordis-plugin-loader ~1.1.0`; `schemastery@3.19.0` depends on
`@standard-schema/spec ^1.1.0` and `@deepseek-ai/cosmokit ~1.9.0`.

---

## 6. Unverified / not found items (explicitly marked)

1. **`@deepseek-ai/dsh-webhook` and `@deepseek-ai/dsh-webhook-github` are NOT installed.**
   `find` over `/home/ubuntu/.npm-global`, `/home/ubuntu/.dsh`, and
   `/home/ubuntu/dsh-workspace` found no such directory and no `package.json` with those
   names. The only local evidence is the catalog text at
   `dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:237-238`:
   - `| @deepseek-ai/dsh-webhook | no | Fire-and-forget webhook rule runtime that creates Workspace-backed DeepSeek Harness Sessions |`
   - `| @deepseek-ai/dsh-webhook-github | yes | Signed GitHub HTTP webhook adapter for the DeepSeek Harness webhook runtime |`
   Their source, `package.json`, `cordis.patch.yml`, and Config schema are **unverified**.
   (The `standardwebhooks` npm package is installed, but it is a generic webhook
   verification library, not a DSH plugin.)
2. **No `apps/cli/config/examples/` directory exists in this installed checkout.**
   `SK/SKILL.md:18` and `dsh-sdk-app/README.md:26` reference
   `apps/cli/config/examples/<feature>/cordis.yml` and `.../ptc.yml`; those paths belong
   to a source checkout and are absent here. Likewise `docs/subsystems/*.md`,
   `packages/<group>/<name>/src`, and `tests/*.spec.ts` are absent.
3. **The exact Session-creation API for an inbound external event was not verified.**
   §1.4 shows `agent.inject(createUserMessage(...))` into an *existing* Session; creating
   a new Session is described only by the catalog blurb for the missing `dsh-webhook`.
4. **No config dumps were executed.** `dsh --profile web --dump-config`,
   `--dump-config-schema`, `--dump-default-config` are documented in
   `dsh/lib/types/args.d.ts:29-45` and `dsh/lib/bin.js:105` but were **not run** (only
   `--help` commands were permitted). The live profile's composed tree is therefore
   inferred from `package.json` + `cordis.patch.yml` + bundle patches, not from a dump.
5. **No `plugin_manager` / `install_bundle` / `dsh plugin add` was executed.** All install
   guidance is derived from source and `--help`; **not verified by execution**.
6. **Test files of the third-party plugin (`test/*.test.mjs`, `scripts/build.mjs`) are not
   shipped** in the installed package and were not inspected. Its vitest/TS versions are
   read from `devDependencies`, not from a lockfile in the package.
7. **`~/.config/dsh` does not exist**; `DSH_HOME=/home/ubuntu/.dsh` is the only home.
   A home-level `$DSH_HOME/cordis.patch.yml` was **not present** (only
   `$DSH_HOME/profiles/web/cordis.patch.yml`).
8. **`tsdown` version is unverified** — it is referenced only by `scripts.bundle` strings
   and is not installed in the runtime `node_modules`.
9. `node_modules/bundle-name` is an unrelated npm package (macOS bundle identifiers,
   `sindresorhus/bundle-name`), **not** a DSH bundle. Do not use it as an example.
10. `dsh-http-proxy` is a **library, not a plugin** (`lib/types/index.d.ts:9-10`);
    `dsh-plugin-detail` and `dsh-package-manifest` are utility/type packages, not
    representative plugin entries.

---


## Appendix A — Authoritative scaffolding templates (verbatim, with line numbers)

All from `BASE/dsh-agent-preset/skills/cordis-plugin-development/` (abbreviated `SK`).
`SK/SKILL.md:38` notes that in Desktop this directory sits inside `app.asar`; here it is
a normal directory. **Copy templates into the workspace; never edit them in place**
(`SK/SKILL.md:38`).

### `SK/SKILL.md` (full)

```markdown
    1  ---
    2  name: cordis-plugin-development
    3  description: Use when designing, reviewing, adding, enabling, disabling, installing, configuring, or debugging a plugin, bundle, feature, page, panel, tool, or MCP connection in the current Harness profile, including a shipped plugin that is disabled by default, and for any visual object, decoration, or widget request that names no other destination, which means an installed UI plugin rendered in the Harness Web UI.
    4  ---
    5  
    6  # Persistent Harness plugins
    7  
    8  For implementation, use ordinary workspace files to author a bundle, then `plugin_manager` with `action: install_bundle` and the absolute package directory as `target` to install it in the current profile. Changes affect every session in that profile and survive restart. Load `editing-cordis-compositions` for agent preset changes.
    9  
   10  Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory: `install_bundle` performs those steps, and each hand-made write outside the workspace needs its own approval. Every `plugin_manager` action, including `list_plugins` and `list_bundles`, also needs approval without Full access, so call it only when its result decides the next step.
   11  
   12  ## Design or review
   13  
   14  Read the applicable references below and inspect the proposed or existing plugin against current APIs. Report design choices or findings instead of following the installation workflow. Do not write files, install bundles, or change profile state unless the user requests implementation.
   15  
   16  ## Enable a shipped plugin
   17  
   18  A shipped bundle can resolve a plugin row and leave it `disabled`. The row id and its reason are in the shipped patch, `packages/bundle/*/cordis.patch.yml` in a source checkout. Write a workspace bundle whose patch overrides that row with `disabled: false` and inserts the Host rows it depends on; a source checkout's `apps/cli/config/examples/<feature>/cordis.yml` lists them for opt-in features. Packages shipped with dsh resolve from the dsh installation, so the bundle declares no dependencies on them. Install it with `install_bundle`.
   19  
   20  ## Deliver a working plugin first
   21  
   22  1. Resolve the requested result and destination. An unspecified visual destination is the current Harness Web UI; a standalone image or HTML file does not complete such a request. Choose reasonable visual details and implement a small first version; install it before visual refinement.
   23  2. Discover only the APIs needed for that version: `cordis_inspect_list`, then targeted `cordis_inspect_query` calls. For UI, query Client `Slots.listSubTree` and the selected slot's registration options and props. For anything beyond a static decoration, such as tool policy, agent context, session-derived state, or Chat rows, read `references/practices.md` before choosing the extension point; for a user action in plugin UI, also read `references/user-actions.md`. Once the chosen slot and registration API are known, write the plugin.
   24  3. Read and copy the matching template files into one workspace directory, or author the package, patch, and required Host/Client files there. Before installing, complete the display checklist in `references/host-plugin.md`: meaningful localized titles/descriptions, an original or licensed icon, and exported resources with distribution checks where applicable. This applies to Host-only and configuration-only bundles too; adapt template text and artwork to the request. Check JavaScript syntax and the manifest, then install. Use the installed plugin as the first preview; do not create preview HTML, mock shells, design variants, screenshot scripts, or rasterizer tooling first.
   25  4. Read the installation result: `application` and `warnings` decide whether the change is live, not logs, process lists, or the page's boot payload. Confirm new rows with approval-free `cordis_inspect_query`, not `list_plugins`. After `application: applied`, exercise the capability or inspect the live Client registration. Verify installed display metadata and the icon using `references/host-plugin.md`. Use the connected page when available; follow `references/verification.md` for page/panel design checks and unavailable browser control, and `references/user-actions.md` for user actions. Restore user state changed during testing. Report verification limits; installation and slot registration alone do not establish what the user sees.
   26  5. Fix observed defects in the same plugin. When the requested result works, finish with its location, verification status, and the reason for any display-resource exception; never silently accept default artwork. Do not continue speculative variants, optional features, or mock previews. Close any task list.
   27  
   28  ## Knowledge sources, in order
   29  
   30  1. Inspection: `cordis_inspect_query` answers exact Service methods and Event modes (`Service`, `Event`), a mounted plugin's Config JSON Schema (`Config.listConfigs`: filter the paged directory by `name`, then query the `entry` id), the Tools this Agent can call (`Tool`), and live Client Slots and theme tokens (`Slots`, `Theme`).
   31  2. Package documentation: `Config.listConfigs` with `name` set to the package finds its entries; querying one `entry` returns its `packageDir`, the resolved package directory. Read `<packageDir>/README.md`. Bundled packages resolve from the dsh installation and profile-installed bundles from the profile, so never guess the path from `$DSH_PROFILE_DIR`.
   32  3. Source: installed packages ship built `lib/index.js` and `lib/types/**/*.d.ts` with JSDoc under that same `packageDir`, not `src/`; a source checkout of DSH has `packages/<group>/<name>/src`. Read them when inspection and the README leave a question open, and start source-level diagnosis from a concrete installation or runtime failure.
   33  
   34  `DSH_PROFILE` (profile name) and `DSH_PROFILE_DIR` (its directory, whose `node_modules` holds only profile-installed bundles) are set in every shell call of a profile-launched Harness and absent when the Harness was booted without a profile. Bash reads them as `$DSH_PROFILE`; PowerShell, which the Windows preset uses, reads them as `$env:DSH_PROFILE`. With `dsh` on the PATH, `dsh --profile "$DSH_PROFILE" --dump-config` prints the composed profile.
   35  
   36  ## Read next
   37  
   38  The files below live in this skill's base directory, which the `skill` tool reported, and the table is the complete list: do not enumerate that directory. In every deployment, including a source checkout, read these files with the file-read tool, write copies into the workspace with the file-write tool, and verify a copy by reading it back. In Desktop the directory sits inside `app.asar`, which only the Host process's own file reads can open; shell commands (`ls`, `cat`, `cp`, `cmp`), the glob and search tools (they run a native ripgrep process), `node`, and pnpm all fail on it. Never install or syntax-check a template in place; copy its contents into the workspace first.
   39  
   40  | Task | File |
   41  |---|---|
   42  | Bundle manifest, locale resources, icons, installation, Host exports and Config | `references/host-plugin.md` |
   43  | Web UI: Client manifest, module loader, slot registration | `references/ui-plugin.md` |
   44  | Connecting an MCP server through a configuration-only bundle | `references/mcp-bundle.md` |
   45  | Page/panel design checks and verification without browser control | `references/verification.md` |
   46  | UI plugin template, including display resources | `templates/decoration/package.json`, `templates/decoration/cordis.patch.yml`, `templates/decoration/index.js`, `templates/decoration/client.js`, `templates/decoration/locale`, `templates/decoration/icon.svg` |
   47  | MCP bundle template, including display resources | `templates/mcp/package.json`, `templates/mcp/cordis.patch.yml`, `templates/mcp/locale`, `templates/mcp/icon.svg` |
   48  | Loader patch dialect and the list of installable plugin packages | the `cordis-composition-reference` skill |
   49  | Choosing extension points, contexts, and state mechanisms for upgrade stability and performance | `references/practices.md` |
   50  | Sharing application operations between UI actions and agent tools | `references/user-actions.md` |
```

### `SK/references/host-plugin.md` (full)

```markdown
    1  # Bundles and Host plugins
    2  
    3  A bundle is a package whose `package.json` declares `dsh.bundle.patch`; the YAML patch inserts plugin entries. Give the package and rows unique names; use the Loader's existing YAML syntax, including `!!js` where expressions are needed. Read an existing patch before editing it: a matching override replaces the complete `config`.
    4  
    5  ## Manifest
    6  
    7  A Host-only bundle needs no dependencies, install scripts, or build tool:
    8  
    9  ```json
   10  {
   11    "name": "@local/my-plugin",
   12    "version": "1.0.0",
   13    "private": true,
   14    "type": "module",
   15    "exports": { ".": "./index.js" },
   16    "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
   17  }
   18  ```
   19  
   20  `cordis.patch.yml`:
   21  
   22  ```yaml
   23  - insert:
   24      - id: my-plugin
   25        name: '@local/my-plugin'
   26        config: {}
   27  ```
   28  
   29  ## Display metadata and icon
   30  
   31  Plugin Manager and Settings read `meta.title` and `meta.description` from exported locale JSON and an icon from exported resources without activating plugins. Complete this checklist before installation:
   32  
   33  - Write a recognizable title and a description of the capability in `locale/en.json` under `meta.title` and `meta.description`. Add the same fields for the user's language and other supported locales, such as `locale/zh.json`; do not leave template copy unrelated to the delivered plugin. Write English titles and other UI labels in sentence case: capitalize only the first word and proper nouns, as in `Git worktrees`.
   34  - Create an original icon or use artwork whose license permits redistribution, retaining any required attribution.
   35  - Export `./locale/*.json` and `./icon`; retain existing runtime exports. Keep the patch, locales, icon, and every runtime file in `files`, updating it whenever you add modules or assets. For a packed or published bundle, verify the actual packed file list. Local directory installation links the checkout instead, so check the files directly; `files` does not filter a linked directory.
   36  - Check that the icon is a valid image of the declared format and satisfies the path and size limits below. An accepted filename alone does not establish that its bytes render.
   37  
   38  For example, the locale file contains:
   39  
   40  ```json
   41  { "meta": { "title": "My decoration", "description": "Draws a badge under the composer." } }
   42  ```
   43  
   44  ```json
   45  {
   46    "exports": { "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
   47    "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"]
   48  }
   49  ```
   50  
   51  A package-root plugin may instead declare a top-level `icon` in `package.json`; it takes priority over `./icon` and is a path relative to the manifest directory. A subpath plugin such as `my-plugins/search` is not a package and never reads a `package.json`; it exports `./search/locale/*.json` and `./search/icon` instead. Icons may be SVG, PNG, JPEG, or WebP up to 256 KiB and must stay inside the package; absolute paths, URLs, and symlinks leaving it are rejected. Missing fields of a package-root plugin fall back to `package.json` `name` and `description`, and missing images use the panel's default artwork; malformed metadata produces a diagnostic and keeps the valid text.
   52  
   53  After installation, verify the intended title and description in bundle details and plugin rows, plus the rendered icons, in English and the user's locale where supplied. Check for metadata diagnostics and unintended fallbacks, and that each plugin row shows its own exported icon or, when it has none, the generic artwork. Without browser control, inspect the installed resources and report that rendered display remains unverified; do not claim visual success from installation alone.
   54  
   55  An existing plugin's metadata may remain unchanged when it still describes the requested result. A disposable test fixture or an explicitly requested metadata-free package may omit resources, but explain each omission in the delivery report. A Host-only or configuration-only bundle still has a visible inventory entry; neither is an exception by itself.
   56  
   57  ## Host plugin export forms
   58  
   59  `index.js` exports one of these forms; do not mix them:
   60  
   61  - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
   62  - A service class as the default export.
   63  
   64  Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation; query `Config.listConfigs` for an installed plugin's schema before writing its `config`, and follow `$defs` references in the returned document.
   65  
   66  ## Persist your own configuration
   67  
   68  Plugin code never persists configuration by reading, filtering, and rewriting the active profile's `cordis.patch.yml`, and never locates that file by walking up from the package directory. That file is not your bundle's patch: it belongs to the user and holds other plugins' `insert` rows, comments, and `!!js` expressions. To change its own configuration after `apply` returns, a plugin uses the config editor:
   69  
   70  ```js
   71  const entry = ctx.fiber.entry
   72  const editor = ctx.get('configEditor')
   73  if (entry === undefined || editor === undefined) throw new Error('Configuration cannot be saved in this profile')
   74  await editor.edit(entry, current => ({ ...current, field: value }))
   75  ```
   76  
   77  `change` returns the row's complete config. The editor keeps the rest of the file, validates the candidate, serializes the write with other profile changes, and rejects values that a higher layer overrides. Report a rejection or a missing editor to the user instead of claiming the value was saved. Editing an ordinary field restarts the plugin so `apply` rebuilds its state; a field declared `.volatile()` updates in place and is read with `config.field.get()`. Store secrets, such as a token from an in-app sign-in or binding flow, as `ctx.credentials.modifyRecord()` records, not configuration; declare `credentials` in `inject` or read it with `ctx.get('credentials')`, and see the `@deepseek-ai/dsh-credentials` README for record keys.
   78  
   79  ## Install, enable, and observe
   80  
   81  `plugin_manager` `install_bundle` performs package installation and bundle selection; do not reproduce those steps with shell commands. Only pass `approvedBuilds` after the user explicitly approves the reported pending build scripts. Preserve returned failures and pending states; report success only after observing the requested capability.
   82  
   83  `list_plugins` and `list_bundles` return exact identifiers for existing installations. `set_plugin` and `set_bundle` toggle them; `remove_bundle` removes a bundle. Inspect saved-state and activation outcomes separately: `failed` requires diagnosis, `overridden` means a higher-priority layer wins, and `restart-required` means the change is not live. Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation. Do not infer updated browser code from an unchanged slot id.
```

### `SK/references/mcp-bundle.md` (full)

```markdown
    1  # Connect an MCP server
    2  
    3  Read `templates/mcp/` with the file-read tool and write its files into your bundle directory. A configuration-only bundle's manifest needs a unique name, version, and `dsh.bundle.patch`, but no Host/Client entry files. Its patch, `templates/mcp/cordis.patch.yml`, inserts the already installed `@deepseek-ai/dsh-mcp-client` with `serverName`, `transport: streamable-http`, `url`, and `failOnStartupError: true`.
    4  
    5  Replace the endpoint, install the bundle through `plugin_manager`, then call `mcp__demo__ping` or another newly available `mcp__<serverName>__<tool>` tool to verify the connection. For stdio, use `transport: stdio`, `command`, and optional `args`, `env`, and `cwd`; `Config.listConfigs` on the installed row returns the complete client schema. Ambient credentials are scrubbed; reference existing credentials with Loader `!!js` rather than copying secrets into conversation text. Repair the same bundle on failure instead of creating duplicates.
```

### `SK/templates/decoration/index.js`

```js
    1  /** Host half of the decoration bundle; the Client module owns the rendering. */
    2  export function apply() {}
```

### `SK/templates/decoration/client.js`

```js
    1  window.__ModuleLoader__.load({
    2    id: '@local/my-decoration',
    3    factory(require) {
    4      const React = require('react');
    5      const h = React.createElement;
    6      function Decoration() {
    7        return h('svg', {
    8          viewBox: '0 0 64 64', width: 48, height: 48,
    9          'aria-hidden': true,
   10          style: { display: 'block', pointerEvents: 'none' },
   11        }, h('circle', { cx: 32, cy: 32, r: 24, fill: '#247bbf' }));
   12      }
   13      return {
   14        inject: ['slots'],
   15        apply(ctx) {
   16          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
   17            name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
   18          }, Decoration));
   19        },
   20      };
   21    },
   22  });
```

### `SK/templates/decoration/locale/en.json`

```json
    1  {
    2    "meta": {
    3      "title": "Composer decoration",
    4      "description": "Displays a blue circle below the message composer."
    5    }
    6  }
```

### `SK/templates/mcp/locale/en.json`

```json
    1  {
    2    "meta": {
    3      "title": "Demo MCP connection",
    4      "description": "Connects a remote MCP server to make its tools available to the agent."
    5    }
    6  }
```

### `cordis-composition-reference/SKILL.md` (full)

```markdown
    1  ---
    2  name: cordis-composition-reference
    3  description: Use when writing or reading a Cordis bundle patch or agent preset for this harness and you need the Loader YAML dialect (insert, override by id, group, disabled, isolate, !!js) or the list of installable Harness plugin packages and what each provides.
    4  ---
    5  
    6  # Cordis composition reference
    7  
    8  Reference material for bundle patches and preset plugin lists. Procedures live in `cordis-plugin-development` and `editing-cordis-compositions`.
    9  
   10  ## Loader patch dialect
   11  
   12  A profile composes an ordered list of patch layers over the bundle entry lists. Each patch is a mapping:
   13  
   14  - `insert: [rows]` appends rows; with an `id` naming an existing `group: true` row, the rows are appended inside that group's `config` list.
   15  - A patch with an `id` and no `insert` targets the existing row with that id. Supplied fields replace the row's fields; `config` is replaced wholesale, never deep-merged, so restate every field the row needs. A truthy `name` asserts the existing plugin name rather than renaming it.
   16  - Non-insert patches without a nonempty `id`, and targets that match no row, are warned about and skipped.
   17  
   18  A row has `id`, `name` (the plugin package specifier; inserted relative paths are anchored beside their patch file), optional `config`, and optional `disabled`, `inject`, `intercept`, and `isolate`.
   19  
   20  - `group: true` with `name: cordis:group` makes `config` a nested entry list and allows patches to insert into it by id. `cordis:include` loads a literal YAML or JSON entry list from `config.path`.
   21  - `disabled` accepts a boolean, null, or a `!!js` expression evaluated against the Loader context at every mount decision. A disabled row omits required `config` unless `group: true` forces activation.
   22  - `!!js` scalars are Loader expressions, never `!js`. Inside `config` they are evaluated after the row's declared injections activate, against that plugin's context (`ctx.<service>`), so `!!js dshHomePath('sessions')` and `!!js "!ctx.get('profileContext')"` are valid. Other row metadata stays literal.
   23  - `isolate` maps service names to `true` or a realm label; a preset plugin that provides a service isolates the provider and all consumers together. Scope controls contributions and event visibility; `isolate` controls service instances.
   24  
   25  `plugin_manager` `list_plugins` reports each row's `enabled` flag and `fiberPhase`; `set_plugin` and `set_bundle` answer `overridden` when a higher-priority layer wins.
   26  
   27  ## Installable plugin packages
   28  
   29  `references/packages.md` lists every workspace package that exports a Cordis plugin, grouped by package group, with whether its row takes `config`. Search it with `grep -n <keyword>` rather than reading it whole. Plugins outside this list come from installed bundles; `plugin_manager` `list_bundles` names them.
```

### `dsh/lib/profile-boot.js` (full, 2 lines)

```js
    1  import { a as prepareProfile, i as initializeProfileFromDefault, n as PROFILE_ROOT_FILENAME, o as runProfile, r as homePatchPath, t as INSTALL_ANCHOR } from "./profile-boot-e2mS45fC.js";
    2  export { INSTALL_ANCHOR, PROFILE_ROOT_FILENAME, homePatchPath, initializeProfileFromDefault, prepareProfile, runProfile };
```

### `dsh/lib/types/args.d.ts` (full)

```ts
    1  /**
    2   * Commander adapter for the `dsh` command line.
    3   *
    4   * The launcher parses only what it owns — which profile to boot, which extra
    5   * patch overlays to apply, and the config dumps — and hands **everything after
    6   * its own flags** to the booted tree verbatim, where injected app plugins parse
    7   * their own flag families and print their own `--help` (see
    8   * `@deepseek-ai/dsh-cmdline`). Launcher flags therefore come first: the first
    9   * token this parser does not recognize starts the inner arguments, so
   10   * `dsh --profile tui --resume abc` boots the tui profile with `--resume abc`,
   11   * and `dsh --profile web -h` prints the web app's help, not this one's.
   12   *
   13   * `dsh <name>` abbreviates `dsh --profile <name>`; `plugin` manages a profile's
   14   * plugin dependencies by forwarding to pnpm.
   15   * @module @deepseek-ai/dsh/args
   16   */
   17  /** Boot a named profile and hand it the invocation's inner arguments. */
   18  interface ProfileInvocation {
   19      mode: 'profile';
   20      profile: string;
   21      /** Shipped template that replaces the named profile. */
   22      fromDefaultProfile?: string | undefined;
   23      /** Extra patch-list overlays applied after the profile's own layer, in argv order. */
   24      patches: string[];
   25      /** Everything after the launcher's own flags, verbatim, for injected app plugins. */
   26      args: string[];
   27  }
   28  /** Print a composed profile tree and exit without booting. */
   29  interface DumpConfigInvocation {
   30      mode: 'dump-config';
   31      profile: string;
   32      /** Shipped template that replaces the named profile. */
   33      fromDefaultProfile?: string | undefined;
   34      /** Omit the profile's user layer and --patch overlays; print bundle layers only. */
   35      defaultOnly: boolean;
   36      patches: string[];
   37  }
   38  /** Print declared plugin schemas without mounting the profile. */
   39  interface DumpConfigSchemaInvocation {
   40      mode: 'dump-config-schema';
   41      profile: string;
   42      /** Shipped template that replaces the named profile. */
   43      fromDefaultProfile?: string | undefined;
   44      patches: string[];
   45  }
   46  /** Manage a profile's plugins: forward `args` to pnpm inside the profile directory. */
   47  interface PluginInvocation {
   48      mode: 'plugin';
   49      profile: string;
   50      /** Raw pnpm arguments, verbatim. */
   51      args: string[];
   52  }
   53  /** The resolved `dsh` invocation. Help, version, and errors exit inside {@link parseDshArgs}. */
   54  export type DshInvocation = ProfileInvocation | DumpConfigInvocation | DumpConfigSchemaInvocation | PluginInvocation;
   55  /**
   56   * Resolve argv into one invocation, or print and exit for help, version, or an
   57   * error.
   58   * @param argv - arguments after the Node binary and script.
   59   * @param version - version string printed by `--version`.
   60   * @param manageDesktopProfile - permit Desktop's installed carrier to manage its reserved profile's plugins.
   61   * @returns the resolved invocation.
   62   */
   63  export declare function parseDshArgs(argv: readonly string[], version: string, manageDesktopProfile?: boolean): DshInvocation;
   64  export {};
   65  //# sourceMappingURL=args.d.ts.map
```

### `dsh/lib/types/profile-boot.d.ts` (full)

```ts
    1  /**
    2   * Shared profile boot for every `dsh` surface: resolve the profile, stack its
    3   * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
    4   * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
    5   * tree over the profile's empty root config, and wire fail-loud plus bounded shutdown.
    6   *
    7   * App flags are not the launcher's business: the invocation's inner arguments
    8   * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
    9   * plugin may read the same immutable snapshot.
   10   * @module @deepseek-ai/dsh/profile-boot
   11   */
   12  import { type Context } from '@deepseek-ai/cordis';
   13  import { type ProfileContext, type Profile } from '@deepseek-ai/dsh-app-boot';
   14  import { type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
   15  import { type ProcessShutdown } from './process-shutdown.ts';
   16  /**
   17   * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
   18   * over every profile's own layer. Resolved per call, not at module load:
   19   * `$DSH_HOME` may be set by the test or launcher after import.
   20   * @returns the absolute patch-file path.
   21   */
   22  export declare function homePatchPath(): string;
   23  /** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
   24  export declare const INSTALL_ANCHOR: string;
   25  /** Root config filename inside a profile directory. */
   26  export declare const PROFILE_ROOT_FILENAME = "cordis.yml";
   27  /**
   28   * Replace the named custom profile with a fresh copy of one shipped template.
   29   * This copies only the template's bundle list; local state from the
   30   * same-named shipped profile is not read, and no inheritance metadata is
   31   * persisted. The new profile is assembled in a `.<name>.staging-*` directory
   32   * under the profiles directory and moved into place; only then is any previous
   33   * target directory, including its dependencies and user patch, deleted. A
   34   * failed move restores the previous directory; when restoring also fails, it
   35   * stays in the staging directory. Shipped profile names, compared without
   36   * case, are reserved. Concurrent replacements leave one complete copy; each
   37   * one either succeeds or reports the concurrent recreation.
   38   * @param name - the profile name to create or replace.
   39   * @param fromDefaultProfile - shipped profile template to copy.
   40   * @param home - Harness home containing the profile directory.
   41   * @throws when the template is unknown, the target name is shipped, another process recreates the target
   42   *   between the two renames, or a file-system operation fails; a restore failure is an `AggregateError`
   43   *   that names the staging path holding the previous profile.
   44   */
   45  export declare function initializeProfileFromDefault(name: string, fromDefaultProfile: string, home?: string): void;
   46  /**
   47   * Load a resolved profile for `name` and (re)write the empty root config. The
   48   * root is always rewritten: the whole composition is patch layers, and the
   49   * vendored Loader's tree write-back (a plugin self-disposing persists the
   50   * current tree) can bake composed rows into this file — which would duplicate
   51   * every bundle insert on the next boot. The file exists on disk only because
   52   * the Loader needs a real include root to anchor `baseUrl` at the profile
   53   * directory (the config dump anchors on the same file, so both compose over
   54   * the identical base).
   55   * @param name - the profile name.
   56   * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
   57   * @param fromDefaultProfile - shipped template that replaces the profile before loading it.
   58   * @returns the loaded profile.
   59   * @throws when explicit initialization names an unknown template or a shipped target.
   60   */
   61  export declare function prepareProfile(name: string, userLayer?: boolean, fromDefaultProfile?: string): Profile;
   62  /** An application-owned profile and its independent installation fallback. */
   63  export interface ResolvedProfileRuntime {
   64      /** Profile already loaded from the application's own directory. */
   65      profile: Profile;
   66      /** Absolute package.json path of the application's dsh installation. */
   67      installAnchor: string;
   68  }
   69  /** Options for {@link runProfile}. */
   70  export interface RunProfileOptions {
   71      /** This run's frozen environment snapshot, provided before any entry mounts. */
   72      environment: LaunchEnvironmentSnapshot;
   73      /** The profile name to boot. */
   74      profile: string;
   75      /** Loaded application profile; bypasses named profile initialization when supplied. */
   76      resolvedProfile?: ResolvedProfileRuntime | undefined;
   77      /** Shipped template that replaces the named profile before boot. */
   78      fromDefaultProfile?: string | undefined;
   79      /** `--patch` overlay paths, in argv order. */
   80      patchFiles: readonly string[];
   81      /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
   82      args: readonly string[];
   83      /** Application-owned package runtime, scoped to plugin package operations. */
   84      packageManager?: ProfileContext['packageManager'];
   85  }
   86  /**
   87   * Boot one profile invocation end to end and leave process lifetime to the
   88   * mounted plugins (or to a one-shot runner the composition mounts).
   89   * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
   90   * @returns the settled root context and the shutdown controller.
   91   * @throws after disposing startup resources; cleanup failures retain the original error.
   92   */
   93  export declare function runProfile(options: RunProfileOptions): Promise<{
   94      ctx: Context;
   95      shutdown: ProcessShutdown;
   96  }>;
   97  //# sourceMappingURL=profile-boot.d.ts.map
```

### `dsh-plugin-manager/lib/types/install-spec.d.ts` (full)

```ts
    1  /**
    2   * Reading an install spec before pnpm sees it: which of pnpm's spec forms it
    3   * takes, and for a registry name whether it is one the registry can accept.
    4   * @module @deepseek-ai/dsh-plugin-manager/install-spec
    5   */
    6  /**
    7   * One spec read into its form and the parts an inspection needs. A git spec
    8   * and a tarball URL carry the `host` pnpm fetches them from, which no registry
    9   * stands in for; only their dependencies come from the registry.
   10   */
   11  export type ParsedInstallSpec = {
   12      readonly kind: 'registry';
   13      readonly spec: string;
   14      readonly name: string;
   15      readonly range?: string;
   16  } | {
   17      readonly kind: 'path';
   18      readonly spec: string;
   19      readonly path: string;
   20  } | {
   21      readonly kind: 'tarball';
   22      readonly spec: string;
   23      readonly path?: string;
   24      readonly host?: string;
   25  } | {
   26      readonly kind: 'git';
   27      readonly spec: string;
   28      readonly host: string;
   29  };
   30  /** A spec neither pnpm nor the registry would take; `reason` is what the person reads. */
   31  export declare class InvalidInstallSpecError extends Error {
   32      readonly spec: string;
   33      readonly reason: string;
   34      /**
   35       * @param spec - the spec as typed, trimmed.
   36       * @param reason - why it is refused, as one sentence.
   37       */
   38      constructor(spec: string, reason: string);
   39  }
   40  /**
   41   * Read a spec into its form. A path must be absolute: the Host's working
   42   * directory means nothing to the person typing into a browser, and a
   43   * relative path resolved against the profile would point inside it.
   44   * @param raw - the spec as typed.
   45   * @returns the parsed spec.
   46   * @throws {InvalidInstallSpecError} for an empty spec, a relative path, a name the
   47   * registry would refuse, or a URL that is neither a git host nor a tarball.
   48   */
   49  export declare function parseInstallSpec(raw: string): ParsedInstallSpec;
   50  /** The user information of an http(s) URL, up to the last `@` before the path, which holds a password or access token when present. */
   51  export declare const HTTP_USER_INFO: RegExp;
   52  /**
   53   * The spec `pnpm add` accepts for a dependency the profile manifest records. A git address, URL, or other
   54   * non-registry protocol is the recorded value without the user information of an http(s) URL, whose query string
   55   * is kept; a `file:` or `link:` path, which pnpm records relative to the profile or with `~` for the home
   56   * directory, becomes absolute. A registry range, tag, or alias follows the dependency name after `@`, as does a
   57   * non-registry value installed under a name other than the package's own.
   58   * @param name - the dependency name.
   59   * @param recorded - the value the profile manifest records for it.
   60   * @param profileDir - the profile directory a relative local path is resolved against.
   61   * @param packageName - the name the installed package's manifest declares, when it could be read.
   62   * @returns the installable spec.
   63   */
   64  export declare function dependencySpec(name: string, recorded: string, profileDir: string, packageName?: string): string;
   65  //# sourceMappingURL=install-spec.d.ts.map
```

### `dsh-package-manifest/lib/types/index.d.ts` (full)

```ts
    1  /**
    2   * Public package manifest and plugin display types, with no runtime exports.
    3   * @module @deepseek-ai/dsh-package-manifest
    4   */
    5  export type { DshBundleManifest, DshClientManifest, DshEnginesManifest, DshManifest, DshPackageManifest, DshProfileManifest, LocalizedText, PluginLocalizedMeta, } from './types.ts';
    6  //# sourceMappingURL=index.d.ts.map
```

---

## Appendix B — Recommended `package.json` skeleton for `dsh-plugin-feishu-gateway`

Combining §2, §3 and §5 (plain-JS ESM, no build step, Host-only gateway; add a
`dsh.client` block + `client.js` only if a Web UI half is needed):

```json
{
  "name": "@local/dsh-plugin-feishu-gateway",
  "version": "0.1.0",
  "private": true,
  "description": "Feishu/Lark channel gateway: receives events from the Lark open platform and injects them as DSH user messages.",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./package.json": "./package.json",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md"],
  "engines": {
    "node": ">=22.19.0",
    "dsh": ">=0.2.2-rc.1 <0.3.0-0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/dsh-llm": "0.2.2-rc.1",
    "@deepseek-ai/dsh-session": "0.2.2-rc.1"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "icon": "./icon.svg"
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: feishu-gateway
      name: '@local/dsh-plugin-feishu-gateway'
      config:
        appId: ''
        verificationToken: ''
        # do NOT put appSecret/encryptKey in config — use ctx.credentials records
```

`index.js` (shape only — the actual Lark client is the implementation work):

```js
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const Config = z.object({
  appId: z.string().default(''),
  verificationToken: z.string().default(''),
});
export const inject = ['agents', 'sessions', 'credentials'];

export function apply(ctx, config) {
  const controller = new AbortController();
  const client = connectToLark(config, controller.signal); // implementation detail
  client.on('message', (event) => {
    const agent = ctx.agents.get(event.sessionId);
    if (!agent) return;
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: event.text }],
      source: { kind: 'feishu' },
    }));
  });
  // explicit cleanup on unload
  return () => {
    controller.abort();
    client.close();
  };
}
```

Local test install (from the workspace):

```sh
dsh plugin --profile web add /home/ubuntu/dsh-workspace/projects/dsh-plugin-feishu-gateway
```

> The `Config`/`inject` combination above follows `references/host-plugin.md:61` and the
> `static Config` pattern in `dsh-schedule/lib/index.js:2091-2101`. Whether `agents` and
> `sessions` are the correct injection names for a *new* Session, and the exact
> Session-creation API, remain **unverified** (§6 item 3) — inspect with
> `cordis_inspect_query` / `Config.listConfigs` before implementing.
>
> For display metadata, also create `locale/en.json` (and `zh.json`) with
> `{ "meta": { "title": "...", "description": "..." } }` and an `icon.svg`, per
> `SK/references/host-plugin.md:29-55`.
