# 架构设计与官方 API 调研

> 本文是「先调研、再实现」交付物的设计部分。所有 DSH API 结论都来自本机已安装的
> `@deepseek-ai/dsh@0.2.2-rc.1` 及其 `node_modules/@deepseek-ai/*` 的 `.d.ts` / `lib/*.js`，
> 证据与行号见 [../research/dsh-api.md](../research/dsh-api.md)。**未确认的私有 API 一律不用。**

---

## 1. 调研结论摘要

### 1.1 这套 DSH 到底是什么

| 事实 | 证据 |
| --- | --- |
| 运行时版本 `0.2.2-rc.1`（`dsh-app-boot` 同版本），Node 要求 `>=24.9.0` | `dsh/package.json:180` |
| 插件框架是 `@deepseek-ai/cordis@4.1.0`，ESM-only | `cordis/package.json:9-19` |
| 配置校验用 `@deepseek-ai/schemastery@3.19.0`，实现 Standard Schema | `schemastery/lib/types/index.d.ts:145` |
| Profile 不是单文件配置，而是**分层补丁组合**：`cordis.yml`（永远是空 `[]`）→ 每个 bundle 的 `cordis.patch.yml` → profile 自己的 `cordis.patch.yml` → `~/.dsh/cordis.patch.yml` → `--patch` | `dsh/lib/types/profile-boot.d.ts:1-10`；`dsh-app-boot/lib/types/profile.d.ts:5-20` |
| 一个可安装插件的**决定性字段**是 `package.json.dsh.bundle.patch` | `dsh-package-manifest/lib/types/types.d.ts:57-67`；`dsh-sdk-app/package.json` |
| 兼容性由 `engines.dsh`（优先）或 `@deepseek-ai/dsh*` peer 范围决定，预发布版本参与比较 | `dsh-app-boot/lib/types/plugin-compatibility.d.ts:16-28`；`dsh-app-boot/lib/index.js:1094-1145` |

### 1.2 官方 Cordis 插件契约（4.1.0）

插件形状是 `Plugin.Function | Plugin.Constructor | Plugin.Object`（`cordis/lib/types/registry.d.ts`）。
本插件采用**命名导出的 Object 形式**（与 `dsh-sdk-app` 一致）：

```ts
export const name = 'feishu-gateway'
export const inject = ['agents', 'agentLoop', 'sessions', 'llm']
export const Config = Schema.object({ ... })
export function apply(ctx: Context, config: GatewayConfig): void { ... }
```

Loader 的 `unwrapExports()` 取 `moduleNamespace.default ?? moduleNamespace`，因此有/无 default 都可以工作
（`cordis-plugin-loader/lib/index.js:811-817`）。本包同时导出一个等价的 default 对象，便于 `ctx.plugin()` 直接调用。

**生命周期（重要）**：Cordis 4.1.0 **没有** `ctx.on('ready')` / `ctx.on('dispose')` / `ctx.scope` / `Context.service`
（`../research/dsh-api.md` §1.2 明确列为 NOT FOUND）。正确写法：

- `ctx.effect(() => { start(); return async () => { await stop() } }, 'label')`：disposer 在 fiber 卸载时按逆序、可 await 地执行；
- `ctx.on(name, listener)` 返回的 listener 本身是 **fiber-owned**，卸载自动移除；
- `ctx.provide(name, value)` 注册的服务同样随 fiber 卸载；
- `apply()` **不能返回普通对象**（`Fiber._execute` 会抛 `TypeError('Invalid effect')`）。

本插件的 `apply()` 只做三件事：`ctx.provide('feishuGateway', 诊断服务)`、`ctx.effect(...)` 启动/停止、
可选打印脱敏配置。所有连接、监听器、AbortController、AgentHandle 都在 `FeishuGateway.stop()` 里集中释放。

### 1.3 原生 Session：为什么选「path A」

调研给出两条进程内路径：

