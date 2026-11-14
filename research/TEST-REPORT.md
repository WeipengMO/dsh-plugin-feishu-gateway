# `fix/gateway-reliability-idempotency` 完整测试与代码审查报告

**日期**：2026-11-14（Asia/Shanghai）
**PR**：[#1](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/pull/1) `fix: harden Feishu gateway durability, retries and native Session lifecycle`
**被测分支**：`fix/gateway-reliability-idempotency`（检出前 HEAD `75a5c3a`）
**执行者**：Team Lead `lead` + 3 个只读/隔离写入的 teammate（`code-reviewer`、`runtime-compat`、`fault-injector`）

> 本报告中的 PASS 均指**实际执行命令并观察到输出**；BLOCKED 均给出明确原因，未声称通过。
> 未合并 PR、未发布 npm、未修改 `web` Profile / `dsh-web` / DSH Core / 其它运行中的插件，
> 未读取或输出任何生产 App Secret / API Key 的值。

---

## 一、执行原则符合性

| 原则 | 状态 |
| --- | --- |
| 先检查环境/仓库/Git/DSH 版本/现有服务 | ✅ 见 §二 |
| 优先使用 `/home/ubuntu/dsh-workspace/projects/dsh-plugin-feishu-gateway` | ✅ 已存在，直接使用 |
| 不修改 `web` Profile、`dsh-web.service`、DSH Core、其它运行中插件 | ✅ web 配置 mtime 保持 `12:35`/`17:34` 未变 |
| 不覆盖/删除/清理现有业务数据 | ✅ 测试 profile 配置先备份；真实运行时 probe 用隔离 `DSH_HOME` |
| 测试统一使用独立 Profile `feishu-gateway-test` | ✅ |
| 只用 Mock 凭据或专用飞书测试应用 | ✅ 仅环境变量名 + 本地 Mock LLM + 占位值；**未使用生产密钥** |
| 不使用 `allow-version` / 绕过兼容性检查 | ✅ `version-exemptions` = `{}`，无 `compatibility.json` |
| 所有修改有明确理由；发现问题→复现→最小修复→测试→文档→推送 | ✅ 见 §七 |
| 能自动完成的直接执行 | ✅ |
| 缺凭据/模型路由/真实飞书应用的测试标记 BLOCKED | ✅ §二/§四/§五/§六 |

---

## 二、环境检查

### 2.1 系统与工具链

| 项 | 值 |
| --- | --- |
| OS | Ubuntu 24.04.4 LTS (Noble), kernel `6.8.0-147-generic` |
| CPU 架构 | `x86_64`，4 vCPU |
| Node.js | `v24.22.2` |
| pnpm / npm | `12.18.0` / `11.13.0` |
| DSH CLI | `0.2.2-rc.1`（`/home/ubuntu/.npm-global/bin/dsh`） |
| DSH 运行时 | `dsh-app-boot 0.2.2-rc.1`（`getDshRuntimeVersion()` 的来源） |
| 运行时 Cordis | `@deepseek-ai/cordis 4.1.0`（`dsh` 自带） |
| 仓库路径 | `/home/ubuntu/dsh-workspace/projects/dsh-plugin-feishu-gateway` |
| 检出分支 / SHA | `fix/gateway-reliability-idempotency` / `75a5c3a`（检出时工作区 clean） |
| `DSH_HOME` / 当前 Profile | `/home/ubuntu/.dsh` / `web`（环境变量 `DSH_PROFILE=web`） |

### 2.2 GitHub PR 与 CI

`gh pr view 1`：**OPEN**，`isDraft=false`，`mergeable=MERGEABLE`，base `main`，head
`fix/gateway-reliability-idempotency`，`+541 / -208`，11 个提交（最新 `75a5c3a`）。
`gh pr checks 1` / `statusCheckRollup`：**`verify (24)` = SUCCESS**（run `43586541138`，42s）。
PR head OID `75a5c3a` 与本地 `origin/fix/...` 一致，故无需联网 fetch 即可检出。

### 2.3 DSH Profile 目录与现有服务

- `$DSH_HOME/profiles/`：`web/`、`feishu-gateway-test/`（后者为先前测试遗留，**其配置已先备份**到仓库内 `.tmp/profile-backup/`：
  `cordis.patch.yml`、`cordis.yml`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.plugin-manager/`）。
- `$DSH_HOME/feishu-gateway-test-state/` 仅有 `dedup.json`（`{"seen":{}}`）。
- `$DSH_HOME/sessions/`、`storages/`：Web GUI 的会话数据（只读列举，未修改）。
- **现有 Web 服务**：`dsh web --no-open --host 100.96.140.49 --port 3080 ...`（PID `943668`），
  监听 `100.96.140.49:3080`。**没有** `dsh-web.service` systemd unit（`systemctl status` 报 not found），
  即服务以进程方式运行。另有 `opencode serve`（PID 934784）。两者全程未触碰。
- 可用 Agent / Session / LLM：`dsh-base` 是**配置型 bundle**（其 `cordis.patch.yml` 装载
  `ctx.agents` / `ctx.agentLoop` / `ctx.sessions` / `ctx.llm` / `session/event` /
  `agent/assistant-stream` / `llm/stream`，均为真实 API，类型声明已核对）。但初始时
  **没有为该测试 Profile 启动的运行时进程**，只有一个 out-of-scope 的 Web GUI。
- LLM 凭据环境变量名 `DEEPSEEK_API_KEY`、`MAGPIE_API_KEY`、`OPENAI_API_KEY`、
  `ANTHROPIC_API_KEY`、`FEISHU_GATEWAY_DEFAULT_APP_ID/SECRET` 均 **ABSENT**；
  唯一可用密钥是 `$DSH_HOME/.credentials.yaml` 中支撑 Web GUI 的**生产**值，**未读取、未复制、未复用**。

### 2.4 `engines.dsh` / Cordis 版本 / 运行时实际兼容（不靠声明推断）

| 声明 | 运行时实际 |
| --- | --- |
| `engines.dsh: ">=0.2.2-rc.1 <0.3.0-0"` | `dsh-app-boot/lib/index.js:1089-1144` 的 `evaluatePluginCompatibility()` 用 `semver.satisfies(v, range, {includePrerelease:true})`；`0.2.2-rc.1` 满足上下界 → 返回 `undefined`（兼容）。`engines.dsh` 存在时**单独决定**，`peerDependencies` 被忽略 |
| `engines.node: ">=24.9.0"` | `v24.22.2` ✅ |
| `peerDependencies: @deepseek-ai/cordis ~4.1.0` | 运行时自带 `4.1.0` ✅；且该 peer 不匹配 `@deepseek-ai/dsh*` 过滤规则，不参与 DSH 兼容性门禁 |
| `dsh.bundle.patch: ./cordis.patch.yml` | `dsh plugin add` 的 `reconcile()` 把包名写入 `dsh.profile.bundles` ✅ |

**实证**（不仅是读代码）：
- `dsh plugin --profile feishu-gateway-test add <tgz>` → **exit 0**（预检 + 安装后检查 + boot 激活门禁全通过）；
- `dsh plugin --profile feishu-gateway-test version-exemptions` → `{}`；
- `compatibility.json` **不存在** → 从未授予任何豁免；
- 真实启动一次 headless 运行时后，插件 `apply()` 执行并写出 `stateDir/dedup.json`（见 §四），
  证明**已真正激活**而非仅组合配置。
- 启动期 `reconcileProfilePlugins` 的 `denial()` 未禁用该行。

结论：**兼容性通过，且无需/未使用 `allow-version`**；`MISSING_CREDENTIAL` 来自 LLM 适配器
（`dsh-llm-deepseek-api-key` / `dsh-llm-pi-ai`），**不是**兼容性问题。

---

## 三、完整自动化回归测试

### 3.1 命令、退出码、结果

在 `fix/gateway-reliability-idempotency` 上，修复前与修复后各执行一轮完整命令。
下表为**最终（修复后）**结果；修复前一轮在 §3.4 单独列出。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Lockfile 校验通过，无需重解析 |
| `pnpm run typecheck` | 0 | `tsc -p tsconfig.json` 无错误 |
| `pnpm run build` | 0 | `clean + tsc -p tsconfig.build.json`，生成 `lib/` |
| `pnpm run test` | 0 | **14 文件 / 113 测试全通过** |
| `pnpm run test:coverage` | 0 | 全通过；**All files 91.98% stmts / 81.86% branch / 87.07% funcs / 91.98% lines** |
| `pnpm run pack` | 0 | 产出 `dist/dsh-plugin-feishu-gateway-0.1.0.tgz` |
| `pnpm run verify` | 0 | typecheck + build + test，**113 测试全通过** |
| `pnpm run demo "你好，请介绍一下自己"` | 0 | 出站 `DSH 原生 Session 回复：...`，`processed=1`，`created=1`，`status=ok` |
| `pnpm run demo "你好" ou_stranger` | 0 | 无回复，`rejected.sender-not-allowlisted=1`，`processed=0` |

> ⚠️ `pnpm run demo` 与所有 vitest 用例使用 `MockSessionBridge`（**模拟 Agent 文本**），
> 不能作为「原生 Session 可用」的证据；见 §五。
> 首次 `pnpm install` 在 workspace-write 沙箱下因 pnpm store 锁（`/run/user/1000/...`）EACCES，
> 按批准流程以 `danger-full-access` 重试**同一命令**后 exit 0；后续均通过。

### 3.2 覆盖率（修复前 → 修复后）

| | Stmts | Branch | Funcs | Lines |
| --- | --- | --- | --- | --- |
| 修复前（98 测试） | 91.01% | 81.22% | 85.46% | 91.01% |
| 修复后（113 测试） | **91.98%** | **81.86%** | **87.07%** | **91.98%** |

新增覆盖包含 `owner-lock.ts` 92.94% stmts。

### 3.3 十项重点检查结论

| # | 检查点 | 结论 | 依据 |
| --- | --- | --- | --- |
| 1 | Inbox 原子入队与重复消息拦截 | **PASS（单实例）**；多实例共享 `stateDir` 曾重复执行，已修复 | 单测 + S1/S7（4 次同 id → 1 次执行 1 条回复）；F1 由 S6 复现并加 `.owner.lock` |
| 2 | 入站异步持久化失败时 ACK 行为 | **PASS（客户端侧）** | S5：`chmod 0o500` → `emitMessage` 抛 `EACCES`，无持久入队；`lark-transport.test.ts` 验证 handler 重抛 → SDK 发 `code:500`。**飞书服务端重推未验证** |
| 3 | JSONL 断尾恢复 | **PASS，但发现并修复一个 bug** | S4 断尾截断安全；新增测试发现「合法末行缺 `\n`」会在下次追加粘成 `}{...}` 导致随后 `open()` 抛错 → 已修复并加测试。已完成非法行仍硬失败（已文档化） |
| 4 | Outbox 并发发送 / 重连补发 | **PASS** | 单测（并发 send/drain/重复 key）+ S8（重启后同 UUID 恰好投递一次）；全局 mutex 串行 |
| 5 | UUID 跨重试 / 跨重启一致性 | **PASS（reply 路径）**；`create` 路径发现并修复 | S8 + 单测；`lark-transport.ts` 的 `create` 曾每次新生成 UUID → 已改为 `target.uuid ?? newId('fg')` 并加真实断言测试；原 `outbox.test.ts` 的「REST UUID」断言为假阳性，已改标题并注明覆盖范围 |
| 6 | Agent 超时 / 异常 / 取消后 Session 隔离 | **Mock 层 PASS；真实运行时 BLOCKED** | 集成测试（超时后下一条用新 Session）；真实运行时未驱动超时/异常/取消场景 |
| 7 | 重启后 `running → uncertain` 恢复 | **PASS，且修复了隔离不对称** | S2（`stop()`-abort 与**真实 SIGKILL 子进程**两种方式）：`running`→`uncertain`、不重放、新消息正常；S9：`pending` 会重放（不丢）。修复前 `uncertain` 不解除 Session 绑定 → 已修复并加集成测试 |
| 8 | 白名单撤销后待执行消息拦截 | **PASS（重启后重放）**；热撤销不支持 | 集成测试 `does not execute a formerly allowlisted message...`；`MessageRouter` 持有构造时快照，运行中撤销无效（已文档化） |
| 9 | 多机器人部分连接失败隔离 | **PARTIAL** | 抛错的 connect 被 per-bot try/catch 隔离 ✅；错误 `appId` 曾被无条件标记 `connected`（已修复为仅 `onReady`/`onReconnected` 才 connected）；单个 `sendText` 无硬超时仍可能队头阻塞（已文档化） |
| 10 | 关闭时连接 / 监听器 / Session 清理 | **Mock 层 PASS；真实运行时 BLOCKED** | 集成/单测验证 `transport.close`、`bridge.dispose()`、两个 `ctx.on` disposer、`AgentHandle.dispose()`；真实运行时未验证 |

### 3.4 修复前的额外故障注入（临时测试目录）

新增 `scripts/fault-injection.mjs`（独立 ESM harness，每个场景 `mkdtemp(os.tmpdir())` +
`finally` 中 `rm -rf`，不使用任何仓库真实状态目录），报告见
`research/fault-injection-report.md`。执行 3 次确定性一致。

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| S1 重复投递 / S7 快速连发 / S9 未启动 pending 重放 | PASS | PASS |
| S2 崩溃中断（stop-abort **+ 真实 SIGKILL**）→ `uncertain` 不重放 | PASS | PASS |
| S3 回复已发但 `markProcessed` 前崩溃（构造状态注入） | PASS | PASS |
| S4 JSONL 断尾 | PASS | PASS |
| S5 持久化失败 → 拒绝而非假 ACK | PASS | PASS |
| **S6 两个实例共享一个 `stateDir`** | **🐞 BUG（F1 HIGH，3/3）**：同一 `message_id` 被 **2 次 Agent 执行 + 2 条回复**；`${pid}.tmp` rename ENOENT 碰撞 | **PASS**：第二实例被 `.owner.lock` 拒绝，恰好 1 次执行；陈旧锁可被接管；无残留 tmp |
| S8 Outbox UUID / idem 键跨重启 | PASS | PASS |

最终 `node scripts/fault-injection.mjs` → exit 0、`{"PASS":9}`、0 BUG。

---

## 四、真实 Cordis / DSH 兼容性测试

### 4.1 独立 Profile 与 `.tgz` 安装

- 先备份 `~/.dsh/profiles/feishu-gateway-test/` 的配置（§2.3），未覆盖已有测试状态。
- `dsh plugin --profile feishu-gateway-test add file:<repo>/dist/dsh-plugin-feishu-gateway-0.1.0.tgz` → **exit 0**。
- `version-exemptions` = `{}`；`compatibility.json` 不存在 → **未使用任何豁免**。
- 最终 `.tgz`（含全部修复）已重新安装一次，仍 exit 0。

### 4.2 `dsh --profile feishu-gateway-test --dump-config`

**exit 0**，417 行组合树。检查结论：

- ✅ `dsh-plugin-feishu-gateway` bundle 进入 Profile（`# == dsh-plugin-feishu-gateway, patched by <test>/cordis.patch.yml`）。
- ✅ `cordis.patch.yml` 按 `id: feishu-gateway` **整体替换** config（`offline: true`、`allowlist: []`、`stateDir` 等），非深合并。
- ✅ `feishu-gateway` 行声明 `inject: [agents, agentLoop, sessions, llm]`；组合树中 `llm` / `session` / `agent` / `agent-loop` / `agent-default-model` / `llm-pi-ai` / `llm-deepseek` 等 dsh-base 行齐全。
- ✅ 模块导入：从 Profile 内 `import('dsh-plugin-feishu-gateway')` → `Config, apply, createGateway, default, inject, name`；`.../testing` → `MockFeishuTransport, MockSessionBridge, createGateway, silentLogger`；`package.json` 中 `engines.dsh`、`dsh.bundle.patch` 正确。
- ✅ 无依赖冲突、Schema 错误或版本不兼容（exit 0，无 warn/error）。
- ⚠️ **`--dump-config` 只组合配置层，不挂载插件**，不能证明激活。

