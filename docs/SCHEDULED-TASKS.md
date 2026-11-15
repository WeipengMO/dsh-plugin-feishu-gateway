# DSH 原生定时任务与执行历史（Issue #19）

> **开发分支功能，尚未实机验收。** 本文描述 `feat/scheduled-tasks` 分支为 GitHub Issue #19
> 「feat(admin): Web 后台管理 DSH 原生定时任务与执行历史」新增的能力与边界。CI 只运行
> Mock 单元/集成测试，不接入真实飞书租户或真实 DSH Host；截至本分支**没有任何真实租户
> 端到端（E2E）结论**，不得把 CI 全绿、Mock 用例或本文的验证清单当作实机 PASS。本文所有
> 原生 API 事实均来自本机已安装的 `@deepseek-ai/dsh-schedule@0.2.2-rc.1`，跨 Profile 接口
> 事实来自 [SCHEDULE-API-CONTRACT.md](SCHEDULE-API-CONTRACT.md)（该合约是设计单一事实来源，
> 本文不改动它）。§7 另附 OpenClaw 交互 / 生命周期对照参考，并明确本插件不复制其调度引擎。

---

## 1. 目标与边界

**目标**：在 DSH Web 的「飞书管理」里直接管理 **DSH 原生 `ctx.schedule` 定时任务**
（Host-wide 持久提醒），并把每次执行的结果投递到飞书，同时提供任务列表/详情、执行历史与
审计。任务的定义、重复规则、暂停/恢复/立即执行/删除、错过运行处理、以及持久投递历史，
**全部由 DSH 原生 Host 服务拥有**。

**Gateway 只做两件事**：

1. **跨 Profile 管理命令桥**：Web Admin（`web` Profile）→ `ops-control` 命令邮箱 → Gateway
   （`feishu-channel` Profile）→ `ctx.schedule`。Web Admin 不直接 RPC 调用原生 schedule 服务。
2. **飞书专用通知/投递旁路（sidecar）**：`stateDir/schedule-delivery.json` 保存
   `原生 task id → 飞书 chat 目标` 的映射，配合执行台账把结果送进飞书。**这不是第二个
   调度器**，也不保存重复规则或触发时点。

明确的不变量（与本项目一贯的设计取舍一致）：

- **不引入第二套 Cron / 定时引擎**：没有自建 recurrence 求值器、没有决定「何时触发」的
  唤醒循环或独立调度进程；重复规则只通过 `toNativeTiming()` 翻译成原生 `ScheduleTiming`
  后交给 `ctx.schedule.create/edit`。Gateway 侧唯一的周期性动作是合约 §6 的 **10 秒
  `refresh()` 心跳**（只重读原生目录 / 历史并重建读模型，**不决定触发时点**）。
- **不引入第二套 Agent / LLM 循环**：到期提醒仍由 DSH 自己在原生 Session 中唤醒，Gateway
  只观察事件、转发文本，不调用模型、不追加提示词。
- **不绕开 allowlist / 群策略**：飞书目标在命令进入时和每次投递前都要经
  `validateFeishuTarget`（`MessageRouter` 等价的当前白名单/群策略）权威复核。
- **不绕开 DSH 原生工具审批**：审批决策、Agent 沙箱、`workspace-write` 等完全由 DSH 控制；
  管理页不提供绕过入口。
- **Web Admin 不是信任边界**：Gateway 对每个命令载荷始终重新校验。

### 1.1 数据流

```text
DSH Web Profile — dsh-plugin-feishu-admin
  飞书管理 → 定时任务（SchedulePanel）
    │  GET /schedule · POST /schedule/preview
    │  POST /schedule/commands（202 queued）· GET /schedule/results
    │  ↓ 一次性命令文件 ops-control/requests/<uuid>.json（schedule ≤ 8192 B）
    ▼
跨 Profile ops-control 命令邮箱 / 结果（本机同 Unix 账户，0600，无新端口）
    │  Gateway 原子「先领取、再执行」；Gateway 始终重新校验命令
    ▼
DSH feishu-channel Profile — dsh-plugin-feishu-gateway
  ScheduleManager ── ctx.inject(['schedule']) ──▶ ctx.schedule（原生 Host 服务）
    │  create/list/view/edit/run/history/deleteInactive/deliveryLimits
    │  target: { kind:'session', sessionId }（Gateway 自有 Session）
    ▼
DSH 原生 Session（到期以 source.kind:'schedule' 的 user-role 消息触发）
    │  schedule/resolve-agent waterfall 接回 Gateway 持有的实时 Agent
    │  session/event：assistant/message · assistant/attempt · turn/end
    ▼
ScheduleManager 观察 ObservedScheduleTurn
    │  schedule-delivery.json（taskId → 飞书目标 + notify）
    │  validateFeishuTarget 重新核对白名单 / 已启用群
    ▼
DurableOutbox（幂等键 schedule:<taskId>:<messageId>）
    ▼
飞书 chat（已授权私聊 / 已启用群）
```