| | Path A `ctx.agents` | Path B `ctx.sessionController` |
| --- | --- | --- |
| 装载位置 | `dsh-base`（web / sdk / sdk-minimal 都有） | **仅 `dsh-web-app`** |
| CREATE | `agents.create({ sessionId, meta:{cwd}, agentOptions })` | `sessionController.create({ cwd, sessionId? })` |
| SEND | `handle.agent.followup(createUserMessage({...}))` | `sessionController.prompt({ requestId, sessionId, mode:'queue', content:[...] }, signal)` |
| SUBSCRIBE | `ctx.on('session/event')`、`ctx.on('agent/assistant-stream')` | `follow({ address, assistantStream:true }, signal)` |
| RESUME | `agents.resume({ resumeSessionId })` | `resolveAgent` / `prompt` 内部隐式恢复 |
| CLOSE | `await handle.dispose()`（同时移除 Session） | **没有公开 close/dispose**，`cancel()` 只取消当前 turn |

**决策：采用 Path A。** 理由：

1. 它是 DSH 自己的 SDK server 使用的路径（`dsh-sdk-jsonrpc-server/lib/index.js:765-790`），跨 profile 可用；
2. 有明确的 `AgentHandle.dispose()` 所有权语义，满足「卸载时清理所有监听器和连接」；
3. 不依赖 Web-only 服务，也不依赖 `SessionController` 缺失的 close；
4. 完全**不创建第二套 Agent / LLM Session**：会话日志、模型路由、循环调度都属于 DSH。

`ctx.sessionController` 及其 `wait()` / `follow()` 保留为 v0.2.0 的可选增强（Web 管理面板 / 长任务状态）。

### 1.4 其他官方接口的定位（v0.2.0 预留，v0.1.0 不引入）

| 接口 | 官方入口 | 本版状态 |
| --- | --- | --- |
| Agent 模型/工作区绑定 | `AgentOptions { provider, model, reasoningEffort, maxTokens }` + `CreateAgentOptions.meta.cwd` | 已支持可选覆盖，默认继承 profile |
| 审批 | `ctx.approval` / `ctx.on('approval/request', (req, next) => ...)`，四种 `ApprovalOutcome` | 未桥接；危险操作仍走 DSH 原生审批 |
| 定时主动通知 | `ctx.schedule.create({ title, prompt, timing, target })`，`target: { kind:'session', sessionId }` | 未实现 |
| Session 持久化 | `ctx.sessionPersistence` / `session/flush`，由 profile 的 `dsh-session-persistence-jsonl` 提供 | 由 DSH 自己负责；插件只持久化「聊天 → Session id」映射 |
| 凭证 | `ctx.credentials.resolve(credentialRef(name))` / `modifyRecord` | 本版只用环境变量名（`apiKeyEnv` 同款模式），因为只需要固定变量 |

---

## 2. 系统架构

### 2.1 分层与端口

```
┌──────────────────────── Feishu / Lark 开放平台 ────────────────────────┐
│  WSClient (long connection)          REST: im.message.reply / create   │
└───────────────▲──────────────────────────────────▲──────────────────────┘
                │ im.message.receive_v1            │ text reply
┌───────────────┴──────────────────────────────────┴──────────────────────┐
│  FeishuTransport (端口)                                                   │
│    LarkTransport  = @larksuiteoapi/node-sdk 1.76.0 真实实现               │
│    MockFeishuTransport = 内存实现（测试 / offline）                        │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ InboundMessage
┌───────────────┴──────────────────────────────────────────────────────────┐
│  MessageRouter（纯函数安全边界）                                           │
│    allowlist / group-off / sender_type / message_type / code-point 截断    │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ accepted
┌───────────────┴──────────────────────────────────────────────────────────┐
│  DurableInbox (JSONL 原子准入) → DedupIndex (非权威可选缓存)               │
│  仅安全回放 pending；running → uncertain，不重复执行 Agent 副作用          │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ 每个 chat 串行队列
┌───────────────┴──────────────────────────────────────────────────────────┐
│  SessionRegistry（仅 chat→sessionId 映射）                                 │
│  SessionBridge (端口)                                                      │
│    DshSessionBridge = ctx.agents.create/resume + followup                  │
│                      + session/event + agent/assistant-stream + dispose    │
│    MockSessionBridge = 测试替身                                            │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ SessionReply
┌───────────────┴──────────────────────────────────────────────────────────┐
│  DurableOutbox（先持久化再发送；有界指数退避；reconnect 时 drain）         │
└───────────────▲──────────────────────────────────────────────────────────┘
                │
        FeishuTransport.sendText
```