### 4.3 真实运行时加载（重点）

`dsh-headless` 需要任务参数且默认缺完整 LLM 路由，实测：

| 尝试 | 结果 |
| --- | --- |
| `dsh --profile feishu-gateway-test`（裸跑） | exit 1：`dsh: a task is required` |
| `dsh --profile feishu-gateway-test "<task>"`（原样） | exit 1：`MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official" ... DEEPSEEK_API_KEY` —— 启动期即失败，插件来不及 `apply()` |

**能否安全地配置独立模型路由？** 结论：**能，且已用纯 Mock 方式实证**。做法：

1. 在 `~/.dsh/profiles/web/cordis.patch.yml` **只读**参考 `llm-pi-ai` / `agent-default-model`
   两行的结构（只取 id、包名、env 变量名，不复制/不打印任何凭据值）。
2. 在**隔离的临时 `DSH_HOME`**（`/tmp/dsh-l4-home-*`，复制一份测试 Profile）中添加按 id 的覆盖行：
   `llm-pi-ai.providers.mock-route` = `{ apiKeyEnv: FEISHU_GATEWAY_TEST_LLM_KEY, api: openai-completions, baseURL: http://127.0.0.1:18080/v1, models:[{id: mock-model,...}] }`、
   `agent-default-model` = `{provider: mock-route, model: mock-model}`；
   并把 `feishu-gateway.stateDir` 改到该隔离 home 内。
