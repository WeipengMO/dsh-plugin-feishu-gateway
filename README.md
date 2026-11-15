# DSH Feishu Gateway

将飞书 / Lark 私聊接入 **DSH 原生 Session / Agent** 的独立 Cordis 插件；配套 Web Admin 提供通道状态和配置管理。没有第二套 Agent 或 LLM 服务，也不要求修改 DSH Core。

**当前 Gateway：`0.2.0-rc.7` · Admin：`0.2.0-rc.7`** · DSH `>=0.2.2-rc.1 <0.3.0-0` · Node.js `>=24.9.0`

> **2026-11-15 实机验收结论**：原生 Session 复用、飞书消息收发、`/cancel`、CardKit 流式卡片与取消按钮、原生 `allowed-once` / `rejected` 工具审批，在现有单用户飞书私聊部署中通过。此处的实机结论来自部署侧记录，不等于 CI 自动验证真实租户。见 [0.2.0-rc.1 验收快照](docs/ACCEPTANCE-0.2.0-rc.1.md)。

## 部署架构与隔离

| DSH Profile | 只安装 | 作用 |
| --- | --- | --- |
| `feishu-channel` | `dsh-plugin-feishu-gateway` | 飞书 WebSocket、消息路由、持久化、原生 Session、卡片与审批 |
| `web` | `dsh-plugin-feishu-admin` | DSH Web「飞书通道」设置和受保护管理 API；**不运行 Gateway** |

飞书专用身份与记忆隔离需要 **Gateway `0.2.0-rc.7` 和 Web Admin `0.2.0-rc.7`**；只升级 Web Admin 会显示运维遥测不可用（旧版 Gateway 不产生匿名事件）。不要把 Gateway 安装进 `web`；升级后的客户端热加载不保证 Web 服务端代码也已换代，服务端仍缓存旧代码时可能对新增字段返回 400。应在确认维护窗口并保存状态后重启相应服务，然后验证配置读写。

持久化的 **Inbox、Outbox、Session 绑定**和环境变量凭据在升级时保留，不要清空 `stateDir`。同一 `stateDir` 只允许一个 Gateway 进程持有。

## 已实现

- 飞书长连接和白名单私聊、收发消息、去重与持久化 Inbox/Outbox、崩溃后保守恢复。
- 通过 DSH `ctx.agents` 创建、复用和恢复原生 Session；不另建模型/工具执行引擎。
- `/help`、`/status`、`/cancel`、`/new` 私聊控制命令；`/cancel` 不回滚已经执行的外部操作。
- 入站纯文本型 `post` 富文本；可选 `post/md` Markdown 回复。图片和文件双向传输仍未实现。
- DSH Web 管理面板：白名单、模型、机器人、回复格式、凭据写入、通道健康和独立服务重启。
- **飞书运维控制中心（Gateway rc.7 / Admin rc.7）**：DSH 左侧栏可查看实时任务、消息生命周期、Session 绑定、原生审批审计、Token 用量、连接诊断与本地告警；确认后取消正在执行的任务或触发安全 Outbox 补发，并可以在高级配置里修改机器人、模型、白名单、审批卡片、重试和连接参数。Settings → 飞书 Gateway 只管理写入凭据。通过同机私有运维事件/命令队列与现有 DSH 认证 API 协作，不新增 Agent / LLM 调用。详见 [完整操作手册](docs/OPERATIONS-CONTROL-CENTER-V2.md)。
- **飞书独立身份与记忆管理（rc.7 / rc.7）**：飞书管理 → Agent 档案，采用双栏文件导航与专注 Markdown 编辑器（源码行号、当前行高亮、Markdown 语法着色、光标位置、空格缩进），以编辑/预览/版本历史/加载配置标签页切换（参考 OpenClaw 的 Files 操作方式）；支持 SOUL/IDENTITY/USER/TOOLS/MEMORY/AGENTS.md 及按日记忆的编辑、历史版本、恢复、加载开关与上下文字节预算。复用 DSH 原生 AGENTS.local.md 指令加载，保存后新 Session 生效，保留用户原有本地规则，不增加额外 LLM 调用。飞书 Session 使用独立 cwd，**不会再将飞书档案写入普通 DSH 工作目录**。旧共享托管区块支持备份后明确确认清除，旧飞书会话需 /new 切换。详见 [Agent 隔离与迁移手册](docs/AGENT-PROFILE-ISOLATION.md) 和 [档案管理手册](docs/AGENT-PROFILE-MANAGER.md)。
- 可选 CardKit 流式任务卡片、取消按钮、DSH 原生工具审批卡片。**0.2.0-rc.2 起，Card 模式成功时直接在原卡片显示最终完整答案与模型/Token/速度/用时底栏，不再额外发送相同的文本；完成后取消按钮自动消失。`0.2.0-rc.3` 起，底栏按行展示模型、**Token 总用量**、速度和用时；速度根据 DSH 已有的输出 Token 与流式生成时长计算，不额外请求模型，缺少有效时长则隐藏速度。`0.2.0-rc.4` 起，底栏使用 **12px 灰色辅助信息**，与原样的回答正文形成视觉区分。** 如卡片创建/更新失败或超出卡片大小限制，回退到 DurableOutbox 文本回复。
- **定时任务（Issue #19，开发分支）**：「飞书管理 → 定时任务」桥接 DSH 原生 `ctx.schedule` 任务（一次性 / 间隔 / 每日 / 每周 / 每月 / Cron，显式时区与下次触发预览），经跨 Profile `ops-control` 命令邮箱下发；Gateway 只做管理命令桥与飞书投递旁路（`schedule-delivery.json`），执行结果经 Outbox 投递到已授权私聊 / 群，并提供原生投递回执 + 执行台账（状态 / 耗时 / Token / Session 引用 / 错误摘要）与审计。不另建 Cron 引擎或 Agent / LLM，不绕开白名单、群策略与 DSH 原生工具审批。详见 [定时任务功能说明](docs/SCHEDULED-TASKS.md)。

