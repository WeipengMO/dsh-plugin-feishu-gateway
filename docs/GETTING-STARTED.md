# 首次部署 DSH 飞书插件

本指南用于 **DSH Web 和 Gateway 安装在同一主机、同一 Unix 用户** 的场景。已有正式部署时请读 [升级和运维](OPERATIONS.md)，不要覆盖现有状态目录。

## 1. 准备环境

- DSH 版本满足 [Gateway engines.dsh](../package.json) 和 [Admin engines.dsh](../web-admin/package.json)，Node.js `>=24.9.0`，安装 pnpm。
- 在飞书开放平台创建企业自建应用，添加机器人能力，采用**长连接接收事件**，订阅 `im.message.receive_v1`。使用 CardKit 操作时还需配置对应卡片事件和权限。
- 应用取得所需消息权限并**发布生效**，将允许使用的用户添加到可用范围。
- 不要让两个进程同时消费同一个 App ID 的 WebSocket 长连接。

完整的事件、权限与平台操作见 [飞书应用配置](FEISHU-APP.md)；群聊独立见 [群聊管理](GROUP-CHAT.md)。

## 2. 构建两个独立安装包

```bash
git clone https://github.com/WeipengMO/dsh-plugin-feishu-gateway.git
cd dsh-plugin-feishu-gateway
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack

GATEWAY_VERSION=$(node -p "require('./package.json').version")
ADMIN_VERSION=$(node -p "require('./web-admin/package.json').version")
```

**注意**：上面命令构建的是当前检出的 Git 分支，不代表 npm 的正式发布版本。不要把开发分支的功能或版本直接当作生产发布。

```bash
dsh plugin --profile feishu-channel add "./dist/dsh-plugin-feishu-gateway-$GATEWAY_VERSION.tgz"
dsh plugin --profile web add "./dist/dsh-plugin-feishu-admin-$ADMIN_VERSION.tgz"
dsh --profile feishu-channel --dump-config
dsh --profile web --dump-config
```

核对 `web` Profile 中只有 Admin，`feishu-channel` 中只有 Gateway。不要同时在 `web` 中运行第二个 Gateway。首次 Profile 配置请参照仓库 [示例 patch](../cordis.patch.yml) 和 [测试 Profile 指南](TEST-PROFILE.md)；**不要直接照抄其他用户的绝对路径或机器人 ID**。

## 3. 配置凭据与访问范围

可以通过 **DSH Web → 设置 → 飞书 Gateway** 安全写入应用凭据，也可以由独立服务环境提供：

```text
FEISHU_GATEWAY_DEFAULT_APP_ID=cli_替换为你自己的AppID
FEISHU_GATEWAY_DEFAULT_APP_SECRET=替换为你自己的AppSecret
```

运行脚本支持从 `~/.dsh/feishu-channel.env` 加载这些变量。实际密钥**不要**写进 README、Git 仓库、日志或浏览器截图。限制文件权限为 `0600`。

在「飞书管理 → 接入与权限」配置允许使用机器人的用户 `open_id`。空白名单意味着拒绝接收私聊，不是对所有人开放。群聊默认关闭，需要单独启用，且有成员白名单与 @ 要求。

## 4. 启动通道

项目提供一个长期运行的启动脚本，支持以下只读状态和运行命令：

```bash
scripts/channel/start-feishu-channel.sh --status
scripts/channel/start-feishu-channel.sh           # 前台调试运行
```

长期运行推荐使用 **一个** systemd 用户服务，具体示例见 [运维手册](OPERATIONS.md)。不要同时运行脚本的 `--daemon` 模式和 systemd；同一个 `stateDir` 只能由一个 Gateway owner 管理。

## 5. 验证真实连接

1. 检查 Gateway 的 `transports.default` 是否为 `connected`，或在本机查询 `http://127.0.0.1:18095/health`。
2. 在已授权的飞书私聊向机器人发送 `/status` 和一条普通消息，确认收到回复。
3. 连续发送两条消息，确认同一聊天的上下文得到复用；发送 `/new` 后新对话应与旧历史分离。
4. 进入 DSH Web 左侧 **飞书管理**，核对连接状态、机器人、消息投递和会话管理。
5. 若启用卡片、群聊或定时任务，分别进行真实事件、权限与操作验收；模拟测试不能替代真实租户验证。

## 6. 后续使用

- [Web 管理](WEB-ADMIN.md)：管理界面、命令、状态和操作含义。
- [日常运维](OPERATIONS.md)：升级、备份、代理、服务控制、日志。
- [会话历史](SESSION-CENTER-UX.md)：归档、恢复和关联的区别。
- [定时任务](SCHEDULED-TASKS.md)：原生 Schedule 与飞书通知。