3. 起一个本地 `openai-completions` SSE Mock LLM（`.tmp/mock-llm.mjs`），设置
   `FEISHU_GATEWAY_TEST_LLM_KEY=mock-not-a-real-key`（**占位 Mock 值**）。
4. `env DSH_HOME=<隔离> ... dsh --profile feishu-gateway-test "<task>"`。

**结果：exit 0，输出 `测试成功`** —— 真实 DSH 0.2.2-rc.1 headless 运行时成功启动，
Mock LLM 收到流式请求并返回内容。并在隔离 home 中确认：

- `$L4HOME/feishu-state/dedup.json` 被写出 → 只有 `FeishuGateway.start()` 会写它，
  **证明插件 `apply()` / `ctx.effect` 在真实运行时执行**（`inject` 的四个服务真实挂载）；
- `$L4HOME/sessions/.../session-*` 目录被创建 → 原生 Session 基础设施真实工作；
- 真实 `~/.dsh/feishu-gateway-test-state` 与 `web` Profile 均**未被改动**；
- 未读取、未复用生产密钥。

> 因此 §四 的「真实运行时激活」**不是 BLOCKED**：它已用**独立、隔离、纯 Mock 的
> 模型路由**完成。若不使用该 Mock 路由、且没有独立的非生产 LLM 凭据，则按原样启动
> 仍会因 `MISSING_CREDENTIAL` 而 **BLOCKED**（生产 `MAGPIE_API_KEY` /
> `DEEPSEEK_API_KEY` 的值禁止复用）。二者不矛盾：前者是「可安全配置独立路由」的证明，
> 后者是「默认/仅生产凭据环境」下的阻塞原因。