**端口化**是关键设计：`FeishuTransport`、`SessionBridge`、`GatewayLogger`、`CordisLike`
都是本项目自定义的窄接口，生产适配器与 Mock 实现可互换。因此：

- `pnpm test` 不需要凭据、不需要网络、不需要启动 DSH；
- DSH 服务的接入通过 `ctx.get('agents')` 的**结构化契约**完成，不 import DSH 内部包、
  不在编译期依赖 `@deepseek-ai/dsh-session` / `dsh-agent` 的类型，避免版本耦合；
- 唯一运行时动态 import 是官方 `@deepseek-ai/dsh-llm` 的 `createUserMessage`（失败时回落到
  同形状的本地构造），以及 `@larksuiteoapi/node-sdk`。

### 2.2 一条消息的完整时序

1. `WSClient` 推 `im.message.receive_v1` → `LarkTransport` 归一化成 `InboundMessage`
   （取 `open_id`、`chat_id`、`chat_type`、`message_type`，`content` 是 JSON 字符串里的 `text`）。
2. `MessageRouter.decide()` 安全判定；拒绝则只计数、debug 日志、**不回复**（避免探测泄露）。
3. `DurableInbox.recordIfAbsent()`：以单一持久化入口原子处理重复的 `message_id`，先落盘后确认接收；落盘失败不 ACK。
4. `DedupIndex.checkAndRemember()`：Inbox 成功后才更新的可选缓存，失败不阻断已经可靠入队的工作。
5. 按 `botId:chatId` 进入串行队列，避免同一会话两个 turn 交错。
6. `SessionRegistry` 查映射：
   - 无 → 以聊天键与随机后缀生成新的 Session id → `bridge.create()` → `bind()`；
   - 有 → `bridge.resume(existing.sessionId)`；恢复失败则换新 id 重新 create（防陈旧 id 卡死）。
7. `bridge.submit()` → `agent.followup(createUserMessage(...))`，DSH 自己的 loop 驱动模型。
8. `bridge.waitForReply()` 同时收集：
   - **durable**：`session/event` 的 `assistant/message` / `assistant/attempt`（`event.data.message.content` 文本块）；
   - **live**：`agent/assistant-stream` 的 `text-delta` chunk；
   - 结束条件：`turn/end`；超时 / abort 由 `withTimeout` 兜底。
9. 在 Agent 提交前将 Inbox 持久标记为 `running`。超时则取消并解绑原 Session；崩溃恢复时 `running` 变 `uncertain` 并通知用户检查操作结果。
10. 回复经 `truncateText` 后送入串行 Outbox，按入站消息设置幂等键，持久记录发送 UUID；失败重试或重连补发。成功后 `markProcessed()`；运行失败终结为 `failed`，不自动重放。

### 2.3 持久化模型（v0.1.0 的「基础」部分）

| 文件 | 格式 | 作用 |
| --- | --- | --- |
| `dedup.json` | 原子 JSON（`message_id → 首次时间`） | 非权威加速索引；TTL + 容量上限裁剪 |
| `inbox.jsonl` | 追加日志（`received`/`running`/`processed`/`failed`/`uncertain`） | 防止崩溃重放 Agent 副作用，保守恢复 |
| `outbox.json` | 原子 JSON（pending + sent ledger） | 单进程串行补发、固定 UUID、消息幂等键 |
| `sessions.json` | 原子 JSON（chat → sessionId） | 重启后 `ctx.agents.resume` |

所有写操作都是「同目录临时文件 + `rename`」，单进程内用 Promise chain 串行化，避免并发丢写。
**没有引入 SQLite / 原生依赖**，也没有引入第二套会话存储 —— 会话内容完全由 DSH 的
`dsh-session-persistence-jsonl` 管理。损坏的状态文件会被隔离成 `.corrupt-*` 并干净启动。

