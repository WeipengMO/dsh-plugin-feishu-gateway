# DSH 飞书 Gateway 插件（v0.1.0）

> 一个**从零建立、可独立发布、长期运行**的 TypeScript Cordis 插件，把飞书 / Lark 私聊消息通过 WebSocket 长连接桥接到 **DSH 原生 Session / Agent**，目标是逐步替代 OpenClaw 的飞书交互层。
>
> An independently authored, publishable TypeScript Cordis plugin that bridges Feishu/Lark direct messages to **native DSH Sessions** over a long-lived WebSocket. v0.1.0 covers the WS connection, DM send/receive, an allowlist, native Sessions, and basic durable persistence/dedup. All automated tests use mocks; **no real Feishu tenant was contacted**.

---

## 状态与边界（请先读）

| 项目 | 状态 |
| --- | --- |
| 版本 | `0.1.0` |
| 已实现 | WebSocket 长连接、私聊收发、白名单、DSH 原生 Session、消息持久化与去重基础、单元 + 集成测试、CI、健康诊断 |
| 未实现（v0.2.0+） | 卡片 / 流式回复、图片文件双向、原生工具审批桥接、长任务取消、定时任务主动通知、Web 管理面板、多机器人独立工作区与模型 |
| 真实端到端验证 | **未做**。没有真实飞书凭据，测试全部使用 Mock Transport / Mock SessionBridge |
| 现有 DSH Web 配置 | **未改动**。本项目不写 `~/.dsh/profiles/web/` 的任何文件 |
| `allow-version` | **未使用**。通过如实声明 `engines.dsh` 满足官方兼容性检查 |
| 第二套 Agent / LLM 系统 | **没有**。会话、历史、模型、循环全部由 DSH 自己管理 |

---

## 目录结构

```
dsh-plugin-feishu-gateway/
├── package.json                # 插件清单（含 dsh.bundle.patch / engines.dsh）
├── pnpm-workspace.yaml         # pnpm 12 构建脚本白名单
├── tsconfig*.json              # NodeNext / ESM / 严格模式
├── vitest.config.ts            # Vitest 配置
├── cordis.patch.yml            # Bundle 补丁：把插件插入 profile 的 Cordis 树
├── locale/{en,zh}.json         # 插件显示元数据
├── src/
│   ├── index.ts                # Cordis 插件入口（name / inject / Config / apply）
│   ├── config.ts               # schemastery 配置、密钥解析、脱敏摘要
│   ├── types.ts                # 领域类型 + 端口接口（SessionBridge / FeishuTransport）
│   ├── gateway.ts              # 流水线编排 + 生命周期 + 健康诊断
│   ├── channel/
│   │   ├── lark-transport.ts   # 真实 @larksuiteoapi/node-sdk WSClient 适配器
│   │   └── mock-transport.ts   # 内存 Mock（测试用）
│   ├── router/message-router.ts# 安全边界：白名单 / 群聊 / 消息类型 / 截断
│   ├── inbox/{inbox,dedup}.ts  # 持久化 JSONL 收件箱 + 去重索引
│   ├── session/
│   │   ├── dsh-session-bridge.ts   # 官方 path A：ctx.agents + session/event + assistant-stream
│   │   ├── mock-session-bridge.ts  # 内存 Mock
│   │   ├── session-registry.ts     # 聊天 → 原生 Session id 的映射（仅映射）
│   │   └── session-bridge.ts       # 文本抽取工具
│   ├── outbox/outbox.ts        # 持久化发件箱 + 重试 + 断线补发
│   ├── storage/json-store.ts   # 原子 JSON 状态存储（无原生依赖）
│   ├── util/                   # 日志 / 重试 / id
│   └── testing/index.ts        # 对外测试工具（子路径导出 ./testing）
├── tests/
│   ├── unit/                   # 10 个单元套件
│   └── integration/            # 真实 Cordis 生命周期 + 全链路 Mock 集成
├── docs/                       # 架构 / 兼容性 / 测试 Profile / 飞书应用 / Roadmap
├── profiles/feishu-gateway-test/  # 本地测试 Profile 模板（不覆盖 web）
├── research/                   # 调研报告（DSH API / 插件范例 / 参考项目）
└── .github/workflows/ci.yml    # GitHub Actions CI
```

---

## 快速开始

```bash
# 需要 Node >= 24.9.0、pnpm 12
pnpm install
pnpm run typecheck
pnpm run build
pnpm run test
# 一条命令跑完：
pnpm run verify
```

