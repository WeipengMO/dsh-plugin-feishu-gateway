# Round 2 — 真实 DSH 0.2.2-rc.1 运行时 SessionBridge 验证报告

**日期**：2026-11-14（Asia/Shanghai）
**分支 / HEAD**：`fix/gateway-reliability-idempotency`，起始 `8ccca30dd5ea1c817251a6207b8307a9aab17678`（已确认包含目标提交）
**PR**：[#1](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/pull/1) — **未合并、未发布 npm**
**本轮产出提交**：见文末「交付」

> **本轮核心不是 Mock 单元测试。** 所有「真实运行时」结论都来自实际启动
> `dsh 0.2.2-rc.1` headless Host 进程并驱动**真实 `DshSessionBridge`**
> （`create` / `submit` / `waitForReply` / `resume` / `cancel` / `dispose`），
> 未用 `MockSessionBridge` 替代原生 Agent。`pnpm run verify` 通过**不等于**真实 DSH
> Session 测试通过。

---

## 0. 前置：`pnpm run verify`

`git status` 干净、HEAD = `8ccca30`（远端 ref 一致）。
`pnpm run verify` → **exit 0**，14 文件 / **119 测试**全通过（typecheck + build + test）。

---

## 1. 测试环境（复用上一轮隔离设施）

| 项 | 值 |
| --- | --- |
| DSH CLI / runtime | `0.2.2-rc.1`（`dsh-app-boot 0.2.2-rc.1`，Cordis `4.1.0`） |
| 隔离 `DSH_HOME` H1 | `/tmp/dsh-l4-home-bmnXVq`（上一轮建立，本轮复用） |
| 独立 Host 2 `DSH_HOME` | `/tmp/dsh-l4-home-r2b`（新 `mktemp`，复制 DSH `sessions/` + `storages/` 持久化） |
| 恢复失败 Host 4 | `/tmp/dsh-l4-home-r2d`（复制后删除该 Session 的持久化文件） |
| Profile | `feishu-gateway-test`（`dsh-base` + `dsh-headless` + 插件；`llm-pi-ai` / `agent-default-model` 指向本地 Mock LLM） |
| 真实服务 | `ctx.agents` / `ctx.agentLoop` / `ctx.sessions` / `ctx.llm` / `session-persistence-jsonl` 均由真实 DSH 挂载 |
| 测试 LLM | 本地 OpenAI 兼容 SSE 适配器，**无状态、只依据请求中的真实会话历史生成回复**（`/\b[A-Z]{2,}-\d{3,}\b/` 抽取式记忆），无针对测试问题的硬编码答案 |
| 凭据 | 仅占位 `FEISHU_GATEWAY_TEST_LLM_KEY=mock-not-a-real-key`；**未读取/复用任何生产密钥** |
| 插件构建 | 每轮 `pnpm run build` 后同步 `lib/` 到隔离 Profile 的已安装包 |
| 可复现 harness | [`scripts/real-runtime/`](../scripts/real-runtime/README.md)（`mock-llm.mjs` + `native-session-probe.mjs` + README） |
| DSH 源码分析 | [`research/dsh-internals.md`](dsh-internals.md)（只读，逐条 file:line） |

**保持「同一个持续运行的 Host 进程」的方法**：`dsh-headless` 在自身一次性任务完成时调用
`io.exit()`（`dsh-headless/lib/index.js:383`）→ 根 fiber 并发卸载 → 清掉 `agents.factory`
（`dsh-agent/lib/index.js:558-567`）并 detach Session（`dsh-session/lib/index.js:1576-1578`）。
因此测试 LLM 只对该 headless 任务自身的请求延迟 45 s（`HOST_KEEPALIVE`），使**同一个
`dsh` 进程**在三轮期间保持运行，之后任务正常完成、Host 正常退出。三轮均在**一次**
`dsh` 调用内完成，没有每轮重启 `dsh-headless`。

---

## 2. 结果总表（按任务要求）

| 项目 | 结果 | 关键证据 |
| --- | --- | --- |
| 同一 Host 连续三轮对话 | **PASS** | Host 1 单次进程 3 轮全部返回；bridge 序列 `create,submit,waitForReply,resume,submit,waitForReply,resume,submit,waitForReply,dispose`；`errors=[]` |
| 三轮 Session ID 一致 | **PASS** | 三轮 `sessionId` 均为 `feishu-default-oc_r2-session-c80b7703-72c9-4b94-be79-51f429a54690`；`bridgeHandleCount=1` 全程不变 |
| 上下文真实保留 | **PASS** | Turn 3 的 LLM 请求 `roles=["system","user","user","user","assistant","user","assistant","user"]`，含前两轮 User 与 Assistant 消息；Turn 1 回复确认语、Turn 2/3 回复 `GBM-7429`（由历史推导，非硬编码） |
| 跨 Host 重启恢复 | **PASS** | Host 1 正常关闭后，独立 `DSH_HOME` + 新进程用同一 Session ID 冷恢复；Host 2 的 LLM 请求含前三轮 3 条 User + 3 条 Assistant 消息，回答 `GBM-7429`；`bridge: resume,submit,waitForReply,dispose`，`errors=[]` |
| 超时与异常隔离 | **PASS** | 超时 / 取消 / Agent 异常三种情形后下一条消息均使用**全新 Session**；`oldTextLeaked=false`；`crossAttributed=0` |
| 原生事件正确投递 | **PASS** | `session/event`（`user/message`、`assistant/message`、`turn/end` 含 `reason.kind`）与 `agent/assistant-stream`（`start`/`chunk`/`text-delta`）均到达插件级 ctx |
| 现有自动化测试 | **PASS** | 修复后 `pnpm run verify` → 14 文件 / **123 测试**通过；完整回归 9 条命令全 exit 0 |

**BLOCKED / 未验证**（如实标注，不声称通过）：真实飞书租户端到端、真实 Web profile /
`dsh-web.service`（按要求未触碰）、真实商用 LLM（本轮用基于历史生成回复的测试适配器，
满足「不得硬编码固定答案」但非真实模型）。

---

## 3. Host 1：同一进程连续三轮（详细）

测试 LLM 是**无状态**的：服务端不保存任何记忆，回复只由 DSH 当次请求中的 `messages`
历史算出。若 DSH 没有把前几轮放进上下文，Turn 2/3 不可能返回 `GBM-7429`。

| Turn | 输入 | 输出 | Session ID |
| --- | --- | --- | --- |
| 1 | `请记住字符串 GBM-7429。` | `已记录：请记住字符串 GBM-7429。` | 同一个 |
| 2 | `我上一轮让你记住了什么？` | `GBM-7429` | 同一个 |
| 3 | `请再次重复第一轮的字符串。` | `GBM-7429` | 同一个 |

- `processed` 依次 1→2→3，`errors=0`，`status=ok`。
- **活动 AgentHandle 没有被重复 dispose**：`disposeCalls = 1`，且发生在 `gw.stop()`
  （`via: "create"` 的句柄在 finally 才释放）；三轮中间无任何 dispose。
- 每轮快照：`agentRegistryHas=true`、`sessionStoreHas=true`、`factoryPresent=true`、
  `bridgeHandleCount=1`。
- `sessions.json` 绑定 `default:oc_r2 → <同一 sid>`，`persisted=true`。

## 4. Host 2：独立 Host 从 DSH 持久化恢复（详细）

- Host 1 正常 `gw.stop()` 后，新建 `/tmp/dsh-l4-home-r2b`：复制
  `sessions/`（含 `session.v4.jsonl.zstd`）、`storages/` 与 Gateway `sessions.json`；
  **新 `dsh` 进程**、新 `DSH_HOME`，`PROBE_MODE=resume`，`PROBE_SESSION_ID` 与 Host 1 相同。
- DSH 会话持久化按 workspace 分目录（`<projectKey(cwd)>/<encodeSegment(id)>/`），
  故 Host 2 复用同一 workspace 路径；这是合法的服务重启/共享存储场景。
- `resume()` 走**冷恢复**（fresh bridge，无缓存 handle）→ `agents.resume({resumeSessionId})`
  → 成功；`agentRegistryHas/store/factory` 均为 true。
- Host 2 的 LLM 请求 #2：
  `roles=["system","user","user","user","assistant","user","assistant","user","assistant","user"]`
  = 三轮 User + 三轮 Assistant + 新问题；回答 **`GBM-7429`**。
- `bridge: resume,submit,waitForReply,dispose`，`errors=[]`。

## 5. Host 3：超时 / 取消 / 异常隔离（详细）

| 场景 | 触发 | 之后的新 Session | 旧文本泄漏 | 事件交叉归因 |
| --- | --- | --- | --- | --- |
| 超时 | `DELAY_MARKER` 使 LLM 延迟 600 ms > `replyTimeoutMs=200` | ✅ 不同 sid | ❌ 无 | `crossAttributed=0` |
| 取消 | 真实 `bridge.cancel()` + `AbortController.abort()` 直接驱动原生桥 | ✅ 不同 sid | ❌ 无 | `crossAttributed=0` |
| Agent 异常 | `FAIL_MARKER` → LLM HTTP 500，DSH 重试 5 次后 `turn/end` 带 `reason.kind=error` | ✅ 不同 sid（本轮修复后） | ❌ 无 | `crossAttributed=0` |

事件序列（异常 Session）：`turn/start → ... → assistant/attempt ×6 → llm/retry ×5
→ step/end → turn/end{reason.kind:"error"}`；Gateway 随后 `markFailed` + `unbind`，
下一条消息创建新 Session 且 `assistant/message` 正常到达。

## 6. 重点检查的三个老问题

| 问题 | 本轮结果 |
| --- | --- |
| `cannot append outside a SessionStore` | **未再出现**（当前四份结果文件命中数均为 0） |
| `no agent factory registered` | **未再出现**（当前四份结果文件命中数均为 0） |
| 异常创建新 Session 导致上下文丢失 | **未出现**。Host 4（删掉该 Session 的 DSH 持久化文件）触发冷恢复失败 → Gateway 回复「已保留会话绑定，没有重新创建空白会话」，`bridge.create` 调用数 **0**，绑定保持原 sid |

> 唯一命中旧错误串的文件是 `/tmp/dsh-l4-home-bmnXVq/probe-result.json`（mtime
> `21:02`，**上一轮遗留**），与本轮四个 Host 结果无关。

**根因分析（DSH 源码，见 `research/dsh-internals.md`）**：上一轮这两个错误不是 Gateway
缺陷，而是 `dsh-headless` 一次性任务结束即 `io.exit()` 触发 root fiber 并发卸载：
`agents.setFactory` 是 effect-scoped（`dsh-agent/lib/index.js:558-567`），卸载时
`this.factory = void 0`；`AgentHandle.dispose()` 会 `detachSession()` 把 Session 从
SessionStore 摘掉（`dsh-session/lib/index.js:1576-1578`）。本轮用 `HOST_KEEPALIVE`
让 Host 持续运行，问题消失；`8ccca30` 的「保留活动 handle、只在冷恢复时 resume」
策略经真实运行时验证正确。

---

## 7. 本轮发现并修复的真实 Gateway 缺陷

**现象**：Agent 失败时 DSH 发
`turn/end` + `data.reason = { kind:'error', error:{ message:'500: ...', code:'SERVER' } }`
且**不产生** `assistant/message`。原 `DshSessionBridge.onSessionEvent` 只调用
`settle()`，于是 `waitForReply()` 返回 `{text:'', reason:'idle'}`，Gateway 把失败 turn
当成成功：发送「模型未返回文本内容。」、`markProcessed` 标记 `done`、**不解除 Session
绑定**。用户消息被静默当作已处理且无隔离。

**修复（最小）**：
- `TurnState` 增加 `failure?: string`；
- `onSessionEvent` 在 `turn/end` 且 `reason.kind === 'error'` 时记录失败详情；
- `waitForReply` 若存在 failure 则抛错，复用既有 `dispatch` 失败路径
  （`markFailed` + `unbind` + 明确诊断）；
- **仅** `kind === 'error'` 视为失败，`aborted`/`interrupted` 等取消类原因不受影响
  （否则会误伤用户主动取消，已在单测中覆盖）。

**复现测试**（`tests/unit/dsh-session-bridge.test.ts` 新增 4 个）：
`turn/end` error 抛错、`completed` 正常、`aborted` 不抛错、失败后下一轮 turn 状态被清理。

修复后真实运行时复验：异常场景下一条消息**创建新 Session**、旧文本/事件无泄漏；
三轮对话与跨 Host 恢复不受影响。

---

## 8. 完整自动化回归（修复后）

| 命令 | 退出码 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm run typecheck` | 0 |
| `pnpm run build` | 0 |
| `pnpm run test` | 0（14 文件 / **123 测试**） |
| `pnpm run test:coverage` | 0 |
| `pnpm run pack` | 0 |
| `pnpm run verify` | 0 |
| `pnpm run demo "你好，请介绍一下自己"` | 0 |
| `pnpm run demo "你好" ou_stranger` | 0 |

覆盖率（`pnpm run test:coverage`）：**All files 92.59% stmts / 82.15% branch /
87.15% funcs / 92.59% lines**（修复前 91.98% / 81.86% / 87.07% / 91.98%）。

另有 `node scripts/fault-injection.mjs` → exit 0 / `{"PASS":9}`（上一轮 9 场景回归，
0 BUG）。

---

## 9. 记录的状态与事件（按要求）

- **Agent Registry**：`agents.get(sid)` 在三轮与跨 Host 恢复后均为 `true`；
  `agents.factory` 在持续运行的 Host 中始终 `true`（仅在 Host teardown 时被清空）。
- **SessionStore**：`sessions.get(sid)` 全程 `true`；`turn/end` 本身不 detach Session，
  只有 `AgentHandle.dispose()` / teardown 会。
- **Agent Factory**：由 `dsh-agent-loop` 的 `[Service.init]` 通过
  `ctx.effect(() => ctx.agents.setFactory(this))` 注册（`dsh-agent-loop/lib/index.js:1344`），
  `agents: []` 配置不会禁用它。
- **Session 持久化**：`<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd`
  （zstd，v4）+ `session.lock`；Host 2 复制该文件即可冷恢复，不需要 sessionQuery/SQLite、
  `storages/` 或 projection cache。
- **事件序列**：`permission/preset → sandbox/mode → approval/policy → agent/inbox/spliced
  → turn/start → step/start → system/message → user/message → request/header →
  request/context → session/title → assistant/message → step/end → turn/end(completed)`；
  异常轮为 `assistant/attempt ×6 → llm/retry ×5 → turn/end(error)`。
  `agent/assistant-stream` 的 `start`/`chunk(text-delta)`/`end` 均到达。

---

## 10. 交付

- 代码修复：`src/session/dsh-session-bridge.ts`；回归测试：
  `tests/unit/dsh-session-bridge.test.ts`。
- 文档：`README.md`、`docs/ARCHITECTURE.md`。
- 可复现真实运行时 harness：`scripts/real-runtime/{README.md,mock-llm.mjs,native-session-probe.mjs}`。
- 报告：`research/ROUND2-TEST-REPORT.md`（本文件）、`research/dsh-internals.md`（DSH 源码分析）。
- 推送到 PR #1 分支 `fix/gateway-reliability-idempotency`；**不合并、不发布 npm**、不修改
  DSH Core、不影响 `dsh-web.service`。
