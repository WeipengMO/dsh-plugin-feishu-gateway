# 飞书通道可靠性与可选代理

适用范围：独立 `feishu-channel` Profile（Node.js 24+），不更改 DSH Web Profile，不改动 DSH Core。

## P0 — 任务超时与取消原因

- Gateway 审计明确区分 `cancel-requested-card`、`cancel-requested-command`、`timed-out` 和 `failed`。
- 到达 `replyTimeoutMs` 时，向飞书发送含**执行时限、工具调用次数和失败次数**的简明诊断，并隔离旧 Session；工具产生的副作用不会被自动回滚。
- DSH 原生 `agent.cancel({kind:'user'})` 是 SDK 既有 API，因此原生 Session 仍可能显示 `aborted/user`；**取消来源以 Gateway 运维审计和通道日志为准**。
- 接口不存储原始工具参数、抓取 URL、网页正文、密钥或完整模型推理内容。

## P1 — 轻量问题避免长时间无效抓取

- 首次创建专用飞书 Agent 工作目录时，如果 `AGENTS.local.md` 不存在，会放置轻量搜索指南。
- 普通聊天通常最多尝试五次网页查询；同域连续两次失败应停止；不要通过修改 User-Agent、长时间 `sleep` 或 `curl` 绕过封锁。
- **这是 Agent 指令引导，不是 DSH Core 的强制工具调用硬配额**。遇到不能遵循指令的模型时，仍以 Gateway 的 `replyTimeoutMs` 为硬超时。
- 如果已有 `AGENTS.local.md`（包括符号链接），绝不覆盖。可以在 DSH Web → 飞书管理 → Agent 档案中自行合并规则。定制的 `AGENTS.md` 不会被覆盖。

## P2 — CardKit 流式任务卡片

当 `streamCards=true`，卡片将定期展示：

- 运行时间（十秒粒度的空闲心跳）
- 最近工具名称（例如 `web_fetch`）
- 调用次数、失败次数
- 能确认的 HTTP 状态码（例如 403、567）

不显示 URL、命令参数、文件路径、原始报错正文、审批详情或密钥。正常完成后保留最终回答、模型、实际报告 Token 用量和工具统计。CardKit 写入失败时沿用 DurableOutbox 兜底。

## 代理设置

在 **DSH Web → 飞书管理 → 模型与配置 → 网络代理** 可设置：

| 字段 | 作用 |
| --- | --- |
| 启用代理 | 默认关闭；仅影响启动新的飞书 Channel |
| 代理 URL 环境变量名 | 默认 `FEISHU_CHANNEL_PROXY_URL`；也可改为 `HTTPS_PROXY` |
| 代理预检失败回退直连 | 默认打开 |

代理 URL **不写入源码、GitHub、Web Admin 配置或运行日志**。在 VPS 私有文件 `~/.dsh/feishu-channel.env` 放置实际 URL：

```bash
# 仅为占位示例，换成私有网络中的真实代理地址
FEISHU_CHANNEL_PROXY_URL='http://proxy.internal.example:8080'
# FEISHU_GATEWAY_DEFAULT_APP_ID / _APP_SECRET 同样放这里
```

该环境文件应为权限 `600`。当前代理 URL 仅支持 `http://` 或 `https://`，不得含用户名、密码、路径、查询参数或片段；若需要认证代理，请另外设计安全凭据方案。管理端只存储环境变量**名称**。

使用仓库的 `scripts/channel/start-feishu-channel.sh` 启动时：
1. 加载私有 env 文件后读取已验证的托管代理设置。
2. 通过所选代理快速访问飞书 OpenAPI 以预检 CONNECT/HTTPS 通路。
3. 预检通过：在启动 DSH 前设置 `HTTP_PROXY`、`HTTPS_PROXY`、小写别名和 `NODE_USE_ENV_PROXY=1`，并对飞书 WebSocket 使用 SDK 的代理 Agent。保留 `NO_PROXY`；如果未设置，默认排除环回地址。
4. 预检失败：若允许回退，取消 HTTP(S)/ALL_PROXY 环境变量并直接启动；若禁止回退，启动失败并给出诊断（不泄露 URL）。

**重要边界**：

- 这是**启动时的选路及失败回退**，并不是对每个请求自动双线路重试。代理已经通过预检后若在执行中断线，飞书 WebSocket 使用 SDK 重连机制；如需切换直连，可重启独立通道。
- Feishu REST 写操作不能在响应未知时直接使用另一线路重复发送，否则可能重复投递。原有 DurableOutbox 的 UUID/幂等机制继续有效。
- DSH Agent 的 Node `fetch`/`web_fetch` 以及从 Agent 启动的子进程会继承相关环境变量，但**不同工具是否真正使用代理取决于其实现**。Bash `curl` 通常遵守环境变量；有些工具不会。不能保证所有网络调用均走代理。
- 通过直接 `dsh --profile feishu-channel` 而非仓库启动脚本启动的环境，不会自动执行代理预检。改配置后需要重启独立 Feishu Channel。
- 代理预检不等同于真实飞书 WebSocket 与 LLM 端到端验收。完成升级后请用真实飞书私聊、`/status` 和网关日志再验证一次。

## 验收建议

1. 代理关闭：启动通道，验证私聊发送与接收。
2. 设置不可连接代理且启用回退：启动日志应出现 `falling back to direct`，仍应能够通过直连回复。
3. 设置可用代理：启动日志应出现 `proxy preflight passed`（不应打印 URL），飞书 WebSocket 应成功连接。
4. 测试普通查资讯：流式卡片应显示 `web_fetch`、调用次数和 HTTP 失败状态。
5. 使用较短的测试超时触发长任务，确认最终诊断明确写出“执行超时”，运维事件状态为 `timed-out`。
6. 测试 `/cancel` 和卡片取消，运维日志分别记录来源，并确认新的消息不会继续被旧任务影响。