### 2.4 生命周期与清理清单

`apply()` → `ctx.effect` → `gateway.start()`；disposer → `gateway.stop()`：

- [x] `AbortController.abort()` 取消所有在途 `waitForReply` / 重试 sleep；
- [x] 每个 `FeishuTransport.close()` → `WSClient.close({force:true})`；
- [x] `await Promise.allSettled(inFlight)` 等待消息处理器收敛；
- [x] `bridge.dispose()` → 两个 `ctx.on` disposer + 每个 `AgentHandle.dispose()`；
- [x] `ctx.provide('feishuGateway', ...)` 由 Cordis fiber 自动注销；
- [x] 清空每聊天队列与状态。

`health()` / `diagnostics()` 暴露只读状态：`transports`、`sessionBridge.available`、
`inbox/outbox/dedup` 计数、`processed/rejected/errors`、`uptimeMs`。

---

## 3. 关键设计取舍

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 插件形状 | 命名导出 Object + 等价 default | 与 `dsh-sdk-app` 一致，Loader 两种都支持 |
| 发布形态 | **Bundle**（`dsh.bundle.patch`） | 官方唯一支持 `dsh plugin add` 安装到 profile 的形态 |
| Session 接入 | `ctx.agents` path A | 跨 profile、有明确 dispose、非 Web-only |
| 服务声明 | `inject: ['agents','agentLoop','sessions','llm']` | 缺失时插件**不激活**而不是抛错 |
| `SessionId` / `UserMessage` | 运行时字符串 + 动态 import 官方构造函数 | 避免编译期依赖 DSH 内部 branded 类型 |
| 去重 vs 恢复 | 以 Inbox 为准；running/failed 不自动重放 | 避免重复执行不可逆 Agent 操作 |
| 群聊 | 硬编码拒绝 | 需要 mention 解析、群隔离、审批策略，属于 v0.2.0 |
| 存储 | 原子 JSON / JSONL | 零原生依赖、易审计；v0.2.0 可换 SQLite |
| 真实凭据 | 完全不接触 | 用户明确要求；测试全 Mock |
| `allow-version` | 绝不使用 | 兼容性靠如实声明 `engines.dsh` |

---

## 4. 明确未使用 / 未验证的东西

- 未使用 `ctx.on('ready')`、`ctx.on('dispose')`、`ctx.scope`、`Context.service`（4.1.0 中不存在）。
- 未使用 `SessionController.close()`（不存在）、未自建 `Session.append()` 事件类型。
- 未使用任何 `allow-version` / `compatibility.json` 豁免。
- 未修改 `~/.dsh/profiles/web/` 或 DSH Core 的任何文件。
- 未做真实飞书端到端验证；`LarkTransport` 的 API 形状来自
  `@larksuiteoapi/node-sdk@1.76.0` 自带的 `types/index.d.ts`（`WSClient.start`、
  `EventDispatcher.register`、`im.message.reply/create`、`Domain`），但**没有用真实凭据连过**。
  `im.message.reply` 在本机安装包的 `types/index.d.ts` 中已确认（GitHub README 的两段示例
  只用了 `create`，调研报告据此把 `reply` 标为「未从 README 验证」，此处以本机类型声明为准）。
- 未做真实 DSH 运行时验证：`session/event` 是 **scope-filtered** 事件，理论上注册在插件根 ctx
  的监听器应收到全部 Session 的事件，但这一行为只在带 FakeCtx 的集成测试中验证过，
  **未在真实 DSH 进程中确认**。因此 `DshSessionBridge` 增加了 `agent.whenIdle()` 作为二次
  完成信号（仅在已观察到 assistant 内容后才生效），并且即使收不到 `turn/end`，
  `waitForReply` 也会在超时时把已收集到的文本返回。v0.2.0 应在真实租户中复核事件投递，
  必要时改用 `ctx.sessionController.follow({ assistantStream: true }, signal)`。
- 社区参考项目调研报告已标注可达性与「已验证 / 推断」；本项目代码从零编写，未 Fork。