Gateway 另外发布**脱敏只读模型** `stateDir/ops-schedule.json`（原子写、0600、version 1）供
Web Admin 读取；`schedule/changed` emit 事件触发 `refresh()` 重建该模型。管理命令写入
`stateDir/schedule-audit.jsonl`，执行台账写入 `stateDir/schedule-runs.json`。

---

## 2. 原生 API 依据

以下均基于本机安装包（下文 `N` 代表
`/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-schedule/`）：

- `N/lib/types/index.d.ts` — `ScheduleService`、配置、`schedule/resolve-agent` 声明；
- `N/lib/types/types.d.ts` — `ScheduleTiming`、`ScheduleTargetRequest`、
  `ScheduleCatalogEntry`、投递回执与历史、错误码；
- `N/lib/index.js` — `ScheduleRuntime` 投递、`ctx.sessions.flush()`、`schedule/changed` emit、
  `source: { kind: 'schedule' }`；
- `N/README.zh.md` / `N/README.md` — 包级行为说明与「已知限制」；
- 包版本由 `N/package.json` 确认为 `@deepseek-ai/dsh-schedule@0.2.2-rc.1`。

| 原生能力 | 关键事实 | 证据 |
| --- | --- | --- |
| `ScheduleService` 管理面 | `create` / `list` / `view` / `edit` / `run` / `history` / `deleteInactive` / `deliveryLimits`（另有 `catalog()`、`remoteCreate/List/Edit/History`）。管理读与写都**不激活目标 Session**，只有投递才创建/恢复 Session。`deliveryLimits()` 返回 `{ newSessionIntervalSeconds }`。`edit` 用 `expectedUpdatedAt` 做乐观并发检测，版本不符返回 `schedule_conflict`。 | `lib/types/index.d.ts:57-240`（`create:98`、`list:104`、`catalog:115`、`view:121`、`history:127`、`run:143`、`deleteInactive:159`、`edit:177`、`deliveryLimits:78`） |
| `ScheduleTiming` 七种规则 | `after`、`at`、`every`、`daily`、`weekly`、`cron`、`rrule`。`daily/weekly/cron` 都要求**显式时区**（`UTC` 或 IANA `Area/Location`）；`weekdays` 为 ISO 周一 `1`..周日 `7`；`cron` 为五字段 Vixie 表达式；`every` 至少 60 秒。 | `lib/types/types.d.ts:279-300`；`README.zh.md:63-71, 138-141` |
| `ScheduleTargetRequest` | `session`（复用已有、未归档、非委派的 Session）、`new_once`（首次投递创建一个 Session 后复用）、`new`（每次投递新建 Session）。**本功能固定使用 `session`**：Gateway 通过 `ensureTaskSession(clientRef)` 预留自有 Session id，使 `schedule/resolve-agent` 能把恢复请求接回 Gateway 持有的实时 Agent。 | `lib/types/types.d.ts:309-343`；合约 §3、§6 |
| `ScheduleCatalogEntry` 状态 | `status: 'active' \| 'paused' \| 'ended'`（只有 `active` 有定时器义务）；`executionActive?: true` 表示最近一次投递正在复用目标 Session 中排队/运行；另有 `deliveryFloorEndsAt?`、`lastDelivery?`、`createdAt?` / `updatedAt?`。 | `lib/types/types.d.ts:394-417` |
| `schedule/changed` | `@mode emit` 事件；任务写盘提交后发出，客户端据此重读全局目录。Gateway 注册该事件 → `manager.onChanged()` → 去抖 `refresh()`。 | `lib/types/types.d.ts:553-560`；`lib/index.js:2450` |
| `schedule/resolve-agent` | `@mode waterfall` 事件：`(sessionId, next) => Promise<Agent>`，用于「通过 embedding 的拥有方恢复提醒 Session」，默认 `next()` 交回 Web Session controller。Gateway 对 `manager.isTaskSession(id)` 的返回自有实时 Agent（`ctx.agents.get(id)`），否则 `next()`。 | `lib/types/index.d.ts:13-27`；`lib/index.js:1496`；合约 §6 |
| `source.kind:'schedule'` 用户消息 | 到期提醒以 **producer kind 为 `schedule` 的 user-role 消息**进入目标 Session（单次 `[SCHEDULE REMINDER]` / 批次 `[SCHEDULE REMINDER BATCH]` 固定前缀）；变更通知也以同类消息进入相关 Session。Gateway 的 `DshSessionBridge` 据此观察并采集 `assistant/message` / `assistant/attempt` 直到 `turn/end`。 | `README.zh.md:225-273`（`README.md:225-273`）；`lib/index.js:1387,2561`；合约 §6 |
| `ctx.sessions.flush` 投递确认 | 服务依赖 `sessionPersistence` 的 `session/flush` 监听器，通过 `ctx.sessions.flush(agent.session)` 确认**持久收件箱投递**；flush 未确认即失败。Session flush 与任务回执是**两次独立提交**，因此投递语义为「至少一次」。 | `lib/types/index.d.ts:50-56`；`lib/index.js:1368,1393,2563`；`README.zh.md:280` |
| 投递历史与保留 | `history({ id, limit, before? })` 返回 newest-first 回执页（`limit` 1..100），带 `earlierRecordsUnavailable` / `earlierRecordsPruned` / `retention` / `nextBefore`。保留配置：`deliveryHistoryDays` 默认 30（1–3650 天）、`deliveryHistoryRecords` 默认 200（1–10,000 条），**追加回执时裁剪、`lastDelivery` 始终保留**；`newSessionIntervalSeconds` 默认 60（60–604,800 秒）。回执字段：`scheduledAt` / `deliveredAt` / `messageId` / `targetSessionId`。 | `lib/types/index.d.ts:29-45`；`lib/types/types.d.ts:255-260, 344-392`；`README.zh.md:55-61` |

