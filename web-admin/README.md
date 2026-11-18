# DSH Feishu Admin

`dsh-plugin-feishu-admin` 是 **DSH Web 的管理端伴随插件**，将「飞书管理」挂到官方侧栏，提供受认证保护的状态查询、管理配置、会话整理与运维操作。**它不启动飞书 WebSocket、Agent 或第二套 Gateway。**

- 安装在 `web` Profile；真正运行飞书机器人的 `dsh-plugin-feishu-gateway` 安装在独立 `feishu-channel` Profile。
- Web 管理复用 DSH Web 的认证与同源保护，不新增对外监听端口。
- 消息队列、飞书绑定、原生 DSH 历史有不同数据归属；Admin 不会因「归档关联」而删除原生对话。
- App Secret 仅安全写入，不回显；管理操作经单一 Gateway owner 执行，不直接操作其它 Host 的 Agent。

## 使用文档

| 阅读目的 | 文档 |
| --- | --- |
| 首次安装两个 Profile | [首次部署](../docs/GETTING-STARTED.md) |
| 管理台各入口 | [Web 管理说明](../docs/WEB-ADMIN.md) |
| Skills 技能库 | [飞书专属 Skills](../docs/FEISHU-SKILLS.md) |
| 会话归档、关联、回收站规划 | [会话管理](../docs/SESSION-CENTER-UX.md) |
| 升级、服务、代理与排障 | [运维手册](../docs/OPERATIONS.md) |
| API / 安全 / 测试 | [开发说明](../docs/DEVELOPMENT.md)、[技术架构](../docs/ARCHITECTURE.md) |

## 源码及构建

- `src/server.mjs`：受认证保护的管理 API。
- `src/skills-manager.mjs`、`src/skills-panel.js`：飞书专用 SKILL.md 管理，不读写 DSH 全局 Skills。
- `src/client.js`、`src/workbench.js`、`src/*-panel.js`、`src/client.css`：DSH Web 前端。
- `src/session-organizer.mjs`、`src/session-read.mjs`：原生 DSH 历史与飞书关联的不同只读 / 管理路径。
- `test/*.test.mjs`：权限、数据脱敏、管理命令和前端静态回归。

```bash
pnpm --dir web-admin run build
pnpm --dir web-admin test
```

运行前确认 Gateway 与 Admin 的版本及 API 兼容；本仓库分支中存在未正式发布的功能，**测试通过不等于已部署**。当前源码版本以 [package.json](package.json) 为准。

## 可选的永久删除扩展

正常浏览、归档、恢复和管理飞书聊天**不需要**额外插件。若希望在「飞书管理 → 会话管理 → 已归档」中使用永久删除，需要在 **DSH Web `web` Profile** 可选安装 [@michengai/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager)：

```bash
dsh plugin --profile web add @michengai/dsh-archive-manager
```

Web Admin 会在运行时检查 `workspaceRegistry.archivedSessionMetadata`、`deleteArchivedSessions` 和 `deleteSession` 是否全部可用；没有安装、没有启动或服务状态不安全时「删除」保持灰色，其他功能正常。安装后需确认 DSH Web 已加载插件，且实际版本兼容；不会自动删除任何会话。详见 [会话管理指南](../docs/SESSION-CENTER-UX.md)。
