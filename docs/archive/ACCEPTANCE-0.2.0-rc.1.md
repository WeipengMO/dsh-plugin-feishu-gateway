# 0.2.0-rc.1 最终清理与实机验收快照

- **日期**：2026-11-15（部署侧验收记录；本报告整理日期同日）
- **项目**：`WeipengMO/dsh-plugin-feishu-gateway`
- **验收基线**：`main` 提交 `0380ca4892fd55ab8775a6383c338a134d6fa90f`
- **包含变更**：PR #1、#2、#3、#4、#5 均已合并
- **GitHub CI**：主分支运行 [43670886378](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/actions/runs/43670886378) 为 success（**Mock + 构建/静态检查**；不含真实飞书租户）
- **软件版本**：Gateway `0.2.0-rc.1`、Admin `0.2.0-rc.1`
- **证据来源**：以下“实机通过”来自操作者提供的飞书与 DSH 服务端验收记录；仓库检查只独立核对了版本、PR、CI、实现字段。**未在本次 GitHub 文档清理时远程登录部署主机或重新运行实机测试。**

## 1. 部署 Profile 与持久化隔离

| 检查 | 现场结论 |
| --- | --- |
| `feishu-channel` | 只安装 Gateway 0.2.0-rc.1；重启后 `connected` |
| `web` | 只安装 Admin 0.2.0-rc.1；`feishu-gateway` 计数 = 0 |
| 原生 Session / Inbox / Outbox | 保留，未在升级时清空 |
| 通道运行时 | `errors=0` |
| Web Admin 服务端代码加载 | 新客户端曾热加载但服务器仍运行旧 0.1.0 → 保存 `streamCards` 返回 HTTP 400；**手动重启 `dsh-web.service` 后恢复正常** |

**部署注意**：前端热加载 ≠ 服务端进程已加载新管理插件。升级后检查服务端实际包版本；必要时在维护窗口重启 Web 服务，不能仅凭刷新浏览器判定新功能可用。Gateway 和 Admin 不得装错 Profile，不得启动第二个 Gateway 争夺同一 `stateDir`。

## 2. 运行配置（最终确认）

```yaml
# 以下为本次部署确认的有效配置，不是源代码默认值
streamCards: true
approvalCards: true
streamIntervalMs: 800
approvalTimeoutMs: 90000
```

- 飞书通道 Profile 的 **原生审批插件和 preset 均为 `ask`**。
- 工作区内普通工具仍按 `workspace-write` 策略运行，不因启用卡片而弹出额外审批。
- 只有 DSH 原生 `approval/request` 真正触发的沙箱权限升级等操作才显示审批卡片；插件没有自建第二套授权/工具执行系统。
- 代码默认 `streamCards=false`、`approvalCards=false`；本次通过 Admin 显式开启。
- 审批处理包括一次性授权和拒绝；卡片内容不包含完整 shell 参数、敏感路径或密钥。生产使用时必须对请求上下文另行核对。

## 3. 逐级验收记录

| 项目 | 结果 | 现场证据/说明 |
| --- | --- | --- |
| 基础私聊回归 | **PASS** | 测试1/测试2；长任务仍复用同一原生 Session |
| 旧 `/cancel` | **PASS** | 运行中 turn 标记为 `failed` 并解绑；没有额外卡片副作用 |
| 仅开启 `streamCards` | **PASS** | 长任务创建 CardKit 卡片，并实时增量更新 |
| 卡片取消按钮 | **PASS** | 回调触发取消；turn 记录 `cancelled by user`；无 CardKit 错误 |
| CardKit / callback 权限 | **PASS（当前部署）** | 卡片创建、流式更新、按钮回调均生效；本次未再次改飞书开放平台配置，功能成功说明现有权限/订阅在该环境可用 |
| 原生审批：允许一次 | **PASS** | `approval/asked → allowed-once`，测试命令 `touch /tmp/approval-test-1` 执行 |
| 原生审批：拒绝 | **PASS** | `approval/asked → rejected`，工具返回拒绝；`/tmp/approval-test-2` 不存在 |
| 最终运行状态 | **PASS** | `pendingApprovals=0`、`activeTurns=0`、`errors=0`；Session 绑定保留 |
| Web Admin 开关保存 | **PASS（重启 Web 服务端后）** | `streamCards` 与 `approvalCards` 均可保存 |

