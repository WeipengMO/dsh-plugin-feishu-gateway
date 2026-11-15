# 飞书管理工作台运行及部署（Admin 0.2.0-rc.5）

飞书独立身份/记忆工作区与旧共享数据清理见 [AGENT-PROFILE-ISOLATION.md](AGENT-PROFILE-ISOLATION.md)，编辑器操作见 [AGENT-PROFILE-MANAGER.md](AGENT-PROFILE-MANAGER.md)，现有运维后台说明见 [OPERATIONS-CONTROL-CENTER-V2.md](OPERATIONS-CONTROL-CENTER-V2.md)。本文件保留旧 Web Admin 的部署、systemd 和安全配置说明。**当前 DSH 设置页面仅供飞书 Gateway 凭据写入；所有运行概览、模型、机器人列表、白名单与服务操作均在左侧「飞书管理」中。**

# 旧版 Web Admin 部署说明（历史操作）

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

- `dsh-plugin-feishu-gateway-0.2.0-rc.7.tgz`（运行通道；取消重复回复）
- `dsh-plugin-feishu-admin-0.2.0-rc.5.tgz`（Web 管理插件，含原生侧栏工作台）

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
dsh plugin --profile feishu-channel add "./dist/dsh-plugin-feishu-gateway-0.2.0-rc.5.tgz"

# 运维后台需要 Admin 0.2.0-rc.3，旧版必须升级：
dsh plugin --profile web add "./dist/dsh-plugin-feishu-admin-0.2.0-rc.3.tgz"
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

---

## 定时任务（Issue #19，开发分支，新增）

> 本节描述 `feat/scheduled-tasks` 分支新增的 Web Admin「定时任务」页，属于**开发分支能力**，
> 尚未在真实飞书租户 / DSH Web 上复验；不改变上文历史部署与验收结论。完整功能说明、
> 原生 API 依据与验证清单见 [SCHEDULED-TASKS.md](SCHEDULED-TASKS.md)，字段以
> [SCHEDULE-API-CONTRACT.md](SCHEDULE-API-CONTRACT.md) 为准。

入口：DSH 左侧栏 **飞书管理 → 定时任务**（工作台导航项 `['schedule', '定时任务', '⏱']`，
`SchedulePanel`）。页面管理的是 **DSH 原生 `ctx.schedule` 任务**；Gateway 只跨 Profile 桥接
管理命令并把结果投递到飞书，**不自建 Cron 引擎**。`ctx.schedule` 未挂载时页面显示明确的
「原生定时服务不可用」，不假装任务存在，也不回退到自建调度器。

### 接口

所有端点位于既有 `/api/feishu-admin`，统一经过现有 `security(req, reject)`：

| Method | Path | 请求体 | 返回 |
| --- | --- | --- | --- |
| GET | `/schedule` | — | `{ ok:true, model }` = 脱敏后的只读模型 |
| POST | `/schedule/preview` | `{ spec, count }` | `{ ok:true, occurrences:[ISO], summary }`（纯计算、无副作用） |
| POST | `/schedule/commands` | 规范化命令字段 | `202 { ok:true, command:{ id, type:'schedule' } }` |
| GET | `/schedule/results` | — | `{ ok:true, commands:[...] }`（近期 schedule 命令结果） |

`spec` 是统一的 `ScheduleSpec`（`once` / `every` / `daily` / `weekly` / `monthly` / `cron`；
wall-clock 类必须带显式 `timeZone`），`count` 限定 `1..10`，返回前 `count` 个严格未来的
UTC ISO 触发点。`web-admin/src/schedule-spec.mjs` 与 Gateway `src/schedule/spec.ts` 必须
校验同一批输入；title ≤ 120、prompt ≤ 4000、`everySeconds ≥ 60`。

### 命令与结果语义

- `POST /schedule/commands` 经 `queueOperatorCommand` 扩展支持 `type:'schedule'` 的有界
  `schedule` 对象，配合 `serializeMutation` 串行写入 `ops-control/requests/<uuid>.json`：
  schedule 命令上限 **8192 字节**，其余命令维持原 1024 字节上限。
- `actor` 由**服务端**写入（**绝不取自请求体**），为有界标签（≤ 64 字符）。
- `action` 取值：`create` / `update` / `pause` / `resume` / `run` / `delete` /
  `delete-inactive` / `refresh`；`create` 必须带 `clientRef`（用于在原生 task id 产生前预留
  Gateway 自有 Session id），`update` 可带 `expectedUpdatedAt` 做乐观并发冲突检测，
  `delivery: null` 清除飞书投递配置。
- 返回 `202 queued` **只表示命令已入队，不等于执行成功**；最终结果通过
  `GET /schedule/results` 轮询，状态为 `completed` / `rejected` / `not-found` /
  `conflict` / `error`。`OperatorResult` 可附带 ≤ 200 字符的 `detail`（稳定码/短文本，
  **无密钥、无原始异常正文**）；`readOpsResults()` 白名单放行 `type:'schedule'` 并保留
  `detail`。
- **Web Admin 不是信任边界**：Gateway 侧对命令载荷始终重新校验（`validateSpec`、
  `validateFeishuTarget`），越权目标在投递前被拒绝。
- 所有载荷有界：读模型 ≤ 200 任务 / 每任务 ≤ 20 deliveries / ≤ 200 runs / ≤ 200 audit，
  文件 ≤ 1 MiB。

### 只读模型

Gateway 发布 `stateDir/ops-schedule.json`（原子写、0600、version 1）作为**脱敏读模型**：
`available`、`reason`、`limits.newSessionIntervalSeconds`、`tasks`、`deliveries`、`runs`、
`audit`。`web-admin/src/schedule-read.mjs` 以与 `ops-read.mjs` 相同的严格白名单读取
（`lstat`、拒绝 symlink、≤ 1 MiB、version 校验、有界字符串、不回显原始异常文本），
**从不读取 `inbox.jsonl` / `outbox.json` / `sessions.json`**。注意 `tasks[].prompt`
**包含 prompt 文本**，因此该模型只对已认证管理员会话开放。

### 安全规则

- 复用 DSH Web 原生会话认证 + 同源 / CSRF 校验（`security(req, reject)`）：写操作要求
  `content-type: application/json` 与 `x-dsh-feishu-admin: 1`；未登录、跨站 Origin、
  缺少请求头一律拒绝。**不新增任何监听端口**，跨 Profile 只经本机同 Unix 账户、0600 的
  `ops-control` 命令邮箱。
- 飞书投递目标只能从 `GET /state` 返回的**已配置机器人、白名单用户与已启用群**中选择；
  当前策略会拒绝的群直接拒绝。Gateway 在每次投递前再次以 `MessageRouter` 等价的白名单 /
  群策略做权威复核（`validateFeishuTarget`），目标持久化在 `schedule-delivery.json` 旁路。
- 每个命令追加一条审计到 `stateDir/schedule-audit.jsonl`：actor / 时间 / action / taskId /
  状态 / 参数摘要，**从不写入 prompt 正文、密钥、飞书原始 ID、工具参数或原始异常**；
  读模型内 audit 有界（≤ 200 条）。
- 不绕开 DSH 原生工具审批、白名单或 Agent 沙箱；审批决策仍完全由 DSH 控制。
