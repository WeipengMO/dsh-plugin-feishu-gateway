# 飞书 Gateway 的 DSH 原生上下文压缩

此文是飞书 Gateway 上下文压缩的唯一使用与运维说明。**上下文压缩**（compaction）不同于“归档/删除会话”或“压缩日志文件”：它用摘要替换模型后续请求中较早的历史，同时原始 DSH Session 事件仍持久保存，因此不会清理磁盘空间。

## 采用哪套引擎？

- **自动压缩由 DSH 原生 `@deepseek-ai/dsh-compaction-basic` 负责**，飞书 Gateway 不维护第二套摘要器、模型循环或压缩阈值，防止重复摘要与历史分叉。
- 同一个 DSH Session 由飞书正常发送的下一条消息继续沿用；DSH 在请求前按**当前/目标模型**的上下文窗口、预计输出与安全余量决定何时压缩。
- 超过阈值后，DSH 可先裁剪过大的工具结果、再将旧消息总结为一个持久检查点并保留最近的对话；提供方确认上下文溢出时可尝试压缩后重试。
- DSH 基础 Profile 通常已加载该后端；实际是否可用取决于部署版本与 Profile。**不要因为本飞书插件增加了命令，就认定 DSH 引擎一定已加载或自动策略已启用**。

## 触发策略：参考 Codex，保留 DSH 原生语义

Codex 的设计核心是**根据实际上下文窗口的压力**触发压缩，而不是根据总账单 Token 或消息数量。DSH 的 `compaction-basic` 默认规则（视宿主版本）为：

```text
触发阈值 = floor(min(
  当前模型上下文窗口 W × thresholdRatio,
  W - 预留输出 token O - 额外余量 B
))
默认 thresholdRatio = 0.8
默认 B = 65,536 tokens
最近历史保留预算约为 (W-O) × retainRatio；默认 retainRatio = 0.16
```

自动触发的时间点：
1. **请求前**：上下文使用量达到原生阈值；不会因为仅累计历史 Token 用量高而触发。
2. **模型切换**：按新模型可用上下文重新计算压力；小窗口切换可能更早压缩。
3. **真实上下文溢出**：DSH 在确认是 context-window exceeded 的情况下，压缩后有限次重试。
4. **人工按需**：发送 `/compact` 调用原生 `compactNow()`；即使未到自动阈值也可请求有用的压缩，但可能发现没有可安全压缩的历史。

**不推荐**按“每天零点/每 50 条消息/累计 Token 达到 100k”触发。摘要会增加一次模型调用，压缩不保证内容零损失；太早或频繁地压缩会增加开销并降低细节保真度。对于小上下文模型，默认的 `65,536` token 余量可能过大，需在 DSH 引擎中按模型调整，**不是在飞书插件额外计算一个阈值**。例如 `W=128000`、`O=8192`，默认 B 下实际阈值是 `54272`（约 42.4%），不是 80%；还可能遇到容量缺失或预算非法。

## 飞书命令

| 命令 | 作用 | 保护 |
| --- | --- | --- |
| `/context` | 查看本聊天的原生压缩引擎是否可用、Gateway 本次启动后观察到的压缩记录 | 仅读；不创建/恢复 Session，不向模型发送新提示词 |
| `/compact` | 按需压缩本聊天已存在的原生 Session，报告替换历史项与被替换区域的估算 Token | 排入当前聊天队列，不并发运行同一 Feishu 会话；由 DSH 原生 idle/锁机制决定是否允许 |
| `/help` | 查看以上命令 | 保留原有权限检查 |

`/compact` 没有历史时会明确拒绝；模型没有足够旧内容可压缩时返回“无需压缩”，不会伪造成功；原生服务缺失、忙碌、摘要失败、持久化失败均有独立提示。命令经过私聊及群聊权限校验、Inbox 去重和 Outbox 可靠投递，不把 `/compact` 当成普通用户提示词，也不创建第二个 LLM Session。

“本次 Gateway 启动后观察到的次数”属于内存监控数据；重启后会归零，不能代表原生持久日志中压缩总次数。被替换区域估算 Token 也**不等于净节省的 Token**，原生摘要可能消耗额外 Tokens。

