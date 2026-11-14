# 飞书测试应用配置说明

> **本项目不会连接任何现有正式飞书应用。** 本文档描述如何**新建一个专用于测试的**
> 企业自建应用，并把它接到独立的 `feishu-gateway-test` profile（见 [TEST-PROFILE.md](TEST-PROFILE.md)）。
> 本次交付没有创建飞书应用、没有使用任何真实凭据、没有做真实端到端验证。

以下信息中关于 SDK 行为的部分来自
`@larksuiteoapi/node-sdk@1.76.0` 自带的类型声明与 README（见 [../research/references.md](../research/references.md) §4/§5）；
开放平台控制台的具体文案以你当天的界面为准。

---

## 1. 创建测试应用

1. 打开飞书开放平台 `https://open.feishu.cn/app`（国际版用 `https://open.larksuite.com/app`）。
2. 「创建企业自建应用」→ 命名例如 `DSH Gateway Test (dev)`，图标随意。
3. 记录 **App ID**（形如 `cli_` + 16 位十六进制）和 **App Secret**。
   - 长连接模式要求自建应用的 `appId` 满足该格式，否则 `WSClient.start()` 会直接返回；
     本插件在 `connect()` 时会打一条脱敏告警（不打印 id 本身）。
4. **不要**把这两个值写进 `cordis.patch.yml`、`.env` 之外的任何文件，更不要提交到 Git。

---

## 2. 开启机器人能力

「应用能力」→「添加应用能力」→ **机器人**。关闭 / 不配置「事件订阅的回调 URL」，
本插件使用**长连接（WebSocket）**，不需要公网 IP、域名或 Webhook 地址。

---

## 3. 事件订阅（长连接模式）

「事件订阅」→ 订阅方式选择 **「使用长连接接收事件」**（SDK ≥ 1.24.0 支持）。

添加事件：

| 事件 | 用途 | v0.1.0 是否必需 |
| --- | --- | --- |
| `im.message.receive_v1` | 接收用户私聊消息 | ✅ 必需 |
| `card.action.trigger` | 卡片按钮回调 | ❌ v0.2.0 卡片/审批才用 |

长连接模式的已知限制（来自 SDK README 与调研报告）：

- **只支持事件订阅，不支持回调订阅**；
- **同一个 App ID 只能有一个长连接消费者**：多个客户端同时连同一个 app 时，飞书会随机挑一个投递，
  且两者互相冲突。所以测试期间：**不要让现有正式应用 / 其它飞书插件与测试应用共用同一个 App ID**，
  也不要在两个 profile 里同时启用同一个 bot；
- 卡片回调（`card.action.trigger`）在长连接下按**事件**注册即可，不是 HTTP callback；
- 事件处理必须在约 **3 秒内返回**，否则飞书会重推。本插件的事件处理器**不 await**
  模型调用：先由 `DurableInbox` 落盘、再异步驱动原生 Session，因此能快速 ACK。
  （代价：落盘前进程崩溃会丢该条消息；v0.2.0 的确认式 ACK 会补齐。）

---

## 4. 权限（API 权限 / 作用域）

在「权限管理」申请并**发布版本**使权限生效。常用项（以控制台实际名称为准）：

| 权限 | 用途 |
| --- | --- |
| `im:message` / 获取与发送单聊、群组消息 | 接收消息事件 |
| `im:message:send_as_bot` | 以机器人身份发消息 |
| `im:message.p2p_msg:readonly` | 读取用户发给机器人的单聊消息 |
| `im:resource` | v0.2.0 图片/文件下载才需要 |

v0.1.0 只需要「接收私聊文本 + 以机器人身份回复」。群聊相关权限
（如 `im:message.group_msg` / `im:message.group_at_msg`）**不需要申请**，因为本版本硬编码拒绝群聊。

> 权限变更后必须**创建版本并发布**（企业自建应用通常需要管理员审核），否则长连接能连上但
> 事件/发送接口会返回权限错误。

---

## 5. 可用范围与白名单

