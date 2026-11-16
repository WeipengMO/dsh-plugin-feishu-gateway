# Issue #19 实机验收报告（9/9 通过）

> 日期：2026-11-16 · 环境：真实 DSH/飞书部署（`dsh-feishu-channel.service` + `dsh-web.service`，两者均为 `0.2.0-rc.15`）· 结论：**9 项全部通过（真实租户实机验证）**。

本报告记录 Issue #19「Web 后台管理 DSH 原生定时任务与执行历史」在**真实 DSH Host 与真实飞书租户**上的端到端验收。所有结果均来自实机操作与真实飞书 OpenAPI 回读，**不是** Mock/CI 结果（CI 结果另见 §8）。CI 全绿不能替代本报告，本报告也不改变历史实机结论的适用范围。

## 0. 环境与方法

- **Schedule 宿主**：`feishu-channel` Profile 的 `cordis.patch.yml` 显式挂载 `@deepseek-ai/dsh-schedule@0.2.2-rc.1`（`dsh-base` 默认不带）。`ctx.schedule` 可用，读模型 `available:true`。
- **Gateway / Admin**：均为已安装 `0.2.0-rc.15`（含彩色交互结果卡片、NO_REPLY 静默、慢任务回退修复、空白面板修复）。
- **飞书**：真实租户，Gateway bot 应用 `cli_a930…`；测试投递到**已授权群**「OpenClaw group session」`oc_2b961650…e0fa4bab`；负向用例使用**已禁用群** `oc_9750e181…` 与一个**非白名单用户** `ou_0000…`。
- **操作通道**：全部经 DSH Web 已认证接口 `/api/feishu-admin/schedule*`（浏览器 cookie 会话）驱动，与页面调用完全一致；不绕过 `security()`。
- **独立回读**：使用 **Gateway bot 自身** tenant token 直接读飞书 `im/v1/messages` 核对真实消息（未打印任何密钥；经 Gateway 配置的本机代理）。运维控制台的 `lark-cli` bot（`cli_a978…`）不属于这些群，不能用于本验读。
- **隔离与清理**：验收期间创建的任务均为一次性测试任务，**已全部删除**；验收结束时宿主仅保留原有 4 个生产任务，投递旁路与群消息均未残留测试配置。生产「早间/晚间新闻、A股收盘、科研文献」任务未被修改。

## 1. 验收结果总览（9/9）

| # | 验收项 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | 原生 Schedule 服务已加载，页面显示任务列表而非「原生定时服务不可用」 | ✅ 通过 | `GET /schedule` → `available:true, reason:null, limits.newSessionIntervalSeconds:60`，`tasks:4`；`schedule-panel.js` 仅在 `available:false` 时显示不可用态 |
| 2 | 创建固定间隔（每 5 分钟）任务，后台结果 `completed`（非仅 `queued`） | ✅ 通过 | 提交 `POST /schedule/commands` → `202 queued` → 轮询 `/schedule/results` 得 `state:completed, detail:"completed schedule-8b4bda1e…"`；读模型新增该任务 `every 300s` |
| 3 | Agent 只回复 `SCHEDULE_E2E_OK`，飞书收到蓝色完整结果卡片且无重复 | ✅ 通过 | 真实飞书 `im/v1/messages`:1 条 `interactive` 卡片 `om_x100b609200…`，标题 `SCHEDULE_E2E_OK`；`buildScheduleCard(..., {template:'blue'})`（`header.template=blue`）；该次触发仅 1 条，无重复 |
| 4 | 暂停/恢复/立即运行/删除，状态与历史更新，删除需二次确认 | ✅ 通过 | `pause`→`paused`（触发冻结）；`resume`→`active` 且 `scheduledAt` 前移到下一未来时刻；`run`→立即执行；`delete`→任务从读模型移除、delivery 配置与会话释放；审计逐条记录；删除按钮为两步「确认删除任务/确认删除」 |
| 5 | 执行历史：状态、耗时、Token、Session 关联、投递结果 | ✅ 通过 | run 台账：`status:success, elapsedMs:5625, tokens:10694, model:magpie/group/deepseek, sessionRef:fa042f9f4099e04f, delivered:true`；UI 历史列「状态/耗时/Tokens/模型/Session/已投递/错误」 |
| 6 | 仅回复 `NO_REPLY` 的任务：运行记录 `skipped` 且无飞书消息 | ✅ 通过 | run 台账 `status:"skipped", delivered:false`；飞书群消息计数前后不变，无新消息 |
| 7 | 重启 Profile 后任务/投递目标/下次触发保留，不立即重复推送旧结果 | ✅ 通过 | 重启 `dsh-feishu-channel.service`（pid 1139519→1149455，health `ok`，transports connected）：两测试任务 `scheduledAt` 完全不变，delivery 配置与会话保留；`outbox.sent` 30→30、群消息 3→3（无重发） |
| 8 | 已授权群能收到结果；未授权群/用户被拒绝且不产生消息 | ✅ 通过 | 已授权群收到真实卡片（见 #3）；禁用群 `oc_9750…` 与非白名单用户 → 命令 `rejected:"delivery target not allowed"`，未建任务/配置，禁用群 0 消息；审计仅记摘要（无 prompt） |
| 9 | 慢任务不出现「兜底提示+真实结果」双发；断网/重复投递不重复执行 | ✅ 通过* | 慢任务（`sleep 90`）运行 `elapsedMs:98788`，仅产生 1 条真实卡片 `SLOW_TASK_DONE`，**0 条**橙色兜底提示；run 台账 10 条/10 个唯一 messageId（0 重复），dedupe 台账 10 唯一，Outbox 0 pending |