## Web Admin

在 **飞书管理 → 会话管理**（独立导航）页底部展开“上下文压缩”：

- 展示从 **Gateway Profile** 传回的真实 `ctx.compaction` 能力和本轮进程观察到的压缩记录。
- 按原生 `compaction/start` 事件的 `turn` 区分 **自动**（数字）、**手动**（`null`）和 **未分类**（缺少有效 start），只在成功的 `compaction/summary` + `compaction/end` 后计入完成次数；失败只计次数与时间，不显示潜在敏感错误内容。
- 如果本次 Gateway 启动后已观察到自动压缩，界面明确显示“已观察到”；否则显示“未验证”，**不是“已关闭”**。观察计数随进程重启清零。
- 解释飞书中 `/context` 与 `/compact` 命令。
- 不提供伪造的上下文百分比/估算 Token 压力，也不把累计用量图表作为自动压缩触发依据。
- Web Admin 运行在另一个 `web` Profile，它的 compaction 状态不能代替 `feishu-channel` Profile 的实际状态。
- 原生服务目前没有稳定的公开 `auto enabled`、模型窗口占用/阈值读取端口，因此不会根据“有服务”伪造“自动已开启”或实时百分比。Gateway 不修改 DSH Profile 配置。

## 配置与兼容性

在运行 **Gateway 的 `feishu-channel` Profile** 中确认 DSH 原生压缩后端（并非在仅供管理界面使用的 `web` Profile 中开启）。随附 DSH 基础配置可能已启用，避免重复挂载；需要自行定制时遵循该 DSH 版本的配置目录，例如：

```yaml
# 示意：仅在尚未挂载且宿主兼容时配置，切勿与已加载实例重复注册
- name: '@deepseek-ai/dsh-compaction-basic'
  config:
    auto: true
    thresholdRatio: 0.8
    retainRatio: 0.16
    # 小上下文模型可单独设置 modelPolicies[].headroomTokens
```

如需 DSH 原生命令后端，还可挂载 `@deepseek-ai/dsh-command-compact`；**但飞书的 `/compact` 已直接调用同一个原生 `ctx.compaction.compactNow()`，不需要为了飞书命令额外安装 DSH 命令插件**。

相关权威资料：

- [DSH compaction-basic](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.zh.md)
- [DSH compaction 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.zh.md)
- [Codex 对 Agent loop 和 compaction 的说明](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

## 验收

1. 在没有原生 `compaction` 服务的测试 Profile 中，`/context` 显示未检测到；`/compact` 提示不可用，不会往 Agent 发送伪造摘要。
2. 在启用原生引擎的 `feishu-channel` Profile 中，先正常对话，再执行 `/compact`，观察原生 `compaction/start`、`compaction/summary`、`compaction/end`。只有完整成功的记录计入观察值。
3. 发送下一条普通消息，确认仍使用原 Session ID，能依据摘要继续工作。
4. 正在运行的任务或定时任务占用 Session 时，手动压缩返回忙碌/失败提示，不取消任务、不截断中间状态。
5. 使用不同上下文容量的模型和大工具结果，验证压力触发、模型切换以及溢出后的恢复策略。**这部分需要真实 DSH 和真实模型环境**，Mock 测试只能验证调用边界与状态。
6. 进行一轮**不发送 `/compact`** 的测试：先将该测试模型 `modelPolicies` 的阈值调低至有效预算范围，再让 Agent 持续多次工具调用/对话直到超出阈值；确认真实日志出现 `compaction/start` 且 `turn` 为数字，之后有 `summary`、`end`；`/context` 与 Web Admin 的“自动”计数增加。
7. 手动发送 `/compact`，确认 `compaction/start.turn === null`，手动计数增加，自动计数不应增加；未达到阈值且未手动压缩时不得凭累计 Token 用量计入压缩。
8. 缺失压缩服务时显示“未检测到”；仅服务存在但还没有自动压缩记录时显示“未验证”，绝不能将“服务可用”等同于“auto 已启用”。失败/重复 end 事件不得增加成功次数，摘要及原始错误不应出现在后台 DTO 中。