> 原生包「已知限制」还明确：宿主必须运行才有投递；重启后**重复任务只发送最近一次错过的
> 发生时点**；删除会移除已保存历史并停止未来投递；管理范围是**整个宿主、没有任务级授权**；
> JSON 存储分页只限制响应条数，不限制存储/内存/指令字节数。见 `N/README.zh.md:275-286`。

### 2.1 本功能对原生规则的翻译

统一 `ScheduleSpec`（Web 表单、预览端点、操作命令共用）到原生 `ScheduleTiming` 的映射，
由 `src/schedule/spec.ts` 的 `toNativeTiming()` 完成，并与
`web-admin/src/schedule-spec.mjs` 保持同一套校验：

| `spec.kind` | 原生 `timing` | 备注 |
| --- | --- | --- |
| `once` | `{ kind:'at', at: { date, time, time_zone } }`（本地）或 `{ kind:'at', at: '<ISO UTC>' }`（绝对） | 显式时区 |
| `every` | `{ kind:'every', every_seconds }` | `everySeconds ≥ 60`，不涉及时区 |
| `daily` | `{ kind:'daily', daily: { time, time_zone } }` | 显式时区 |
| `weekly` | `{ kind:'weekly', weekly: { time, time_zone, weekdays } }` | 显式时区 |
| `monthly` | `{ kind:'cron', cron: { expression: '<min> <hour> <day> * *', time_zone } }` | **映射到 cron 的 day-of-month；没有该日的月份跳过** |
| `cron` | `{ kind:'cron', cron: { expression, time_zone } }` | 五字段 + 显式时区 |

输入上限：title `1..120` 字符（trim 后非空）、prompt `1..4000` 字符（trim 后非空）、
`everySeconds ≥ 60`、预览 `count` `1..10`。预览用 `Intl.DateTimeFormat` 偏移探测把本地
wall-clock 转 UTC（DST 安全、时区显式，不用固定数值偏移），在有界 horizon（≤ 366 天）
内逐日生成候选，返回前 `count` 个严格未来的 UTC ISO 时刻；纯计算、无副作用。

**本功能未使用**原生的 `after` 与 `rrule` 规则，也未使用 `new_once` / `new` 目标；表单提供
的六种规则是一层面向飞书运维的收敛视图，不是对原生能力的扩展。

---

## 3. 功能清单（对应 Issue #19 验收项）

| 能力 | 说明 |
| --- | --- |
| 任务列表 / 详情 | 读 `ops-schedule.json` 的 `tasks`：标题、规范化 spec、`timingKind` / `timeZone`、`scheduledAt` 下次触发、`status`、`executionActive`、`lastDelivery`、`target`、飞书 `delivery` 配置。按 `schedule/changed` 刷新。**不复制原生 Session 内容**。 |
| 创建 / 编辑计划 | 一次性（`once`）/ 固定间隔（`every`）/ 每日 / 每周 / 每月 / Cron 六种；wall-clock 类必须显式 `timeZone`（`UTC` 或 IANA 名）。「下次触发预览」调用 `POST /schedule/preview`，与 Gateway 侧同一算法。 |
| 执行目标与 prompt | 每个任务由 `ensureTaskSession(clientRef)` 预留一个 **Gateway 自有的原生 Session**（`target: { kind:'session', sessionId }`），prompt 作为每次触发投递的指令；到期由 DSH 在该 Session 中唤醒 Agent。`clientRef` 在 `create` 时必填，用于在原生 task id 产生前预留 Session id。 |
| 飞书投递目标 | 私聊（`p2p`，白名单用户）/ 已启用群（`group`）二选一，可选 `botId`、`senderId` 与 `notify: 'result' \| 'failure' \| 'both' \| 'none'`。`chatId` 可为 `oc_…`（chat_id）或 `ou_…`（user open_id，`p2p` 时以 `receive_id_type: 'open_id'` 发送）；群目标必须是 `oc_…`。下拉项受 `GET /state` 的已配置机器人、白名单用户与已启用群约束；当前策略会拒绝的群直接拒绝，且每次投递前再次复核白名单 / 群策略。`delivery: null` 清除配置。 |
| 运行控制 | `pause` / `resume` / `run`（立即执行，不移动下次触发）/ `delete` 需浏览器二次确认；另有 `delete-inactive` / `refresh`；`update` 可带 `expectedUpdatedAt` 做乐观冲突检测。底层只调用 `port.edit(...)` / `port.run(...)` / `port.deleteInactive()`，与原生状态保持一致。 |
| 执行历史 | **原生投递回执**（`deliveries`：`scheduledAt` / `deliveredAt` / `messageId` / `targetSessionId`）+ **Gateway 执行台账**（`runs`：状态、耗时 `elapsedMs`、`tokens`、`model`、`sessionRef`（16-hex 关联引用）、`delivered`、有界 `error` 摘要）。台账状态取自 `ObservedScheduleTurn.status`：`success` / `failed` / `timeout` / `empty`（空回复，界面按「无结果 / 跳过」展示，**不是**一个名为 `skipped` 的字段）。 |
| 错误处理 | 见 §3.1。 |
| 权限与审计 | 见 §3.2。 |

