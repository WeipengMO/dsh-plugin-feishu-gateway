# Session 生命周期与数据归属（技术说明）

面向开发与管理员。普通用户建议先看 [会话管理说明](SESSION-CENTER-UX.md)。

## 两种记录，不是同一回事

| 数据 | 由谁拥有 | 操作影响 |
| --- | --- | --- |
| **DSH 原生 Session** | DSH Session 持久化与 Workspace 服务 | 真正的聊天历史、上下文、侧栏归档与恢复 |
| **飞书聊天关联** | Gateway 的 `sessions.json` 关联索引 | 哪段飞书聊天继续使用哪个 DSH Session |
| **飞书消息投递** | Gateway Inbox/Outbox 及审计 | 已接收、待处理、已发送、失败记录 |
| **飞书工作区显示** | DSH WorkspaceRegistry | 哪些历史会话显示在飞书工作区 |

一段会话即使“未关联飞书聊天”，**也可能是有价值的历史**；“孤儿”不是删除资格。归档会话不会减少 DSH 真实历史占用。

## 已有操作及安全边界

**DSH 原生归档**：Web 端基于只读 Header 枚举，预览后才调用 DSH WorkspaceRegistry 的归档能力。当前限制为未关联、未运行且未被活动定时任务引用的会话。仅移动侧栏可见性，**不删原始文件**。

**恢复归档**：若当前 DSH WorkspaceRegistry 暴露 `unarchiveSession`，Web Admin 提供恢复操作；旧运行时无该能力时禁用按钮并提示。不复制数据、不自动重建已解除的飞书绑定。

**飞书关联隐藏 / 解除关联**：管理端发起预览后使用 30 秒一次性令牌，由唯一 Gateway owner 串行处理，重新验证活动任务、Inbox、审批、Outbox 和绑定状态。解除关联意味着下次飞书消息新建 Session，而**非删除旧 Session**。批量操作每次最多 20 条，部分记录变更时可能被跳过，不承诺全有或全无。

**自动整理飞书工作区**：默认关闭；仅自动处理明确关联的现有聊天和活动任务，不会擅自搬迁首次部署前的全部旧历史。定时任务移除后使用等待宽限期；手动取消归档后不重复自动隐藏已处理记录。仅更改显示归属，不接管 Agent writer。

## 仍未实现：回收站 / 删除 / 自动清理

真正的回收站应允许恢复被删除候选，永久删除必须处理 DSH 原生数据及其它引用，不可用删除 Gateway `sessions.json` 映射替代。自动规则应基于可靠的**最近活动时间**；若原生 Header 只有创建时间，必须标注活动时间未知，**不能猜测为最后使用日期**。

详细的功能约束与验收见 [Issue #37](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/issues/37)。

## 验证

```bash
pnpm run verify
pnpm --dir web-admin test
```

还需在真实 DSH 版本验证归档→恢复保持原 sessionId/标题/历史完整；验证正在运行、已绑定、定时任务引用的会话被拒绝；验证旧版无原生恢复 API 时 UI 只读降级。CI 自动测试和真实会话清理**不是一回事**。

更多：[Session 管理 UI](SESSION-CENTER-UX.md)、[工作区整理](FEISHU-SESSION-ORGANIZATION.md)、[开发与测试](DEVELOPMENT.md)。
