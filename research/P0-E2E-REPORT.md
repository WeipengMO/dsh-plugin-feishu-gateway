# P0 推进报告：真实飞书租户 E2E / 真实商用 LLM

**日期**：2026-11-15（Asia/Shanghai）
**分支**：`fix/gateway-reliability-idempotency`（PR #1，**未合并**）
**起点提交**：`7102193`

## 1. 结论先行

| P0 | 状态 | 原因 |
| --- | --- | --- |
| 真实飞书租户端到端 | **BLOCKED** | 环境无任何专用测试 App 凭据（`FEISHU_GATEWAY_DEFAULT_APP_ID` / `_APP_SECRET` / 测试 `open_id` 均 ABSENT） |
| 真实商用 LLM | **BLOCKED** | 环境无任何测试 LLM 路由（`FEISHU_GATEWAY_TEST_LLM_KEY` / `_BASE_URL` / `_MODEL` 均 ABSENT） |
| 测试设施（两项共用的前置能力） | **已完成并实测通过** | `e2e:mock` PASS、`e2e:daemon-smoke` PASS |

**没有把 Mock 测试通过当作 P0 通过。** 两个 P0 都停在「只差凭据」的最后一步，
凭据一到位即可一条命令执行；缺凭据时脚本明确返回 **BLOCKED（exit 3）** 并列出
所需环境变量的**名称**。

## 2. 本轮交付物

| 文件 | 作用 |
| --- | --- |
| `scripts/e2e/lib.mjs` | 纯逻辑核心：凭据门禁（只处理变量名）、profile patch 生成、结果判定（真实模型容错） |
| `scripts/e2e/setup.mjs` | 创建隔离 `DSH_HOME` + 测试 profile + 安装构建产物 + 链接 `dsh-llm` |
| `scripts/e2e/run.mjs` | 编排：`preflight` / `session-bridge` / `daemon-smoke` / `feishu` |
| `scripts/e2e/e2e-daemon.mjs` | 测试专用长驻 Host（保活 + 127.0.0.1 控制面） |
| `scripts/e2e/lib.d.mts` | 供 TS 测试使用的类型声明 |
| `tests/unit/e2e-lib.test.ts` | **20 个**纯逻辑单测（凭据门禁、patch 生成、判定逻辑） |
| `docs/E2E.md` | 两项 P0 的完整执行手册（含飞书开放平台最小配置、手动发消息流程、断言清单） |
| `.env.example` / `README.md` / `package.json` | 变量名清单、入口说明、`e2e:*` 脚本 |

## 3. 关键技术问题与解决

### 3.1 真实飞书长连接需要「长驻 Host」，`dsh-headless` 做不到

`dsh-headless` 是一次性应用：任务结束即 `io.exit()`（`dsh-headless/lib/index.js:383`）
→ 根 fiber 卸载 → `agents.factory` 被清空（`dsh-agent/lib/index.js:558-567`）、
Session 被 detach（`dsh-session/lib/index.js:1576-1578`）。
真实飞书场景需要在**人工发消息期间进程一直存活**。

**解决**：daemon 模式 profile 只挂 `dsh-base` + 插件（**不含** `dsh-headless`），
由 `e2e-daemon.mjs` 持有进程生命周期，并暴露只绑定 `127.0.0.1` 的控制面
（`/health`、`/diagnostics`、`/events`、`/shutdown`）。
实测：`gatewayProvided=true`、`transports.default=connected`、
`sessionBridge.available=true`、`/shutdown` 后 `E2E_DAEMON_STOPPED` 正常打印。

### 3.2 探针与插件争抢同一个 `stateDir`

探针自己创建 `FeishuGateway`，与 profile 中的插件实例共享 `stateDir` 时，
上一轮加入的**独占 `.owner.lock`** 会（正确地）拒绝第二个实例：
`stateDir ... is already owned by a running Feishu gateway`。

**解决**：生成的 patch 给探针分配独立的 `<stateDir>-probe`。
这反过来**验证了 F1 的修复在真实运行时确实生效**。

### 3.3 真实模型的断言不能逐字相等

真实商用模型会加散文、改写大小写、甚至用 markdown 强调。
**解决**：`evaluateThreeTurns` 断言「回复**包含** token（大小写不敏感）」，
而不是 `=== token`；同时保留结构化断言（同一 Session ID、调用序列、handle 只 dispose 一次、
三服务在线）。已用「模型加散文」的用例覆盖（`tests/unit/e2e-lib.test.ts`）。

### 3.4 凭据绝不落盘

- 生成的 `cordis.patch.yml` 只写环境变量**名**（`apiKeyEnv` / `appIdEnv` / `appSecretEnv`）；
- 报告只记录变量**名称**与存在性；
- 单测显式断言：序列化后的报告不包含任何凭据**值**、patch 中不出现 `appSecret: "..."`。

## 4. 实测证据（无凭据部分）

### 4.1 `pnpm run e2e:mock` → PASS（exit 0）

```
"status": "PASS",
"same-host-3-turns": PASS  { turns, sameSessionId, firstTurnAcknowledged,
                             secondTurnRecalls, thirdTurnRecalls, bridgeSequence,
                             handleDisposedOnce, servicesLive, noErrors }
"cross-host-resume": PASS  { sameSessionId, recallsToken, coldResumeUsed, noErrors }
"isolation":         PASS  { allScenariosPresent, allCreateNewSession,
                             noOldTextLeaked, noCrossAttributedEvents }
sessionId: feishu-default-oc_r2-session-...
replies: ["已记录：请记住字符串 <TOKEN>。", "<TOKEN>", "<TOKEN>"]
resumeReply: "<TOKEN>"
```

