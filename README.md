# DSH Feishu Gateway

让飞书机器人直接使用 **DSH 原生 Agent、Session、模型和工具**，并在 DSH Web 中管理聊天、任务与运行状态。Gateway 负责消息与执行，Web Admin 负责可视化管理；不需要另建 Agent 服务。

> **版本说明**：本分支的源码版本以 [Gateway package.json](package.json) 和 [Web Admin package.json](web-admin/package.json) 为准。开发分支、npm 已发布版以及服务器实际安装版可能不同；请勿混用不同版本的安装包。会话管理第三轮 UI 与删除操作可查看 [PR #41](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/pull/41)，状态以 GitHub 为准；请在测试环境验证后再部署。

## 能做什么

- **飞书聊天**：私聊与受控群聊、@ 触发、成员权限、按聊天隔离上下文、`/new`、`/cancel` 等命令。
- **原生对话**：由 DSH 保存 Session 和历史；飞书端恢复上下文，后台可查看历史与关联、归档及（运行时支持时）恢复。
- **任务和审批**：流式卡片、任务取消、DSH 原生工具审批、结果通知。
- **自动化**：管理 DSH 原生定时任务，并把执行结果推送到授权的飞书聊天。
- **管理后台**：模型与备用模型、机器人/群聊权限、Agent 档案、Token 用量、消息投递、代理及运行诊断。
- **可靠性**：持久化 Inbox/Outbox、消息去重、保守重试与重启恢复；不自动重放可能已经产生副作用的任务。

**手动永久删除通过可选的 `@michengai/dsh-archive-manager` 提供**（安装于 DSH Web `web` Profile）；没有安装时「删除」按钮保持灰色，其他功能正常运行。自动永久删除和按期限物理清理尚未实现（[Issue #37](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/issues/37)）；图片/文件双向传输也不应视为已实现。**归档和解除飞书关联均不会删除 DSH 对话内容或回收其磁盘空间。**

## 快速开始

环境要求：Node.js `>=24.9.0`、匹配 `package.json` 中 `engines.dsh` 的 DSH、pnpm，以及一个配置了机器人和长连接事件的飞书应用。

| DSH Profile | 安装包 | 用途 |
| --- | --- | --- |
| `feishu-channel` | `dsh-plugin-feishu-gateway` | 常驻 WebSocket、原生 Agent/Session、消息与定时任务投递 |
| `web` | `dsh-plugin-feishu-admin` | DSH Web 侧栏「飞书管理」和受认证保护的管理 API |

**两个插件必须装在各自的 Profile；不要把 Gateway 安装到 `web`。**

在仓库根目录构建并安装**当前检出的源码版本**：

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack

GATEWAY_VERSION=$(node -p "require('./package.json').version")
ADMIN_VERSION=$(node -p "require('./web-admin/package.json').version")
dsh plugin --profile feishu-channel add "./dist/dsh-plugin-feishu-gateway-$GATEWAY_VERSION.tgz"
dsh plugin --profile web add "./dist/dsh-plugin-feishu-admin-$ADMIN_VERSION.tgz"

dsh --profile feishu-channel --dump-config
dsh --profile web --dump-config
```

**安装包更新不等于常驻服务已重启加载。** 首次配置飞书 App ID/Secret、白名单、权限、长连接和系统服务的完整步骤见 **[首次部署](docs/GETTING-STARTED.md)**。已经部署过的用户请直接阅读 **[升级和运维](docs/OPERATIONS.md)**。

## 管理界面怎么用

在 DSH Web 左侧打开 **飞书管理**：

| 入口 | 管理内容 |
| --- | --- |
| 总览 | Gateway 连接状态、运行摘要 |
| 会话与消息 | **会话管理**、实时任务、消息投递 |
| 定时任务 | 创建、暂停、运行、删除任务及查看执行历史 |
| 接入与权限 | 机器人、群聊、成员白名单和工具执行策略 |
| Agent 档案 | 飞书专用身份、指令、记忆文件与历史版本 |
| 用量与审计 | Token 统计、模型用量与工具审批记录 |
| 运维与诊断 | 告警、连接和结构化日志 |
| 模型与连接 | 主模型、多个备用模型、代理和消息卡片选项 |

「会话管理」包含**对话历史 / 已归档 / 飞书聊天关联**，支持对历史执行单条或多选「归档」，以及对已归档历史多选「恢复 / 删除」（单次最多 20 条）。删除需要可选的 `@michengai/dsh-archive-manager` 扩展接口，没有安装时保持灰色；所有确认统一在后台页面内弹窗。90 天自动归档需手动启用，自动永久删除保持关闭。详见 [会话管理说明](docs/SESSION-CENTER-UX.md)。

飞书聊天内可使用 `/help`、`/status`、`/new`、`/cancel`、`/models` 等命令。模型目录以 **Gateway 所在 DSH Profile** 为准，详见 [飞书命令与模型](docs/FEISHU-CHANNEL.md)。


> **可选增强**：永久删除已归档 DSH 对话需要在 **`web` Profile** 安装并启用 `@michengai/dsh-archive-manager`。没安装时「删除」按钮为灰色，归档、恢复和飞书消息功能不受影响。具体步骤见 [会话管理指南](docs/SESSION-CENTER-UX.md)。

## 安全与升级原则

- 飞书私聊只允许授权的 `open_id`；群聊默认关闭，需要显式配置策略和成员白名单。
- App Secret 仅由受控环境变量或管理端写入，不能进入 Git；Admin 不回显。
- Gateway 与 Web Admin 在同机同用户部署时协作，**同一状态目录只允许一个 Gateway owner**。
- 正在执行、等待审批、存在未投递消息或被活动定时任务引用的会话，不得通过后台强制执行破坏性清理。
- 提交到 GitHub 或 CI 通过不会更新服务器进程；升级前先保存状态并安排维护窗口。

本仓库有历史真实部署验收记录（例如定时任务 9/9），但 **GitHub CI 主要使用 Mock 与本地安全测试**，不能直接证明每个新分支都已通过真实租户与 DSH Web 的端到端验收。

## 文档导航

**[文档总览](docs/README.md)** · [首次部署](docs/GETTING-STARTED.md) · [日常运维](docs/OPERATIONS.md) · [Web 管理后台](docs/WEB-ADMIN.md) · [会话与历史](docs/SESSION-CENTER-UX.md) · [定时任务](docs/SCHEDULED-TASKS.md) · [开发与测试](docs/DEVELOPMENT.md)

历史版本变更、早期架构设计与验收快照集中在 [历史资料](docs/archive/README.md)，**不应作为当前版本的安装指令**。

MIT License.
