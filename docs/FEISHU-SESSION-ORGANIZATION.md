# 飞书原生 Session 归位与台账（Issue #34）

## 架构与边界

- Gateway (feishu-channel profile) 独占原生 Agent 的创建、续接及标题写入，标题只在已持有会话的 Gateway 进程更新。
- Admin (web profile) 读取 DSH Session persistence 的 header，并通过 WorkspaceRegistry 归位或归档。绝不调用 Agent resume、抢占跨进程写锁，也不删除会话文件。
- `sessions.json` 是唯一聊天绑定映射；`ops-schedule.json` 是任务引用来源。Web 另存的 `ops-session-organization.json` 仅记录幂等对账游标，不复制对话。
- 工作区目录采用 Gateway 报告的隔离 `agent-workspace` 真实路径；Web 不应直接修改 `workspace.json` 文件。
- 归档有两种含义：Gateway 绑定归档只改变聊天绑定；DSH 原生归档只从 Web 侧栏隐藏历史，两者不能混为一谈。

## 启用前检查

1. 先部署支持会话标题的 Gateway，再部署支持原生 Session 台账的 Admin；确认 DSH 原生 Session / Workspace 服务可用，Gateway 已报告隔离工作区路径。
2. 先备份 `~/.dsh/feishu-channel-state/` 的配置和对账状态；不应移动、删除或手工修改 `~/.dsh/sessions/` 原生历史。
3. 在「飞书管理 → 会话管理」检查原生会话台账和整理计划。默认禁用自动整理；先使用只读预览核对 workspace、待归位 ID、孤儿和 legacy 数量。
4. 只有在预览与真实活跃聊天/任务匹配后才打开整理开关，然后手动执行对账。建议先以一个私聊、一个群聊及一个定时任务进行端到端验收。

## 命名规则

- 群聊：`飞书群·<群名>`；多机器人可加入 botId。
- 私聊：`飞书·私聊·<姓名>`；无法查询姓名时退化为 chatId 尾号。
- 定时任务：`飞书定时·<任务标题>`。
- 手动改过的用户标题不得覆盖；缺失标题服务时只记录告警，不应阻断聊天。冷历史标题无需迁移。

## 归档及安全确认

- 初次上线不应自动归档不再绑定的历史；历史清单先 dry-run，逐条确认后再使用管理端原生归档操作。
- 对账只能在观察到旧绑定被新绑定**明确替换**后归档旧聊天 Session；一次短暂解绑不等于可归档。
- 旧定时目标在任务不再引用且超过宽限期后才可归档，活跃 Session 由 DSH 原生活动检查兜底。
- 手动恢复过的 Session 不应因为下一轮对账再次自动归档。
- 管理端显示脱敏引用为默认设置；查看明文标识需要明确开启。接口不提供聊天正文或完整 open_id。

## 回滚

关闭管理端的整理开关，即停止后续自动归位/归档；已归位的 Workspace 关联不自动反向移动。需要恢复某条原生历史时，使用 DSH 的已归档 Session 恢复能力。Gateway 与 Admin 可分别回退，但不要直接编辑 DSH persistence 或原生会话文件。对账游标保留以供审计和继续升级。

## 尚需验收

在真实双 Host 的环境中验证：首次 dry-run、私聊与群聊创建标题、`/new` 绑定切换、任务重建与 24h 宽限期、Web/Gateway 重启恢复、手动恢复后不重复归档、原生活动检查以及全过程无 `session/writer-held`。还需补充隔离 DSH_HOME 的自动化测试，并核对 Issue #34 的首次 17 条历史迁移清单是否符合当前实际状态。
