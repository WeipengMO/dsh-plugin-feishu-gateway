# 配置飞书应用（长连接模式）

本指南针对飞书开放平台的企业自建应用，用于让 DSH Feishu Gateway 收发机器人消息。平台 UI 与权限名称可能更新，以飞书开发者后台实际显示为准。

## 1. 创建机器人应用

1. 前往 [飞书开放平台](https://open.feishu.cn/app)（国际版可使用 [Lark 开放平台](https://open.larksuite.com/app)），创建企业自建应用。
2. 为应用开启 **机器人** 能力，获取 App ID 与 App Secret，并将密钥存储在服务器受保护的环境文件或 Web Admin 凭据写入入口。
3. 在事件订阅中选择 **使用长连接接收事件**，订阅 `im.message.receive_v1`。
4. 在权限管理中申请消息接收与机器人发送所需权限，**发布应用新版本**并完成组织要求的审核。
5. 将需要使用机器人的账号加入应用可用范围。

长连接不需要公网 Webhook 地址；**同一个 App ID 不应在多个 Gateway 进程中同时运行 WebSocket 消费者**，否则事件接收可能冲突。

## 2. 消息与交互权限

| 能力 | 通常涉及的权限/配置 |
| --- | --- |
| 接收用户消息 | `im.message.receive_v1` 事件与对应消息读取权限 |
| 机器人发送消息 | `im:message:send_as_bot` 等发送权限 |
| 私聊 | 单聊消息读取授权与用户可用范围 |
| 群聊要求 @ | 群 @ 消息读取权限、机器人能识别自己的结构化 mention |
| 群聊全部消息 | 对应的群消息读取权限与群策略，需显式开放 |
| CardKit 操作/审批 | `card.action.trigger` 相关事件、卡片能力及后台权限 |

具体作用域取决于飞书应用类型及开放平台版本。可参考 [群聊管理](GROUP-CHAT.md)、[审批与流式卡片](APPROVAL-STREAMING.md)。**保存 Gateway 配置不能代替飞书开放平台的权限发布。**

## 3. 配置凭据与白名单

将凭据写入 `~/.dsh/feishu-channel.env`（权限 `0600`）或通过 DSH Web 设置中的安全写入入口配置。示意：

```text
FEISHU_GATEWAY_DEFAULT_APP_ID=cli_替换成实际AppID
FEISHU_GATEWAY_DEFAULT_APP_SECRET=替换成实际AppSecret
```

在 DSH Web **飞书管理 → 接入与权限** 配置允许接入的用户 `open_id`；空白名单为**全部拒绝**，不是公开模式。**不要通过故意清空白名单来探测用户 ID**，应使用有权限的飞书管理/通讯录或合法身份查询途径获取。

群聊默认拒绝；只有显式开启并通过成员授权和消息权限检查才处理群消息。

## 4. 验证

- Gateway 与 Admin 分别安装在 `feishu-channel` 和 `web`，通道实际连接。
- `im.message.receive_v1` 已订阅；应用权限已发布、用户在可用范围中。
- 未启动第二个共用 App ID 的长连接消费者。
- 在已授权私聊发送 `/status` 和普通消息，验证收到回复，连续对话保留上下文。
- CardKit/审批、群聊和定时任务需要分别验收真实权限和回调；CI 中的 SDK Mock 不能取代真实飞书 API 验证。

更多问题见 [首次部署](GETTING-STARTED.md) 和 [排障](OPERATIONS.md)。
