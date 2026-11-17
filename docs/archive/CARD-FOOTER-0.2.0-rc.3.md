# Gateway 0.2.0-rc.3：CardKit 统计底栏排版

本版本仅调整 **0.2.0-rc.2 单卡片回复**的展示与计算条件，不修改原生 DSH Agent 的提示词、模型调用过程、原生工具审批 `ask`、Session/Inbox/Outbox，Web Admin 仍使用 `0.2.0-rc.1`。

## 终态显示

```text
DSH 已完成
[最终回复正文]

模型：magpie/group/deepseek
Token 用量：2,450
速度：72.1 tok/s
用时：34.2s
```

以上数字是布局示例，实际卡片只展示可由现有事件取得的数值。使用 Markdown 硬换行，每项独立显示；不再输出入/出 Token 拆分，也不在速度旁加 `≈`。

## 数据来源与模型开销

| 项目 | 数据来源 | 何时隐藏 |
| --- | --- | --- |
| 模型 | DSH Session `request/context` 或 `request/header` 上报的 provider/model | 无有效标识 |
| Token 用量 | DSH 原生 `assistant/message`/`assistant/attempt` 的提供方上报 `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` | 无有效 usage |
| 速度 | `outputTokens ÷ (DSH 流式 start/end 记录的生成时长，秒)` | 没有有效 outputTokens 或完整流式生成时长 |
| 用时 | Gateway 当前消息执行阶段的本地墙钟差 | 无法计时 |

速度依然是**从 DSH 现成数据计算出的整体输出吞吐量**，不是模型提供的独立测速字段；标签按产品要求简写为「速度」，没有 `≈`。缺少流式生成时间时**不再用整个任务用时替代**，以免把工具执行/人工审批耗时当成生成耗时。

**不会因为显示这些统计而额外调用 LLM，也不会增加模型上下文 Token。** 仅在网关处理现有事件时进行简单计算，并将几十个字符附加在已经需要更新的终态 CardKit 消息内；少量网络请求字节属于卡片负载，不是模型 Token。

## 发布及验证

- Gateway 插件版本为 `0.2.0-rc.3`，单独升级 `feishu-channel` Profile。
- 已安装的 Web Admin `0.2.0-rc.1` 无需重装。
- 继续维持 `streamCards=true`、`approvalCards=true`，审批策略 `ask`。
- 自动化测试验证换行、总 Token、无 `≈`、有效生成时间才计算速度，且单卡片交付和失败时 Outbox 兜底逻辑不变。
- **没有在此次仓库修改中重启或部署真实服务**；仍需要实机验证飞书对 Markdown 硬换行及终态全量更新的显示效果。

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack
dsh plugin --profile feishu-channel add "./dist/dsh-plugin-feishu-gateway-0.2.0-rc.3.tgz"
```

实际服务重启请在没有运行任务时通过既有飞书通道后台执行，保留 Session/Inbox/Outbox 与凭据。历史单卡片交付实现说明见 [0.2.0-rc.2 文档](CARD-DELIVERY-0.2.0-rc.2.md)。
