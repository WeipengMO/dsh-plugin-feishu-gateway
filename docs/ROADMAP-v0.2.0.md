# v0.2.0 开发建议

> v0.1.0 已交付：WS 连接、私聊收发、白名单、DSH 原生 Session、持久化与去重基础、
> 86 个 Mock 单元/集成测试、CI、健康诊断。本文按「目标功能」逐项给出 v0.2.0 的落地建议、优先级、
> 官方 API 依据与风险。所有建议继续遵守：**不 Fork、不改 Core、不用私有 API、不建第二套 Agent/LLM、
> 安全默认、卸载全清理、不用 `allow-version`**。

---

## 优先级总览

| 优先级 | 功能 | 依赖 | 复杂度 |
| --- | --- | --- | --- |
| P0 | 卡片与流式回复 | `agent/assistant-stream` 已有事件 | 中 |
| P0 | 原生工具审批桥接 | `ctx.approval` / `approval/request` | 中 |
| P0 | 长任务状态与取消 | `agent.cancel({kind:'user'})`、已预留 `SessionBridge.cancel` | 中 |
| P1 | 多机器人独立工作区与模型 | `CreateAgentOptions.meta.cwd` + `AgentOptions` | 中 |
| P1 | 消息队列 / 重试 / 断线恢复增强 | 现有 Inbox/Outbox | 中 |
| P1 | 图片、文件双向传输 | `im/v1/image`、`im/v1/file`、DSH attachment | 高 |
| P1 | 定时任务主动通知 | `ctx.schedule.create` | 中 |
| P2 | Web 管理面板 | `dsh.client.platform: 'web'` 客户端模块 | 高 |
| P2 | 日志 / 健康检查 / 诊断增强 | 现有 `health()` / `diagnostics()` | 低 |
| P2 | 群聊（严格策略） | mention 解析 + 群隔离 + 审批 | 高 |

---

## P0-1 飞书卡片与流式回复

**现状**：v0.1.0 收集完整回复后一次性 `im.message.reply` 文本。

**建议**：

1. 复用已有的 `agent/assistant-stream` 监听（`DshSessionBridge` 已经收集 `text-delta`），
   但改成**边收边发**：用飞书卡片 `cardkit` 的流式更新能力或 `im.message.patch` 局部更新
   （社区项目用了 `patch`；**不要**依赖 `createLarkChannel`，它会把插件锁死在较新的 SDK 版本）。
2. 引入节流（例如每 200–400 ms 或每 N 个 token 合并一次），避免触发 5 QPS 单聊限频。
3. `turn/end` 时把最终文本落为一条持久 `assistant/message`，卡片只作为过程展示。
4. 卡片按钮回调 `card.action.trigger` 在长连接下按**事件**注册（不是 HTTP callback），
   用于「取消」「重试」「查看详情」。
5. 保持 `DurableOutbox` 作为最终一致性兜底：流式失败时仍能补发完整文本。

**验收**：长回答可见增量；取消后卡片停在已生成部分；断线重连后不重复发整段。

---

## P0-2 原生 DSH 工具审批桥接

**官方依据**（[../research/dsh-api.md](../research/dsh-api.md) §5）：
`ctx.approval`（`@deepseek-ai/dsh-user-approval`，`super(ctx, "approval")`），
事件 `ctx.on('approval/request', (req, next) => ...)`，返回四种 `ApprovalOutcome` 之一或 `next()`。

**建议**：

- 插件注册 `approval/request` 的 **waterfall 监听器**，把危险工具调用渲染成飞书审批卡片
  （展示工具名、参数摘要、**脱敏**后的路径），把用户点击结果映射回 `ApprovalOutcome`。
- 绝不在卡片里放完整命令参数、密钥或工作区敏感路径；只给摘要 + 一个可审计的 request id。
- 超时 / 用户无响应 → 回落到 `next()` 交还给 DSH 原有审批通道，**不默认放行**。
- 审批状态持久化到 `stateDir`，重启后能重新发卡片或拒绝过期请求。
- 保持 DSH 的 `workspace-write` 沙箱与「危险操作需审批」默认；插件只做**桥**，不做第二套权限判定。

---

## P0-3 长任务状态与取消

**现状**：`SessionBridge.cancel(sessionId)` 已实现，调用 `agent.cancel({kind:'user'}, {keepInbox:true})`；
`waitForReply` 有 `replyTimeoutMs` + AbortSignal。但用户还没有主动取消入口。