\* 第 9 项中「断网恢复不重复执行 Agent」为**设计+单测覆盖**：Agent 执行由原生 `schedule` 时序触发，一次触发只产生一个 `messageId`，投递重试只经 DurableOutbox 以稳定幂等键重发已生成内容，绝不重新调用模型；为避免打断线上在途任务，未在生产机上人为制造断网。其余为实机验证。

## 2. 逐项证据摘要

### 第 1 项 — 原生服务加载
- `GET /api/feishu-admin/schedule` → `available:true, reason:null, limits:{newSessionIntervalSeconds:60}, tasks:4, runs:6, audit:8`。
- Profile 补丁含官方 Host 服务行 `- id: schedule / name: '@deepseek-ai/dsh-schedule'`（DSH 原生能力，非自建调度器）。
- 页面在 `available:false` 时才渲染「原生定时任务服务不可用」分支（`schedule-panel.js:534-539`）；当前为 `true`，正常显示列表。

### 第 2 项 — 创建（202 queued → completed）
- `POST /schedule/commands`（`{type:'schedule', schedule:{action:'create', clientRef, title, prompt, spec:{kind:'every',everySeconds:300}, notify:'result', delivery:{group}}}`）→ `202 queued`。
- `GET /schedule/results` 轮询到 `state:completed, detail:"completed schedule-8b4bda1e-a5f6-4095-b85f-bf3497a370e9"`。
- `nextTriggerPreview`（`/schedule/preview`）返回 `every 300s` 的未来触发点，与保存后 `scheduledAt` 一致。

### 第 3 项 — 真实蓝色结果卡片 + 无重复
- 立即 `run` → 原生 Session 被唤醒（`sessionRef` 出现、`assistant/message`→`turn/end` 事件齐全）。
- 飞书回读：`msg_type:"interactive"`，`message_id om_x100b6092009d8ca4dd5d630f14f28f1`，卡片内容标题 `SCHEDULE_E2E_OK` + 正文 `SCHEDULE_E2E_OK` + note 页脚「DSH 原生定时任务 · 自动推送」。
- 颜色：`buildScheduleCard` 默认 `blue`，`manager` 对 `success` 显式传 `template:'blue'`（失败/兜底为 `orange`）。用已安装包同代码路径复核，输出 `header.template=blue`。
- 该次触发**只产生 1 条**消息（不同 `messageId` 的下一次触发是新的合法运行，非重复）。

### 第 4 项 — 暂停/恢复/立即运行/删除
- `pause` → 读模型 `status:paused`，`scheduledAt` 冻结不再前进。
- `resume` → `status:active`，`scheduledAt` 重算为下一未来时刻（02:14:22Z → 02:15:38Z）。
- `run` → 立即执行，不移动下次触发（原生语义）。
- `delete` → 读模型任务消失；`schedule-delivery.json` 中该任务 `configs`/`sessions` 被删除（会话释放）。
- 审计逐条：`pause/resume/delete` 均 `state:completed`。
- 二次确认：`schedule-panel.js:440-445` 删除为两步（先切换 `confirmDelete`，再点「确认删除」，文案「此操作不可撤销」）。