---

## 五、原生 Session 功能测试（关键结论）

在 §四 的真实运行时之上，追加一个**测试专用 probe 插件**（仅存在于隔离 home，
`insert` 进组合树）：通过公开 `createGateway(config, { ctx, transports:[MockFeishuTransport] })`
**不注入 `MockSessionBridge`**，从而构造出真实 `DshSessionBridge` 去调用真实的
`ctx.agents.create()` / `agent.followup()` / `session/event` / `agent/assistant-stream`。
注入两条入站消息，把观测结果写入 JSON。

| 验证点 | 结果 |
| --- | --- |
| 1. `ctx.agents.create()` 建立 Session | ✅ `sessionBridge.available=true`，`boundSessions=1`，`sessions.json` 绑定 `feishu-default-oc_l4-session-*`；`session/event` 中该 id 的事件确实到达**插件级 ctx** |
| 2. 首条消息提交给 Agent 并得到回复 | ✅ **修复后**：入站消息被 splice 进 agent inbox → Mock LLM 被调用 → `assistant/message` 携带真实模型文本 → 出站 **`测试成功`**（非模拟文本），`turn/end: completed` |
| 3. 后续消息复用已有 Session 上下文 | ❌ **BLOCKED**：第二条约 `cannot append outside a SessionStore`；改为每轮 `agents.resume()` 重新挂载后，headless 测试 profile 又报 `no agent factory registered (load an agent-loop plugin)` |
| 4. `session/event` 提供最终回复 | ✅ 修复后首轮确认（`assistant/message` 事件）；`agent/assistant-stream` 14 个事件亦到达 |
| 5. `agent/assistant-stream` 不重复拼接 | ✅ 首轮只产生一条回复，未见重复文本拼接（多轮未验证） |
| 6. Agent 超时后新消息不收旧回复 | ⛔ **未在真实运行时验证**（仅 Mock 层集成测试） |
| 7. Agent 抛错后不错误复用原 Session | ⛔ **未在真实运行时验证**（仅 Mock 层） |
| 8. 卸载不残留 Listener / AgentHandle | ⛔ **未在真实运行时验证**（仅 Mock 层单测/集成测试） |