## 当前已验收的运行配置

| 设置 | 值 |
| --- | --- |
| `streamCards` | `true` |
| `approvalCards` | `true` |
| `streamIntervalMs` | `800` |
| `approvalTimeoutMs` | `90000` |
| `feishu-channel` 的原生审批插件及 preset | **`ask`** |
| Agent 沙箱 | **`workspace-write`**；正常工作区内工具无需逐次审批 |
| 触发审批的操作 | 需要提升沙箱权限并触发 DSH 原生 `approval/request` 的操作 |

源码中的两个卡片开关**默认仍为 `false`**，上述 `true` 是此次部署的显式管理配置，不是全局默认变更。审批决策由原生 DSH 控制：只授权当前请求的 `allowed-once`，拒绝或超时不放行；卡片只是入口，不能绕过原生策略。审批卡片仅显示工具名称，**不展示完整命令参数**，不要在不了解操作内容时盲目授权。

**本分支（rc.9 → rc.11）：**rc.9 修复了 `https-proxy-agent@5` 的 CommonJS 导入错误（Gateway 启动即崩溃），并在 CI 中增加 ESM 运行时导入冒烟检查；rc.10/rc.11 在此基础上优化代理配置流程——可在 **DSH Web → 飞书管理 → 模型与配置 → 网络代理** 直接输入/测试/保存代理地址（含认证代理，地址明文显示、不做遮挡，也不再需要填写环境变量名），支持从旧环境变量文件一键导入、清除与「保存并重启飞书通道」，无需再手工编辑 Linux 配置文件。代理 URL 保存在 `stateDir/network-proxy.json`（0600），任何 API、页面和日志都不回显原文。详见 [代理配置流程](docs/PROXY-CONFIG-FLOW.md) 与 [可靠性及代理部署说明](docs/RELIABILITY-AND-PROXY.md)。

操作说明：[审批与流式卡片](docs/APPROVAL-STREAMING.md) · [Web Admin](docs/WEB-ADMIN.md) · [飞书通道](docs/FEISHU-CHANNEL.md)。

