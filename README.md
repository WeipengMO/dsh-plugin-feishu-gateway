# DSH Feishu Gateway

在飞书中使用 DSH Agent，并通过 DSH Web 管理机器人和会话。

插件沿用 DSH 的模型、工具和会话能力。你可以直接在飞书与 Agent 对话、运行任务，也可以在浏览器里配置机器人、查看任务状态和使用情况。

## 功能

- **飞书对话**：支持私聊、群聊、@ 机器人和独立的聊天上下文。
- **模型与 Agent**：选择主模型及备用模型、切换 Agent 预设，使用飞书专属的 Agent 档案和 Skills。
- **任务处理**：查看运行进度，通过飞书卡片处理工具审批、取消任务。
- **定时任务**：使用 DSH 原生调度，在后台管理任务，并通过飞书接收执行结果。
- **管理后台**：管理机器人与访问权限、会话历史、消息投递、Token 用量及网络代理。

飞书对话使用 DSH 原生 Session；不需要再部署一套独立的 Agent。

## 安装

需要 Node.js 24.9+、[DSH](https://github.com/deepseek-ai/deepseek-harness)、pnpm，以及一个已开启机器人能力的飞书应用。DSH 版本要求见 [package.json](package.json)。

项目由两个插件组成，分别安装到对应的 DSH Profile：

| 插件 | Profile | 用途 |
| --- | --- | --- |
| `dsh-plugin-feishu-gateway` | `feishu-channel` | 飞书消息、Agent、任务执行 |
| `dsh-plugin-feishu-admin` | `web` | DSH Web 管理界面 |

### 从源码安装

```bash
git clone https://github.com/WeipengMO/dsh-plugin-feishu-gateway.git
cd dsh-plugin-feishu-gateway
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack

GATEWAY_VERSION=$(node -p "require('./package.json').version")
ADMIN_VERSION=$(node -p "require('./web-admin/package.json').version")

dsh plugin --profile feishu-channel add "./dist/dsh-plugin-feishu-gateway-$GATEWAY_VERSION.tgz"
dsh plugin --profile web add "./dist/dsh-plugin-feishu-admin-$ADMIN_VERSION.tgz"
```

安装后按 [首次部署指南](docs/GETTING-STARTED.md) 配置飞书应用、启动 Gateway，并重启需要加载插件的 DSH 服务。

## 配置

1. 在[飞书开放平台](https://open.feishu.cn/)创建应用，开启机器人能力和长连接事件订阅。
2. 在 **DSH Web → 设置 → 飞书 Gateway** 配置 App ID 和 App Secret。
3. 在 **DSH Web → 飞书管理 → 接入与权限** 设置允许使用机器人的成员及群聊。
4. 启动飞书通道，在管理后台的「总览」检查连接状态。

飞书应用的权限与事件订阅配置详见 [飞书应用配置](docs/FEISHU-APP.md)。

## 使用

配置完成后，直接在飞书中向机器人发送消息。常用命令：

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看可用命令 |
| `/status` | 查看当前聊天与连接状态 |
| `/new` | 开始新会话 |
| `/cancel` | 取消当前任务 |
| `/models` | 查看可用模型 |
| `/model provider/model` | 切换当前会话模型 |
| `/context`、`/compact` | 查看或手动压缩上下文 |

更多命令和群聊设置见 [飞书聊天指南](docs/FEISHU-CHANNEL.md)。

在 DSH Web 左侧选择 **飞书管理**，可以编辑模型路由、Agent 档案和 Skills，查看会话、定时任务、消息投递和 Token 用量。各页面用法见 [管理后台指南](docs/WEB-ADMIN.md)。

## 文档

- [首次部署](docs/GETTING-STARTED.md) — 环境准备、安装、启动与连接验证
- [飞书应用配置](docs/FEISHU-APP.md) — 机器人权限与事件订阅
- [管理后台](docs/WEB-ADMIN.md) — 配置、会话与任务管理
- [升级与运维](docs/OPERATIONS.md) — 服务管理、备份与故障排查
- [完整文档](docs/README.md) — 其他功能与开发资料

## License

[MIT](LICENSE)