三个 Host 各自独立 `mktemp -d`，Host 2 复制 DSH `sessions/` + `storages/` 与
Gateway `sessions.json` 后冷恢复同一 Session ID。

### 4.2 `pnpm run e2e:daemon-smoke` → PASS（exit 0）

8 项检查全 PASS：gateway service provided、host stays alive、
offline transport connected、native session bridge available、event stream served、
graceful shutdown accepted、shutdown teardown logged。

### 4.3 两个 P0 的 BLOCKED 行为

```
$ node scripts/e2e/run.mjs session-bridge --llm real      → exit 3
  BLOCKED — missing: FEISHU_GATEWAY_TEST_LLM_KEY, FEISHU_GATEWAY_TEST_LLM_BASE_URL,
                     FEISHU_GATEWAY_TEST_LLM_MODEL

$ node scripts/e2e/run.mjs feishu --llm real              → exit 3
  BLOCKED — missing: <上述 3 个> + FEISHU_GATEWAY_DEFAULT_APP_ID,
                     FEISHU_GATEWAY_DEFAULT_APP_SECRET, FEISHU_GATEWAY_TEST_ALLOWLIST
```

## 5. 完整回归（本轮改动后）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | lockfile 校验通过 |
| `pnpm run typecheck` | 0 | — |
| `pnpm run build` | 0 | — |
| `pnpm run test` | 0 | **15 文件 / 143 测试**（新增 20 个 e2e-lib 单测） |
| `pnpm run test:coverage` | 0 | **92.59% / 82.15% / 87.15% / 92.59%** |
| `pnpm run pack` | 0 | 产出 tgz |
| `pnpm run verify` | 0 | 143 测试通过 |
| `pnpm run demo "你好，请介绍一下自己"` | 0 | 正常回复 |
| `pnpm run demo "你好" ou_stranger` | 0 | 正确拒绝 |
| `node scripts/fault-injection.mjs` | 0 | `{"PASS":9}` |

## 6. 凭据到位后的执行步骤（最小化）

### P0-A 真实商用 LLM

```bash
export FEISHU_GATEWAY_TEST_LLM_KEY='<测试 key>'
export FEISHU_GATEWAY_TEST_LLM_BASE_URL='https://<provider>/v1'
export FEISHU_GATEWAY_TEST_LLM_MODEL='<model-id>'
pnpm run e2e:real-llm
```

### P0-B 真实飞书租户

1. 飞书开放平台新建**独立测试自建应用** → 开启长连接事件订阅
   `im.message.receive_v1` → 授予 `im:message` 权限 → 发布并对测试账号可见。
2. ```bash
   export FEISHU_GATEWAY_DEFAULT_APP_ID='cli_...'
   export FEISHU_GATEWAY_DEFAULT_APP_SECRET='...'
   export FEISHU_GATEWAY_TEST_ALLOWLIST='ou_...'
   export FEISHU_GATEWAY_TEST_LLM_KEY='...' FEISHU_GATEWAY_TEST_LLM_BASE_URL='...' FEISHU_GATEWAY_TEST_LLM_MODEL='...'
   pnpm run e2e:feishu -- --wait-ms 300000
   ```
3. 脚本启动长驻 Host 并等待 `transports.default === 'connected'` 后，
   由测试账号在飞书中依次发送三条消息（脚本会打印提示与 TOKEN）。
4. 断言：3 条消息均被处理、`errors === 0`、`inbox.done >= 3`、
   `outbox.pending === 0`、`boundSessions === 1`（会话续接在同一 Session）。

## 7. 如实声明的边界

- **P0-A / P0-B 均未执行**（无凭据），状态为 BLOCKED，不是 PASS。
- `e2e:mock` 与 `e2e:daemon-smoke` 通过**只**证明测试设施与 SessionBridge 链路可用。
- `e2e:feishu` 的自动断言覆盖**投递、持久化、会话续接、错误计数**；
  「回复文本包含 token」需要人工在飞书确认，或与 `e2e:real-llm`（同一 SessionBridge 路径）交叉验证。
- 真实飞书服务端对非 200 ACK 的重推、>1h `uuid` 去重窗口，仍无法脚本化断言。
- 本轮未修改 DSH Core、未使用 `allow-version`、未合并 PR、未发布 npm。
- **`web` profile 说明（透明记录）**：`~/.dsh/profiles/web/cordis.patch.yml` 的 mtime 在
  00:37 发生变化，但**内容结构与本轮之前完全一致**（仍为 `ui-settings-general` /
  `llm-pi-ai(magpie)` / `agent-default-model` 三行），且 `grep -cE 'mock-route|e2e|native-session-probe|FEISHU_GATEWAY_TEST_LLM'`
  为 **0** —— 不含任何本轮测试产物。本轮所有 `dsh` 调用都显式设置了隔离的 `DSH_HOME`；
  该 mtime 变化来自正在运行的 `dsh web` 进程自身对设置文件的持久化，不是本轮写入。
  `dsh web`（PID 943668）全程正常运行。
