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
   - 有 → `bridge.resume(existing.sessionId)`：如果当前 Bridge 已持有活动 AgentHandle，**直接复用**；只有新进程 / 新 Bridge 缺失 Handle 才从持久化 `agents.resume()`。恢复失败**保留原 Session 绑定**并回复诊断，不创建空白会话。
7. `bridge.submit()` → `agent.followup(createUserMessage(...))`，DSH 自己的 loop 驱动模型。
8. `bridge.waitForReply()` 同时收集：
   - **durable**：`session/event` 的 `assistant/message` / `assistant/attempt`（`event.data.message.content` 文本块）；
   - **live**：`agent/assistant-stream` 的 `text-delta` chunk；
   - 结束条件：`turn/end`；超时 / abort 由 `withTimeout` 兜底。
9. 在 Agent 提交前将 Inbox 持久标记为 `running`。超时/异常/取消则取消并解绑原 Session；崩溃恢复时 `running` 变 `uncertain`、**同样解除该聊天的 Session 绑定**（下一条消息创建全新 Session），并通知用户检查操作结果。`uncertain` / `failed` 不自动重放，目前也没有程序化的重试 / 解决入口（见 ROADMAP v0.2.0 的死信队列 + 手动重放 TODO）。
10. 回复经 `truncateText` 后送入串行 Outbox，按入站消息设置幂等键，持久记录发送 UUID；失败重试或重连补发。成功后 `markProcessed()`；运行失败终结为 `failed`，不自动重放。

### 2.3 持久化模型（v0.1.0 的「基础」部分）

| 文件 | 格式 | 作用 |
| --- | --- | --- |
| `dedup.json` | 原子 JSON（`message_id → 首次时间`） | 非权威加速索引；TTL + 容量上限裁剪 |
| `inbox.jsonl` | 追加日志（`received`/`running`/`processed`/`failed`/`uncertain`） | 防止崩溃重放 Agent 副作用，保守恢复 |
| `outbox.json` | 原子 JSON（pending + sent ledger） | 单进程串行补发、固定 UUID、消息幂等键 |
| `sessions.json` | 原子 JSON（chat → sessionId） | 重启后 `ctx.agents.resume` |

三个 `JsonStore` 状态文件使用「同目录**按实例唯一**的临时文件 + `rename`」原子写入；
`inbox.jsonl` 是 **append-only 日志**（`appendFile`，带 `0o600`），不是 `rename` 路径，
且**没有 `fsync`**——「持久化」指交给内核页缓存，可抵御进程崩溃，不能保证机器掉电不丢。
各存储内部用各自的 Promise chain 串行化；**但 Inbox / Registry / Outbox 之间没有跨库事务**：
`outbox.send()`（外部 REST 副作用）发生在 `registry.touch()` 与 `markProcessed()` 之前。
**没有引入 SQLite / 原生依赖**，也没有引入第二套会话存储 —— 会话内容完全由 DSH 的
`dsh-session-persistence-jsonl` 管理。

损坏文件处理**仅覆盖三个 `JsonStore` 文件**：它们会被隔离成 `.corrupt-*` 并干净启动。
`inbox.jsonl` 只修复**尾部断行**：损坏的不完整末行会被 `truncate` 掉；合法但缺结尾换行
的末行会补齐 `\n`（否则下一次追加会把两个 JSON 对象粘成一行）。**一条已完成的非法
JSONL 行仍会让 `open()` 抛错并使插件启动失败**，目前没有隔离 / 跳过 / 命令行修复入口。

### 2.3.1 `stateDir` 单实例独占（fail closed）

Inbox 的准入权威是**实例内的内存 Map**。两个 Gateway 实例（或两个进程）共用同一
`stateDir` 时，会各自把同一个 `message_id` 判定为新消息并**执行两次 Agent**（不可逆副作用）。
该场景已由 `scripts/fault-injection.mjs` 的 S6 复现并修复：启动时以 `O_EXCL` 创建
`stateDir/.owner.lock`（内容含 owner 令牌、pid、host、`/proc` starttime），第二个实例
`start()` 直接失败。锁由持有者在 `stop()` / 启动失败时按令牌释放；陈旧锁通过 PID 存活
与 starttime 比对（可识别 PID 复用与僵尸进程）被接管，因此 SIGKILL 后的重启不会被永久锁死。

