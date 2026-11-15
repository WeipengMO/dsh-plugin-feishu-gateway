# 飞书 Agent 档案独立化（Gateway 0.2.0-rc.7 / Admin 0.2.0-rc.6）

## 目标

**飞书 Channel 的 `SOUL.md`、`MEMORY.md`、`IDENTITY.md`、`USER.md`、`TOOLS.md`、`AGENTS.md`、`AGENTS.local.md` 与普通 DSH 工作区分离。**

修改飞书 Agent 人格和记忆，不会向普通 DSH Session 的默认上下文写入新内容；普通 DSH 新 Session 也不会因为在飞书管理后台编辑档案而自动继承这些文件。

本功能隔离的是 **Agent 工作区、自动加载指令与 Session 上下文**，不等于 Unix 账号或操作系统级文件权限隔离。两个服务若用同一 Linux 用户运行，具备相应文件权限的工具仍可能通过绝对路径访问其他目录。若要求完全不可相互访问，需要额外的 Unix 用户、不同权限或 DSH 沙箱策略。

## 1. 实际目录布局

```text
/home/ubuntu/dsh-workspace/              # 旧/普通 DSH 工作目录
├── AGENTS.md
├── AGENTS.local.md                       # 普通 DSH 指令（不再写入）
├── SOUL.md                               # 如果以前已有，保持原样
└── MEMORY.md                             # 如果以前已有，保持原样

/home/ubuntu/.dsh/feishu-channel-agent/   # 飞书专用 Agent 目录（示例）
├── AGENTS.md
├── AGENTS.local.md                       # 飞书专属自动生成片段
├── IDENTITY.md
├── SOUL.md
├── USER.md
├── TOOLS.md
├── MEMORY.md
└── memory/
    └── 2026-11-15.md

~/.dsh/feishu-channel-state/
├── sessions.json                         # 原生 DSH Session 的飞书映射
├── ops-runtime.json                      # 向 Web Admin 声明飞书实际 cwd
└── agent-profile-history/                # 飞书档案历史快照
```

以上是典型布局，实际路径以飞书管理后台「Agent 档案」顶部展示的 **飞书专属工作区** 为准。

默认路径选择规则：

- 若 `stateDir/agent-workspace` 与旧 `workspace` 完全不重叠，默认使用该目录。
- 若原 `stateDir` 在旧工作区内部（例如原默认 `<cwd>/.feishu-gateway`），使用 `$HOME/.dsh/feishu-channel-agent` 作为备用独立目录。
- 在「飞书管理 → 高级配置 → 模型与配置」中可明确设置绝对路径 `agentWorkspace`。**不能与旧 `workspace` 相同、作为其父目录，或位于其子目录内**；否则启动会拒绝。
- 启动前检查独立目录的符号链接和真实位置；不允许通过符号链接间接回到旧 DSH 目录。
- 专用目录创建权限 0700，档案文件 0600；管理 API 的文件名白名单、修订冲突、历史快照与加载预算继续有效。

本次保留旧 `workspace` 配置作为兼容/旧项目位置记录，**不再把它传给新建的飞书原生 Session**。新建 Session 的 `cwd` 现在是飞书专用的 `agentWorkspace`。相对路径的工具操作也会以这个新目录为工作位置；需要访问原项目时应使用绝对路径，并确认 DSH 沙箱允许该操作。请留意这项行为变化。

## 2. 指令如何加载？

- 飞书 Gateway 调用 DSH 原生 `ctx.agents.create` 时，`meta.cwd` 设置为飞书专属目录。
- `AGENTS.md` 由 DSH 原生 `dsh-agent-instructions` 在**飞书目录**中读取。
- 飞书后台把勾选且非空的 `SOUL.md`、`IDENTITY.md`、`USER.md`、`TOOLS.md`、`MEMORY.md` 生成的片段写入**飞书目录中的** `AGENTS.local.md`，而不是普通 DSH 的文件。
- `memory/YYYY-MM-DD.md` 不自动加入上下文，需由 Agent 通过正常工作区工具按需读取。
- 修改后需创建新的飞书 Session 生效。已有运行中 Session 不会被替换提示词。每个飞书机器人仍共享本 Gateway 的专属目录，本版没有多机器人独立人设。
- 原生指令加载插件必须在飞书 Profile 中启用，否则即使写入文件也不会被自动读取。

## 3. 升级旧版本：避免普通 DSH 继续看到旧飞书指令

旧版 rc.6 的「Agent 档案」可能已把飞书内容写入普通 DSH 工作区的 `AGENTS.local.md`。**仅将新版本改成独立目录，不会使该旧片段自动消失**。因此本版还提供明确的迁移检查：

