# 文档中心

本目录按实际使用场景组织。**从 [项目 README](../README.md) 或下面的「开始使用」进入；不要从早期 rc 版本的安装说明中复制旧路径或版本号。**

## 开始使用

| 文档 | 适合什么时候读 |
| --- | --- |
| [首次部署](GETTING-STARTED.md) | 新服务器、飞书应用、双 Profile 安装、首次验证 |
| [飞书开放平台配置](FEISHU-APP.md) | 事件订阅、机器人权限、发布应用、测试白名单 |
| [飞书聊天与命令](FEISHU-CHANNEL.md) | `/new`、`/cancel`、`/models`、消息格式 |
| [Web 管理后台](WEB-ADMIN.md) | 各模块功能、哪些设置需要重启、危险操作 |
| [升级、备份与排障](OPERATIONS.md) | systemd、代理、健康检查、双 Profile 升级 |

## 按功能查阅

| 功能 | 主要说明 | 进一步参考 |
| --- | --- | --- |
| 会话历史、归档与关联 | [会话管理](SESSION-CENTER-UX.md) | [关联与工作区的技术边界](SESSION-LIFECYCLE.md)、[工作区整理](FEISHU-SESSION-ORGANIZATION.md) |
| 上下文自动压缩和手动 `/compact` | [上下文压缩](CONTEXT-COMPACTION.md) | [飞书聊天命令](FEISHU-CHANNEL.md) |
| 定时任务 | [定时任务](SCHEDULED-TASKS.md) | [Schedule API 合约](SCHEDULE-API-CONTRACT.md) |
| 群聊与 @ | [群聊管理](GROUP-CHAT.md) | [飞书权限](FEISHU-APP.md) |
| 模型 / 多模型回退 | [模型及用量](USAGE-AND-MODELS.md) | [历史用量](TOKEN-USAGE-ANALYTICS.md) |
| Agent 预设 / 飞书工作模式 | [Agent 预设](AGENT-PRESET-SELECTION.md) | [Web 管理后台](WEB-ADMIN.md) |
| 工具审批 / 任务卡片 | [卡片与审批](APPROVAL-STREAMING.md) | [安全与可靠性](RELIABILITY-AND-PROXY.md) |
| Agent 档案 | [档案管理](AGENT-PROFILE-MANAGER.md) | [工作区隔离与旧配置迁移](AGENT-PROFILE-ISOLATION.md) |
| 网络代理 | [运维手册](OPERATIONS.md) | [代理技术实现](PROXY-CONFIG-FLOW.md) |

## 开发、维护与测试

- [开发与测试](DEVELOPMENT.md)：源码结构、版本、CI、Mock 和真实租户的区别。
- [架构和 API 参考](ARCHITECTURE.md)：包含早期方案及后续实现增量，属于**技术背景**，不能取代当前代码。
- [DSH 兼容性](COMPATIBILITY.md) 和 [隔离测试 Profile](TEST-PROFILE.md)。
- [真实端到端测试](E2E.md)：运行条件与人工验收边界。
- [独立飞书 CLI 权限问题](FEISHU-CLI.md)：用于排查额外安装的 CLI，不是 Gateway 的必需依赖。

## 已知未完成

- **自动永久删除与按期限物理清理**：尚未支持；手动永久删除只有在 DSH 安全删除服务可用时才开放，[Issue #37](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/issues/37)。
- 媒体双向传输等仍需按相应 GitHub Issue 与当前源码确认。
- 会话管理最新 UI 与安全删除集成的验收状态见 [PR #41](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/pull/41)；**通过 CI 不等于已经发布或实机验收**。

## 历史资料

[docs/archive/](archive/README.md) 保存旧版本发布说明、设计草案、单次验收报告和旧 Roadmap，仅供追溯。`research/` 保存早期调研、测试报告和 DSH API 逆向研究；它们不能代表当前运行版本。

**维护约定**：当前操作步骤只在「首次部署」「Web 管理」「运维」等对应文档维护；功能文档不再重复一套固定 rc 安装命令。版本号以各自 `package.json` 为准。