1. 「应用发布」→「可用范围」把测试账号加入可见范围；否则机器人收不到该用户的私聊。
2. 获取测试账号的 `open_id`：
   - 飞书管理后台 / 通讯录里查；
   - 或临时把 `allowlist` 留空、启动后看插件 debug 日志中记录的 `senderId`；
   - 或用 `lark-cli` 的联系人查询能力按姓名解析 `open_id`。
3. 把 `open_id` 填入测试 profile 的 `cordis.patch.yml`：

```yaml
- id: feishu-gateway
  config:
    allowlist:
      - ou_这里换成你的测试账号open_id
```

`allowlist` 为空 = **拒绝所有入站消息**（fail closed），这是刻意设计，避免误把机器人暴露给全公司。

---

## 6. 注入凭据并启动

```bash
export FEISHU_GATEWAY_DEFAULT_APP_ID='cli_xxxxxxxxxxxxxxxx'
export FEISHU_GATEWAY_DEFAULT_APP_SECRET='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

# 用独立 profile，不要用 web
dsh --profile feishu-gateway-test
```

生产/长期运行请用 systemd `Environment=` 或容器 secret 注入，**不要**把密钥写进仓库。
插件解析凭据的优先级：

1. 配置里的 `appIdEnv` / `appSecretEnv` 指定的变量名；
2. 隐式的 `FEISHU_GATEWAY_<BOT_ID_UPPER>_APP_ID` / `_APP_SECRET`；
3. 配置里的字面量（**仅本地开发**，不推荐）。

日志只打印来源名（如 `env:FEISHU_GATEWAY_DEFAULT_APP_SECRET`），**从不打印密钥值**。

---

## 7. 验证清单（真实凭据场景）

```
[ ] App ID 形如 cli_ + 16 hex，且是「企业自建应用」
[ ] 已开启机器人能力、已选择「使用长连接接收事件」
[ ] 已订阅 im.message.receive_v1
[ ] 已申请并发布 im:message / im:message:send_as_bot 等权限
[ ] 测试账号在应用可用范围内
[ ] 同一个 App ID 没有其它长连接消费者
[ ] allowlist 填了测试账号的 open_id
[ ] profile 是 feishu-gateway-test，不是 web
[ ] 环境变量已注入，日志显示 credentials resolved from env:...
[ ] 私聊发一条文本，日志出现 transport default -> connected / created native DSH session ...
[ ] 收到机器人回复
```

如果日志出现 `incompatible-version`，说明 `engines.dsh` 与运行的 DSH 版本不匹配 —— **不要**
用 `dsh plugin allow-version` 绕过，应升级插件或 DSH 版本。

---

## 8. 常见故障

| 现象 | 可能原因 |
| --- | --- |
| `WSClient` 立刻返回、无连接 | App ID 格式不对 / 未开启长连接接收事件 / 应用未发布 |
| 事件收不到 | 未订阅 `im.message.receive_v1`、权限未发布、测试账号不在可用范围、同一 App ID 被别的进程占用 |
| 发送返回 `code != 0` | 缺 `im:message:send_as_bot`、权限未发布、机器人不在会话中 |
| 消息重复 | 长连接重连重推；`DedupIndex` 会按 `message_id` 去重，若仍重复检查 `dedupTtlMs` |
| 发送超时 / 代理报错 | Node ≥18 + `http_proxy` 时 axios 可能报 `Protocol "https:" not supported`；可在部署层清空代理变量，或在 v0.2.0 显式关闭 SDK http 实例的代理 |
| 群聊无响应 | **预期行为**：v0.1.0 硬编码关闭群聊 |

---

## 9. 合规边界

- 不要使用现有正式飞书应用的 App ID / Secret。
- 不要把凭据写进 `~/.dsh/profiles/web/` 或任何会被提交的文件。
- 不要修改 DSH Core 或现有 Web 配置。
- 没有真实凭据时，用 `offline: true` 跑 Mock（见 TEST-PROFILE.md §5A），
  **不要声称完成真实端到端验证**。