读模型整体有界：≤ 200 任务、每任务 ≤ 20 deliveries、≤ 200 runs、≤ 200 audit 条目；
文件 ≤ 1 MiB，读取时拒绝 symlink 并严格白名单化，不回显原始异常文本。

### 3.1 错误处理

- **错过的运行**：原生语义是重启后重复任务**只发送最近一次错过的发生时点**；延迟投递会
  合并错过的时点。本功能不补发、不重建历史，也不把缺口推断成成功。
- **`schedule_execution_pending`**：`run()` 在该任务已有一次执行排队、运行中，或仍处于
  **最小投递间隔（execution / delivery floor）**内时返回该状态；`newSessionIntervalSeconds`
  默认 60 秒，目录里有 `deliveryFloorEndsAt`。「立即执行」沿用同一准入，不移动下次触发。
- **Outbox 幂等键**：每次飞书发送使用稳定的 `schedule:<taskId>:<messageId>` 幂等键；
  兜底通知使用 `schedule:<taskId>:<messageId>:notice`。发送前重新走持久化 Outbox，失败
  由既有退避/drain 机制处理。
- **重复发送保护**：按 `messageId` 去重（内存 + 持久化 `schedule-runs.json` 台账），叠加
  Outbox 幂等键；原生回执本身可能因 flush/回执两次独立提交而重复，故不能只依赖它。
- **兜底通知**：`refresh()` 若发现新的原生 `lastDelivery` 在 5 分钟宽限期内没有匹配的
  Gateway run（Host 创建的 Session 事件被 scope 过滤掉时会发生），发送一条有界提示
  「任务已触发，结果在 DSH Session 中」，保证飞书侧至少有通知。
- **失败 / 空回复**：`notify` 含 `failure` 时发送有界失败通知。命令结果
  （`OperatorResult`）可附带 ≤ 200 字符的 `detail`，为稳定码 / 短文本，**不含密钥、原始
  异常正文或 prompt 文本**。

### 3.2 权限与审计

- 管理接口复用 **DSH Web 已认证会话**（`security(req, reject)`、同源/CSRF 校验）；普通
  飞书用户不能从聊天获得管理端能力。
- **Gateway 侧权威复核**：Web Admin 不是信任边界，命令载荷一律重新 `validateSpec`、
  `validateFeishuTarget`；未授权用户 / 被策略拒绝的群在投递前被拒绝。原生服务本身是
  Host-wide、无任务级授权，因此这层复核是必要的边界。
- `actor` 由服务端写入（**绝不取自请求体**），是有界标签（≤ 64 字符）。
- 每个命令向 `stateDir/schedule-audit.jsonl` 追加一条审计：`actor`、时间、`action`、
  `taskId`、`state`、`summary`（参数摘要，如 `daily 09:00 Asia/Shanghai`）——
  **从不写入 prompt 正文**，也不写飞书原始 ID、密钥、工具参数或原始异常。
- 注意：`ops-schedule.json` 的 `tasks[].prompt` **包含 prompt 文本**，因此该读模型只对
  已认证管理员会话开放，且被严格白名单化读取；它从不读取 `inbox.jsonl` /
  `outbox.json` / `sessions.json`。

---

## 4. 操作指南

> 以下描述的是页面**应当如何操作**；这些步骤尚未在真实飞书租户 / DSH Web 上复验。

### 4.1 打开页面

DSH Web 左侧栏 → **飞书管理 → 定时任务**（工作台导航项 `['schedule', '定时任务', '⏱']`，
`SchedulePanel`）。页面顶部先显示原生服务状态：若 `ctx.schedule` 未在该 Profile 挂载，
页面显示明确的「原生定时服务不可用」（`available:false` + `reason`），**不会**假装任务
存在，也不会回退到自建调度器。

### 4.2 创建每日提醒并预览

