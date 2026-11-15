# 飞书管理中心 v2 — 操作后台与运维接口

**版本**：Gateway `0.2.0-rc.5`、Web Admin `0.2.0-rc.3`（测试候选）。

**定位**：DSH 左侧栏「飞书管理」是 **真实运行与配置控制台**；「设置 → 飞书 Gateway」只负责写入 App ID / App Secret。前者可以修改受控配置、执行经授权的运维操作，而不仅是展示数字。

## 1. 功能完成情况

| 优先级 | 能力 | 本版实现范围 | 边界 |
| --- | --- | --- | --- |
| P0 | 实时任务 | 运行中任务引用、所属机器人、阶段与耗时；点击确认后取消 | 不展示会话内容，不开放任意进程终止 |
| P0 | Session 管理 | 原生 Session 绑定列表、首次/最近活动、持久化与活跃关联 | 不复制 DSH Session 内容；解除绑定 / 清除记录尚未开放 |
| P0 | 消息投递 | 入站/任务/出站事件相关联的消息生命周期、队列计数、确认后触发安全 Outbox drain | **不重放 uncertain Agent turn**；永久失败沿用 Outbox 不补发规则 |
| P0 | 审批审计 | approval/request 的请求与最终结果事件、所属 Session 匿名引用 | 只有事件状态，不记录审批工具参数、聊天正文、审批者标识；不会绕开 DSH 原生 ask |
| P0 | 日志诊断 | 有界结构化事件、WebSocket 连接、重连/失败计数、最近连接时间、快照新鲜度 | 不是 `journalctl` 全量日志，也不暴露未脱敏报错 |
| P1 | Token 使用 | 已有 DSH usage 按模型/机器人/日期汇总，纯浏览器图表 | 仅最近审计窗口已上报 usage 的任务；不能当作历史总费用账本 |
| P1 | 告警 | 健康快照过期、Gateway degraded、Outbox 堆积、机器人未连接的规则告警 | 目前为**管理页本地告警**，未建立离线主动飞书推送 |
| P1 | 可编辑配置 | 模型路由、工作目录、机器人列表、授权白名单、卡片开关、重试与超时、连接开关、受控重启 | 原有托管配置使用修订号防覆盖；**重启后生效**，系统会显示 pendingRestart |
| P2 | DSH 自动化、群聊隔离、飞书 Docs/Wiki/Bitable | 本次仅保留扩展规划与安全契约 | **未接入这些外部能力，不展示假可用按钮** |

## 2. 设计架构

```text
DSH Web Profile — dsh-plugin-feishu-admin 0.2.0-rc.3
 ├─ DSH Sidebar / Main（原生 Slot）
 ├─ DSH Settings：飞书 Gateway 仅写入凭据
 └─ 已认证 /api/feishu-admin/
      ├─ GET  state / health / diagnostics
      ├─ GET  ops / ops/events
      ├─ POST ops/commands   ← 管理员确认
      ├─ PUT  config         ← expectedRevision 并发保护
      ├─ PUT  credentials    ← 写入但不回显
      └─ POST restart        ← 交互二次确认
                 │
                 │ 本机同 Unix 账户；0600 文件；无外部管理端口
                 ▼
~/.dsh/feishu-channel-state/
 ├─ ops-runtime.json              ← 每 10 秒匿名运行快照
 ├─ ops-events.jsonl              ← 结构化脱敏事件（2 MiB 阈值轮转）
 └─ ops-control/
     ├─ requests/<uuid>.json      ← Web Admin 一次性命令
     ├─ processing/<uuid>.json    ← Gateway 原子领取后，不再重放
     └─ results/<uuid>.json       ← 最多 500 个操作结果
                 ▲
                 │ Gateway 拥有状态目录独占锁
DSH feishu-channel Profile — Gateway 0.2.0-rc.5
 ├─ Feishu WS / CardKit / Session Bridge / DSH 原生审批
 ├─ Inbox/Outbox/SessionRegistry（现有持久化存储，不迁移）
 ├─ OpsTelemetry（纯系统运行事件）
 └─ OpsCommandMailbox（仅 cancel-task / retry-outbox）
```