### 第 5 项 — 执行历史字段
- run 台账示例：`{status:'success', elapsedMs:5625, tokens:10694, model:'magpie/group/deepseek', sessionRef:'fa042f9f4099e04f', delivered:true, error:null}`。
- 原生投递回执（`deliveries`）给出 `scheduledAt/deliveredAt/messageId/targetSessionId`；UI 运行历史列同 `schedule-panel.js:503-516`。

### 第 6 项 — NO_REPLY 静默
- 任务 prompt 仅要求回复 `NO_REPLY`；`run` 后 run 台账：`{status:'skipped', elapsedMs:4543, tokens:10700, delivered:false}`。
- 飞书群消息计数运行前后不变（无新消息）；`isSilentReply()` 对 ≤80 字符的 `NO_REPLY` 生效，长正文中提及该词不抑制。

### 第 7 项 — 重启恢复
- `systemctl --user restart dsh-feishu-channel.service`；4s 内 `health.status=ok`、`transports.default=connected`、`ws client ready`；pid 由 1139519 变为 1149455。
- 重启前后：`tasks 6→6`，两测试任务 `scheduledAt` **逐字节相同**，`delivery` 配置与会话均保留；`outbox.sent 30→30`、群消息 `3→3`（未重推旧结果）。
- 结论：任务定义、投递目标、下次触发由原生 Host 存储 + `schedule-delivery.json` + `.owner.lock` 持久化，重启不重放已投递结果。

### 第 8 项 — 群聊权限
- 正向：已授权群收到真实卡片（第 3 项）。
- 负向：`create` 指定禁用群 `oc_9750e181…` → `state:rejected, detail:"delivery target not allowed"`；指定非白名单用户 `ou_0000…`（p2p）→ 同样 `rejected`。二者均**未创建任务/配置**，禁用群消息数为 0。
- `validateScheduleTarget` 在命令入口与每次投递前都按当前机器人/白名单/群策略复核（`gateway.ts:874+`）。

### 第 9 项 — 慢任务 / 断网 / 重复投递边界
- 慢任务：prompt 内 `sleep 90`，实机 `elapsedMs:98788`、`tokens:21563`、`status:success`；群内仅新增 1 条 `SLOW_TASK_DONE` 卡片，**兜底提示计数 0**。机制：`maybeFallbackNotices` 在 `executionActive===true` 时跳过，且有 5 分钟宽限期（`manager.ts:795-833`），故慢任务不会被「兜底提示 + 真实结果」双发。
- 历史对照：修复前旧运行曾同时发出橙色 note「scheduled task triggered; result lives in the DSH Session」与真实结果（群内 1794761784212 与 1794761803650 两条）；当前代码路径已消除该双发（commit `0075388`）。
- 重复投递：run 台账按 `messageId` 去重（10/10 唯一）、Outbox 以 `schedule:<taskId>:<messageId>` 稳定幂等键发送、pending=0；投递重试不重跑 Agent。

## 3. 未覆盖 / 边界说明（诚实标注）

- **断网恢复**：未在生产机人为断网（避免打断在途生产任务）；以代码路径 + 单测（Outbox 幂等、messageId 去重）+ 上述重复投递台账证明「恢复后只重发已生成内容、不重复执行 Agent」。
- **>5 分钟超长任务**：为避免超长等待，慢任务用 ~99s；`executionActive` 守卫与 5 分钟宽限期对更长任务同样成立。
- **页面视觉**：数据层（API 读模型）已确认；像素级渲染请部署者在 DSH Web「飞书管理 → 定时任务」目视确认（当前 `available:true`，不会出现不可用态）。

## 4. CI（独立于实机，供参考）

`pnpm run verify` 全绿（exit 0）：typecheck + build + vitest **339/339**（31 文件）+ web-admin node 测试 **81/81** + client 语法检查。CI 不接真实租户，不能替代本报告。

## 5. 结论

Issue #19 的 9 项实机验收清单**全部通过**。DSH 原生 `ctx.schedule` 在本 Profile 正确挂载并被桥接；任务创建/暂停/恢复/立即运行/删除、结果卡片投递、NO_REPLY 静默、重启持久化、群聊权限拒绝与慢任务/重复投递边界均在真实飞书租户上验证通过，未改动生产原有任务。
