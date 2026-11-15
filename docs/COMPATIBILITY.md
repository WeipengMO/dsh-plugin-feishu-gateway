# 版本兼容性分析

> 目标：说明本插件与当前 DSH 运行时、Node、Cordis、飞书 SDK 的兼容边界，以及
> **如何在不使用 `allow-version` 的前提下通过官方兼容性检查**。

---

## 1. 实测环境（本机）

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| DSH CLI / `dsh-app-boot` | `0.2.2-rc.1` | `/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json` |
| `@deepseek-ai/cordis` | `4.1.0` | `cordis/package.json` |
| `@deepseek-ai/schemastery` | `3.19.0` | `schemastery/package.json` |
| `@deepseek-ai/dsh-session` / `dsh-agent` / `dsh-api-session-controller` / `dsh-package-manifest` | `0.2.2-rc.1` | 各包 `package.json` |
| Node.js | `v24.22.2` | `node -v` |
| pnpm | `12.18.0` | `pnpm -v` |
| npm | `11.13.0` | `npm -v` |
| `@larksuiteoapi/node-sdk` | `1.76.0`（发布最新版，已安装） | `npm view` / `pnpm-lock.yaml` |
| TypeScript | `5.9.3`（固定） | `devDependencies` |
| Vitest | `3.2.7`（固定） | `devDependencies` |

DSH CLI 自身声明 `"engines": { "node": ">=24.9.0" }`，本插件因此也声明 `>=24.9.0`
（不是 Cordis 文档里更宽松的 `>=22.19.0` —— 运行 DSH 的约束更严格）。

---

## 2. DSH 官方兼容性检查到底怎么工作

入口：`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()`
（`lib/index.js:1094-1145`，类型见 `lib/types/plugin-compatibility.d.ts`）。

```
runtimeVersion = getDshRuntimeVersion()      // 读 dsh-app-boot/package.json 的 version = 0.2.2-rc.1

if (manifest.engines.dsh 存在):
    semver.satisfies(runtimeVersion, engines.dsh, { includePrerelease: true })
    → 不满足 => requirements = { "engines.dsh": range }，拒绝安装/启动
    → peerDependencies 被完全忽略
else:
    遍历 peerDependencies 中名字为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的项，
    逐项与 runtimeVersion 比较（workspace:^ / ~ / * 视为当前运行时）
```

关键点：

1. **预发布版本参与范围比较**（`includePrerelease: true`）。`^0.2.2` **不匹配**
   `0.2.2-rc.1`（实测 `semver.satisfies('0.2.2-rc.1','^0.2.2',{includePrerelease:true}) === false`），
   这是一个容易踩的坑。
2. **安装前检查 + 启动时检查**各做一次；本地路径安装会直接读该目录的 `package.json`。
3. 拒绝码 `incompatible-version`，CLI 退出码 1。
4. 唯一「合法绕过」是 `dsh plugin --profile <p> allow-version <pkg@version> --dsh-version <exact> --accept-risk`，
   它写入 profile 的 `compatibility.json`，且要求精确版本对 + 显式风险确认。**插件代码无法自授豁免。**

### 本项目的声明

```json
"engines": {
  "node": ">=24.9.0",
  "dsh": ">=0.2.2-rc.1 <0.3.0-0"
}
```

选 `<0.3.0-0` 而不是 `<0.3.0` 的原因：开启 `includePrerelease` 后，
`>=0.2.2-rc.1 <0.3.0` 会意外把 `0.3.0-rc.1` 判为满足，而 `<0.3.0-0` 不会。
实测：

| 版本 | `>=0.2.2-rc.1 <0.3.0-0` | `>=0.2.2-rc.1 <0.3.0` |
| --- | --- | --- |
| `0.2.2-rc.1`（本机） | ✅ | ✅ |
| `0.2.3` | ✅ | ✅ |
| `0.3.0-rc.1` | ❌ | ✅（不希望） |
| `0.3.0` | ❌ | ❌ |

因为 `engines.dsh` 存在，我们的 `peerDependencies` 只有 `@deepseek-ai/cordis: ~4.1.0`，
**不声明任何 `@deepseek-ai/dsh*` peer**，从而彻底避免与运行时版本检查的交叉影响。

> ⚠️ 如实说明：本机只验证了 `0.2.2-rc.1`。范围 `>=0.2.2-rc.1 <0.3.0-0` 表示「按 0.2.x
> 的公开 API 编写、预期兼容 0.2.x」，**不代表已对每个 0.2.x 补丁版本做过实测**。
> 升级 DSH 后应重跑 `pnpm run verify` 并按新的 `dsh --version` 复核本文件。
>
> 另据 [../research/references.md](../research/references.md)，GitHub `deepseek-harness` 的
> `master` 分支 README 已出现 `0.2.2-rc.3`（developer preview，文档明确警告会有破坏性变更）。
> **本项目的兼容性基准是本机安装的 `0.2.2-rc.1`，不是 GitHub master**；所有 API 证据都来自
> 本机 `node_modules` 的 `.d.ts`。部署到其它 DSH 版本前必须重新核对 `dsh --version` 与对应
> `.d.ts`，不要假设 master 与本机一致。

**本项目没有、也不会使用 `dsh plugin allow-version`、没有创建 `compatibility.json`，
没有设置任何版本豁免。** 若将来官方运行时升级到 `>=0.3.0` 而插件尚未适配，正确做法是
发布新的插件版本并更新 `engines.dsh`，而不是申请豁免。