1. 点「新建任务」，填写标题（≤ 120 字符）与执行指令 prompt（≤ 4000 字符）。
2. 规则选「每日」，填本地时间（如 `09:00:00`）并**显式选择时区**（如
   `Asia/Shanghai`；也可用 `UTC`）。一次性/每周/每月/Cron 同样要求显式时区；固定间隔
   按秒计、`everySeconds ≥ 60`，不涉及时区。
3. 选「下次触发预览」（`count` 1..10），页面显示接下来若干次严格未来的 UTC 触发时刻，
   以及规则摘要。预览是纯计算，不会创建任务。
4. 选执行目标（Gateway 自有 Session 由系统预留，无需手填）与飞书投递目标：白名单内的
   私聊用户，或已启用群（`GET /state` 中可选）；设置 `notify`（结果 / 失败 / 两者 / 不通知）。
5. 保存后命令进入 `ops-control/requests/<uuid>.json`，返回 `202 queued`。**202 只表示
   已入队，不等于执行成功**；到「最近后台操作结果」或 `GET /schedule/results` 轮询最终
   `completed / rejected / not-found / conflict / error`。
6. 重启对应服务后，任务应仍在列表中（原生 Host 存储 + Gateway 投递旁路 +
   `stateDir/.owner.lock` 单实例锁），下次触发时刻保持。

### 4.3 结果如何投递到飞书

到期时 DSH 原生服务把 `source.kind:'schedule'` 的提醒消息投入该任务的 Gateway 自有
Session；`schedule/resolve-agent` waterfall 把恢复请求接回 Gateway 持有的实时 Agent。
Gateway 的 `DshSessionBridge` 采集 `session/event` 里的 `assistant/message` /
`assistant/attempt` 文本与 usage，直到 `turn/end`，形成 `ObservedScheduleTurn`。
`ScheduleManager.onScheduleTurn()` 据 `notify` 决定发送，发送前再次
`validateFeishuTarget`（当前白名单/群策略），再经 **DurableOutbox** 以
`schedule:<taskId>:<messageId>` 幂等键把（截断后的）文本发到所选私聊或群。失败 / 空回复
按 `notify` 发送有界失败通知；若 Host 创建的 Session 事件被 scope 过滤，兜底通知保证
飞书侧至少收到「已触发、结果在 DSH Session」的提示。

原生投递回执只证明**指令已进入 Session 收件箱并被持久化**（`ctx.sessions.flush`），
**不证明模型已执行完成**；真实执行结果以 DSH Session / 飞书收到的文本为准。

### 4.4 查看历史与审计

- **任务详情**：状态（`active` / `paused` / `ended`）、`executionActive`、下次触发、
  最近一次原生 `lastDelivery`、飞书 `delivery` 配置。
- **运行历史**：上半部分是原生投递回执（`deliveries`），下半部分是 Gateway 执行台账
  （`runs`：状态 / 耗时 / Token / 模型 / `sessionRef` / 是否送达 / 错误摘要）。两者按
  `messageId` 关联；原生回执与 Gateway run 不一一对应（scope 过滤时可能只有前者）。
- **审计**：`audit` 展示 actor、时间、action、taskId、状态、参数摘要；**没有 prompt 正文**。
  完整审计在 `stateDir/schedule-audit.jsonl`，读模型内只保留最近 ≤ 200 条。

---

## 5. 部署与验证 Runbook（真实 DSH 测试 Profile）

> **这是给部署者的「应验证什么」清单，不是已完成验收记录。** 下列步骤**均未在本分支
> 执行**。**CI（`.github/workflows/ci.yml`）只运行 Mock 单元/集成测试**：类型检查、构建、
> vitest、web-admin 测试与打包，不接入真实飞书租户，也不启动真实 DSH Host。因此
> **不宣称任何真实租户 E2E 验证**；Mock 测试通过不能替代本节清单。

### 5.1 隔离前提

- 使用独立的 **测试 Profile `feishu-gateway-test`**（Gateway）与一个与之配对的隔离
  Web Admin 测试 Profile（名称由部署者决定，本文档不预设）。两者必须同主机、同 Unix
  用户、指向**同一套独立 `DSH_HOME` / `stateDir`**（沿用
  [OPERATIONS-CONTROL-CENTER-V2.md](OPERATIONS-CONTROL-CENTER-V2.md) §2 的同机约束）。
- **测试 Profile 必须使用独立 `stateDir`**：绝不指向生产 `feishu-channel` 的状态目录。
  同一 `stateDir` 只允许一个 Gateway 进程（`.owner.lock`，见
  [ARCHITECTURE.md](ARCHITECTURE.md) §2.3.1）；不要同时启动两个实例争抢。
- Gateway 包**只**装进 `feishu-gateway-test`，Admin 包**只**装进配对的隔离 Web Profile；
  绝不把 Gateway 包装进 `web`，也不要覆盖生产 Profile 的安装包。

### 5.2 安装与挂载确认