**两 Profile 必须位于同一台主机、以同一 Unix 用户运行，并指向同一状态目录**。本版本不支持跨服务器的远程管理员操作。

## 3. 后台真实操作

### 3.1 取消运行中任务

1. 进入「飞书管理 → 实时任务」；检查机器人、匿名任务引用和阶段。
2. 仅运行中阶段有「取消任务」操作。点击后浏览器弹出明确确认。
3. Web Admin 经过原有 DSH 会话鉴权、Origin/CSRF 检查，将经过校验的 `{type:"cancel-task",ref:"<16 位哈希>"}` 写入一次性命令队列。
4. Gateway 用原子 rename **先领取，再执行**；只允许与当前内存活跃任务唯一匹配的引用，复用原来的 `requestCancel`，会同时撤销该任务未决审批并请求 DSH 原生 Agent 取消。
5. 管理页先显示「已提交」，在「告警中心 → 最近后台操作结果」检查最终 `completed/not-found/rejected/error`。

**已执行的外部工具可能具有不可逆副作用，取消不等于撤销。** 管理员取消不会影响其他聊天。

### 3.2 安全 Outbox 补发

在「消息投递」有待发队列时，点击「触发 Outbox 安全补发」，再次确认。该操作仅调用现有 `DurableOutbox.drain()`，沿用每条消息原来的 UUID/幂等及永久错误保护。**绝不调用新的 Agent turn，也不会自动重试 uncertain Inbox 记录**。

如果 Gateway 进程未运行，命令可能因超过 30 秒有效期而被拒绝；不能将 HTTP `202 queued` 理解成执行成功。Gateway 崩溃导致 processing 文件残留时，命令**不自动再次执行**；应先人工确认实际状态。

### 3.3 修改配置

「飞书管理 → 高级配置」保留可写入的模型、机器人、白名单、开关、超时、重试和重启功能。其他页面顶部也有「配置管理」入口，机器人/安全页可以直接跳转到相应配置标签。

- 修改配置通过 `PUT /config`，携带 `expectedRevision`，如被其他管理员修改会拒绝覆盖。
- `admin-config.json` 使用原子文件替换及 0600 权限；只覆盖受允许的字段。
- 管理页提示**配置已保存但未应用**；重启前先检查是否有任务在执行。
- 「重启飞书通道」必须经浏览器确认；后端只允许指定的 systemd 用户服务。
- `App Secret` 只能在「设置 → 飞书 Gateway」更新，写入受限文件，不可通过 API 查询原文。
- DSH 原生审批 `ask`、工作区权限和 Agent 沙箱不会因后台操作被暗中修改。

## 4. 数据与隐私设计

所有运行明细来自**新生成的匿名操作 DTO**，而不是从历史私人存储文件原样拼接：

- 任务 ID 与原生 Session ID 转换为 SHA256 前 16 位，用于界面关联。**这不是鉴权凭据**。
- 事件只允许 `kind`、枚举状态、时间、合法机器人别名、匿名引用、经校验的模型名称、已上报 Token、任务耗时。
- 不记录用户 open_id、chat_id、聊天文本、工具参数、目录路径、密钥、任意异常字符串和 stdout/stderr。
- `ops-events.jsonl` 每隔若干次写入检查大小；超过 2 MiB 后只保留最近 1,000 条。管理 API 最多读取 200 条，不能保证完整历史账单。
- `ops-runtime.json` 每 10 秒心跳更新；超过 15 秒视为过期，不能继续把旧任务标为“正在运行”。
- 本机运维文件权限为 0600；管理员 API 仍走 DSH Web Session 验证与跨站请求拦截，无新监听端口。
- 操作结果最多保留 500 条；异常日志不含敏感详情，详细排错仍需服务器原生日志。
- **模型用量仅复用 DSH 已有 usage 事件**，所有管理图表和接口均不发起额外 LLM 调用，不增加提示词 Token。

## 5. 管理 API 合约

