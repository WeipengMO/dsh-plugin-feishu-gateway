# Agent 档案与长期记忆管理（Gateway 0.2.0-rc.7 / Admin 0.2.0-rc.6）

> **飞书专用目录隔离**：新版不会修改普通 DSH 工作区的身份/记忆文件。独立 cwd、旧共享托管区块安全清理与旧 Session /new 的具体说明参见 [飞书 Agent 身份隔离与迁移指南](AGENT-PROFILE-ISOLATION.md)。

## 定位与入口

本功能位于 **DSH 左侧栏 → 飞书管理 → Agent 档案**，不是新的 DSH 全局左侧导航项，也不属于「高级配置」。它管理的是 **运行中的 Feishu Gateway 创建原生 DSH Session 时使用的实际工作区**，不复制 DSH Agent、Session 或聊天记录。

**DSH 设置 → 飞书 Gateway** 仍然只管理飞书应用凭据。**飞书管理 → 高级配置** 仍然管理模型、机器人、工作目录、超时与安全参数。

## 页面功能

| 入口 | 关联文件 | 说明 |
|---|---|---|
| 身份与人格 | IDENTITY.md、SOUL.md、USER.md | Agent 名称、风格、边界及用户偏好 |
| 工作规则 | AGENTS.md、TOOLS.md | DSH 工作规范与环境约定；AGENTS.md 继续由 DSH 原生加载 |
| 长期记忆 | MEMORY.md | 跨会话的重要事实和长期决策 |
| 每日记忆 | memory/YYYY-MM-DD.md | 按日期选择、创建、编辑、追溯；**不自动注入上下文** |
| 预览 | 「预览」标签页 | 只渲染 Markdown 的安全文本结构，不执行 HTML 或脚本 |
| 历史 | 「版本历史」标签页 | 最近 30 个版本、时间、修订摘要和一键恢复（恢复前二次确认） |
| 加载控制 | 「加载配置」标签页 | 勾选纳入上下文的五种档案文件、总/单文件 UTF-8 字节预算及同步详情 |

编辑器采用 **双栏布局（左侧文件列表 + 右侧单一工作区）**，右侧切换「编辑 / 预览 / 版本历史 / 加载配置」，支持 Ctrl/⌘+S 保存、文件搜索、移动端折叠列表、离开工作台前提醒未保存草稿、冲突拒绝、文件未创建状态和同步反馈；深浅主题随 DSH 切换。管理面板顶部显示真实的 Workspace、是否待同步、已加载文件数量和上下文字节数。**多个飞书机器人共享一个专用 Feishu Gateway Workspace 时会共享档案内容**，本版不假装提供独立机器人隔离。

## 真正让 SOUL / MEMORY 进入 DSH 上下文

