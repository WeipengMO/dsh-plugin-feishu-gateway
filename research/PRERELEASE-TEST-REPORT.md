# RC 发布前测试报告（Gateway + Admin）

**日期**：2026-11-18（Asia/Singapore）
**被测提交**：`cb9e02d66271717e9cda017cc8bbe56707843606`（`main`，由本地 `4ef38d6` 快进到最新 `origin/main`）
**包版本**：Gateway `dsh-plugin-feishu-gateway@0.2.0-rc.20` / Admin `dsh-plugin-feishu-admin@0.2.0-rc.28`
**运行环境**：Node `v24.22.2`、pnpm `12.18.0`（与 `packageManager` 一致）、DSH CLI `0.2.2-rc.1`
**执行者**：Team Lead `lead`（含一个独立只读复审子代理）

> 本报告只记录**实际执行并观察到输出**的 PASS；缺凭据、缺独立飞书租户、缺人工浏览器验收的项目一律写 BLOCKED / NOT TESTED，不宣称通过。
> **未执行 `npm publish`、未建立发布 tag、未改动生产 Profile、未读取或输出任何真实 App Secret / API Key。**

---

## 0. 判定摘要

| 维度 | 结论 |
| --- | --- |
| 源码 / 版本 / npm 未占用 | PASS（npm 未登录，"无权限"与"不存在"无法区分，需发布者复核） |
| CI / 双包工件门禁（§2） | PASS（本地完整复现，含额外 CI 步骤）；但注意 CI workflow 本身**没有任何 E2E 步骤**，见 §2.1 |
| tarball 人工安全检查 | PASS（无密钥、无状态文件、无越界路径） |
| 隔离环境自动化验收 | **PASS**：`e2e:daemon-smoke` 与 `e2e:mock` 3/3 全过（cross-host-resume Harness 已修复，见 §3.3） |
| 真实飞书租户 / 真实模型 / 浏览器人工 / 升级回滚 | **NOT TESTED**（无测试应用与模型凭据） |
| npm 发布权限 | **BLOCKED**（未登录，无法核对所有权 / 2FA / 令牌） |
| **综合判定（§6）** | **RC only**：功能主体、全部自动门禁与隔离环境 E2E 通过，但真实验收缺失；不得宣称可用于生产。 |

---

## 1. 源码与版本（§1）

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 最新 main / 完整 SHA | PASS | 本地快进到 `origin/main` = `cb9e02d…43606`，工作区 clean |
| Gateway / Admin 预发布版本 | PASS | `0.2.0-rc.20` / `0.2.0-rc.28`；`release:check` 校验预发布格式 |
| Node 引擎 | PASS | 声明 `>=24.9.0`，实际 `v24.22.2` |
| DSH 引擎 | PASS | 声明 `>=0.2.2-rc.1 <0.3.0-0`，实际 `dsh --version` = `0.2.2-rc.1` |
| 两包引擎一致 | PASS | `release:check`：engine 约束一致 |
| npm 目标版本未发布 | PASS（有保留） | `npm view` 两个包名均 404 → 目标版本未被占用；但 `npm whoami` 为 `ENEEDAUTH`，404 也可能是无权限，发布者须再确认包名所有权 |
| 禁止 `latest` 标签 | 未涉及 | 本次未发布；发布时必须 `--tag next` |

说明：`corepack enable` 因沙箱权限无法写 `/usr/bin/pnpm`（EACCES）而失败；系统已有 pnpm `12.18.0`，与 `packageManager` 一致，`pnpm install/run` 均正常，不构成发布门禁问题。

---

## 2. CI / 双包工件门禁（§2）

在 checkout 的干净代码上执行（依赖安装使用本地 store 绕过 `/run/user/1000` 权限限制）：

