# 飞书管理工作台（DSH 左侧栏）

## 目标与交互分工

新增 DSH 左侧导航「飞书管理」，打开与会话区同级的原生主面板；旧「设置 → 飞书通道」调整为「设置 → 飞书 Gateway」，**仅显示 App ID / App Secret 的写入表单与凭据配置状态**。

这不是外部 Web 网站、iframe，也不需要 fork DSH。使用 DSH 官方的根级客户端插槽：

- `sidebar.panellist`：`id = feishu-management` 的导航按钮与图标；
- `main`：同 `key = feishu-management` 的主面板；
- `settings.section`：`id = feishu-channel`，只保留凭据输入；
- 所有注册均使用 `ctx.slots.inject(..., () => ctx.slots.register(...))`，延迟声明与卸载由宿主管理。

参考：[DSH 官方 sidebar](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar/README.md)、[官方扩展示例](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/client/index.tsx)。

## 当前实现：工作台 v1

| 页面 | 当前数据或操作 | 边界 |
| --- | --- | --- |
| 总览 | 健康、已处理、活跃任务、待发送、会话绑定、错误；各机器人连接、服务状态；处理链路 | **真实网关聚合数据**，不编造趋势或最近活动 |
| 机器人 | 连接状态、部署地区、启用/禁用状态、凭据是否齐全 | 不回显 App ID / Secret |
| 消息与投递 | Inbox/Outbox 当前汇总、处理数、拒绝数、错误数 | 单条消息、原文、手动重试**未实现** |
| 会话与审批 | 原生 Session 绑定、运行中任务、当前等待审批、已有交互卡片设置 | Session 列表与审批历史**未实现** |
| 安全与权限 | 已托管白名单的数量、现有 DSH 认证/审批边界 | 不显示完整 open_id，不变更原生工具执行策略 |
| 运行诊断 | 连接、Bridge、systemd、运行时间和聚合状态 | 日志流与细粒度审计**未实现** |
| 高级管理 | 复用原有管理 UI（模型、白名单、卡片、机器人、重启） | 修改配置后需要按原流程重启；凭据只在 Settings 写入 |

**UI 细节**：DSH 原生导航 + 工作台内二级菜单，宽屏为导航栏/主内容双列；窄屏折叠为横向选项栏。使用 DSH 的主题色、前景/边框/卡片变量，浅色与暗色均保留对比；键盘焦点、错误提示、空态及加载态均有对应组件。仅由客户端渲染，**没有任何额外 LLM 调用或 Token 开销**。

## 服务与权限

```text
DSH Web Profile
 └── dsh-plugin-feishu-admin 0.2.0-rc.2
      ├── 客户端 sidebar.panellist → main (飞书管理)
      ├── 客户端 settings.section (凭据)
      └── 原有认证 /api/feishu-admin/{state,health,diagnostics,config,credentials,restart}
                         │
                         │ 127.0.0.1:18095（只读状态）
                         ▼
DSH feishu-channel Profile
 └── dsh-plugin-feishu-gateway 0.2.0-rc.4
       └── 原生 Agent、Session、审批、Inbox/Outbox
```

- 不新增监听端口，不启动第二个 Gateway，不在 Web Profile 实例化 Agent。
- 状态来自原 `/state`、`/health`、`/diagnostics`。可见网页每 15 秒轻量读取健康端点，离开可见状态时跳过轮询；首次进入读取配置和健康，手动刷新可重新拉取。
- DSH Web 原有浏览器会话认证、Origin/CSRF 防护与配置乐观并发检查保持不变。
- 只在浏览器表单存在 App Secret 输入；服务端将凭据写入 0600 文件，不从接口回显。
- 前端工作台不会请求读取聊天正文、完整审计日志、磁盘上的 Inbox/Outbox 记录；待新增专用过滤 API 后才提供明细。
- 旧配置的状态和数据文件均保留。

## 可扩展性：下一阶段

遵循“能力模型 → 服务端查询 DTO → 页面组件”的独立模块结构：

1. **P1 事件审计**：Gateway 输出结构化、脱敏、短期保留的任务事件；管理端分页与时间过滤，单条可展开但默认无聊天正文。凭据、工具参数和工作区路径不得进入审计流。
2. **P1 Session 管理**：可视化绑定列表、关联机器人、开始/结束时间、任务状态；以 DSH 原生 Session ID 为指针而非复制会话。解除绑定、取消任务等写操作必须二次确认并复用权限验证。
3. **P1 可靠性控制**：入站/出站队列详细计数，单条失败的人工重试；必须区分 uncertain/已执行副作用，**不可盲目重放**。
4. **P2 资源趋势**：采样真实计数与模型上报 Token，用有限期历史做趋势图；不通过文本长度估 Token，不让浏览器持久化原文。
5. **P2 多机器人**：每 Bot 独立筛选、配置、故障通知；可扩展通知目标或其他渠道适配器，但不将其与 DSH Host 核心耦合。
6. **P2 插件式页面注册**：按 `overview`, `delivery`, `sessions`, `security` 等 ID 拆组件并注册，后续通过有版本的 DTO/能力检查按需展示新页，不依赖原生私有 API。

这些是后续目标，**当前 v1 不假装已有日志流、消息历史或可操作的 Session 列表**。

## 安装与验证

只有 Web Admin 版本更新至 `0.2.0-rc.2`；Gateway `0.2.0-rc.4` 不变。

```bash
git switch main && git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack
dsh plugin --profile web add "$PWD/dist/dsh-plugin-feishu-admin-0.2.0-rc.2.tgz"
```

在没有在途重要 Web 会话的维护窗口重启**承载 Web Profile 的 DSH Web 服务**，而不是重启 feishu-channel。浏览器重新加载页面，确认左侧栏有「飞书管理」入口，Settings 中只有凭据页。安装包可从 GitHub CI Artifact 获得，但构建产物路径应以实际运行结果为准。

**自动化 CI 只能覆盖 Slot 注册代码、构建、API 安全测试、Mock 状态与静态契约。** DSH 宿主真实 UI 插槽渲染、窄屏布局与既有 Profile 交互必须在独立 Web 测试环境进行实机验收；不要因为构建通过便声称生产 UI 已验证。