构建产物：`lib/index.js`（ESM）+ `lib/types/index.d.ts`。包以 **bundle** 形式发布：`dsh.bundle.patch` 指向 `cordis.patch.yml`。

---

## 架构（一句话版）

```
Feishu WebSocket → FeishuTransport
  → MessageRouter（白名单 / 群聊关闭 / 类型检查）
  → DurableInbox（持久化原子入队）+ DedupIndex（非权威缓存）
  → SessionRegistry → SessionBridge（ctx.agents 原生 Agent/Session）
  → 监听 session/event + agent/assistant-stream 收集回复
  → DurableOutbox（串行补发 / 持久 UUID / 幂等键）→ Feishu reply/create
```

详细设计、官方 API 证据、能力矩阵见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，版本兼容性分析见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

---

## 配置

插件配置由 `schemastery` 的 `Config` 校验。**密钥永远不写进配置**：`appIdEnv` / `appSecretEnv` 只声明环境变量名，值在激活时从 `process.env` 读取，且从不出现在日志里。

```yaml
# profile 的 cordis.patch.yml 中按 id 覆盖 config
- id: feishu-gateway
  config:
    bots:
      - id: default
        enabled: true
        domain: feishu
        appIdEnv: FEISHU_GATEWAY_DEFAULT_APP_ID
        appSecretEnv: FEISHU_GATEWAY_DEFAULT_APP_SECRET
    allowlist: ['ou_xxxxxxxxxxxxxxxx']   # 空 = 拒绝所有人（fail closed）
    allowGroups: false                    # v0.1.0 强制关闭群聊
    workspace: /home/ubuntu/workspace     # 原生 Session 的 cwd
    stateDir: /home/ubuntu/.dsh/feishu-gateway
    offline: false
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `bots` | `[]` | 多机器人条目，每个对应一条 WS 长连接 |
| `allowlist` | `[]` | 允许的发信人 `open_id`；**空列表拒绝全部** |
| `allowGroups` | `false` | v0.1.0 即使设为 `true` 也会被路由层拒绝 |
| `workspace` | `process.cwd()` | 传给 `ctx.agents.create({ meta: { cwd } })` |
| `agent` | `{}` | 可选 `{ provider, model, reasoningEffort }`，留空继承 profile 默认模型 |
| `stateDir` | `$DSH_HOME/feishu-gateway` | 收件箱 / 发件箱 / 去重 / Session 映射 |
| `dedupTtlMs` | `86400000` | `message_id` 记忆时长 |
| `maxTextLength` | `8000` | 按 Unicode code point 截断 |
| `replyTimeoutMs` | `120000` | 等待原生 Session 回复的上限 |
| `sendRetries` | `3` | 发件重试次数 |
| `offline` | `false` | 硬开关；`FEISHU_GATEWAY_OFFLINE=1` 也会强制开启 |

环境变量命名约定（未显式声明时自动使用）：

```
FEISHU_GATEWAY_<BOT_ID_UPPER>_APP_ID
FEISHU_GATEWAY_<BOT_ID_UPPER>_APP_SECRET
```

见 [.env.example](.env.example)。生产环境请通过 systemd / 容器 secret 注入环境变量，**不要提交 `.env`**。

---

## 安全默认

1. **私聊白名单**：`allowlist` 为空时拒绝所有入站消息；只按 `open_id` 精确匹配。
2. **群聊关闭**：v0.1.0 硬编码拒绝 `chat_type === 'group'`，配置开关不能打开。
3. **只处理文本**：非 `text` 消息直接丢弃；机器人自身消息（`sender_type !== 'user'`）丢弃，避免回声循环。
4. **密钥**：只从环境变量读取；日志只打印解析来源（如 `env:FEISHU_GATEWAY_DEFAULT_APP_SECRET`），不打印值；`redactedConfigSummary()` 脱敏。
5. **最小权限**：插件本身不申请任何文件系统 / 网络特许；部署时建议保持 DSH 的 `workspace-write` 沙箱，危险操作走 DSH 原生审批（v0.2.0 桥接）。
6. **卸载清理**：`ctx.effect` 的 disposer 关闭所有 WebSocket、取消在途任务、`AgentHandle.dispose()` 释放每个原生 Session、移除监听器。
7. **不绕过兼容性**：`engines.dsh` 如实声明，绝不使用 `allow-version` 精确豁免。

---

## 本地测试 Profile 安装

**不要**手改现有 `web` profile。创建一个独立 profile：

```bash
# 0. 先构建：lib/ 不在 git 里，干净检出必须生成
pnpm install --frozen-lockfile && pnpm run build