**过程中发现并修复的两个真实代码缺陷：**

1. **默认配置下原生 Session 完全不可用（严重）**：`DshSessionBridge.create()` 只在显式
   `config.agent` 路由存在时才传 `agentOptions`，而 `ctx.agents.create()` **不会**自动继承
   `agent-default-model`。实测每个 turn 以
   `agent "..." has no provider/model: set AgentOptions.provider and AgentOptions.model or record a model selection`
   结束，用户收到「模型未返回文本内容。」，消息却被标记 `done`（静默失败）。
   **修复**：未配置 `agent` 路由时从 `ctx.agentDefaultModel.currentSelection()` 取
   provider/model/reasoningEffort 填入 `agentOptions`；服务缺失/抛错时安全降级。
   加 3 个单测；修复后在真实运行时**去掉显式 `agent` 配置**重跑，首条消息仍返回真实
   模型文本 `测试成功`，`turn/end: completed`。
2. **后续消息复用缓存句柄失败**：`resume()` 在 `this.handles` 已有句柄时直接 return，
   复用已脱离 SessionStore 的 Session → `cannot append outside a SessionStore`。
   **修复**：改为每轮释放旧句柄并按 `agents.resume({resumeSessionId})` 重新挂载；加单测。
   但 headless 测试 profile 未注册 agent factory，端到端仍报
   `no agent factory registered`，**该点保持 BLOCKED**，未宣称通过。