**建议**：

- 增加命令式控制：`/status`、`/cancel`、`/new`（新建 Session）。
  注意路由层目前只放行 `text`，命令也是文本，天然可用。
- `/status` 读 `ctx.get('feishuGateway').health()` + 当前 turn 的运行时长、
  已生成 token 数（`agent/assistant-stream` 的 chunk 计数）。
- `/cancel` → `bridge.cancel()` + 中止 `waitForReply` 的 AbortController（**每会话独立**，
  目前是全局 `AbortController`，应改为 per-chat，否则取消一个会话会误伤其它会话）。
- 用卡片展示进度条 / 「取消」按钮，回调走 `card.action.trigger`。
- 卸载时仍要保证 `stop()` 能取消所有在途 turn。

**已知技术债**：`FeishuGateway` 目前只有一个全局 `AbortController`；v0.2.0 应改为
`Map<chatKey, AbortController>`，这是支持细粒度取消的前置重构。

---

## P1-4 多机器人独立工作区与模型

**官方依据**：`ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model, reasoningEffort } })`。

**建议**：

- 把 `BotSpec` 扩展为可携带 `workspace` / `agent` / `agentPreset`，
  每个 bot 一个独立的 `cwd` 与模型路由；`SessionRegistry` 的 key 已经是 `botId:chatId`，天然隔离。
- **不要**为每个 bot 启动独立 Agent 进程或 LLM 客户端 —— 仍然全部走同一个 `ctx.agents`。
- 每个 bot 一条 `WSClient`（v0.1.0 已支持），注意同一 App ID 不能有两个长连接消费者。
- 独立工作区必须落在 DSH 的沙箱策略内（`workspace-write`），不要给插件自己开文件权限。

---

## P1-5 队列 / 重试 / 断线恢复增强

v0.1.0 已有 JSONL Inbox + 原子 JSON Outbox + DedupIndex。建议：

- **确认式 ACK**：目前事件处理器不 await 持久化（为满足 3 秒 ACK）。
  改为「先 `await inbox.record()` 再返回」，并用并发队列控制落盘延迟；
  若超过阈值则先回 ACK 并在后台补写，记录丢消息风险指标。
- **指数退避 + 死信队列**：Outbox 增加 `maxAttempts`、死信列表与手动重放入口。
- **断线恢复**：`WSClient.onReconnecting` / `onReconnected` 已接入 `onStateChange`，
  在 `connected` 时 drain outbox；补上「重连后重新订阅/校验 event dispatcher」健康检查。
- **去重**：`DedupIndex` 目前按 TTL + 容量裁剪；增加按 chat 的分片与落盘压缩，避免单文件无限增长。
- **背压**：每个 chat 已有串行队列，再增加全局并发上限与排队长度上限，避免长任务堆积。
- **可替换存储**：把 `JsonStore` / `DurableInbox` 抽象成接口，v0.2.0 可选 SQLite
  （DSH 自带 `dsh-session-query-sqlite`，但**会话历史仍归 DSH**，插件只存自己的队列/映射）。

---

## P1-6 图片 / 文件双向传输

**建议**：

- 入站：`im.message.receive_v1` 的 `message_type` 为 `image` / `file` / `post` 时，
  用 `im/v1/messageResource` 下载 → 转成 DSH `attachment` / `SessionAttachmentRequest`，
  通过 `sessionController.attachment()` 或 `createUserMessage` 的 image block 注入原生 Session。
- 出站：DSH 交付物（`dsh-deliverable-file-references`）→ 上传到飞书 `im/v1/file` / `im/v1/image` → 发送。
- **安全默认**：限制文件大小/类型、扫描文件名、不把附件内容写进日志、白名单外用户不接收文件。
- v0.1.0 明确只支持 `text`，非文本被丢弃；开启附件前必须先做类型/大小校验与审批策略。

---

## P1-7 定时任务主动通知

**官方依据**（[../research/dsh-api.md](../research/dsh-api.md) §6）：
`ctx.schedule.create({ title, prompt, timing, target })`，`target: { kind: 'session', sessionId }`；
或 `@deepseek-ai/cordis-plugin-timer` 的 `ctx.timeout(...)`。

**建议**：