### 审批测试的重要纠正

第一次只使用 `echo` 的测试**没有触发卡片**，原因是该命令在 `workspace-write` 沙箱内运行，并不需要审批。后改为显式请求 `sandbox_permissions="danger-full-access"` 且提供 `justification`，才进入原生审批流程；审计事件已留存。这证明“没出现审批卡”不等于审批桥接失败，测试必须确实触发原生请求。

> 测试中显式请求高权限仅用于受控的审批验证，**不代表应将常规任务改为 danger-full-access**。

## 4. 未覆盖的真实场景（不标记 PASS）

| 场景 | 本次现场状态 | 已有覆盖 / 后续 |
| --- | --- | --- |
| 审批到期不响应 | **未实机测试** | 单元/集成模拟覆盖；补真实 90s 超时验证 |
| 同一卡片重复点击 | **未实机测试** | 单元/集成模拟覆盖；验证至多一次有效决策 |
| 等待审批时取消任务 | **未实机测试** | 单元/集成模拟覆盖；验证取消后旧卡片不可放行 |
| 陌生人点击审批卡片 | **未实机测试** | 单用户私聊无法构造；需第二测试账号 |
| 跨聊天点击审批卡片 | **未实机测试** | 单用户单私聊无法构造；需独立聊天/账号 |
| WebSocket 初次握手失败 | **遗留问题** | SDK 自动重连不足以证明首次握手失败后的自主恢复；需要健康看门狗和退避重连机制 |
| 真实飞书故障注入 / 长时运行 | **未覆盖** | 应单独设置恢复与持久化回归，不应从本次短时 PASS 外推 |

## 5. 安全与可靠性约束（保持不变）

1. 保持 Gateway / Admin 的 Profile 隔离，禁止把网关装进 Web。
2. 保持 `workspace-write`，原生审批策略 `ask`；授权须为单次请求，不允许仅凭卡片放宽全局沙箱。
3. `allowlist`、`open_id`、机器人/聊天/卡片消息 ID、nonce、过期状态仍作为回调判定基础；对未验证的攻击路径不能宣称实机安全通过。
4. 不上传 Secret、token、`stateDir`、聊天正文或私人审计日志到 GitHub。审计记录应由运行环境受控保存。
5. 卡片是非持久进度界面；**最终完整回复仍经 DurableOutbox**。不承诺严格 exactly-once，也不应自动重放可能已执行外部操作的 `uncertain` turn。
6. 本轮为文档整理与验收快照，不修改运行时逻辑，不主动重启 `dsh-web.service` 或 `dsh-feishu-channel.service`，不发布 npm 正式版。

## 6. 下一阶段的明确入口

**优先级 P1：首次 WebSocket 握手看门狗**。要求有限退避、最大重试间隔、恢复时单实例锁与事件订阅安全、健康状态不虚报、避免错误凭据造成无限密集重连。必须注入首连失败/网络恢复的故障测试，实机验证后才能关闭问题。

**P1：补齐真实审批边界用例**。在受控测试环境依次测试超时、重复回调、审批中取消，以及跨操作者/聊天的未授权点击；记录请求 ID 和结果，不保存敏感调用参数。

## 7. 复验入口

```bash
# 仓库自动化；CI 只用 Mock
pnpm install --frozen-lockfile
pnpm run verify
pnpm run test:coverage
pnpm run pack

# 只读检查安装目标
dsh --profile feishu-channel --dump-config
dsh --profile web --dump-config
```

真实部署需根据 [APPROVAL-STREAMING.md](../APPROVAL-STREAMING.md) 逐级验收；没有真实权限升级时，不应把“无审批弹窗”当作 PASS。历史 Mock E2E 报告见 [research/P0-E2E-REPORT.md](../../research/P0-E2E-REPORT.md)，其历史 BLOCKED 状态**不能覆盖本次真实生产会话的人工验收**，反之亦然。
