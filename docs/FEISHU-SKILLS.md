# 飞书专属 Skills（轻量技能库）

本功能仅属于飞书 Gateway 和 Web Admin。借鉴 Codex / OpenClaw 的 SKILL.md 约定，但不包含插件市场、自动下载安装、脚本执行、依赖解析与密钥注入。不会修改 DSH Core、全局技能注册表、模型路由或工具权限。

## 使用方式

在 DSH Web → 飞书管理 → Skills 技能：

1. 点击「+ 新建」，按模板填写 YAML frontmatter 的 name、description 和 Markdown 指令；或者点击「粘贴导入 SKILL.md」，贴入完整文本。
2. 默认停用。保存后，在左侧列表中打开开关启用。后台支持搜索、筛选、编辑、预览、删除、同步状态和上下文预算。
3. 在飞书发送 /new 开始新的独立 Agent Session，然后提出与技能描述对应的需求。技能说明是按任务相关性使用的模型上下文，而不是额外的工具调用权限。

样例：

~~~markdown
---
name: gbm-literature
description: 用户要求整理胶质母细胞瘤的研究文献、方法与证据时使用
---

# 胶质母细胞瘤文献解读

- 先确认研究问题、样本类型和证据层级。
- 对比关键方法、样本量、局限性。
- 给出来源和可验证的后续实验建议。
~~~

## 作用范围和存储

- 数据存放在 Gateway 的 stateDir/feishu-skills.json（0600），完全独立于 DSH 的全局 Skills 文件夹与其它配置。
- 仅把启用技能的 SKILL.md 文本，同步到运行中 Gateway 的**独立 Agent 工作区**的 AGENTS.local.md 中的 DSH-FEISHU-SKILLS 专属标记段。Agent Profile 标记和用户手写内容不会被覆盖。
- Web Admin 只接受真实 DSH Owner 浏览器权限，以及 Gateway 隔离工作区的实时状态快照。没有授权或快照时读写拒绝。
- 不支持第三方脚本的下载、自动安装、执行，不改原生 DSH 工具审批。Skills 不是沙箱或权限升级方式。
- 新建、编辑、开关等修改**建议通过飞书 /new 开始新会话**验收；正在运行的旧会话可能仍使用已有上下文。

## 限额和安全

- 最多 24 个技能；单个 SKILL.md 最大 12 KiB；已启用技能的总上下文最大 24 KiB。
- name 为 1–48 位小写字母、数字和连字符构成的标识，须以字母开头、不能以连字符结尾；description 是非空的 1–240 字符单行说明。
- 保存、启停和删除采用预期内容 SHA 版本校验；避免旧页面覆盖新配置。删除需前端确认。
- 遇到符号链接、内容损坏、冲突标记或误指向 DSH 主工作区会拒绝写入。
- 导入前应审阅技能文本，勿将不可信指令、密码、密钥粘贴到技能中。

## API（需 DSH 认证 Owner）

所有路由使用 /api/feishu-admin 前缀，写请求使用 application/json 与 x-dsh-feishu-admin: 1：

| 路由 | 功能 |
| --- | --- |
| GET /skills | 列表、启用数、预算、同步状态 |
| GET /skills/file?name=... | 查看单个 SKILL.md |
| PUT /skills/file | 新建或编辑：name、content、expectedRevision |
| PUT /skills/enabled | 启停：name、enabled、expectedRevision |
| POST /skills/delete | 删除：name、expectedRevision |
| POST /skills/sync | 重试同步：空 JSON |

## 开发、验收与部署

~~~bash
pnpm install --frozen-lockfile
pnpm run verify
node --test web-admin/test/skills-manager.test.mjs
~~~

按仓库 README 的双 Profile 打包安装流程部署 Gateway / Web Admin。**发布前实机验收必须使用隔离测试 Profile**，不能覆盖正在运行的 `feishu-channel` / `web`；详见 [测试环境指南](TEST-PROFILE.md)。

验收路径：新建→保存（默认停用）→启用→飞书 /new 触发→编辑→停用→/new 验证不再应用→删除。另测试未认证 API、超限、非法 YAML frontmatter、重复标记、版本冲突、移动端布局。

源码分支与 npm 发布状态是两件事；这份功能说明不证明当前版本已经正式发布或通过真实飞书租户验收。测试版还需完成 [双包发布检查](PRERELEASE.md)。