1. 升级两个插件、备份原 DSH `AGENTS.local.md` 及相关 `SOUL.md`、`MEMORY.md` 和 Gateway `stateDir`。
2. 进入「飞书管理 → Agent 档案」，确认顶部显示新的飞书独立目录。
3. 如后台发现旧目录中包含由本插件生成的 `<!-- DSH-FEISHU-AGENT-PROFILE:BEGIN -->` / `END` 区块，将显示 **「发现旧版共享指令」**。
4. 如果希望普通 DSH 新 Session 不再使用该内容，点击 **「备份并移除旧共享区块」**，阅读确认提示后执行。后端再次检查文件 SHA-256 修订，先将**旧文件全文备份**到 `stateDir/agent-profile-legacy-backups/`，然后**只删除两个标记之间的托管区块**，原文件其余字节保持不变。
5. 旧目录中的 `SOUL.md`、`MEMORY.md`、`AGENTS.md` 等**不会自动复制、移动或删除**。需要飞书复用的内容，请在确认安全后**手动复制到飞书专属档案**，再勾选加载并保存。
6. 在飞书聊天发送 `/new`；旧绑定 Session 会保留于 DSH 历史中，但本版**不会继续恢复没有独立 cwd 标记的旧会话**。这避免它们继续继承旧 DSH 工作区。新消息会先提示你发送 `/new`，而不是悄悄换掉原 Session 的历史。
7. 普通 DSH 若已有旧会话在内存中包含了历史上下文，修改磁盘文件无法撤销已加载的内容。请新建**普通 DSH Session**才能验证完全退出旧提示词。

没有发现旧托管块时，后台不会修改普通 DSH 的 `AGENTS.local.md`。

**不要直接删除原 DSH 工作区或记忆文件。** 旧版共享工作区可能还有其他用户规则、代码和笔记。

## 4. 配置和版本

Web Admin 受保护配置字段 `agentWorkspace` 支持单独设置飞书 Agent 专用 cwd，例如：

```json
{
  "agentWorkspace": "/home/ubuntu/.dsh/feishu-channel-agent"
}
```

如果留空，Gateway 会按上面的规则自动选择。原 `workspace` 字段作为旧目录标识，不作为飞书新 Session cwd 使用。修改该配置需要重启飞书 Gateway。

升级候选包：

```bash
cd /path/to/dsh-plugin-feishu-gateway
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack

dsh plugin --profile feishu-channel add \
  "$PWD/dist/dsh-plugin-feishu-gateway-0.2.0-rc.7.tgz"
dsh plugin --profile web add \
  "$PWD/dist/dsh-plugin-feishu-admin-0.2.0-rc.6.tgz"
```

在无重要执行中任务的维护窗口，根据服务器**实际** systemd unit 名称分别重启服务；不要重复启动多个 Gateway、也不要清空 `sessions.json` 或 `Inbox/Outbox`。

**重要**：分离 Agent cwd 可能受到飞书 Profile 的沙箱工作区白名单限制。如果新目录位于 Host 允许范围之外，必须按 DSH 官方机制配置该专用 Profile 的工作目录或文件权限。不要通过关闭沙箱或放宽所有工具权限的方式解决。

## 5. 验收

1. 飞书 Agent 页的目录 **不是** 普通 DSH 工作区，且没有父子关系。
2. 修改飞书专用 `SOUL.md`、`MEMORY.md` 并保存；检查同步只写入飞书目录的 `AGENTS.local.md`。
3. 普通 DSH 工作区的 `AGENTS.local.md` 不被新保存操作改变。
4. 若发现旧版托管区块，确认后清理并核对备份中包含移除前完整原文；其他 DSH 规则保持不变。
5. 旧飞书 Session 在未执行 `/new` 时不再继续运行；`/new` 后新 Session 的 cwd 是飞书独立路径。
6. 新建一个普通 DSH Session，不自动继承飞书人设；新建飞书 Session，会加载飞书专用身份档案。
7. 测试 file API 未授权拒绝、路径穿越拒绝、冲突检查、审计日志不输出原文。
8. 特别核对 Git 工作区访问与文件写入权限。独立 cwd 可能改变以前相对路径任务的效果，需回归真实使用场景。

## 6. 局限与后续

- 当前是 **工作区和上下文隔离**，同一 Unix 用户下的任意授权文件读写工具仍可能访问其他目录。
- 旧 DSH Profile 中可能还有全局注入规则、Home 级 `AGENTS.md` 等文件；只隔离原指定 Workspace，不代替检查其他公共祖先的规则来源。
- 多机器人独立身份、Session 原生热更新、独立用户账号和跨服务沙箱策略需后续开发。
- 本次不自动迁移旧档案，不自动删除普通 DSH 内容，不进行生产重启或真实租户验证。以 CI + 隔离测试环境验收为准。
