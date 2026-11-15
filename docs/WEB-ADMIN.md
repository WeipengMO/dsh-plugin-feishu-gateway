# 飞书通道可视化后台（DSH Web 设置页）

## 目标

在现有 DSH Web 的「设置」中新增 **飞书通道** 项，配置模型、工作目录、白名单、机器人、凭据；查看实时健康/消息数量；通过 systemd 重启独立飞书通道。**不修改 DSH Core，也不把真实飞书机器人挂载到 web Profile。**

架构：

```text
DSH web Profile
 └─ dsh-plugin-feishu-admin（仅管理服务 + settings.section UI）
      ├─ /api/feishu-admin/*（DSH 原生 Cookie 认证和 Origin/CSRF 保护）
      ├─ 读取 127.0.0.1:18095/health（不向外网开放）
      ├─ 原子写 ~/.dsh/feishu-channel-state/admin-config.json (0600)
      ├─ 单向写 ~/.dsh/feishu-channel.env (0600)
      └─ systemctl --user restart dsh-feishu-channel.service

独立 feishu-channel Profile
 └─ dsh-plugin-feishu-gateway
      ├─ 在启动时叠加 admin-config.json（允许字段校验）
      ├─ 原生 DSH Sessions + Feishu WebSocket/REST
      └─ 独占 ~/.dsh/feishu-channel-state
```

工具审批和流式任务卡片默认关闭；在开启前请先阅读 [APPROVAL-STREAMING.md](APPROVAL-STREAMING.md) 的权限申请、测试及回滚步骤。

## 前提与限制

1. **同一 Ubuntu 主机、同一 Unix 用户**运行 Web Profile 与 feishu-channel；管理插件默认读写该用户 HOME 下的上述文件。不同用户/主机需要额外的代理与访问控制，当前不支持。
2. 飞书通道原本已在本机监听仅限环回的健康端点 `127.0.0.1:18095`。Web 管理插件不创建任何新监听端口。
3. 管理页面使用与本仓库 `dsh-plugin-remote-ssh` 相同的官方客户端插槽 `settings.section` 和 `settings.section.icon`，目标 DSH `0.2.2-rc.1`。已在真实 DSH Web Profile 验证两项卡片开关保存：先遇到服务端缓存旧 0.1.0 导致 HTTP 400，手动重启 dsh-web.service 后新服务端加载并可成功保存。见 [验收快照](ACCEPTANCE-0.2.0-rc.1.md)。
4. `feishu-channel.env` 的 App Secret 只支持**写入更新，不支持回显**。模型服务提供方密钥继续由原 DSH 凭据库管理。
5. `admin-config.json` 只覆盖允许的配置字段，其他字段包括 `allowGroups`、`stateDir`、沙箱与审批策略继续由原 Profile 管理。
6. 独立的 `feishu-channel` Gateway **启动时**读取托管配置，不动态注入到活跃 DSH 会话。

## 1. 构建、测试并打包

```bash
cd /path/to/dsh-plugin-feishu-gateway
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack
ls -lh dist/*.tgz
```

构建产物为两个独立 tarball：

- `dsh-plugin-feishu-gateway-0.2.0-rc.1.tgz`（运行通道）
- `dsh-plugin-feishu-admin-0.2.0-rc.1.tgz`（Web 管理插件）

**绝不要将 Gateway 的 tarball 安装到 `web` Profile**：它的 Bundle patch 会插入真正的飞书 Gateway。Web Profile 只安装 `dsh-plugin-feishu-admin`。

## 2. 准备 systemd 用户服务（仅管理飞书通道）

如果此前使用 `--daemon` 启动了飞书通道，先按当前仓库文档检查并停止该旧后台进程；不可让 systemd 与 `--daemon` 两个进程共用同一个 `stateDir`。

先核对通道正常启动命令：

```bash
scripts/channel/start-feishu-channel.sh --status
dsh --profile feishu-channel --dump-config
```

用户服务示例（`ExecStart` 路径按实际克隆位置修改）：

```ini
[Unit]
Description=DSH Feishu Channel
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/dsh-workspace
ExecStart=%h/dsh-workspace/projects/dsh-plugin-feishu-gateway/scripts/channel/start-feishu-channel.sh
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
```

保存为 `~/.config/systemd/user/dsh-feishu-channel.service`，并执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-feishu-channel.service
systemctl --user status dsh-feishu-channel.service --no-pager
```

如果不是通过 systemd 用户服务运行，页面的“重启”按钮会返回明确错误；配置仍可安全保存。**不要同时使用 daemon PID 管理和 systemd 管理。**

## 3. 更新两个 Profile（避免相互影响）

```bash
# 安装真正的网关，只进入飞书 Profile
dsh plugin --profile feishu-channel add "./dist/dsh-plugin-feishu-gateway-0.2.0-rc.1.tgz"

# 管理插件，只进入 Web Profile
dsh plugin --profile web add "./dist/dsh-plugin-feishu-admin-0.2.0-rc.1.tgz"
```

重新读取各 Profile 的配置，验证 `web` 中只增加 `feishu-channel-admin`、没有 `feishu-gateway`：

```bash
dsh --profile web --dump-config
dsh --profile feishu-channel --dump-config
```

**只在确认 Profile patch 无误后**按维护窗口重启对应服务。不能通过 GitHub 合并自动更新正在运行的进程；已加载的 JS 模块也不会因文件更新自动热替换。

## 4. 验收

1. DSH Web 设置 → **飞书通道**，应显示连接状态、消息统计、原生 SessionBridge 状态。
2. 修改白名单或超时时间，点击保存；检查 `~/.dsh/feishu-channel-state/admin-config.json` 为 0600，页面提示“需重启”。
3. 点击“重启飞书通道”，检查 `systemctl --user status dsh-feishu-channel.service` 与 `http://127.0.0.1:18095/health`。
4. 飞书私聊发送 2–3 轮消息，验证仍使用同一个原生 Session，消息计数增加。
5. 将「AI 回复格式」切到 Markdown 后重启飞书通道，发送包含代码块/表格的问题，确认飞书按富文本显示；切回普通文本后确认回归正常。
6. 未登录 Web 的请求、跨站 Origin、缺少请求头、无效 open_id、非法文件路径、注入包含换行符的 Secret 均应拒绝。
7. 确认 `dsh-web.service` 并未因飞书通道重启而被重启。

## 安全性

- 使用 `webServer.register` 和 `connection.requestRejection`，沿用 DSH Web 的原生用户认证；不额外开放后台端口。
- 写操作必须带同源请求、`application/json` 和 `x-dsh-feishu-admin: 1`。
- App Secret 不回显、不写入日志；凭据文件仅 0600；拒绝多行 Shell 注入。
- 仅允许启动预设 systemd 用户服务，不接受客户端传入命令、路径或服务名。
- 状态和凭据文件均需为普通文件，拒绝目标目录 symlink；管理配置损坏时拒绝继续覆写。
- 服务独立运行；只有单进程可以拥有 Gateway 的 stateDir。

**当前状态（2026-11-15）**：原生工具审批卡片桥接与流式任务卡片已在单用户私聊中实机通过；它们不再是待开发功能。尚未覆盖的是审批超时/重复操作/跨操作者的真实租户测试、群聊、Web 端全局管理权限分层、多租户/跨机器管理、systemd 未安装时的按钮替代实现。这些不应与本次同机单用户 MVP 混为一谈。