沿用 README 的构建与安装形式（tarball 文件名以 `pnpm run pack` 实际输出为准，**不要
套用本分支尚未发布的版本号**）：

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack

# Gateway 只进入隔离测试 Profile
dsh plugin --profile feishu-gateway-test add "./dist/<Gateway 构建产物>.tgz"
# Admin 只进入配对的隔离 Web 测试 Profile
dsh plugin --profile <隔离 Web 测试 Profile> add "./dist/<Admin 构建产物>.tgz"

dsh --profile feishu-gateway-test --dump-config
dsh --profile <隔离 Web 测试 Profile> --dump-config
```

确认：

1. 两个 Profile 的 `--dump-config` 中没有把 Gateway 误装进 `web`，也没有改动生产
   `feishu-channel` / `web`。
2. 测试 Profile 挂载了提供 `schedule` 服务的
   `@deepseek-ai/dsh-schedule@0.2.2-rc.1`（`ctx.inject(['schedule'])` 可解析）。打开
   「飞书管理 → 定时任务」应显示 `available:true`、`reason:null`，且能读到
   `limits.newSessionIntervalSeconds`（来自 `deliveryLimits()`）。**若显示「原生定时服务
   不可用」，停止后续步骤**——不要尝试用自建调度器替代，先修复 Profile 挂载。
3. 在维护窗口分别重启测试 Profile 对应服务；已加载 JS 不会因文件更新自动热替换。

### 5.3 功能验证清单

1. **创建 + 预览 + 重启持久化**：创建一个每日 `09:00 Asia/Shanghai` 提醒，预览返回接下来
   若干次严格未来 UTC 触发点且与规则摘要一致；保存得到 `202 queued` 后轮询到 `completed`；
   重启测试 Gateway 与 Web 服务，任务、下次触发点与飞书投递配置仍在（原生 Host 存储 +
   `schedule-delivery.json` + 单实例锁）。
2. **运行控制**：依次 `pause`（状态变 `paused`、不再触发）→ `resume`（重算下次未来触发）→
   `run`（立即执行，不移动 `scheduledAt`；若落在最小投递间隔内应返回
   `schedule_execution_pending`）→ `delete`（二次确认后从目录移除、释放任务 Session）；
   核对每步与原生 `view/list` 状态一致，`update` 带过期 `expectedUpdatedAt` 应得 `conflict`。
3. **飞书投递（私聊）**：`notify: 'both'`，目标选一个**白名单内的私聊用户**，等待或
   `run` 一次触发，确认飞书收到结果文本；在「运行历史」中核对原生回执 + Gateway run
   （状态 / 耗时 / Token / `sessionRef` / `delivered`）。重复触发不应产生重复飞书消息
   （Outbox 幂等键 + `messageId` 去重）。
4. **飞书投递（群）**：把目标切到一个**已启用群**（群策略见 [GROUP-CHAT.md](GROUP-CHAT.md)），
   确认该群在当前策略下被允许、消息送达，且 `validateFeishuTarget` 每次投递前复核。
5. **未授权目标拒绝**：用非白名单用户 / 被禁用群创建或更新任务，命令应被 Gateway
   `validateFeishuTarget` 判为 `rejected`，**不产生飞书消息**，审计记录该拒绝且不含
   prompt 正文。同时确认未登录 / 跨站的管理 API 请求返回 401/403。
6. **审计**：核对 `schedule-audit.jsonl` 每条含 actor / 时间 / action / taskId / 状态 /
   参数摘要，确认没有 prompt 正文、密钥、飞书原始 ID 或原始异常文本。
7. **生产隔离**：全程检查生产 `systemctl --user status dsh-feishu-channel.service` 与
   `http://127.0.0.1:18095/health` 未变化；生产 `feishu-channel` 的状态目录未被写入，
   没有新增/删除生产定时任务，也没有第二个 Gateway 进程持有同一 `stateDir`。
8. **CI 边界**：`pnpm run verify` 全绿只说明 Mock 用例通过；本清单中任何一项真实租户
   结论都必须单独、明确标注为「真实租户验证」，不得混入 CI 报告。

---

## 6. 限制与能力缺口

- **`ctx.schedule` 未挂载**：若目标 Profile 没有提供原生 schedule 服务，页面显示
  `available:false` 与明确 `reason`（`DSH native schedule service is not mounted in this
  profile`），**不做任何回退，也不自建调度器**；此时没有「降级可用」的定时任务能力。
- **Host 创建 Session 的 `session/event` 可见性**：本功能用 Gateway 自有的 `session`
  目标 + `schedule/resolve-agent` waterfall 来接回实时 Agent，但插件级 ctx 对 Host
  创建/恢复的 Session 事件仍可能受 scope 过滤影响。因此提供 5 分钟宽限期、且在原生任务仍标记 `executionActive` 时不触发的**兜底通知**
  （只保证「已触发」提示），并明确原生投递回执**不等于模型执行完成**。该可达性是否
  完备**尚未在真实租户复验**（[ARCHITECTURE.md](ARCHITECTURE.md) §4 记录的是 headless
  运行时插件自建 Session 的事件可达性结论，不等同于本场景）。