# 1. 复制模板到独立 Profile（不要动 web）
PROFILE=feishu-gateway-test
mkdir -p "$DSH_HOME/profiles/$PROFILE"
cp -r "profiles/$PROFILE/." "$DSH_HOME/profiles/$PROFILE/"

# 2. 用 dsh 自己的插件管理命令安装（tarball 已含 lib/）
pnpm run pack
dsh plugin --profile "$PROFILE" add "$PWD/dist/dsh-plugin-feishu-gateway-0.1.0.tgz"

# 3. 可选：注入测试凭据（没有凭据就保持模板默认 offline: true）
# export FEISHU_GATEWAY_DEFAULT_APP_ID='cli_...'
# export FEISHU_GATEWAY_DEFAULT_APP_SECRET='...'
```

> **安装 ≠ 测试**：v0.1.0 没有 Web 管理面板，装进 `web` 也不会出现任何界面或交互入口；
> 功能验证不需要启动 DSH、也不需要装进任何 Profile，见下一节。
> 模板用的是 `dsh-headless`，启动需要任务参数且需要 LLM 路由配置（默认模板未配，
> 直接启动会报 `MISSING_CREDENTIAL`）——详见 [docs/TEST-PROFILE.md](docs/TEST-PROFILE.md) §5。

---

## 如何测试（不需要装进 web）

| 层 | 命令 | 验证内容 | 需要 DSH / 飞书 |
| --- | --- | --- | --- |
| L1 单元 + 集成 | `pnpm run verify` | 路由安全、去重、持久化、原生 Session 桥接、真实 Cordis Context 装载/卸载、全链路 Mock 集成与故障注入测试 | 否 / 否 |
| L2 本地全链路 | `pnpm run demo "你好"`（或 `node scripts/demo.mjs "你好"`） | 手动发一条消息，打印入站 → 原生 Session → 出站回复、健康计数 | 否 / 否 |
| L3 安装与配置树 | `dsh --profile <name> --dump-config`、`import('dsh-plugin-feishu-gateway')` | bundle 层能组合、模块能解析 | 只读，不启动 |
| L4 完整运行时激活 | `dsh --profile <name> "<任务>"` | `apply()` 在真实 DSH 里执行 | 是 / 否（需先配 LLM 路由） |
| L5 真实飞书 E2E | 测试应用凭据 + `offline: false` + 从飞书发私聊 | 真实 WS 收发 | 是 / **仅测试应用** |

L2 依赖构建产物 `lib/`，从干净检出先跑一次 `pnpm run build`。换第二个参数可验证拒绝策略：

```bash
pnpm run demo "你好" ou_stranger     # 白名单外 → 无回复
```

**关键说明**：`offline: true` 下用的是 `MockFeishuTransport`，启动 Profile 也**不会自动产生入站消息**，
最多只能看到加载日志。要真正驱动消息流，只有 L1/L2（本地 Mock）或 L5（真实测试应用）两条路 ——
**装进 `web` 并不会让 Mock 产生消息，也不会多出任何 GUI 入口**。

---

## 飞书测试应用配置

见 [docs/FEISHU-APP.md](docs/FEISHU-APP.md)：创建企业自建应用、开启机器人能力、配置 `im.message.receive_v1` 长连接事件订阅、所需权限（`im:message`、`im:message:send_as_bot` 等）、白名单 `open_id` 获取方式。**本项目不会连接任何现有正式飞书应用。**

---

## 构建与测试结果

在本机（Node v24.22.2 / pnpm 12.18.0）执行：

```
pnpm install            ✓ (esbuild / protobufjs 构建脚本已在 pnpm-workspace.yaml 白名单)
pnpm run typecheck      ✓
pnpm run build          ✓  lib/index.js + lib/types/**
pnpm run test           # 运行单元 / 集成 / 故障注入测试（修复分支请以 CI 结果为准）
pnpm run verify         ✓
```

测试覆盖：配置与密钥解析、路由安全策略、去重 TTL/持久化/容量、JSONL 收件箱与重启恢复、原子存储与损坏文件隔离、Session 映射、原生 Session 桥接（事件订阅 / 流式文本 / 超时 / 取消 / 卸载）、发件箱重试与断线补发、**真实 Cordis Context 的插件装载与卸载**、全链路 Mock 集成（白名单 / 群聊 / 去重 / 会话恢复 / 健康诊断）。

CI：`.github/workflows/ci.yml`（pnpm frozen-lockfile → typecheck → build → test → coverage → pack）。

---

## 消息可靠性与执行安全（修复分支）

- **先持久化再确认收到消息**：入站事件先由 Inbox 原子入队，随后才更新可选去重缓存。异步持久化失败不会被当作成功接收。
- **运行中断不自动重复执行**：Inbox 明确区分 `pending`、`running`、`done`、`failed` 和 `uncertain`。崩溃后仅自动处理尚未开始执行的 `pending`；`running` 变为 `uncertain`，向用户提示检查会话，不自动重新运行可能修改文件/执行命令的 Agent Turn。
- **Outbox 串行化与固定 UUID**：同一 Outbox 实例内的入队、发送、重连补发受同一互斥队列保护。每个消息重试都复用持久 UUID，配合本地已发送记录降低重复回复风险。
- **超时会话隔离**：超时任务触发取消并解除原聊天会话绑定，下一条消息使用独立 DSH Session，避免旧回复混入新轮次。
- **权限与凭据**：任务入队和执行时都检查当前白名单；仅接收 `open_id` 和明确的 `p2p` 消息，凭据必须从环境变量读取，不再支持在配置中直接填明文 Secret。
- **`stateDir` 单实例独占（新增）**：启动时以 `O_EXCL` 创建 `stateDir/.owner.lock`；第二个指向同一目录的 Gateway 实例会**启动失败**（fail closed），避免两个实例各自持有一份内存去重 Map 而把同一 `message_id` 执行两次。锁由持有者令牌标识，`stop()` 只释放自己的锁；进程崩溃 / SIGKILL 遗留的陈旧锁会在下次启动时按 PID + `/proc` starttime 检测并接管，不会把插件永久锁死。这是**单机 advisory 锁，不是分布式互斥锁**：`stateDir` 必须位于同一主机、且只被一个 Gateway 实例使用；`JsonStore` 临时文件名也已改为按实例唯一。
- **崩溃恢复的会话隔离（新增）**：`running → uncertain` 的恢复路径现在会**解除该聊天的 Session 绑定**（此前仅超时/异常路径会解绑），下一条消息创建全新 Session，而不是 resume 那个可能已被中断、且可能已产生副作用的旧 Session。
- **JSONL 断尾恢复与出站幂等（新增）**：最后一行是合法 JSON 但缺少结尾换行时会在 `open()` 阶段补齐，避免下一次追加把两个对象粘成一行导致随后启动失败；`im.message.create` 路径也复用持久化的 `uuid`，REST 重试具备幂等键；WebSocket 仅在 `onReady`/`onReconnected` 后才报告 `connected`，配置错误的机器人不再被误报为健康；关闭期间到达的入站事件会抛错而不是被静默 ACK。

**交付语义与保证边界（明确、不夸大）：**

- 本插件**不提供端到端 exactly-once**。实际保证是：单实例、单主机、进程（非机器掉电）崩溃范围内的**「Agent 最多自动执行一次」+「回复至少投递一次」+「尽力而为的外部幂等」**（20k 条上限的 `sent` 记录 + 飞书约 1 小时的 `uuid` 窗口 + 稳定的 `idem` 键）。
- `appendFile` 未 `fsync`：机器掉电可能丢失最近的 `running` 事件，使一次已开始的 Turn 退化为可重放的 `pending` → 理论上重复执行。`inbox.jsonl` 的 append 与 `outbox.send()` / `registry.touch()` / `markProcessed()` 不在同一事务内：回复发出后才标记完成，极窄崩溃窗口内会产生一条「请检查会话后决定是否重发」的二次提示。
- **`failed` / `uncertain` 是终态且目前没有程序化的重试 / 解决入口**：`health()` / `diagnostics()` 只读，唯一的恢复方式是用户在飞书重新发送（产生新的 `message_id`）。这是刻意的保守取舍（避免重放可能已产生副作用的 Turn），也是已知的人工恢复缺口，见 [docs/ROADMAP-v0.2.0.md](docs/ROADMAP-v0.2.0.md) 的死信队列 + 手动重放 TODO。
- **已完成的非法 JSONL 行**（非尾部断尾）仍会让 `open()` 抛错并导致插件启动失败，尚没有隔离 / 跳过 / 命令行修复入口；只有三个 `JsonStore` 状态文件有 `.corrupt-*` 隔离。
- 白名单撤销只对**重启后**重放的 `pending` 生效；运行中的实例仍持有构造时的 allowlist 快照，热撤销需要重新加载插件。Outbox 的 `pending` 与 `inbox.jsonl` 均无上限/压缩（`sent` 有 20k 上限）；单个机器人的 `sendText` 没有硬超时，可能阻塞全局 Outbox 互斥队列。
- 状态文件以 `0o600` 保存**明文**用户消息与回复文本（不含 App Secret 值），`stateDir` 请勿放在会被提交到仓库的位置。飞书服务端对非 200 ACK 的重推行为、超过 1 小时的 `uuid` 去重，均未通过真实租户验证。
- 网络发送成功与本地记录完成之间仍存在极窄的进程崩溃窗口。固定 UUID 有助于服务端去重，但不能跨任意下游工具保证严格 exactly-once；对非幂等的 DSH 工具操作，本项目明确采用保守的 `uncertain` 恢复策略，而不是声称执行恰好一次。运行前仍需真实 DSH + 飞书测试租户验证。

## 真实 DSH 运行时 / 原生 Session 验证（本次补充）

用**隔离的临时 `DSH_HOME` + Mock 凭据 + 本地 Mock LLM（OpenAI 兼容 SSE）**启动了一次真实
`dsh 0.2.2-rc.1` headless 运行时：`dsh plugin add` 安装的 `.tgz` 被装载，
`inject` 的 `ctx.agents/agentLoop/sessions/llm` 均为真实服务，插件 `apply()` 执行并写出
`stateDir/dedup.json`。注意 `--dump-config` 只组合配置、**不证明激活**，激活以真实启动 +
状态文件为准。随后用一个**测试专用 probe** 通过公开 `createGateway()`（不注入
`MockSessionBridge`）把入站消息送入真实 `DshSessionBridge`：

- `session/event` 与 `agent/assistant-stream` **确实**投递到插件级 ctx（澄清了此前文档的
  未验证假设）；`makeUserMessage` 的回退对象也被 `agent.followup()` 接受（入站消息被
  splice 进 agent inbox）。
- **修复前（默认配置，真实缺陷）**：`ctx.agents.create()` 未带 `agentOptions`，每个 turn
  以 `agent ... has no provider/model` 结束，用户只收到「模型未返回文本内容。」，消息却被
  标记 `done` —— 原生 Session 默认不可用。**已修复**：未配置 `agent` 路由时从
  `ctx.agentDefaultModel.currentSelection()` 取 provider/model 填入 `agentOptions`。
  修复后首条消息经真实 `assistant/message` 返回真实模型文本，`turn/end: completed`，
  `agent/assistant-stream` 14 个事件，未观察到重复文本拼接。
- **仍未解决 / BLOCKED**：同一 Session 的**后续消息（上下文复用）**在 headless 测试 profile
  中失败（先 `cannot append outside a SessionStore`；改为按持久化 `agents.resume()`
  重新挂载后变为 `no agent factory registered (load an agent-loop plugin)`，该 profile
  未注册 agent factory）。Agent 超时 / 异常 / 取消后的 Session 隔离、卸载时 Event Listener
  与 AgentHandle 清理，也**未在真实运行时验证**；`pnpm run demo` 与全部 vitest 用例用的
  都是 `MockSessionBridge`（模拟 Agent 文本）。

**结论：Gateway 并非只模拟 Agent 文本** —— 修复后首轮确实走 DSH 原生 Session 并拿到真实
模型回复；但**还不能说「完整使用」**：默认配置原本是坏的、多轮上下文复用仍 BLOCKED，
真实飞书端到端也未验证。详见 `research/TEST-REPORT.md` 与
`research/runtime-compat.md`。

## 后续版本

见 [docs/ROADMAP-v0.2.0.md](docs/ROADMAP-v0.2.0.md)：卡片与流式回复、图片/文件双向、原生审批桥接、长任务取消、Schedule 主动通知、Web 管理面板、多机器人独立工作区/模型、可观测性。

---

## 参考与许可

- DSH 官方 API 调研：[research/dsh-api.md](research/dsh-api.md)
- 插件范例调研：[research/plugin-examples.md](research/plugin-examples.md)
- 参考项目调研：[research/references.md](research/references.md)
- 上游：https://github.com/deepseek-ai/deepseek-harness , https://github.com/larksuite/node-sdk
- 本项目从零编写，未 Fork 任何社区插件。MIT License。
