# 部署维护、升级与排障

适用范围：DSH Web + 飞书通道在**同一主机、同一 Unix 用户**的部署。服务名、工作目录和端口以实际配置为准；不要把示例路径当成用户机器上的既定值。

## 两个进程，两个 Profile

| 组件 | DSH Profile | 职责 |
| --- | --- | --- |
| Gateway | `feishu-channel` | 飞书 WebSocket、原生 Agent 和 Session、持久化 Inbox/Outbox、消息处理 |
| Web Admin | `web` | 认证后台、配置与服务状态查看；**不运行另一个 Gateway** |

常用文件：

- `~/.dsh/feishu-channel.env`：飞书应用凭据（0600，写入但不回显）。
- `~/.dsh/feishu-channel-state/`：Gateway 的 Inbox、Outbox、关联、命令邮箱、运行统计与管理配置；**不能直接删**。
- `~/.dsh/profiles/feishu-channel/`、`~/.dsh/profiles/web/`：各自的 DSH Profile。
- DSH 原生 Session 历史由 DSH 自己持有，**不等于 Gateway 状态目录中的关联记录**。

## systemd 用户服务

若选择 systemd，创建 `~/.config/systemd/user/dsh-feishu-channel.service`，将 `ExecStart` 指向**真实存在且可执行**的启动脚本：

```ini
[Unit]
Description=DSH Feishu Gateway
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/absolute/path/to/dsh-plugin-feishu-gateway/scripts/channel/start-feishu-channel.sh
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-feishu-channel.service
systemctl --user status dsh-feishu-channel.service --no-pager
journalctl --user -u dsh-feishu-channel.service -n 100 --no-pager
```

不要将 `/absolute/path/to/...` 原样保留。**只能有一个 Gateway 持有状态目录**；不要把脚本 `--daemon` 与 systemd 两种运行方式同时开启。Admin 的「重启飞书通道」仅控制已配置的固定用户服务，不支持任意 Shell 执行。

## 安全升级

1. 核对当前分支、[两个 package.json](../package.json) / [Admin 版本](../web-admin/package.json)，以及服务器**实际安装版本**；不要照抄旧 rc 文档的 tarball 文件名。
2. 安排维护窗口，检查是否有运行中的任务、未完成审批、未发送 Outbox。不要强制打断可能已执行外部副作用的任务。
3. 先备份状态目录、环境变量文件和两个 Profile（在服务器上限制备份读取权限；勿上传含凭据的备份）。
4. 执行：

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack
GATEWAY_VERSION=$(node -p "require('./package.json').version")
ADMIN_VERSION=$(node -p "require('./web-admin/package.json').version")
dsh plugin --profile feishu-channel add "./dist/dsh-plugin-feishu-gateway-$GATEWAY_VERSION.tgz"
dsh plugin --profile web add "./dist/dsh-plugin-feishu-admin-$ADMIN_VERSION.tgz"
```

5. 检查两个 Profile 加载的 Cordis 服务与版本，在窗口内重启**对应**服务。仅执行 `dsh plugin add` 不代表运行中的进程已切换新版本。
6. 检查私聊消息往返、`/status`、`/new` 后的上下文、Web 设置保存、原生 Schedule、群聊权限和工具审批是否仍正常。
7. 如有不兼容，停止服务后从**匹配的旧版本和备份**恢复，避免只回滚 Admin 却留下与其不兼容的 Gateway 配置。

## 网络代理

在 DSH Web **飞书管理 → 模型与连接** 设置代理，按界面说明填写、测试、保存并重启。代理优先模式和失败时回退直连的行为以实际生效配置为准；测试代理连接不等于真实 WebSocket/模型调用成功。技术机制见 [代理配置说明](PROXY-CONFIG-FLOW.md)。

## 常见问题

| 现象 | 首先检查 |
| --- | --- |
| 机器人不回复 | Gateway 是否连接、飞书应用是否发布权限、是否在用户可用范围和私聊白名单中 |
| 长连接已连接但收不到事件 | `im.message.receive_v1` 订阅、应用发布、是否有第二个相同 App ID 的长连接进程 |
| 群聊没有响应 | 群策略是否启用、成员白名单、是否明确 @ 机器人、群消息权限 |
| Web 有页面但没有新数据 | 是否同时升级 Gateway 和 Admin；Gateway snapshot 是否过期；Web 服务是否仍缓存旧代码 |
| 模型可见但调用失败 | Gateway Profile 的模型提供方、凭据、模型路由；“可发现”不等于“可调用” |
| 定时任务入口不可用 | Gateway 的原生 `ctx.schedule` 是否实际挂载；任务失败与通知失败分开排查 |
| 操作提交了却没变化 | 请求可能只进入操作队列；到「运维与诊断 → 告警中心」看真正执行结果 |
| 想减少会话历史占用 | 归档和解除关联**都不会清理 DSH 历史**；真实删除/自动清理尚未实现 |

## 安全提醒

不要手动删除 `sessions.json`、`inbox.jsonl`、`outbox.json` 或未知的 DSH 原生会话文件。持久化的数据有写入者和恢复语义。Gateway 的运维信息为受认证与脱敏视图，不代表原始聊天历史的完整备份。更多见 [会话管理](SESSION-CENTER-UX.md)、[真实验收](E2E.md)。