所有端点位于既有 `/api/feishu-admin`，必须通过 DSH Web 浏览器认证：

| Method | Path | 内容 |
| --- | --- | --- |
| GET | `/ops` | `{snapshot, events, summary, commands, telemetryAvailable}` 的脱敏工作台数据 |
| GET | `/ops/events?kind=task&limit=50` | 类型筛选、有上限的只读事件查询 |
| POST | `/ops/commands` | 只能 `{type:"cancel-task",ref:"..."}` 或 `{type:"retry-outbox"}` |
| PUT | `/config` | 现有托管配置并发更新（不变） |
| POST | `/restart` | 现有固定 systemd 服务重启（不变） |

POST 必须有 `content-type: application/json` 与 `x-dsh-feishu-admin: 1`，通过原有 Cookie + Origin/Fetch-Site 验证。返回 `202 queued` **不是成功执行**。查看命令结果需重新读取 `/ops`。

## 6. 安装与升级

> 不要在有在途重要任务时升级。先备份 Profile 与状态目录，特别是 Session、Inbox、Outbox、凭据文件。备份不得提交 GitHub。

```bash
cd /path/to/dsh-plugin-feishu-gateway
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run verify
pnpm run test:coverage
pnpm run pack

# Gateway 只安装在 feishu-channel Profile
dsh plugin --profile feishu-channel add "$PWD/dist/dsh-plugin-feishu-gateway-0.2.0-rc.5.tgz"

# Admin 只安装在 web Profile
dsh plugin --profile web add "$PWD/dist/dsh-plugin-feishu-admin-0.2.0-rc.3.tgz"
```

在维护窗口由有权限的操作者分别重启 Gateway 与 Web Profile 对应服务，避免误启动两个网关实例争夺状态目录。现有 `streamCards`、`approvalCards`、`ask`、模型路由及凭据均继承原配置，本次**没有迁移或清空它们**。

升级后检查：

1. 左侧栏有「飞书管理」，原设置页只含 Gateway 凭据。
2. `GET /ops` 在管理员登录状态下返回 `telemetryAvailable:true`；无登录时拒绝访问。
3. 发送无敏感内容的测试消息，任务状态由 running 进入 done，Session 绑定和消息事件出现。
4. 在无副作用测试任务上验证取消；查看结果，不能把排队 202 当成 completed。
5. 模拟待发 Outbox 的网络失败，通过安全补发验证 UUID 复用；不允许重放 uncertain。
6. 断开并恢复飞书 WS，检查状态、重连次数与快照是否及时更新。
7. 验证模型与白名单保存、pendingRestart 提示、重启后生效，确保凭据不可回显。
8. 管理日志中不包含对话正文、工具参数、open_id 或 Secret。

真实租户/CardKit 操作与完整 DSH UI 验收**不属于 CI 的自动化范围**。没有运行实测，不得宣称实机 PASS。

## 7. 下一阶段：P2 扩展，不虚构已完成能力

- **DSH 定时任务**：连接 DSH 原生 Automation/Scheduler 的只读能力和任务结果目标绑定，不另建 cron 引擎。必须先核对稳定的 DSH API 契约。
- **多用户/群聊**：独立的 Bot/Chat/User 安全隔离策略、提及/话题分流、群授权和跨会话审批审计；默认继续拒绝不受支持的群场景。
- **飞书 Docs/Wiki/Bitable**：独立的能力适配器、作用域授权、租户权限回收与审计，不复用 Gateway 机器人的高权限 Secret 任意访问用户文档。
- **通知中心**：明确配置通知机器人、目标 Open ID、告警去重/节流、离线缓存和静默时段；当前告警只显示在后台，**不主动通知**。
- **长周期统计**：如果未来需要月度费用和 token 历史，应建立单独的聚合存储与可配置保留周期，而不是让有限期事件日志承担账本角色。

遵循「适配器 + 可版本化 DTO + 原生 DSH Slot + 最小权限」逐步扩展，不修改 DSH Core、不在 Web 进程创建第二个 Agent 或 LLM。