> 这是**单机 advisory 锁，不是分布式互斥锁**。`stateDir` 必须位于同一主机且只被一个
> Gateway 实例使用；跨主机 / 网络文件系统共享目录不在支持范围内。长期方案是把准入权威
> 换成真正的磁盘唯一性检查（或 SQLite）。`JsonStore` 临时文件名也已由
> `<file>.<pid>.tmp` 改为 `<file>.<pid>.<随机实例令牌>.tmp`，避免同进程内两个实例互踩。

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
- **真实 DSH 运行时已验证（本次补充，隔离 `DSH_HOME` + Mock LLM）**：`session/event` 与
  `agent/assistant-stream` **确实**投递到插件级 ctx，包括插件自建 Session 的事件
  （实测 `assistant/message` / `turn/end` / `agent/assistant-stream` 均到达）。
  `makeUserMessage` 的动态 import 回退对象也被 `agent.followup()` 接受（入站消息被
  splice 进 agent inbox）。此前「scope-filtered 事件可能收不到」的担忧在 0.2.2-rc.1
  headless 运行时**不成立**。
- **实测发现两个历史缺陷（第二项需通过新的多轮回归重新验证）**：(1) 默认配置下 `ctx.agents.create()` 未带 `agentOptions`，
  Agent 无 provider/model，每个 turn 以 `agent ... has no provider/model` 结束，用户只
  收到空回复兜底且消息被标记 `done`；已修复为从 `ctx.agentDefaultModel.currentSelection()`
  补默认 provider/model。(2) **同一 Session 的后续消息（上下文复用）历史上失败**：之前每条消息
  `dispose()` 原有 Handle 并重新 `agents.resume()`。而 `dispose()` 会把原
  Session 从活动 SessionStore 移除；当一次性 headless 运行时已卸载 Agent Loop 时，
  `resume()` 又会因缺少 Factory 报
  `no agent factory registered (load an agent-loop plugin)`。
  现在同进程活动 Handle 直接复用，冷恢复只在新的 Bridge 启动时发生；
  若 Agent Registry / SessionStore 已经卸载则明确失败，**不会悄悄新建无上下文 Session**。
  该行为有 Mock 回归测试，但跨多轮真实模型上下文、冷恢复与
  超时 / 异常 / 取消后的隔离仍须在长期存活的真实 DSH Host 中验收。
  若 Host 生命周期本身只维持单次任务，需要提供常驻 Host 后再测试。
- 社区参考项目调研报告已标注可达性与「已验证 / 推断」；本项目代码从零编写，未 Fork。

---

## 5. Round 2 真实运行时复验（补充，2026-11-14）

上述「跨多轮真实模型上下文、冷恢复与超时 / 异常 / 取消后的隔离仍须验收」已在
**持续运行的真实 DSH 0.2.2-rc.1 Host** 中完成，复现步骤见
`scripts/real-runtime/README.md`，完整报告见 `research/ROUND2-TEST-REPORT.md`：

- 同一进程连续三轮共用同一 Session；上下文由 DSH 真实会话历史承载（无状态测试 LLM
  只依据请求中的历史生成回复）；活动 `AgentHandle` 仅在 `stop()` dispose 一次；
  AgentRegistry / SessionStore / AgentFactory 始终为真。
- 独立新 `DSH_HOME` + 新进程从 DSH 持久化冷恢复同一 Session ID，LLM 请求含前三轮
  3 条 User + 3 条 Assistant 消息并回答 `GBM-7429`。
- 超时 / 取消 / 异常后均创建新 Session，旧文本与旧事件无跨 Session 归因。
- 上一轮的 `no agent factory registered` / `cannot append outside a SessionStore`
  经 DSH 源码分析确认为 `dsh-headless` 一次性任务 `io.exit()` 触发根 fiber 并发卸载的
  产物（`research/dsh-internals.md`），不是 Gateway 缺陷。
- **本轮修复**：`turn/end` 的 `data.reason.kind === 'error'`（Agent 失败且无
  `assistant/message`）此前被当成成功 → 空回复 + `done` + 不隔离；现在仅该 kind
  抛出，复用既有 `markFailed` + `unbind` 路径，`aborted`/`interrupted` 不受影响。
- 仍**未**在真实飞书租户 / 真实 Web profile 中验证；`dsh-web.service` 未受影响。
