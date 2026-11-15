# 飞书 Channel（在 DSH 中通过飞书与 DSH 对话）

本目录/profile 把**飞书私聊**接到 **DSH 原生 Session**：你在飞书里给机器人发消息，
DSH 用**与 Web 端相同的模型**处理，并把回复发回飞书。

## 架构

```
飞书私聊 ──(WebSocket 长连接)──> dsh-plugin-feishu-gateway
                                      │  allowlist(open_id) / 持久化 Inbox
                                      ▼
                            DSH 原生 Session（ctx.agents）
                                      │  provider magpie / model group/deepseek
                                      ▼
                            DSH 回复 ──(飞书 REST)──> 飞书私聊
```

- Profile：`~/.dsh/profiles/feishu-channel/`（**独立 profile**，不修改 `web` profile）
- 复用同一个 `DSH_HOME`，因此**复用同一份凭据库与同一模型路由**（`MAGPIE_API_KEY`）
- 不含 `dsh-headless`（它是一次性应用），由 `channel-host.mjs` 持有进程生命周期
- 状态：`~/.dsh/feishu-channel-state/`（`inbox.jsonl` / `outbox.json` / `sessions.json` / `channel.log`）

## 凭据（绝不提交）

凭据放在**仓库之外**的 `~/.dsh/feishu-channel.env`（权限 `600`）：

```bash
FEISHU_GATEWAY_DEFAULT_APP_ID=cli_...
FEISHU_GATEWAY_DEFAULT_APP_SECRET=...
```

- 插件只从**环境变量**读取，日志只打印来源名（`env:FEISHU_GATEWAY_DEFAULT_APP_SECRET`），不打印值。
- `.gitignore` 已忽略 `.env` / `.env.*` / `feishu-channel.env`，仓库内不会出现密钥。
- 本轮凭据取自 openclaw 现有飞书应用（`channels.feishu.appId` + `secrets.json` 的
  `/config/feishuAppSecret`），仅写入上述 `600` 文件，未写入任何仓库文件。

## 启动 / 停止

```bash
scripts/channel/start-feishu-channel.sh --daemon   # 后台启动 + PID 文件
scripts/channel/start-feishu-channel.sh --status   # 健康检查（含 transports / inbox / outbox）
scripts/channel/start-feishu-channel.sh --stop     # 优雅停止
scripts/channel/start-feishu-channel.sh            # 前台运行（调试用）
```

控制面只绑定 `127.0.0.1:18095`：`GET /health`、`GET /diagnostics`、`POST /shutdown`。

## 开机自启（可选）

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/dsh-feishu-channel.service <<'EOF'
[Unit]
Description=DSH Feishu channel
After=network-online.target

[Service]
Type=simple
ExecStart=%h/dsh-workspace/projects/dsh-plugin-feishu-gateway/scripts/channel/start-feishu-channel.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now dsh-feishu-channel.service
```

## 配置要点（`~/.dsh/profiles/feishu-channel/cordis.patch.yml`）

| 项 | 值 | 说明 |
| --- | --- | --- |
| `offline` | `false` | 真正建立飞书长连接 |
| `autoConnect` | `true` | 启动即连接 |
| `allowlist` | 你的 `open_id` | 只接受白名单用户的私聊；空列表 = 全部拒绝 |
| `allowGroups` | `false` | 仅私聊 |
| `workspace` | `/home/ubuntu/dsh-workspace` | Agent 的工作目录 |
| `replyTimeoutMs` | `300000` | 长任务上限（5 分钟） |
| `outboxRetryIntervalMs` | `30000` | 飞书 REST 失败时，即使长连接未断开也会周期补发 |
| 模型 | `magpie` / `group/deepseek` | 与 Web 端 `agent-default-model` 一致 |
| 沙箱 | `workspace-write` | 只能写 workspace |
| 审批 | `never` | 聊天通道无交互审批 UI，故不阻塞；如需审批请改回 `ask` 并接审批桥 |

## 排障

| 现象 | 处理 |
| --- | --- |
| `transports.default != connected` | 检查 `channel.log` 是否有 `ws client ready`；确认飞书应用已开启「长连接接收事件」并订阅 `im.message.receive_v1` |
| 发消息无回复，`rejected.sender-not-allowlisted` 增长 | 你的 `open_id` 不在 `allowlist` 中 |
| `rejected.groups-disabled` | 只支持私聊，群聊默认拒绝 |
| `health.errors` 增长 | 看 `channel.log` 的 `message ... failed`，通常是模型路由或权限问题 |
| `invalid durable state` | 不会自动清空 Outbox/Session；备份后人工修复对应 JSON，再启动服务 |
| `.owner.lock.reaper` 持续存在 | 上次清理旧锁的进程可能意外退出；确认所有 Gateway 已停止后，人工检查再处理 |
| 回复很慢/超时 | 长任务可调大 `replyTimeoutMs` |

## 与测试 harness 的区别

`scripts/e2e/` 是**测试**用途（隔离 `DSH_HOME`、可 mock LLM、断言后销毁）。
本 channel 是**长期运行**的真实部署，使用真实凭据与真实模型，不做断言、只做健康检查。