---

## 3. Cordis / 插件框架兼容

| 约束 | 本插件做法 |
| --- | --- |
| Cordis `4.1.0` 插件形状 | 命名导出 `name` / `inject` / `Config` / `apply`，另有等价 default 对象 |
| `Config` 必须是 Standard Schema | `schemastery@3.19.0` 的 `Schema.object(...)` 自带 `~standard` |
| 生命周期 | 只用 `ctx.effect` / `ctx.on` / `ctx.provide` / `ctx.get`；**不用** 4.1.0 中不存在的 `ready`/`dispose` 事件、`ctx.scope`、`Context.service` |
| `apply()` 返回值 | 返回 `void`（返回普通对象会被 `Fiber._execute` 判为非法 effect） |
| 服务注入 | `inject: ['agents','agentLoop','sessions','llm']`；缺失时插件不激活而非崩溃 |
| ESM | `"type": "module"`，`module/moduleResolution: NodeNext`，相对导入带 `.js` 后缀 |

`@deepseek-ai/cordis` 声明为 `peerDependencies: { "~4.1.0" }`，
`@deepseek-ai/schemastery` 声明为 `dependencies`（与官方 `dsh-schedule` 等包一致）。

---

## 4. 飞书 SDK 兼容

`@larksuiteoapi/node-sdk@1.76.0`（MIT）固定为**精确版本** `1.76.0`，不写 `^`。
使用到的公共 API（全部来自该包自带的 `types/index.d.ts`）：

| API | 用途 |
| --- | --- |
| `new WSClient({ appId, appSecret, domain, autoReconnect, onReady/onError/onReconnecting/onReconnected })` | 长连接客户端 |
| `ws.start({ eventDispatcher })` / `ws.close({ force })` | 连接生命周期 |
| `new EventDispatcher({}).register({ 'im.message.receive_v1': handler })` | 事件订阅 |
| `new Client({ appId, appSecret, domain })` | REST 客户端 |
| `client.im.message.reply({ data: { content, msg_type, uuid }, path: { message_id } })` | 回复私聊 |
| `client.im.message.create({ data: { receive_id, msg_type, content, uuid }, params: { receive_id_type: 'chat_id' } })` | 主动发送 |
| `Domain.Feishu` / `Domain.Lark` | 域名枚举 |

SDK 通过**动态 import** 加载，因此 offline / 测试 profile 无需真正初始化 SDK。
`domain: 'feishu' | 'lark'` 对应 `Domain.Feishu` / `Domain.Lark`。

SDK 依赖 `protobufjs`（有 postinstall）与 `ws`；pnpm 12 的构建脚本白名单在
`pnpm-workspace.yaml` 的 `allowBuilds` 中显式列出 `esbuild`、`protobufjs`，
使 `pnpm install --frozen-lockfile` 在 CI 中可重复且不报 `ERR_PNPM_IGNORED_BUILDS`。

---

## 5. TypeScript / 构建兼容

- `target: ES2023`、`module: NodeNext`、`moduleResolution: NodeNext`、`strict: true`。
- 源码中相对 import 一律带 `.js` 后缀 → 编译产物可被 Node ESM 直接加载；
  Vitest/Vite 会把 `.js` 回退解析到 `.ts`（已由 `tests/smoke.test.ts` 验证）。
- 构建用纯 `tsc`：`lib/**/*.js` + `lib/types/**/*.d.ts`，无打包器、无运行时生成器。
- `declarationDir: lib/types` 与官方 `lib/index.js` + `lib/types/index.d.ts` 布局一致。
- `Config` / default 导出使用不透明类型标注，避免 TS2742 把 pnpm 内部的
  `.pnpm/@deepseek-ai+cosmokit@...` 路径泄漏进公开 `.d.ts`。

---

## 6. 已知不兼容 / 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| DSH 升级到 `0.3.x` | 官方 `engines.dsh` 检查会拒绝安装 | 发布适配版本并更新范围；**不申请豁免** |
| `ctx.agents` / `agent/assistant-stream` 在 0.3.x 变更 | 原生 Session 桥接失效 | `DshSessionBridge.available` 会变 false，插件降级为诊断回复而非崩溃；升级时按新 `.d.ts` 复核 |
| 飞书 SDK 大版本升级改动 `WSClient` | 连接失败 | SDK 精确锁版本；升级前跑集成测试并核对 `types/index.d.ts` |
| 未加载 `dsh-agent-loop`（`agentLoop` 服务缺失） | 插件不激活 | 测试 Profile 包含 `dsh-base`；`health()` 报告 `degraded` |
| 无真实凭据 | 未做真实 E2E | 文档明确声明；`offline: true` 用 Mock 验证全链路 |
| Node < 24.9.0 | DSH 本身不支持 | `engines.node` 声明 + CI 固定 Node 24 |

---

## 7. 复核命令

```bash
dsh --version                       # 应输出 0.2.2-rc.1
node -p "require('./package.json').engines"
pnpm run verify                     # typecheck + build + tests（数量以 CI 为准）
pnpm pack --pack-destination dist   # 检查发布内容
# 如需确认兼容性判定（只读）：
node -e "const s=require('semver'); console.log(s.satisfies('0.2.2-rc.1','>=0.2.2-rc.1 <0.3.0-0',{includePrerelease:true}))"
```