**回答「当前 Gateway 到底能不能完整使用 DSH 原生 Session，而不是仅仅模拟 Agent 返回文本」：**

> **不能说「完整使用」，但也确实不是只模拟文本。** 修复后，首轮消息在真实 DSH 运行时中
> 走的是真实 `ctx.agents` 原生 Session，并从 `session/event` 拿到了**真实（Mock LLM 的）
> 模型回复文本**；`session/event` / `agent/assistant-stream` 的 scope 投递、`createUserMessage`
> 回退对象的兼容性也一并实证澄清。但：默认配置原本是坏的（已修），**多轮上下文复用仍失败**
> （BLOCKED），超时/异常/取消隔离与卸载清理未在真实运行时验证（BLOCKED），且
> `pnpm run demo` 与全部 vitest 用例使用的是 `MockSessionBridge`（模拟文本）。
> 真实飞书端到端亦未验证。因此结论是**部分可用、有明确缺口**，不是「完整使用」。

---

## 六、飞书真实长连接测试 —— **BLOCKED**

**阻塞原因**：环境中不存在可用的专用飞书测试应用凭据。
`FEISHU_GATEWAY_DEFAULT_APP_ID`、`FEISHU_GATEWAY_DEFAULT_APP_SECRET`、`FEISHU_APP_ID`、
`FEISHU_APP_SECRET`、`LARK_APP_ID`、`LARK_APP_SECRET` 均 **ABSENT**（只检查变量名存在性，
不打印值）；仓库中只有 `.env.example` 模板（占位 `cli_xxxxxxxxxxxxxxxx`），没有测试 App 配置。
按要求**未**从其它应用或生产服务提取凭据，故未尝试 `offline: false` 连接。

因此以下均 **BLOCKED，未声称通过**：WebSocket 连接与事件订阅、`im.message.receive_v1`、
「持久化后才确认接收」的服务端行为、私聊进入原生 Session、REST API 回复、快速连发顺序与
去重、短暂断线/恢复/Outbox 补发、授权与未授权用户差异。也未在真实环境做任何故障制造。

**需要你完成的最小配置步骤**（只列环境变量名/id，不含任何密钥值）：

1. 在飞书开放平台创建一个**独立测试企业自建应用**，开启「长连接」与
   `im.message.receive_v1` 事件订阅、发送消息权限，取得 App ID / App Secret。
2. 仅通过环境变量提供：`FEISHU_GATEWAY_DEFAULT_APP_ID`、
   `FEISHU_GATEWAY_DEFAULT_APP_SECRET`（插件只从 env 读取，日志只打印来源名）。
3. 把 `feishu-gateway-test` Profile 的 `cordis.patch.yml`（保留备份）中
   `feishu-gateway.config.offline` 改为 `false`，`allowlist` 填测试账号 `open_id`，
   `stateDir` 指向独立测试目录；`autoConnect: true`、`diagnoseOnStart: true`。
4. 如需真实 Agent 回复，另配 §四 的独立（测试专用）LLM 路由；不要复用 Web GUI 的生产密钥。
5. 启动 `dsh --profile feishu-gateway-test "<task>"`，用测试机器人私聊发送指令并观察日志与
   `stateDir` 下的 `inbox.jsonl` / `outbox.json` / `sessions.json`。

---

## 七、代码审查与自动修复

### 7.1 审查覆盖

`code-reviewer` 对 `git diff main..HEAD`（11 提交 / 22 文件 / +541-208）与当前 `src/` 做了
只读深度审查，产出 `research/review-findings.md`：16 条发现（含严重级别、file:line、复现
思路、最小修复建议）、「已正确实现的状态转换」核对、§七 关注点覆盖表、优先级列表、
以及**明确的 exactly-once 保证边界**。`runtime-compat` 产出 `research/runtime-compat.md`。
`fault-injector` 产出 `scripts/fault-injection.mjs` + `research/fault-injection-report.md`。

