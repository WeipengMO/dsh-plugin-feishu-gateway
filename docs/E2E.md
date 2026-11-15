# 两个 P0 的端到端测试（真实商用 LLM / 真实飞书租户）

> **状态更新（2026-11-15）**：下文记载的是早期在**隔离测试 Harness 中**缺少测试专用凭据时的 BLOCKED 结果，仍适用于执行该 Harness 的前提条件；此后部署方已在独立运行的真实飞书单用户私聊环境完成原生 Session、CardKit 流式卡片/取消与工具审批允许/拒绝的**人工实机验收**。请同时参考 [验收快照](ACCEPTANCE-0.2.0-rc.1.md)。两类证据独立，不能互相冒充，也不能把未验证的异常路径标为 PASS。

> 这两个 P0 **都需要外部凭据**。本仓库提供了完整、可一键运行的测试设施；
> 凭据缺失时脚本会明确输出 **BLOCKED**（exit code 3）并列出需要提供的环境变量**名称**，
> **不会**声称通过，也**不会**读取、打印或复用任何生产凭据。

## 0. 快速状态检查

```bash
pnpm run e2e:preflight        # 真实 LLM + 真实飞书，缺什么一目了然
pnpm run e2e:mock             # 无需任何凭据：验证 harness + SessionBridge 链路
pnpm run e2e:daemon-smoke     # 无需任何凭据：验证长驻 Host 机制
```

`e2e:mock` 与 `e2e:daemon-smoke` 通过**只**证明测试设施可用，**不能**代替两个 P0。

---

## 1. P0-A：真实商用 LLM 测试

**目的**：排除「测试适配器」与真实模型的行为差异（真实模型会加散文、可能拒绝、
可能改写大小写、可能多轮后丢上下文）。

### 需要提供的环境变量（仅名称）

| 变量 | 含义 |
| --- | --- |
| `FEISHU_GATEWAY_TEST_LLM_KEY` | **专用测试** LLM 路由的 API key（不要用生产 key） |
| `FEISHU_GATEWAY_TEST_LLM_BASE_URL` | OpenAI 兼容 base URL，例如 `https://<provider>/v1` |
| `FEISHU_GATEWAY_TEST_LLM_MODEL` | 该端点上的真实模型 id |

### 运行

```bash
export FEISHU_GATEWAY_TEST_LLM_KEY='...'        # 值只在环境变量里，不写进任何文件
export FEISHU_GATEWAY_TEST_LLM_BASE_URL='https://<provider>/v1'
export FEISHU_GATEWAY_TEST_LLM_MODEL='<model-id>'
pnpm run e2e:real-llm
```

### 断言（真实模型容错）

三轮消息固定为：

1. `请记住字符串 <TOKEN>。`
2. `我上一轮让你记住了什么？`
3. `请再次重复第一轮的字符串。`

判定**不要求**逐字相等（真实模型会加散文），而是要求 **token 出现在回复中**：

- 三轮共用**同一个 Session ID**；
- Turn 1 有非空回复（确认/复述均可）；
- Turn 2、Turn 3 的回复**包含**该 token；
- `DshSessionBridge` 调用序列恰为 `create → submit → waitForReply → resume →
  submit → waitForReply → resume → submit → waitForReply → dispose`；
- 活动 `AgentHandle` 只 dispose **一次**；
- AgentRegistry / SessionStore / AgentFactory 在三轮中始终为真；
- 独立新 Host 冷恢复同一 Session ID 后仍能回答该 token；
- 超时 / 取消 / Agent 异常后均创建新 Session，旧文本不泄漏、事件不跨 Session 归因。

输出：`.tmp/e2e/session-bridge-real-<ts>/report.json`（含每项 PASS/FAIL 与回复原文）。

---

## 2. P0-B：真实飞书租户端到端

**目的**：验证消息收发、会话续接、失败反馈在真实租户中成立。

### 关键前提：必须用**长驻 Host**

`dsh-headless` 是**一次性**应用：任务一结束就 `io.exit()` → 根 fiber 卸载 →
agent factory 被清空、Session 被 detach（详见 `research/dsh-internals.md`）。
真实飞书长连接需要在「人手动发消息」期间进程一直活着，因此本测试使用
**daemon 模式**：profile 只挂 `dsh-base` + 插件（**不含** `dsh-headless`），
由 `scripts/e2e/e2e-daemon.mjs` 持有进程，并提供只绑定 `127.0.0.1` 的控制面：

| 端点 | 作用 |
| --- | --- |
| `GET /health` | `feishuGateway.health()`（transports / inbox / outbox / sessions 计数） |
| `GET /diagnostics` | `feishuGateway.diagnostics()` |
| `GET /events` | 最近 `session/event` 摘要（仅 id + type，不含消息正文） |
| `POST /shutdown` | 优雅停止，便于断言清理完成 |

