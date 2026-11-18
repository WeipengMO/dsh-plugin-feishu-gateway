# Session 生命周期与安全删除（开发参考）

普通使用请阅读 [会话管理](SESSION-CENTER-UX.md)。

## 数据归属

| 数据 | 管理方 | 删除边界 |
| --- | --- | --- |
| DSH 原生 Session | `ctx.sessionPersistence` | 官方目前无统一 delete API；必须由经验证的持久化所有者操作 |
| 工作区归档和显示 | DSH WorkspaceRegistry | 归档和恢复不删除事件日志 |
| 飞书聊天关联 | Gateway `sessions.json` | 解除绑定不会删除 Session |
| 旧版暂存索引 | Web Admin `session-trash.json` | 用于兼容旧回收站条目，不含聊天正文 |
| 自动归档设置 | Web Admin `session-retention-settings.json` | 90 天默认值、显式启用、自动永久删除关闭 |
| Inbox/Outbox | Gateway | 未处理消息与外部副作用必须独立保护 |

## 当前可见状态

```text
对话历史 ──归档──> 已归档 ──恢复──> 对话历史
                          │
                          └──删除──> 原生历史真正删除（仅安全删除服务可用）
```

旧版存于暂存索引的 Session 也归入「已归档」，恢复使用对应的原先状态。没有安全持久化删除服务时，删除不可用。

## 删除安全流程

1. 仅对已经归档、没有飞书绑定且不属于定时任务的会话开放。Gateway 快照过期、有待处理消息或审批、原生活跃写入者仍存在时拒绝。
2. `POST /sessions/native/delete/preview` 通过服务端索引解析会话引用，并调用可选 `workspaceRegistry.archivedSessionMetadata()` 确认仍处于归档状态；只返回脱敏信息和 30 秒有效令牌。当前 archive-manager 不提供容量估计，因此不展示虚构的预估字节数。
3. 前端显示页面内危险确认弹窗，勾选不可恢复后才提交。
4. `POST /sessions/native/delete` 一次性消费令牌，重新检查会话状态及活动 Agent，再调用 `@michengai/dsh-archive-manager` 扩展的 `workspaceRegistry.deleteSession(id)`。必须收到 `{ deleted: true }`，原生日志和 Workspace 等清理由该插件实现。
5. 若删除服务提供 `presentSessionIds()`，额外检查日志已不在原生持久化中；写入脱敏审计记录；旧暂存索引同步清理。
6. 不能仅依赖 Web 的过期快照断言安全，也不会使用 `fs.rm` 直接操作未知后端的存储目录。

**插件是可选的。** Web Admin 检查 `ctx.get('workspaceRegistry')` 上是否同时存在 `archivedSessionMetadata`、`deleteArchivedSessions` 与 `deleteSession`，这三个方法来自 [@michengai/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager) 的 workspaceRegistry 扩展。没有安装或服务未加载时返回 `canDelete:false`，UI 将删除按钮置灰；其他会话功能正常使用。只能在 **DSH Web `web` Profile** 中加载才会被当前管理端发现。

## API 与设置

- `GET /sessions/ledger?status=current`：正常对话。
- `GET /sessions/ledger?status=archived`：所有已归档，包括旧版暂存项。
- `POST /sessions/native/archive`、`POST /sessions/native/restore`：侧栏归档与恢复。
- `POST /sessions/native/delete/preview`、`POST /sessions/native/delete`：安全永久删除预览与一次性提交。
- `GET /sessions/retention`、`PUT /sessions/retention/settings`：90 天自动归档设置；自动永久删除仍不启用。
- 原有 `/sessions/trash/*` 兼容接口暂时保留，**不再展示额外回收站入口**，以便旧暂存记录恢复。

开发单元与 HTTP 安全测试见 `web-admin/test/session-organizer.test.mjs`、`web-admin/test/server.test.mjs`。真实删除仍需在匹配的 DSH Web 和第三方删除服务上进行人工数据与索引一致性验收。