DSH 原生 \`@deepseek-ai/dsh-agent-instructions\` 默认读取 \`AGENTS.md\`、\`CLAUDE.md\`、\`AGENTS.local.md\` 和 \`CLAUDE.local.md\`，但 **不会仅因为 SOUL.md 或 MEMORY.md 存在而自动读取它们**。

官方文档：[DSH agent-instructions](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md)。

为了**不修改 DSH Core，也不将不可审计的隐藏文字直接附加到聊天消息**，本功能使用原生指令文件：

1. 运营人员编辑、保存 \`SOUL.md\`、\`IDENTITY.md\`、\`USER.md\`、\`TOOLS.md\` 或 \`MEMORY.md\`。
2. Web Admin 从 Gateway **实时快照**中确认实际 Workspace（不是浏览器传入任意路径）。
3. 读取勾选的非空 Markdown，按总预算与单文件预算截断，生成明确标记的托管内容。
4. 原子同步到工作区 **\`AGENTS.local.md\`** 中专属段落：

   \`\`\`text
   <!-- DSH-FEISHU-AGENT-PROFILE:BEGIN -->
   ## 飞书 Agent 档案（DSH 自动加载的工作区指令补充）
   ...
   ### SOUL.md
   ...
   ### MEMORY.md
   ...
   <!-- DSH-FEISHU-AGENT-PROFILE:END -->
   \`\`\`

5. **已有 AGENTS.local.md 的其他文字原样保留**；同步时只替换两个专属标记之间的区块。如果边界不完整或重复，拒绝写入而不是覆盖。
6. DSH **新创建的原生 Session** 在首次有效请求时自动加载这份指令链。用户可以在飞书发送 \`/new\` 创建新 Session 来应用更改。

重要边界：

- **这不是对当前运行中 Session 的热更新。** DSH 原生指令插件有自己的更新/重载触发规则，Web Admin 从进程外修改文件不能保证立刻刷新一个正在执行的 Session。页面显示“新 Session 生效”；保存成功不代表已推送到每一个现有上下文。
- 如果特定 DSH Profile **关闭了 dsh-agent-instructions**，该机制不会自动加载；必须启用 DSH 原生指令插件才能生效。Web Admin 不会绕过它。
- \`AGENTS.md\` 由 DSH 原生按工作区链直接读取，不会再次塞入生成区块，避免重复加载。
- 每日 \`memory/YYYY-MM-DD.md\` 只供 Agent 通过正常文件工具按需读取，不加入自动加载区块，避免每天积累的日记耗尽上下文。
- **字节预算 ≠ Token 预算**。选中的文件进入模型请求后将消耗正常输入 Token；后台文件管理和同步过程不调用 LLM，也不额外启动 Agent。

## 文件与权限安全

后端的受控文件范围严格限定为：

\`\`\`text
<Gateway 实际 workspace>/
├── AGENTS.md
├── IDENTITY.md
├── SOUL.md
├── USER.md
├── TOOLS.md
├── MEMORY.md
├── AGENTS.local.md        ← 自动同步区块（后台不会开放任意编辑此文件）
└── memory/
    └── YYYY-MM-DD.md     ← 只允许合法 ISO 日期命名
\`\`\`

- 不允许浏览或保存任意绝对/相对服务器路径。拒绝 \`../\`、其他文件扩展名以及工作区外位置。
- 工作区路径只接受 Gateway 的最新 \`ops-runtime.json\` 快照；没有运行中的 Gateway 或快照超过 15 秒时返回 503，而不是猜测或使用网页输入路径。
- 工作区及目标文件会检查真实目录、符号链接和大小。拒绝符号链接工作区、链接文件与链接记忆目录。
- 单个 Markdown 文件最高 **24 KiB**；默认总指令预算 **16,000 字节**，单文件 **6,000 字节**，可在 UI 内调整至总量最高 32 KiB。
- 文件保存时检查服务端 SHA-256 修订；其他进程或管理员更改同一文件后，旧版本提交会返回 **409**，不能覆盖新内容。
- 文件使用临时私有文件 + fsync + 原子 rename 写入，权限为 0600；历史记录最多保留 30 个，放在 \`<stateDir>/agent-profile-history/<filename-hash>/\` 中。
- 旧内容的恢复只接受历史记录中的命名修订，恢复前也检查当前文件版本，避免覆盖外部修改。
- 不把档案文本存入运维事件日志、Inbox/Outbox 审计 DTO 或上传到 GitHub。**版本历史是服务器上的真实副本**，可能包含敏感个人资料；备份与迁移时需要保护整个 \`stateDir\`。
- \`USER.md\`、\`MEMORY.md\` 的用户信息会成为模型上下文。不要把密码、Token、私钥、完整凭据或不应提供给模型的敏感信息写入这些文件。
- 系统、开发者指令、工具审批及安全沙箱不会被这些工作区上下文文件覆盖。

## API 接口

所有接口使用既有 \`/api/feishu-admin\` 前缀；**每次请求**由 DSH Web Session 授权。写接口仍需同源保护、JSON Content-Type 和 \`x-dsh-feishu-admin: 1\` 请求头。没有新监听端口。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | \`/agent-profile\` | 工作区、受控文件列表、设置、加载状态、待同步状态 |
| GET | \`/agent-profile/file?name=SOUL.md\` | 返回单个 Markdown 内容与 SHA-256 revision |
| PUT | \`/agent-profile/file\` | \`{name,content,expectedRevision}\`；保存、历史快照、同步 |
| GET | \`/agent-profile/history?name=MEMORY.md\` | 最近 30 个历史版本（不返回全文） |
| POST | \`/agent-profile/restore\` | \`{name,id,expectedRevision}\`；恢复、再次快照、同步 |
| PUT | \`/agent-profile/settings\` | \`{settings,expectedRevision}\`；加载启停及预算 |
| POST | \`/agent-profile/sync\` | \`{}\`；手动同步到原生指令文件 |

前端不会把文件内容放到 URL 参数中；历史查询只读取明确允许的路径。服务端返回的文件内容仅供当前 DSH 已授权用户使用；不要开放无认证的代理读取这些端点。

## 升级与回滚

版本：**Gateway \`0.2.0-rc.6\`、Web Admin \`0.2.0-rc.4\`**。

在 **确认没有重要运行中任务的维护窗口**中执行：

\`\`\`bash
cd /path/to/dsh-plugin-feishu-gateway
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack

# 两个 Profile 都要升级；不要将 Gateway 安装到 web Profile
dsh plugin --profile feishu-channel add \
  "$PWD/dist/dsh-plugin-feishu-gateway-0.2.0-rc.7.tgz"

dsh plugin --profile web add \
  "$PWD/dist/dsh-plugin-feishu-admin-0.2.0-rc.6.tgz"
\`\`\`

备份原有 \`AGENTS.md\`、\`AGENTS.local.md\`、\`SOUL.md\`、\`USER.md\`、\`MEMORY.md\` 和 Gateway \`stateDir\` 后，使用服务器实际的 systemd user 服务名称分别重启 Web Profile 和 Feishu Profile。不要清空原有 Inbox、Outbox、Session、工作目录和环境变量。

注意：即使新版 Web Admin 已安装，也只有 **Gateway rc.7** 才会在运维快照中报告准确的 \`workspace\`；只升级 Web Admin 时「Agent 档案」应显示“Gateway 工作区不可用”，不会退回猜测路径。

**回滚**：在停止相关任务后回滚两只插件到上一个已验证版本；托管的 \`AGENTS.local.md\` 区块仍是普通 DSH 指令内容。若不再需要自动注入，可在新版后台关闭所有加载开关并同步，或在停机备份后人工移除两个标记之间的区块；不要直接删除其他手写内容。现有身份/记忆 Markdown 文件不会被安装或回滚自动清除。

## 实机验收清单

1. 左侧「飞书管理 → Agent 档案」能显示与 Gateway 实际使用的 Workspace 一致的绝对路径，多个机器人共享时有提示。
2. 在没有 \`SOUL.md\` 的工作区中新建该文件；保存后确认真实文件与 \`AGENTS.local.md\` 中的托管内容。
3. 若原有 \`AGENTS.local.md\` 已存在，验证托管内容前后的手写规则均保持原样。
4. 修改 SOUL / USER / MEMORY 的加载开关和预算，检查「已加载文件」和截断信息确实随之变化；停用后从 \`AGENTS.local.md\` 删除托管副本，但不删除源文件。
5. 在飞书发送 \`/new\` 创建全新 DSH Session，使用非敏感、可验证的测试人格文本确认上下文加载；**不要以旧 Session 的回话判断新内容已经生效**。
6. 创建每日 \`memory/YYYY-MM-DD.md\`，确认它不会自动进入 \`AGENTS.local.md\`，只有明确文件读取时才会使用。
7. 修改文件两次，选择历史版本恢复。验证当前文件先进入历史；用旧 \`expectedRevision\` 修改时返回 409。
8. 用不受支持的文件名、符号链接目标和无登录请求验证拒绝访问；关闭 Gateway 后应无法使用旧快照写入文件。
9. 检查 Profile 文件、历史快照及托管覆盖层没有进入普通网关日志；没有额外 LLM 调用。所选上下文引入的**正常输入 Token**可以从新 Session 的实际 usage 统计观察。

## 下一步扩展点（未实现）

- 多机器人 / 多 Agent 独立 Workspace 的选择器：必须先与 DSH 原生 Session workspace 路由保持一致，本版只管理唯一的 Gateway Workspace。
- 面向长期记忆的全文搜索、条目标签、手动从每日笔记提炼摘要：未来需要独立的索引与权限管理；当前只提供真实 Markdown 编辑和日期文件列表。
- 对已有运行中 Session 的刷新：必须使用 DSH 正式支持的 Session 指令重载机制，**不能通过隐形用户消息强制注入指令**。
- 与 DSH 原生记忆/指令管理的共享组件适配：可将后端模块复用至其他渠道，但需要处理共享目录访问控制。
