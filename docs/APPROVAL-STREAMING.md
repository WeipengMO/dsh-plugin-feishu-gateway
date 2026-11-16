# 飞书工具审批与 CardKit 流式任务卡片（0.2.0-rc.5 Gateway / 0.2.0-rc.3 Admin）

这是发布候选版本。**2026-11-15 已在现有真实飞书单用户私聊环境完成流式卡片、卡片取消、原生审批 allowed-once / rejected 的实机验收（0.2.0-rc.1 基线；0.2.0-rc.2/rc.3/rc.4 的卡片终态全量替换和底栏排版仍待实机复验）**；未覆盖超时、重复点击、取消中的审批和跨账号/聊天操作。完整证据边界见 [最终验收快照](ACCEPTANCE-0.2.0-rc.1.md)。源码中的两个开关仍默认关闭；当前部署已显式开启，不要求修改 DSH Core。

## 架构与安全边界

- approvalCards（默认 false）：监听原生 DSH approval/request waterfall，仅处理本插件创建、且目前正在执行的 Agent Session。审批结果完全采用原生 allowed-once / rejected / cancelled / unavailable。
- streamCards（默认 false）：为长任务创建 CardKit v1 卡片实体，按节流周期更新可见文本。0.2.0-rc.2 起，**正常完成时在原卡片上展示完整答复**，并移除取消按钮、显示真实模型和用量统计（有数据才显示）；不会重复发普通文本。仅卡片创建/终态更新失败或超长时回退 DurableOutbox。
- approvalTimeoutMs：默认 90000 毫秒，可选 5000–300000。
- streamIntervalMs：默认 800 毫秒，可选 500–5000。
- DSH 策略为 never 时，审批由 DSH 自己在 waterfall 之前拒绝，**不会触发任何卡片**；插件绝不把 never 改成 ask。
- 审批卡片显示工具和原生授权原因；Bash 命令按同一 Session 的 callId 匹配并以代码块完整展示。无法匹配或过长时明确提示，仍由用户决定是否批准。命令和原因可能包含路径、敏感信息，会发送至原请求所属飞书聊天（含群聊），请注意聊天成员和记录可见性。
- 操作者的 open_id、botId、chatId、卡片消息 ID、随机 nonce、请求未过期状态必须全部匹配。重复或伪造回调不能得到第二次授权。
- 取消 Agent 会同步失效对应审批卡片。进程重启后不恢复旧审批 Promise，过期卡片只能拒绝，绝不能转成授权。
- 按钮通过既有飞书 WS 连接的 card.action.trigger 触发；不暴露公网管理回调接口。

## 飞书开发者后台前提

1. 确认机器人发送消息权限，例如 im:message:send_as_bot。
2. 增加 cardkit:card:write 权限以创建卡片实体、流式写入组件及关闭流式模式。
3. 在应用的事件与回调设置中，使用长连接接收**新版 card.action.trigger** 卡片回调，而不是旧版 trigger_v1。
4. 保存并**发布新的飞书应用版本**，确认新增权限已经生效。
5. 每个 App ID 只有一个实际生产长连接消费者，避免测试服务抢走回调。

官方文档：
- DSH https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md
- 飞书按钮 https://open.feishu.cn/document/feishu-cards/configuring-card-interactions
- 流式文本 https://open.feishu.cn/document/cardkit-v1/card-element/content
- 关闭流式 https://open.feishu.cn/document/cardkit-v1/card/settings

## 构建与安装

在原插件仓库目录：

    git switch main
    git pull --ff-only
    pnpm install --frozen-lockfile
    pnpm run verify
    pnpm run pack
    dsh plugin --profile feishu-channel add "$PWD/dist/dsh-plugin-feishu-gateway-0.2.0-rc.5.tgz"
    # Web Admin 仍为 0.2.0-rc.1；已经安装则无需重复安装

检查两个 Profile。实际 Gateway **只**在 feishu-channel，Web Admin **只**在 web。运行中服务的重启应选择维护窗口，不得中断正在执行的 Agent。原状态目录、Inbox/Outbox 和凭据不要清空。

## 逐级验收

1. 先备份原 Profile、飞书状态目录和凭据（禁止在日志或聊天中显示 Secret）。
2. 新版本安装后，两个开关均保持 false：确认旧有三轮对话、/status、/cancel、重启恢复仍正常。
3. 仅打开 streamCards：在安全的长回答上核验 CardKit 流式预览、取消按钮、完成后原卡片完整答复（无第二条文本）、取消按钮消失、模型/总 Token/速度/用时逐行 **12px 灰色**底栏、超长文本与无权限回退。**无需修改 DSH 审批策略**。
4. 再打开 approvalCards，**只在 feishu-channel Profile** 中把 DSH 工具审批策略明确改为 ask。选择一个低风险工具操作，测试一次允许、一次拒绝、超时、取消、陌生人点击、重复点击、跨聊天点击。
5. 检查原生 DSH Session 的 approval/asked 与 approval/decided 审计，以及工具是否只执行一次。
6. 检查 Web 和 Remote SSH 原有功能未被飞书通道重启影响。

## 回滚

最小回滚：在 Web Admin 将 approvalCards 与 streamCards 都设成 false，在任务空闲时保存并仅重启 dsh-feishu-channel.service。需要降版本时再安装备份的 Gateway 0.1.3 / Admin 0.1.1 包，完整保留持久化 Session/Inbox/Outbox。

## 已知限制

- **已实机通过**：当前租户 CardKit 创建与流式更新、card.action.trigger 的取消按钮、原生 approval/request → allowed-once / rejected。该结论仅针对已测试的单用户私聊与当前已发布飞书应用配置。
- **仍未实机验证**：审批超时、重复点击、审批中取消、陌生账号/跨聊天点击；单元/集成覆盖不等于真实租户验证。
- 命令展示变更需要在真实飞书租户验证；命令无法完整显示时卡片会明确提示，仍由用户决定是否批准。
- 流式卡片仅是非持久预览，断线后可能停止更新；最终答复由 DurableOutbox 继续恢复投递。