- **每月规则**：`monthly` 映射为 cron 的 day-of-month，**没有该日的月份会跳过**（例如 31 日
  在 2 月不触发），不是「顺延到月末」。表单没有独立的 RRULE / `after` 规则入口。
- **原生投递历史的语义**：`deliveries` / `lastDelivery` 是「Session 收件箱已持久化」的
  确认（`ctx.sessions.flush`），**不是模型完成回执**；flush 与回执是两次独立提交，投递为
  「至少一次」。执行结果看 `runs` 台账与 DSH Session，不能把回执当成功。
- **原生服务为 Host-wide**：原生目录无任务级授权；本功能的越权防护来自 DSH Web 认证 +
  Gateway 侧权威复核，二者都不改变原生目录的 Host-wide 性质。
- **无真实租户 E2E**：本分支只有 Mock 单元/集成测试（合约 §7）；§5 的 runbook 是待执行
  清单，**尚未在真实飞书租户 / 真实 DSH Web Profile 完成**。历史实机验收结论
  （[ACCEPTANCE-0.2.0-rc.1.md](ACCEPTANCE-0.2.0-rc.1.md)）针对的是私聊/卡片/审批，**不覆盖
  本功能**。
- **其他沿用既有边界**：交付历史受原生保留配置与读模型有界裁剪限制；Outbox 仍是
  「至少一次 + 尽力幂等」，不提供 exactly-once；跨主机 / NFS 共享 `stateDir` 仍不在
  支持范围内。

---

## 7. 附录：OpenClaw 交互与生命周期参考（仅作设计对照，非本插件实现）

> **本节是什么 / 不是什么**：以下记录的是**另一个项目 OpenClaw** 的 automations 能力，来自
> Lead 提供的本地已核实调研资料（证据：`/home/ubuntu/openclaw-automations.json`、
> `/home/ubuntu/.openclaw/state/openclaw.sqlite`、
> `/home/ubuntu/.npm-global/lib/node_modules/openclaw/docs/automation/cron-jobs/*`，
> 以及其构建产物 `dist/src-BjYHmhrQ.mjs`）。它**只用作管理界面交互与生命周期语义的对照
> 参考**，**不是**本插件的功能或 API 说明，也不属于本仓库 CI 验证范围；左列出现的 CLI、
> 字段、状态名一律属于 OpenClaw，**不要**当作本插件的命令或字段。
>
> **明确边界：本插件不复制 OpenClaw 的引擎。** OpenClaw automations 是一套**内置 cron
> 调度器**（`openclaw automations` 是 `openclaw cron` 的别名）；而本项目 Issue #19 的
> **任务定义、状态、重复规则、投递与历史全部由 DSH 原生 `ctx.schedule` 拥有**，Gateway
> 只是跨 Profile 管理命令桥 + 飞书投递旁路（§1）。本插件**没有**自建 cron 引擎、没有第二个
> Agent / LLM 循环，也没有复制下列任何调度执行机制。**本功能尚未在真实飞书租户验证。**

### 7.1 交互形态对照

| OpenClaw（参考对象） | 本插件（仅界面 / 接口层，执行仍归 DSH 原生） |
| --- | --- |
| 管理面三处：CLI `cron add\|edit\|enable\|disable\|get\|list\|rm\|run\|runs\|show\|status`、聊天 `/loop`、Control UI「Automations」页 | 本插件**没有**这些 CLI / 聊天命令；只有 DSH Web 受保护的 `/api/feishu-admin/schedule*` 接口（[WEB-ADMIN.md](WEB-ADMIN.md)），管理动作走跨 Profile `ops-control` 命令邮箱 |
| Control UI 的 Automations / Run history 双标签页、筛选 All/Active/Paused、starter 模板、任务详情页 Active/Paused 开关 + Run now + clone/remove、inline 设置编辑、保存时冲突检测、View transcript | 「飞书管理 → 定时任务」提供任务列表/详情 + 运行历史（§3）、`pause/resume/run/delete` 控制；冲突检测来自原生 `edit()` 的 `expectedUpdatedAt`；任务状态直接读原生 `status: active/paused/ended`。合约**未规定**额外的列表筛选控件 / 模板 / transcript，读模型也**不复制原生 Session 内容** |
| 任务定义（`name`、`description`、`enabled`、`deleteAfterRun`、`configRevision`、`schedule {kind: at\|every\|cron; expr/everyMs/at; tz}`、`sessionTarget main\|isolated\|current\|session:<id>`、`wakeMode`、`payload agentTurn\|command\|systemEvent\|script\|heartbeat`、`delivery {mode, channel, to, ...}`、`failureAlert`）与运行时状态（`nextRunAtMs`、`lastRunAtMs`、`lastRunStatus ok\|error\|skipped`、`lastDurationMs`、`consecutiveErrors`、`lastDeliveryStatus`、`deliverySuppressionReason`）分离 | 任务定义 / 状态 / 历史**全部由 DSH 原生 `ScheduleService` 拥有**；Gateway 的 `schedule-delivery.json` **只**保存「taskId → 飞书 chat 目标 + `notify`」，**不是**第二份任务定义或运行时状态。执行台账 `runs` 只记录观察到的结果（状态 / 耗时 / Token / `sessionRef` / `delivered` / 错误摘要） |
| 列表 API 返回 `{jobs,total,offset,limit,hasMore,nextOffset,snapshotRevision}` 及 `deliveryPreviews`（**只预览投递目标、不发送**） | `GET /schedule` 返回脱敏只读模型 `ops-schedule.json`；`POST /schedule/preview` 预览的是**触发时点**，不是投递目标预览（两者语义不同，不可混用） |