### 7.2 本轮实际修复（均先构造复现测试 → 最小代码 → 回归 → 文档）

| 编号 | 问题 | 最小修复 | 复现/回归测试 |
| --- | --- | --- | --- |
| F1 **HIGH** | 两个实例共享 `stateDir` → 同一消息执行 2 次；`JsonStore` 的 `${pid}.tmp` 同进程碰撞 | 新增 `src/storage/owner-lock.ts`（`O_EXCL` 独占锁 + owner 令牌 + PID/`proc` starttime 陈旧锁接管）；`JsonStore` 临时文件名改为 `<pid>.<随机实例令牌>.tmp`；`FeishuGateway.start/stop` 获取/释放 | `tests/unit/owner-lock.test.ts`（4）、`tests/unit/store.test.ts` 并发用例、集成「拒绝第二实例并允许重启」、故障注入 S6 由 BUG→PASS |
| F2 | `running→uncertain` 不解除 Session 绑定（仅超时/异常解绑），下一条消息 resume 中断的旧 Session | `start()` 恢复循环里 `registry.unbind(chatKey)`，并移到 pending 调度之前 | 集成「isolates the Session of a crash-interrupted turn」 |
| F4 | 合法末行缺 `\n` 未归一化，下次追加粘成 `}{...}` → 随后 `open()` 抛错 | `open()` 折叠后补齐结尾换行 | `tests/unit/inbox.test.ts` 新增用例 |
| F9 | 错误 `appId` 下 `WSClient.start()` 静默 no-op 却无条件报 `connected` | 仅在 `onReady`/`onReconnected` 才 `connected` | `tests/unit/lark-transport.test.ts` 新增 `suppressReady` 用例 |
| F10 | `im.message.create` 路径每次新生成 UUID，重试无幂等键 | 改为 `target.uuid ?? newId('fg')` | 新增「reuses the persisted REST UUID on the create path」；修正 `outbox.test.ts` 假阳性断言的标题与说明 |
| F11 | `stop()` 窗口内 `handleInbound` 直接 return → 静默 ACK 一条未持久化的消息 | `stopped` 时抛错，让 SDK 发非 200 | 集成「rejects inbound events after stop」 |
| **新 A** | 默认配置 `ctx.agents.create()` 无 provider/model → 真实运行时每个 turn 报错、用户拿空回复 | `DshSessionBridge.create()` 从 `ctx.agentDefaultModel.currentSelection()` 补默认路由 | `tests/unit/dsh-session-bridge.test.ts` 3 个新用例 + **真实运行时 probe 端到端验证** |
| **新 B** | 后续消息复用已脱离 SessionStore 的缓存句柄 | `resume()` 改为释放旧句柄并 `agents.resume()` 重新挂载 | 新增单测；端到端因 headless 缺 agent factory 仍 BLOCKED（如实标注） |

### 7.3 文档更新

`README.md`（单实例独占、崩溃恢复会话隔离、JSONL/出站幂等、**交付语义与保证边界**、
真实运行时/原生 Session 验证结论）、`docs/ARCHITECTURE.md`（修正「所有写操作都是 rename」
与「损坏文件都隔离」的过度表述；修正 `session/event` scope 未验证的旧结论；新增 §2.3.1
owner lock）、`docs/ROADMAP-v0.2.0.md`（新增「本次回归后仍明确存在的缺口」清单）、
`research/fault-injection-report.md`（新增 §0.1 修复后复验）、`research/TEST-REPORT.md`（本报告）。

### 7.4 明确未修复 / 保证边界（不夸大可靠性）

**不提供端到端 exactly-once。** 实际保证 = 单实例、单主机、**进程（非机器掉电）崩溃**范围内的
「Agent 最多**自动**执行一次」+「回复至少投递一次」+「**尽力而为**的外部幂等」
（20k 条上限的 `sent` 账本 + 飞书约 1 小时 `uuid` 窗口 + 稳定 `idem` 键）。