### 需要提供的环境变量（仅名称）

| 变量 | 含义 |
| --- | --- |
| `FEISHU_GATEWAY_DEFAULT_APP_ID` | **专用测试自建应用**的 App ID（`cli_` + 16 hex） |
| `FEISHU_GATEWAY_DEFAULT_APP_SECRET` | 该测试应用的 App Secret |
| `FEISHU_GATEWAY_TEST_ALLOWLIST` | 测试账号 `open_id`，逗号分隔 |
| `FEISHU_GATEWAY_TEST_LLM_KEY` / `_BASE_URL` / `_MODEL` | 同上，真实 LLM 路由（若同时验证回复质量） |

### 飞书开放平台侧最小配置

1. 新建**独立测试企业自建应用**（不要用生产应用）。
2. 开启「事件订阅 → 使用长连接接收事件」，订阅 `im.message.receive_v1`。
3. 权限：接收单聊消息、以应用身份发消息（`im:message`、`im:message:send_as_bot`）。
4. 发布版本并确保测试账号在该应用可用范围内。
5. 测试账号先给机器人发一条消息，建立会话（p2p）。

### 运行

```bash
export FEISHU_GATEWAY_DEFAULT_APP_ID='cli_...'
export FEISHU_GATEWAY_DEFAULT_APP_SECRET='...'
export FEISHU_GATEWAY_TEST_ALLOWLIST='ou_...'
export FEISHU_GATEWAY_TEST_LLM_KEY='...' FEISHU_GATEWAY_TEST_LLM_BASE_URL='...' FEISHU_GATEWAY_TEST_LLM_MODEL='...'

# 启动长驻 Host，等待最多 5 分钟的真实入站消息
pnpm run e2e:feishu -- --wait-ms 300000
```

脚本启动 Host 后：

1. 等待 `/health` 报告 `gatewayProvided: true`；
2. 等待 `transports.default === 'connected'`（真实 WebSocket 建连成功）；
3. **由测试账号在飞书中依次发送三轮消息**（脚本会打印提示）：
   1. `请记住字符串 <TOKEN>。`
   2. `我上一轮让你记住了什么？`
   3. `请再次重复第一轮的字符串。`
4. 轮询 `/health` 直到 `processed >= 3`，然后断言：
   - `three-messages-processed`：3 条消息都被处理；
   - `no-gateway-errors`：`errors === 0`；
   - `inbox-durable`：`inbox.done >= 3`（先持久化后执行）；
   - `outbox-delivered`：`outbox.pending === 0`（回复已发出）；
   - `session-bound` 与 `single-session-per-chat`：`boundSessions === 1`（三轮会话续接在同一 Session）。

输出：`.tmp/e2e/feishu-<ts>/report.json`，以及 `host.log`（已脱敏：不打印 Secret）。

### 无法脚本化的部分（如实说明）

- 发送消息需要**测试账号本人**在飞书中操作；或用 `FEISHU_GATEWAY_TEST_USER_ACCESS_TOKEN`
  以用户身份调用 `im/v1/messages` 脚本化发送（该变量可选）。
- 断言「回复文本包含 token」需要读取 outbound 内容；`/health` 只给计数，
  因此当前 `e2e:feishu` 断言的是**投递与续接**，回复文本请人工在飞书中确认，
  或结合 `e2e:real-llm`（同一 SessionBridge 路径）交叉验证。

---

## 3. 设计约束（为什么这样写）

- **隔离**：每次运行创建独立 `mktemp -d` 的 `DSH_HOME`，`dsh plugin add` 安装构建产物；
  绝不触碰 `~/.dsh`、`web` profile、`dsh-web.service`、DSH Core。
- **凭据**：只从环境变量读取；生成的 `cordis.patch.yml` 只写**变量名**；
  报告只记录变量**名称**与存在性。
- **探针独立 stateDir**：`native-session-probe` 自己创建 `FeishuGateway`，
  因此使用 `<stateDir>-probe`，避免与插件的独占 `.owner.lock` 冲突。
- **无硬编码答案**：mock LLM 无状态，只从请求历史抽取 token；真实 LLM 由模型自行回答，
  断言只检查 token 是否出现在回复中。

## 4. 已知边界

- 真实飞书服务端对非 200 ACK 的重推、>1h `uuid` 去重窗口，仍无法在脚本中断言。
- 真实模型的延迟/限流可能导致 `replyTimeoutMs` 不足；必要时用
  `--reply-timeout-ms`（默认 30000）调整。
- daemon 模式的进程保活由测试插件负责；生产部署应使用常驻进程管理器
  （systemd 等），而不是本测试插件。
