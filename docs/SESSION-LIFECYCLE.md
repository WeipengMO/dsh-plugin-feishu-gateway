# Session 生命周期与数据所有权（开发参考）

普通用户从 [会话管理使用指南](SESSION-CENTER-UX.md) 开始。

## 数据并不是同一个东西

| 数据 | 谁负责 | 删除/归档是否联动 |
| --- | --- | --- |
| DSH 原生 Session 历史 | `ctx.sessionPersistence` | DSH 真正保存正文；**当前无通用 delete API** |
| 原生侧栏归档 | DSH WorkspaceRegistry | 可隐藏/取消隐藏，不删除正文 |
| 飞书聊天绑定 | Gateway `sessions.json` | 决定下一次聊天复用哪个 Session；解除绑定不删除正文 |
| Web 回收站索引 | Web Admin `session-trash.json` | 记录暂存时间与原先状态；不含聊天正文 |
| 回收与归档设置 | Web Admin `session-retention-settings.json` | 90 天候选/30 天到期统计，不直接删除 |
| Inbox / Outbox | Gateway | 负责消息去重与投递，与原生聊天历史独立 |

## 状态流转

```text
对话历史 -- 归档 --> 已归档 -- 恢复 --> 对话历史
    |                       |
    +--- 移入回收站 <-------+
                 |
                 +-- 恢复 --> 移入之前的可见状态
                 |
                 +-- 到期 --> 只标记到期（没有原生删除 API）
```

原生会话必须仍没有关联且非活动状态才允许移入回收站；定时任务会话暂不允许执行该操作。需要 DSH 原生 `unarchiveSession` 支持才能保证恢复可用；没有该能力会禁用回收操作。

Web Admin 保存的回收站索引使用服务端本地权限和原子写，记录的是原生 ID、时间戳与先前归档状态；浏览器只看到经过脱敏的 Session 引用。暂存时先通过原生 WorkspaceRegistry 归档，再记载回收状态。若记录持久化失败，不会报告操作成功；由于这是跨 DSH 和 Web 状态的操作，进程在两步之间崩溃时可能留下已归档但未标记回收的会话，应仍可在「已归档」找回。

## 自动归档

- 初始策略 `archiveAfterDays=90`、`trashKeepDays=30`、`autoArchiveEnabled=false`、`autoDeleteEnabled=false`。
- 自动归档由 Web Admin 每小时检查一次，**需要用户启用**；不会自动从回收站清除记录。
- 自动归档只使用已记录的可信最后活动时间（由此前 Gateway 绑定的活动时间在 Web 管理记录里观察得到），不会以 Header 创建时间补全缺失数据。
- 当前绑定、非正常运行状态、定时任务会话、审批或消息在途以及 DSH 原生锁不允许的归档均会跳过。
- `session-organization-settings.json` 的工作区自动归位是另一个设置，不能与 90 天保留策略混淆。

## API

在 DSH Web 既有认证前缀 `/api/feishu-admin` 下：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /sessions/ledger?status=current` | 当前未归档历史 |
| `GET /sessions/ledger?status=archived` | 已归档列表 |
| `GET /sessions/ledger?status=trashed` | 回收站暂存列表 |
| `GET /sessions/retention` | 配置和候选/跳过/到期统计 |
| `PUT /sessions/retention/settings` | 修改 90 天归档/30 天保留策略，不能打开永久删除 |
| `POST /sessions/trash/preview` | 检查候选与生成 30 秒确认令牌 |
| `POST /sessions/trash/move` | 令牌消费后原生归档+写回收索引 |
| `POST /sessions/trash/restore` | 将暂存会话恢复到原先归档状态 |

这些接口只操作 Web Admin 自身文件和 DSH 原生 WorkspaceRegistry；**没有任何实际永久删除 API**。代码和测试分别见 `web-admin/src/session-organizer.mjs`、`web-admin/src/server.mjs`、`web-admin/test/session-organizer.test.mjs`。

## 后续：永久删除

需要 DSH 为 SessionPersistence 提供经验证的原生 delete/retention 接口（含活动写入者、持久化后端、Workspace 索引、并发与恢复协调）才可以启用自动或手动真实删除。禁止直接推测 `.jsonl.zst` 文件路径并执行 `rm`。详见 [Issue #37](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/issues/37)。
