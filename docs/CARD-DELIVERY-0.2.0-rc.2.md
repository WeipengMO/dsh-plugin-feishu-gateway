# Gateway 0.2.0-rc.2：单张 CardKit 最终回复

**状态**：实现已提交并由自动化测试验证；**尚未在真实飞书租户上执行新版本的终态卡片全量更新验证**。历史 CardKit 创建/流式/取消与原生审批允许/拒绝的实机记录见 [0.2.0-rc.1 验收快照](ACCEPTANCE-0.2.0-rc.1.md)。

## 行为修复

0.2.0-rc.1 将卡片作为流式**预览**，正常完成后又由 DurableOutbox 投递完整文本，因此收到两个相同回答。

0.2.0-rc.2 中：

1. `streamCards=true` 时仍创建一张 CardKit 卡片供实时显示，运行中才存在「取消当前任务」按钮。
2. DSH Agent 完成后，取**原生 Session 返回的最终完整文本**（不依赖累积的流式 delta），通过 `PUT /open-apis/cardkit/v1/cards/:card_id` **全量替换原卡片**，将 `streaming_mode=false`，移除取消按钮，并在卡片底部展示统计。CardKit 完整替换成功后**不发送第二条 Outbox 文本**。
3. `streamCards=false` 时行为完全不变，仍由 DurableOutbox 发送普通文本/Markdown。
4. CardKit 创建失败、最终实体更新失败、内容超出安全大小限制（上限按序列化卡片 JSON 字节数检查）时，**退回原 DurableOutbox 文本发送**以免失去最终答案；超长内容尝试将原卡片改为「切换文本」提示。这里的文本是异常兜底，不是正常双发。
5. `/cancel` 和卡片取消仍遵守当前聊天/当前 Session/当前 nonce 的授权边界，完成或取消后的旧按钮无法发起新的取消操作。原生工具审批 `ask` / `allowed-once` / `rejected` 均未修改。

## 底栏统计口径

- **模型**：从 DSH `session/event` 的 `request/context` 或 `request/header` 取得实际 provider/model；同一 Session 的后续 turn 若未重复发路由事件，复用上次已观察到的模型。未知则不显示。
- **Token**：仅统计 `assistant/message` 或 `assistant/attempt` 的 DSH/LLM **提供方上报用量**：`inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`，并显示入/出拆分。不通过字符串长度推算。
- **生成速度**：用上报的 `outputTokens` 除以 DSH stream start/end 的模型流持续时间；缺少完整时序时退化为整段任务耗时估算，显示「≈」表示近似。没有真实 Token 用量时不显示速度。
- **用时**：该消息进入 Gateway turn 至本次回复完成的墙钟耗时，不含用户等待队列之前的时间。
- **缺失值**：不填虚构的 `0`、固定模型或猜测成本。

## 包与安装边界

- **仅 Gateway 提升至 `0.2.0-rc.2`**；Web Admin 保持 `0.2.0-rc.1`，此前已经安装的不必重装。
- Profile 隔离不变：Gateway 只安装在 `feishu-channel`，Admin 只安装在 `web`。
- `streamCards=true`、`approvalCards=true`、`streamIntervalMs=800`、`approvalTimeoutMs=90000` 属于现有部署配置；源码默认卡片开关仍为 `false`。
- 不改现有原生工具审批 `ask`、`workspace-write`，不清除 Session/Inbox/Outbox。

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run test:coverage
pnpm run pack
dsh plugin --profile feishu-channel add "./dist/dsh-plugin-feishu-gateway-0.2.0-rc.2.tgz"
dsh --profile feishu-channel --dump-config
```

升级后的实际运行进程还需在维护窗口重启 `dsh-feishu-channel.service` 才能加载新包；**不要通过合并 PR 自动重启正在使用的通道**。

## 真实飞书待验收（部署前）

使用隔离测试 Profile / 机器人或安排维护窗口，重点验证：

- 长回答的流式增量、终态原卡片显示**完整答案**，不会再额外发送相同文本；
- 完成后的取消按钮彻底消失；底栏有模型、真实 Token 用量、约略 tok/s 与耗时（未返回的数据不显示）；
- 正常任务无需人为开启 `danger-full-access`，工具审批仍只在实际沙箱升级时触发；
- 用户点击取消后按钮消失，旧卡片操作被拒绝，Session 绑定按既有逻辑安全处理；
- CardKit API 非零码/网络断线/超长答案时，不丢失最终答案；必要时回退文本；
- 核验 CardKit **全量更新 PUT** 的实际飞书应用权限与卡片组件渲染（新路径尚未实机验证）。

官方接口：[卡片全量更新](https://open.feishu.cn/document/cardkit-v1/card/update)、[卡片资源概述](https://open.larkoffice.com/document/cardkit-v1/feishu-card-resource-overview)。原生 DSH 用量事件参考 [DSH Session](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)。

**没有运行时部署/实机验证前，不能把本 RC2 变更标记为真实租户 PASS。**