> 上表右列的事实来自 [SCHEDULE-API-CONTRACT.md](SCHEDULE-API-CONTRACT.md) 与 §2 的已安装原生
> API；左列只是另一产品的交互参考，**不代表本插件实现了左列**。

### 7.2 生命周期 / 可靠性语义对照

以下 OpenClaw 语义值得作为**验收期望**对照，但本插件是通过 **DSH 原生能力 + 既有
DurableOutbox** 达成，不是复制其实现：

- **稳定执行栅栏**（OpenClaw：`cron-slot-v1.<base64([storeKey,jobId,scheduledSlotMs])>`
  持久幂等键）→ 本插件用 Outbox 幂等键 `schedule:<taskId>:<messageId>` + 按 `messageId`
  去重的执行台账（§3.1），**不自建 slot 栅栏**。
- **同一任务最多一个运行中 run** → 原生 `run()` 的 `schedule_execution_pending`、
  `executionActive` 与最小投递间隔（§2、§3.1）。
- **删除任务后 run 回执仍保留、重启只恢复终态结果而不重放 payload / delivery、通道发送
  结果不明确时不自动重放**（防重复消息）→ 本插件不自建回执存储；原生
  `lastDelivery` / `history()` + Gateway `schedule-runs.json` 台账 + Outbox 既有「至少一次、
  不重放 uncertain」约定。**不提供 exactly-once**（§6）。
- **错过运行可配置 catch-up（`skipMissedJobs`）** → 原生是固定语义：重启后重复任务**只发送
  最近一次错过的发生时点**（`N/README.zh.md:12`）；本功能不补发、不重建历史（§3.1、§6）。
- **连续失败退避 / failure-alert 阈值与冷却 / 失败 N 次自动停用 / 终态 run 历史保留**
  → 本插件**没有**自建退避、告警阈值或自动停用；只有
- **`NO_REPLY` 静默抑制** → 已实现：简短（≤80 字符）的 `NO_REPLY` 回复不投递飞书，该次运行记为 `skipped` 而非失败；长正文里偶然提到该令牌不会被抑制。用于「非交易日 / 无内容」等场景，避免无意义推送。
  `notify: 'result'\|'failure'\|'both'\|'none'`（含 `none` 不通知）、有界失败通知、原生保留
  配置与读模型有界裁剪（§3、§6）。这些是否增加属于后续规划，**当前未实现、未验收**。
- **飞书目标归一化 `chat:oc_…`（群）/ `user:ou_…`（私聊），可选 accountId / threadId**
  → 本插件用 `FeishuDeliveryInput` 的 `chatType: 'p2p'\|'group'` + `chatId`（+ 可选
  `botId` / `senderId`）：`ou_…` 走 `receive_id_type: 'open_id'`，`oc_…` 走 `chat_id`；
  且每次投递前经 `validateFeishuTarget` 复核白名单 / 群策略（§3）。目标形态与 OpenClaw
  的 `to` 字符串（`chat:` / `user:` 前缀 + accountId / threadId）**不同**，只借鉴「私聊 /
  群投递」这一概念，不引入其目标格式或账号 / 话题维度。

> 再次强调：以上左项是 **OpenClaw 的实现细节与经验**，用来说明我们「为什么这样设计 /
> 还差什么」；本插件的执行引擎、任务存储、状态与历史**始终是 DSH 原生 `ctx.schedule`**，
> Gateway 不复制、不内嵌、不替代它。本节**不构成**任何真实租户或真实 DSH Host 的验证结论。

---

相关文档：[接口合约（设计事实来源）](SCHEDULE-API-CONTRACT.md) ·
[架构 §2.5 定时任务桥接](ARCHITECTURE.md) · [Web Admin 定时任务接口](WEB-ADMIN.md) ·
[运维控制中心（命令邮箱与脱敏约定）](OPERATIONS-CONTROL-CENTER-V2.md) ·
[路线图 P1-7 定时任务主动通知](ROADMAP-v0.2.0.md) ·
[群聊策略](GROUP-CHAT.md) · [历史用量分析（同属开发分支的写法参考）](TOKEN-USAGE-ANALYTICS.md)。