| 命令 | 结果 | 关键输出 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store-prerelease` | PASS | 锁文件一致，供应链策略 190 条通过 |
| `pnpm run verify` | PASS | `docs:check` / `typecheck` / `build` 通过；Vitest **411/411**；Web Admin `node --test` **190/190**；`node --check` 通过 |
| `pnpm run test:coverage` | PASS | 32 文件 / 411 用例；All files：语句 82.9%、分支 76.45%、函数 84.22%、行 88.58% |
| `pnpm run pack` | PASS | 生成两个 `.tgz` |
| `pnpm run release:check` | PASS | Gateway 206 条目 / 68 个相对 import；Admin 15 条目 / 14 个相对 import；生成 `release-manifest.json` 与 `SHA256SUMS` |
| `(cd dist && sha256sum -c SHA256SUMS)` | PASS | 两包均 `OK` |

额外复现 CI / Security workflow 中、`verify` 之外的步骤：

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| Proxy startup smoke（`tests/proxy-startup.smoke.sh`） | PASS | `PASS: proxy, direct fallback, Lark target and fail-closed startup` |
| ESM runtime import smoke | PASS | `LarkTransport` / `HttpsProxyAgent` v9 / Gateway 入口三处导入均 OK（覆盖 CJS interop 回归） |
| `pnpm audit --prod --audit-level=high` | PASS | `No known vulnerabilities found` |
| `pnpm audit --audit-level=critical` | PASS | 1 个 high（开发依赖），低于 critical 阈值，按 CI 策略放行 |
| `node scripts/security/check-package-contents.test.mjs` | PASS | 3/3 |
| `node scripts/security/check-package-contents.mjs dist` | PASS | 两包 archive hygiene OK |
| Gitleaks / ClamAV 扫描 | NOT TESTED（本地） | 环境未安装这两个外部工具；由 CI security workflow 覆盖，远程 CI 状态因仓库鉴权无法读取 |
| CI workflow 真实运行结果 | NOT VERIFIED | GitHub API 对当前身份返回 404（私有/鉴权），仅完成本地等价复现 |

产物哈希（`dist/SHA256SUMS`）：

```
42d46e7cc2ecb63d85e3f185b0b0b96468acdb597ef7f14500fec2b5d67dc401  dsh-plugin-feishu-gateway-0.2.0-rc.20.tgz
08c8e99a6a4d6ee24ae3a88ccc53c1f35212b21ff829f473e4ee18ad61656c99  dsh-plugin-feishu-admin-0.2.0-rc.28.tgz
```

**tarball 人工检查**：解包两包并逐项目视/检索——无 `.env` / `.npmrc` / `id_rsa` / `*.pem` / `*.key` / `sessions.json` / `admin-config.json` / credentials / `*.db` / `*.log`；无 `node_modules` 或 `.feishu-gateway` 私有目录；代码中未发现 `cli_*`、字面 `app_secret`、Bearer token 形式的明文凭据；打包后的 `package.json` 名称、版本、engines 与源码一致。检查脚本与 `release:check` 的路径规则结果一致。

### 2.1 CI 覆盖缺口（独立复审发现）

`.github/workflows/ci.yml:44-100` 包含 docs / typecheck / build / tests / coverage / pack / release:check，但**没有 `e2e:mock` 或其它 E2E 步骤**；`git log -p` 显示该文件历史中从未出现 E2E。因此“CI 通过”不能证明会话生命周期与桥接能力已验证——真实的 Session 回归可在 CI 全绿的情况下发布。`e2e:mock` 不需要真实凭据（Mock LLM + 默认 `mock-key`），成本很低，建议在下次发布前加入 CI 必跑门禁。本报告的 E2E 结果是本地手工执行的，不能归功于 CI。

---

## 3. 独立真实环境验收（§3）

### 3.1 已执行的隔离环境自动化

| 场景 | 类型 | 结论 |
| --- | --- | --- |
| `pnpm run e2e:daemon-smoke` | Mock / 离线 | **PASS**：长驻 Host 启动，health 中 `transports.default=connected`、`sessionBridge.available=true`，`errors=0` |
| `pnpm run e2e:mock` — same-host-3-turns | Mock LLM | **PASS**：三轮上下文、同 Session、recall token、bridge 序列、无错误 |
| `pnpm run e2e:mock` — isolation | Mock LLM | **PASS**：/new 与跨人场景均新建 Session，无旧文本泄漏、无串号事件 |
| `pnpm run e2e:mock` — cross-host-resume | Mock LLM | **PASS（修复后）**：新 Host 进程复用同一 `stateDir` 完成冷恢复，四项判据全 true，recall 回复为原 token；见 §3.3 |
| 双包安装（仅 Gateway） | 隔离 DSH_HOME | **PASS（部分）**：E2E Harness 用 `dsh plugin add file:<tgz>` 在临时 Profile 安装 Gateway 并成功加载；Admin 单独安装未测 |
| DSH / Cordis 加载与版本 | 隔离 DSH_HOME | **PASS（部分）**：DSH `0.2.2-rc.1` 与 engines 匹配，无版本豁免；daemon-smoke 显示插件已加载 |

### 3.2 无法在当前环境执行的最低验收项

以下均因**缺少独立飞书测试应用 / 测试模型凭据 / 已配置的 Web 测试 Profile / 浏览器人工操作**而标记 NOT TESTED或 BLOCKED；不得由 Mock 结果替代：

| §3 最低项 | 结论 | 原因 |
| --- | --- | --- |
| 飞书长连接真实收发、重启恢复、授权/未授权区别 | BLOCKED | 无飞书测试应用与 App ID/Secret |
| 真实模型三轮连续、`/models`、fallback、预设保存加载 | BLOCKED | 无测试模型凭据 |
| `/cancel` 真实停止且不重放副作用 | NOT TESTED | 仅 Mock 级覆盖 |
| Inbox/Outbox 真实网络失败恢复与不重复副作用 | NOT TESTED | 仅 Mock / 单元测试覆盖 |
| 审批允许/拒绝/超时、CardKit 流式卡片与权限 | NOT TESTED | 仅单元测试覆盖，无真实租户审批与卡片 |
| 群聊 @ 策略、白名单、跨人审批 | NOT TESTED | 无真实群聊与租户 |
| 定时任务真实触发、通知回执与历史 | NOT TESTED | 无独立测试 Profile 长驻运行 |
| Skills / Agent 档案真实工作区不改写 DSH 全局文件 | NOT TESTED | 仅单元测试覆盖 |
| 会话整理真实归档/恢复/解绑不删 DSH 历史 | NOT TESTED | 仅单元测试覆盖 |
| Web Admin 桌面/手机、浅色/深色、缩放、表单反馈人工验收 | NOT TESTED | 当前提交未做浏览器人工验收；`docs/screenshots/` 为历史截图，不作当前证据 |
| 双包带数据升级与回滚演练 | NOT TESTED | 无已安装的成对测试环境与状态备份演练 |
| Admin 包单独安装到真实 Web Profile | NOT TESTED | 仓库只有 Gateway 测试 Profile；`feishu-web-test` 需另行配置为可启动 Web 运行时 |

`e2e:preflight`（`--llm real --feishu live`）、`e2e:real-llm`、`e2e:feishu` 因缺少凭据预期返回 BLOCKED，本次未执行，以免误报 PASS 或触碰任何生产通道。

### 3.3 `e2e:mock` cross-host-resume：根因、修复与复验

**历史故障（曾 FAIL）**：`same-host-3-turns` 与 `isolation` PASS，仅 `cross-host-resume` 四项判据全 false，resume 回复为“本聊天仍绑定旧版共享 DSH 工作区的 Session…”。物证：`/tmp/e2e-h2-iyJAuK/state-probe/sessions.json` 中 workspace 仍是 home1 的 `/tmp/e2e-h1-Yo85fg/state-probe/agent-workspace`；`bridgeCalls` 只有 `dispose`、`resumeCalls` 为空，即护栏在 `bridge.resume` **之前**拒绝，绑定与会话数据未被破坏。

**根因**：`src/gateway.ts:1183` 的隔离护栏 `existing.workspace !== this.isolatedWorkspace` 有意拒绝跨身份工作区恢复；`isolatedWorkspace` 由 `stateDir` 解析（`src/agent-workspace.ts:13-30`）。旧 Harness（`scripts/e2e/run.mjs`，最后改动 `0c3434c`，早于引入护栏的 `4a66407`）把 home1 的绑定拷进全新 home2，必然命中护栏，属于测试场景过期而非产品回归。

**修复**（本次提交）：
- `scripts/e2e/run.mjs` 的 resume 场景改为**新 Host 进程 + 同一 `DSH_HOME`/`stateDir`**（真实重启语义），不再把绑定拷进不同工作区；删除无效的 `PROBE_WORKSPACE` / `PROBE_STATE_DIR` 覆盖（config 优先，见 `native-session-probe.mjs:24-30`）。
- 删除与清理前一轮结果文件的竞态：重启前删除旧 `probe-result.json`，`waitFor` 只接受 `mode === 'resume'` 的新结果。
- 把三轮与恢复结果分别复制到 `outDir/*-probe-result.json`，作为可脱敏证据保留。

**复验结果（修复后实际执行）**：
- `pnpm run build`、`pnpm run pack`、`pnpm run release:check`、`sha256sum -c` 全 PASS。
- `pnpm run e2e:mock` **3/3 PASS**：`cross-host-resume` 的 `sameSessionId` / `recallsToken` / `coldResumeUsed` / `noErrors` 全为 true，`resumeReply` 为注入的 token，证明冷恢复后上下文可用。
- `pnpm run e2e:daemon-smoke` PASS，`pnpm run verify` PASS（411 + 190 用例）。
- 说明：该场景证明的是**同一隔离工作区内的冷恢复**；跨 `stateDir` 迁移仍按设计被护栏拒绝，不在此测试范围内。产品代码未改动。

---

## 4. npm 发布权限核对（§4，只读）

| 命令 | 结果 |
| --- | --- |
| `npm whoami` | `ENEEDAUTH` — 当前机器未登录 npm |
| `npm view dsh-plugin-feishu-gateway versions / dist-tags --json` | 404 |
| `npm view dsh-plugin-feishu-admin versions / dist-tags --json` | 404 |
| 对照实验 `npm view lodash version` | `4.18.1` — registry 连通性正常 |

结论：目标版本在公共 registry 上未被占用；但无法据此确认“包不存在”还是“无权限查看”，也无法核对包名所有权、2FA 与发布令牌。**发布权限 = BLOCKED**，需发布者用有权限账号自行确认。

---

## 5. 发布判定（§6）

**RC only。**

- 不是 READY：真实飞书租户验收、真实模型 / Agent、真实群聊与定时、浏览器人工验收、带数据升级回滚、npm 发布权限均未通过；按 §3 不得写 PASS。
- 不属于 §6 的 BLOCKED 硬条件：未观察到 P0/P1 安全缺陷、DSH 安装失败、真实消息丢失/重复副作用、配置/会话不可逆损坏；本报告也未公开宣称可用于生产。
- 属于 RC only：自动门禁、功能主体与隔离环境 E2E（含修复后的冷恢复）全部通过，剩余限制为真实验收缺失、npm 权限未核对。

**独立复审确认**（只读复审子代理，HEAD `cb9e02d`）：原 FAIL 的根因结论正确，无产品回归证据；该 FAIL 单独不触发 §6 BLOCKED（无数据损坏、无消息丢失/重复副作用）。复审后已按建议修复 Harness 并重跑通过（§3.3）。仍需遵守：
- **不得升级为 READY**。若发布者对外宣称可用、或把未执行的真实验收标成 PASS，按 §6:111-112 立即转为 BLOCKED。
- RC only 的前提是 Release Notes 必须明确：真实飞书 / 真实模型 / Admin 人工验收为 NOT TESTED；真实 Host 重启恢复仅在 Mock 隔离环境验证，未做真实租户验证。

**本次额外完成**：删除 `docs/archive/` 全部 11 个历史文档，并清理 README 与相关文档中的历史说明/失效链接；`docs:check` 通过（32 个 Markdown 文件、177 条本地链接）。

**发布前必须完成（按优先级）**：
1. 在独立飞书测试应用与测试模型账号上完成 §3 最低验收，逐项记录真实/Mock 类型、SHA 与版本。
2. 把 `e2e:mock` 加入 `.github/workflows/ci.yml` 必跑门禁（当前 CI 完全没有 E2E 步骤，真实 Session 回归可能在全绿 CI 下发布）。
3. 用有权限账号执行 §4 只读核对，确认包名所有权、2FA、发布令牌与 `next` 标签策略。
4. 若决定发布 RC：使用 CI 已验收的**同一提交**重新核对 `dist/SHA256SUMS`，两包分别 `npm publish --tag next --access public`；任一失败即停止并查清哪个版本已发布，禁止对已发布版本改内容重试。
5. 发布后建立含完整 SHA 的预发布 tag / GitHub prerelease，附两个 tarball、SHA256SUMS、变更说明、兼容 DSH 版本、已知限制与本报告；安装时固定具体 RC 版本，不用 `latest`。

**原报告状态下未执行**：`npm publish`、GitHub Release / tag。

---

## 6. 实际部署安装记录（用户显式授权后执行）

- 备份：`/home/ubuntu/.dsh/backups/prerelease-upgrade-20261118-195945/dsh-state-and-profiles.tar.gz`（含 `feishu-channel-state`、`feishu-channel.env`、`profiles/feishu-channel`、`profiles/web`、`sessions`、`storages`；目录 700 / 文件 600，SHA256 已核对）。
- 安装前重新 `pnpm run pack`，确保 tarball 含清理后的文档：`release:check` 与 `sha256sum -c` 通过，Gateway tarball 195 条目（已无 `docs/archive/`）、Admin 15 条目；archive hygiene 通过。
- 安装：`dsh plugin --profile feishu-channel add dist/dsh-plugin-feishu-gateway-0.2.0-rc.20.tgz`、`dsh plugin --profile web add dist/dsh-plugin-feishu-admin-0.2.0-rc.28.tgz`。Admin 包内容与上一版 tarball 字节相同（SHA256 `08c8e99a…56c99`），pnpm 报 “Already up to date” 属正常。
- 重启：`systemctl --user restart dsh-feishu-channel.service dsh-web.service`，两个服务均 `active (running)`，启动时间 2026-11-18 20:01:19 / 20:01:20 CST。
- 验证：Gateway 盘上版本 `0.2.0-rc.20`、`/health` 为 `ok`，`transports.default=connected`、`sessionBridge.available=true`、`errors=0`、outbox pending/failed 均为 0、无活动任务与待审批；Web 监听 `100.96.140.49:3080`，未认证访问返回 `401`（预期）；Web 日志中的 `deepseek-account 403` 在重启前已存在，与本次插件升级无关。
- 仍待用户在真实飞书客户端做消息往返、`/status`、`/new`、Web 设置保存等人工冒烟；本报告不把 Mock 结果当作真实租户验收。