- 用户通过飞书发「每天 9 点提醒我 …」→ 插件调用 `ctx.schedule.create`，
  `target` 指向该 chat 对应的**原生 Session id**（`SessionRegistry` 已有映射）。
- 到期时由 DSH 自己唤醒 Session 并通过 `session/event` / `agent/assistant-stream` 产出文本；
  插件复用现有 outbox 把结果发到对应 `chatId` —— **不新建定时任务引擎**。
- 需要把 `schedule task id → chatId` 的映射持久化，支持 `/list` `/cancel`。
- 注意 `dsh-schedule` 的 `session/flush` 确认语义，避免重复投递。

---

## P2-8 Web 管理面板

**官方依据**：`package.json.dsh.client = { platform: 'web', inject, external }` +
`window.__ModuleLoader__` 客户端模块（官方模板见
`dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js`）。

**建议**：

- 只做**只读 + 少量操作**：连接状态、白名单、健康指标、Inbox/Outbox 队列、Session 映射、
  手动重放/取消。
- 通过 `ctx.feishuGateway` 服务暴露的 `health()` / `diagnostics()` 取数，
  管理动作走 Typert Remote（参照 `dsh-plugin-manager` 的 `typert.host` / `typert.remote-client` 分层），
  **不要在 Web 端直接读 `stateDir`**。
- 白名单编辑必须经审批 / 二次确认；面板绝不显示密钥，只显示 `env:VAR_NAME` 来源。
- 注意：客户端模块改动需要重建 Web 产物并刷新页面才生效（本仓库不在 DSH Web checkout 内，
  需按 DSH 的构建流程单独处理）。

---

## P2-9 日志 / 健康检查 / 诊断增强

- 结构化 JSON 日志 + 关联 id（`messageId` / `sessionId` / `botId` / `chatKey`）。
- `health()` 增加：每个 bot 的最近连接时间、重连次数、最后错误、队列积压、平均回复时延。
- 提供 `/diagnose` 命令导出**脱敏**诊断包（参考社区项目的 doctor ZIP 思路，但自己实现），
  内容不含密钥、消息正文、工作区路径原文。
- 增加「配置自检」：启动时校验 `workspace` 存在且可写、`stateDir` 可写、
  `appId` 形状、白名单非空（否则明确告警「当前拒绝所有人」）。

---

## P2-10 群聊（如需开放）

v0.1.0 硬编码关闭群聊是有意的。开放前必须补齐：

- `@bot` mention 解析（去掉 mention 占位符，只把 @ 之后的内容交给模型）；
- 群级白名单 / 群级独立 Session 与工作区隔离；
- 群内敏感信息防泄露策略（不把 A 的私聊上下文带到群里）；
- 群内危险操作强制审批；
- 限频与消息可见范围控制。

---

## 工程化建议

1. **版本**：v0.2.0 发布时按新的 DSH 运行时复核 `engines.dsh`；
   若 DSH 升到 `0.3.x`，发新插件版本而不是申请 `allow-version` 豁免。
2. **测试**：保持「无凭据也能全绿」。新增每个适配器对应的 Mock；
   增加契约测试，用本机 `node_modules/@deepseek-ai/*` 的 `.d.ts` 校验官方 API 形状未漂移。
3. **CI**：当前已有 typecheck / build / test / coverage / pack；
   建议加 `pnpm audit` 与 `dsh plugin --profile <test> version-exemptions` 的只读断言
   （确保永远为空）。
4. **真实 E2E**：等有了测试应用凭据后，单独建一个 **opt-in** 的 E2E 工作流
   （`if: secrets.FEISHU_TEST_APP_ID != ''`），与 Mock 测试分离，
   验证结果必须明确标注「真实租户」而不是混入 Mock 报告。
5. **不变量**：任何新增监听器 / 定时器 / 连接，都必须登记进 `FeishuGateway.stop()` 的清理清单，
   并有对应的「卸载后无残留」测试。

---

## 明确不做的事

- 不做第二套 Agent / LLM / Session 管理；
- 不 import DSH 私有路径、不改 DSH Core、不覆盖现有 Web 配置；
- 不 Fork 或 vendor 社区插件（cube-ai Apache-2.0 / dsh-lark-link MIT 各有归属与已知缺陷）；
- 不把密钥放进配置文件、不打印密钥、不用 `allow-version`；
- 不在没有真实凭据时宣称完成真实端到端验证。