仍存在的缺口（详见 ROADMAP 新增清单）：`failed`/`uncertain` 终态且**无程序化重放/解决入口**
（用户消息可能永久卡住）；已完成非法 JSONL 行仍使 `open()` 抛错；`stateDir` 只是单机
advisory 锁而非分布式互斥；`appendFile` 未 `fsync`（掉电可能丢 `running` → 理论重复执行）；
Inbox/Registry/Outbox 无跨库事务（回复先发后 `markProcessed`，极窄崩溃窗口产生二次提示）；
白名单**热撤销**无效；Outbox `sendText` 无硬超时、`pending`/`inbox.jsonl` 无上限；
超时/取消的 `AgentHandle` 直到 `stop()` 才 dispose；入站持久化失败不体现在 `health()` 计数；
**同一原生 Session 的多轮上下文复用在 headless 测试 profile 中失败**；真实飞书服务端重推
与 >1h `uuid` 去重未验证。

---

## 八、变更清单与交付状态

**源码**：`src/storage/owner-lock.ts`（新）、`src/storage/json-store.ts`、`src/inbox/inbox.ts`、
`src/gateway.ts`、`src/channel/lark-transport.ts`、`src/session/dsh-session-bridge.ts`。
**测试**：`tests/unit/owner-lock.test.ts`（新）、`tests/unit/store.test.ts`、`tests/unit/inbox.test.ts`、
`tests/unit/lark-transport.test.ts`、`tests/unit/outbox.test.ts`、
`tests/unit/dsh-session-bridge.test.ts`、`tests/integration/gateway.test.ts`。
**脚本/报告**：`scripts/fault-injection.mjs`（新）、`research/{TEST-REPORT,review-findings,runtime-compat,fault-injection-report}.md`。
**文档**：`README.md`、`docs/ARCHITECTURE.md`、`docs/ROADMAP-v0.2.0.md`。

- 未合并 PR、未发布 npm、未使用 `allow-version`、未触碰生产凭据或业务数据。
- 测试 Profile 配置已备份于仓库内 `.tmp/profile-backup/`（`.tmp/` 为 gitignore）。
- 隔离 `DSH_HOME` 与本地 Mock LLM 仅用于验证，位于 `/tmp`，可随时丢弃；真实 `~/.dsh`
  除测试 Profile 自身的 `cordis.yml`（由 `--dump-config` 重写，已备份）与该 Profile 的
  `package.json`/lockfile（`dsh plugin add`）外无其它改动。

### 8.1 推送方式与最终状态

- 本地提交：`41b572be92b8d348f0989969bd50883094a81c43`（父提交 `75a5c3a`，21 文件、
  `+3069/-27`）。
- **`git push` 被网络阻塞**：本主机可访问 `api.github.com`（curl 200）但**无法建立到
  `github.com:443` 的 TCP 连接**（`GIT_CURL_VERBOSE` 显示卡在 `Trying 20.6.7.17:443...`，
  `git ls-remote` / `git push` 均超时）。因此改用**官方 GitHub Git Data API**（`gh api`）
  逐个创建 blob → 以父提交 tree 为 `base_tree` 创建 tree → 创建 commit → `PATCH` 分支 ref。
  经校验：API 创建的 tree SHA `efcc59e41a8a3fd24428aab3e6b296380db07129` 与本地
  `HEAD^{tree}` **完全一致**，且用 UTC 时间戳重建后 API commit SHA 与本地 HEAD **完全相同**
  （非 force、fast-forward 自 `75a5c3a`）。
- 远端 `refs/heads/fix/gateway-reliability-idempotency` 已指向 `41b572be`，本地
  `origin/fix/...` 跟踪 ref 已同步；`git status -sb` 干净。PR 仍为 **OPEN**、未合并。
- 新提交触发 CI：`verify (24)` **pass**（run `43600164941`，32s）。

---

## 九、BLOCKED 汇总

| 项目 | 原因 |
| --- | --- |
| 飞书真实长连接全部子项（§六） | 无专用测试 App ID/Secret；禁止从生产提取 |
| 原生 Session：多轮上下文复用（§五.3） | `cannot append outside a SessionStore` → 改 resume 后 `no agent factory registered (load an agent-loop plugin)`；headless 测试 profile 能力不足 |
| 原生 Session：超时/异常/取消隔离、卸载清理（§五.6/7/8） | 未在真实运行时驱动这些场景；仅有 Mock 层测试 |
| 默认、无独立模型路由时的真实运行时激活 | `MISSING_CREDENTIAL`；唯一可用 LLM 凭据是生产值，禁止复用（§四.3 已用纯 Mock 独立路由绕过此阻塞完成激活验证） |
| 飞书服务端对非 200 ACK 的重推、>1h `uuid` 去重 | 需真实租户，未验证（代码侧只做到抛错/稳定 UUID） |
