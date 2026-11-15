# DSH Feishu Gateway

将飞书 / Lark 私聊接入 **DSH 原生 Session / Agent** 的独立 Cordis 插件；配套 Web Admin 提供通道状态和配置管理。没有第二套 Agent 或 LLM 服务，也不要求修改 DSH Core。

**当前 Gateway：`0.2.0-rc.4` · Admin：`0.2.0-rc.1`** · DSH `>=0.2.2-rc.1 <0.3.0-0` · Node.js `>=24.9.0`

> **2026-11-15 实机验收结论**：原生 Session 复用、飞书消息收发、`/cancel`、CardKit 流式卡片与取消按钮、原生 `allowed-once` / `rejected` 工具审批，在现有单用户飞书私聊部署中通过。此处的实机结论来自部署侧记录，不等于 CI 自动验证真实租户。见 [0.2.0-rc.1 验收快照](docs/ACCEPTANCE-0.2.0-rc.1.md)。

## 部署架构与隔离

| DSH Profile | 只安装 | 作用 |
| --- | --- | --- |
| `feishu-channel` | `dsh-plugin-feishu-gateway` | 飞书 WebSocket、消息路由、持久化、原生 Session、卡片与审批 |
| `web` | `dsh-plugin-feishu-admin` | DSH Web「飞书通道」设置和受保护管理 API；**不运行 Gateway** |

Gateway 单独升级到 `0.2.0-rc.4`，现有 Admin `0.2.0-rc.1` 继续兼容，无须重复安装 Web Admin。不要把 Gateway 安装进 `web`；升级后的客户端热加载不保证 Web 服务端代码也已换代，服务端仍缓存旧代码时可能对新增字段返回 400。应在确认维护窗口并保存状态后重启相应服务，然后验证配置读写。

持久化的 **Inbox、Outbox、Session 绑定**和环境变量凭据在升级时保留，不要清空 `stateDir`。同一 `stateDir` 只允许一个 Gateway 进程持有。

## 已实现

- 飞书长连接和白名单私聊、收发消息、去重与持久化 Inbox/Outbox、崩溃后保守恢复。
- 通过 DSH `ctx.agents` 创建、复用和恢复原生 Session；不另建模型/工具执行引擎。
- `/help`、`/status`、`/cancel`、`/new` 私聊控制命令；`/cancel` 不回滚已经执行的外部操作。
- 入站纯文本型 `post` 富文本；可选 `post/md` Markdown 回复。图片和文件双向传输仍未实现。
- DSH Web 管理面板：白名单、模型、机器人、回复格式、凭据写入、通道健康和独立服务重启。
- 可选 CardKit 流式任务卡片、取消按钮、DSH 原生工具审批卡片。**0.2.0-rc.2 起，Card 模式成功时直接在原卡片显示最终完整答案与模型/Token/速度/用时底栏，不再额外发送相同的文本；完成后取消按钮自动消失。`0.2.0-rc.3` 起，底栏按行展示模型、**Token 总用量**、速度和用时；速度根据 DSH 已有的输出 Token 与流式生成时长计算，不额外请求模型，缺少有效时长则隐藏速度。`0.2.0-rc.4` 起，底栏使用 **12px 灰色辅助信息**，与原样的回答正文形成视觉区分。** 如卡片创建/更新失败或超出卡片大小限制，回退到 DurableOutbox 文本回复。

## 当前已验收的运行配置

| 设置 | 值 |
| --- | --- |
| `streamCards` | `true` |
| `approvalCards` | `true` |
| `streamIntervalMs` | `800` |
| `approvalTimeoutMs` | `90000` |
| `feishu-channel` 的原生审批插件及 preset | **`ask`** |
| Agent 沙箱 | **`workspace-write`**；正常工作区内工具无需逐次审批 |
| 触发审批的操作 | 需要提升沙箱权限并触发 DSH 原生 `approval/request` 的操作 |

源码中的两个卡片开关**默认仍为 `false`**，上述 `true` 是此次部署的显式管理配置，不是全局默认变更。审批决策由原生 DSH 控制：只授权当前请求的 `allowed-once`，拒绝或超时不放行；卡片只是入口，不能绕过原生策略。审批卡片仅显示工具名称，**不展示完整命令参数**，不要在不了解操作内容时盲目授权。

操作说明：[审批与流式卡片](docs/APPROVAL-STREAMING.md) · [Web Admin](docs/WEB-ADMIN.md) · [飞书通道](docs/FEISHU-CHANNEL.md)。

## 构建、验收与安装

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run test:coverage
pnpm run pack
```

生成的文件（只需为已有部署升级 Gateway）：

- `dist/dsh-plugin-feishu-gateway-0.2.0-rc.4.tgz`
- `dist/dsh-plugin-feishu-admin-0.2.0-rc.1.tgz`

只升级运行通道 Profile；Admin 保持现有安装即可：

```bash
dsh plugin --profile feishu-channel add "./dist/dsh-plugin-feishu-gateway-0.2.0-rc.1.tgz"
dsh --profile feishu-channel --dump-config
dsh --profile web --dump-config
```

**0.2.0-rc.4 的灰色辅助信息与卡片底栏布局尚未经过真实飞书租户复验**；先使用隔离测试环境验证全量 CardKit PUT 与终态按钮移除，再安排生产升级。**安装命令本身不代表运行服务已更新。** 应检查实际 DSH Host / Web 服务端已重启加载新包、通道已连接、Web 配置保存成功，并按 [逐级验收流程](docs/APPROVAL-STREAMING.md) 验证。不可在未安排维护窗口时随意重启有在途任务的服务。

GitHub [CI](.github/workflows/ci.yml) 执行类型检查、构建、Mock 单元/集成、安全测试、覆盖率与打包；**CI 不接入真实飞书租户**。历史实机验收记录见 [0.2.0-rc.1 验收快照](docs/ACCEPTANCE-0.2.0-rc.1.md)，卡片行为见 [0.2.0-rc.2 交付说明](docs/CARD-DELIVERY-0.2.0-rc.2.md)，新版底栏参见 [0.2.0-rc.3 说明](docs/CARD-FOOTER-0.2.0-rc.3.md)；灰色小字见 [0.2.0-rc.4 说明](docs/CARD-FOOTER-0.2.0-rc.4.md)。

## 安全边界与剩余工作

私聊只接收白名单 `open_id`；默认拒绝群聊；App Secret 通过环境变量注入且 Web Admin 不回显。部署时请保护 `~/.dsh/feishu-channel.env` 和 `stateDir`，并维持最小权限。

**仍待实机验证**：审批超时、重复点击、审批中取消、陌生人或跨聊天卡片点击（已存在模拟/集成测试，不能替代真实租户）。**已知问题**：飞书 WebSocket 初次握手失败可能无法自行恢复，需要健康看门狗/重连兜底。状态监控和异常通知列入后续工作。

更多文档：[架构](docs/ARCHITECTURE.md) · [兼容性](docs/COMPATIBILITY.md) · [飞书开发者后台](docs/FEISHU-APP.md) · [测试 Harness](docs/E2E.md) · [后续路线图（含历史计划）](docs/ROADMAP-v0.2.0.md)。

开发早期的完整调查和测试过程保留在 [research/](research/) 与 [历史 README](docs/archive/README-v0.1.0-history.md)，请勿把其历史状态当作当前验收结论。

MIT License。