## 构建、验收与安装

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run test:coverage
pnpm run pack
```

当前发布版的两个安装包：

- `dist/dsh-plugin-feishu-gateway-0.2.0-rc.13.tgz`
- `dist/dsh-plugin-feishu-admin-0.2.0-rc.13.tgz`

首次安装时分别安装到各自 Profile；已装旧版 Gateway 的用户需要**同时升级 Gateway 与 Web Admin**（rc.10 的管理端 API 依赖新的管理服务端）。不要把 Gateway 安装到 Web：

```bash
dsh plugin --profile feishu-channel add "./dist/dsh-plugin-feishu-gateway-0.2.0-rc.13.tgz"
dsh plugin --profile web add "./dist/dsh-plugin-feishu-admin-0.2.0-rc.13.tgz"
dsh --profile feishu-channel --dump-config
dsh --profile web --dump-config
```

**rc.9–rc.12 的代理配置界面与 Issue #19 定时任务页面尚未在真实 DSH Web/飞书租户复验**；先使用隔离测试环境验证 CONNECT 预检、保存/清除/导入与重启流程，再安排生产升级。**安装命令本身不代表运行服务已更新。** 应检查实际 DSH Host / Web 服务端已重启加载新包、通道已连接、Web 配置保存成功。不可在未安排维护窗口时随意重启有在途任务的服务。

GitHub [CI](.github/workflows/ci.yml) 执行类型检查、构建、Mock 单元/集成、安全测试、覆盖率与打包；**CI 不接入真实飞书租户**。历史实机验收记录见 [0.2.0-rc.1 验收快照](docs/ACCEPTANCE-0.2.0-rc.1.md)，卡片行为见 [0.2.0-rc.2 交付说明](docs/CARD-DELIVERY-0.2.0-rc.2.md)，新版底栏参见 [0.2.0-rc.3 说明](docs/CARD-FOOTER-0.2.0-rc.3.md)；灰色小字见 [0.2.0-rc.4 说明](docs/CARD-FOOTER-0.2.0-rc.4.md)；运维工作台见 [rc.5 操作手册](docs/OPERATIONS-CONTROL-CENTER-V2.md)；身份与记忆管理见 [rc.6 操作手册](docs/AGENT-PROFILE-MANAGER.md)。

## Issue #17：历史 Token 用量分析（开发分支）

新增独立的每日脱敏用量账本，支持历史日历热图、可切换时区的趋势、模型/机器人/用户/聊天/Session 筛选及聚合 CSV；原有滚动审计不承担历史统计。缺失 usage 的任务单独显示，不填造 0。Gateway 环境变量 DSH_FEISHU_USAGE_RETENTION_DAYS 可设置 7–730 天的留存期（默认 365）。部署和验收步骤见 [历史用量分析说明](docs/TOKEN-USAGE-ANALYTICS.md)。此项目前位于 Issue #17 开发分支，尚未经真实飞书租户验收或正式发布。

## Issue #19：DSH 原生定时任务与执行历史（开发分支）

在「飞书管理 → 定时任务」新增 Web Admin 页面：桥接 DSH 原生 `ctx.schedule` 定时任务，把执行结果投递到已授权的飞书私聊或群，并提供执行历史与审计。任务定义、重复规则、暂停/恢复/立即执行/删除与持久投递历史**全部由 DSH 原生 Host 服务拥有**，Gateway 只做跨 Profile 命令桥与飞书投递旁路，不另建 Cron 引擎、Agent 或 LLM。功能说明、接口与验证清单见 [定时任务功能说明](docs/SCHEDULED-TASKS.md)。此功能位于 **Issue #19 开发分支（P2）**，尚未经真实飞书租户 / DSH Web 复验或正式发布；CI 仅运行 Mock 测试，不能当作实机 PASS，也不改变上文 rc.11 发布版与历史实机验收结论。

## 安全边界与剩余工作

私聊只接收白名单 `open_id`；默认拒绝群聊；App Secret 通过环境变量注入且 Web Admin 不回显。部署时请保护 `~/.dsh/feishu-channel.env` 和 `stateDir`，并维持最小权限。

**仍待实机验证**：审批超时、重复点击、审批中取消、陌生人或跨聊天卡片点击（已存在模拟/集成测试，不能替代真实租户）。**已知问题**：飞书 WebSocket 初次握手失败可能无法自行恢复，需要健康看门狗/重连兜底。本地规则监控已上线候选版；主动飞书告警通知与 WS 自动恢复仍需后续开发。

更多文档：[架构](docs/ARCHITECTURE.md) · [兼容性](docs/COMPATIBILITY.md) · [飞书开发者后台](docs/FEISHU-APP.md) · [测试 Harness](docs/E2E.md) · [后续路线图（含历史计划）](docs/ROADMAP-v0.2.0.md)。

开发早期的完整调查和测试过程保留在 [research/](research/) 与 [历史 README](docs/archive/README-v0.1.0-history.md)，请勿把其历史状态当作当前验收结论。

MIT License。


### Group chat policy (Issue #18)

Group chats default to disabled. Configure the allowed group IDs, trusted sender open_ids, @only/auto replies and native Session isolation from **飞书管理 → 群聊管理**. See [Group chat guide](docs/GROUP-CHAT.md) for permission requirements and operational notes.
