# Agent 预设（飞书机器人工作模式）

飞书机器人可以把某一条 **DSH Agent 预设**（`AgentPreset`）作为它的工作模式：新建的飞书会话会绑定并组合该预设，从而使用预设声明的工具、提示词与插件组合来工作，而不是走一条“裸”的默认组合。

本功能只作用于 **Gateway 所在 DSH Profile** 实际注册的预设；Web Admin 只阅读并保存选择，不伪造任何预设。

## 前置条件

- 运行飞书通道的 **`feishu-channel` Profile** 需要挂载 `@deepseek-ai/dsh-agent-preset-registry`（Host 服务名 `agentPresets`），且至少注册了一个预设。
- 若该 Profile 没有预设服务，后台的预设列表会显示为空并提示“还没有获取到预设列表”；此时选择“继承 / 不指定”保持原有行为即可。

## 在后台选择工作模式

1. 打开 **DSH Web → 飞书管理 → 模型与连接**，找到 **「Agent 预设（飞书工作模式）」** 卡片。
2. 从下拉框选择：
   - **继承（不覆盖 Profile 配置）**：不向托管配置写入预设，完全沿用 Profile 已有的设置（默认）。
   - **不指定（无预设，由 DSH 默认组合）**：显式清空，新会话不绑定任何预设。
   - 具体预设（显示名称；默认预设带“（默认）”；无法组合的预设有 ⚠ 标记且不可选）。
3. **保存配置**。修改只在 **重启独立飞书通道** 后对**新会话**生效。

> 已有会话的工作模式在创建时就已固定并记录在 Session 头部；修改预设不会改变正在使用的历史会话。需要切换时，在飞书聊天里发送 `/new` 新建会话。

## 语义与边界

| 场景 | 行为 |
| --- | --- |
| 托管配置 `agentPreset` 为具体 id | 新建 Session 的头部记录该预设，并在 Agent setup 期间 `mount` 该预设的组合 |
| 托管配置省略 `agentPreset` | 沿用 Profile 配置（若 Profile 提供预设则使用，否则不绑定） |
| 托管配置 `agentPreset: ""` 或 `null` | 显式清空：新 Session 不绑定预设 |
| 冷启动恢复已有 Session | 从该 Session 自己记录的头部重建预设，**不**读取当前托管配置，避免重启后对话被悄然换模式 |
| 配置的预设已被移除 / 不可用 | 记录告警并按“无预设”创建新 Session，保证聊天仍可用 |
| 没有 `agentPresets` 服务 | 不使用预设（与引入该功能前的行为一致） |

## 配置与数据契约

- **托管配置**（`stateDir/admin-config.json` 的 `config.agentPreset`）：字符串预设 id（字符集 `[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}`）、`null` 或 `""`（清空）、或省略（继承）。Admin 写入时 `null`/`""` 归一化为空字符串。
- **运行快照**（`stateDir/ops-runtime.json` 的 `agentPresets`）：由 Gateway 从 Host 服务读取并再次清洗后的只读名单：
  ```jsonc
  {
    "agentPresets": {
      "ts": 1690000000000,
      "incomplete": false,
      "defaultId": "standard",       // 可选
      "presets": [
        { "id": "standard", "name": "标准", "description": "…", "isDefault": true },
        { "id": "ptc", "isDefault": false, "broken": "缺少插件 …" }
      ]
    }
  }
  ```
- **`GET /api/feishu-admin/state`** 返回 `agentPresets`（无快照时为 `null`），Web Admin 只做白名单清洗后展示。
- Gateway 只把预设的 `id` 传给 DSH（`meta.agentPreset` + `agentPresets.mount()`），从不保存或回显预设内部实现、YAML 或工具参数。

## 实现位置

- 端口与类型：`src/types.ts`（`AgentPresetCatalog`、`SessionBridge.listPresets`、`create(..., preset?)`）。
- 原生桥接：`src/session/dsh-session-bridge.ts`（`listPresets`、创建时解析并 `mount`、冷恢复时从会话头部重建）。
- Gateway：`src/gateway.ts`（把 `config.agentPreset` 传给新建会话，并把清洗后的名单发布到运行快照）。
- 托管配置校验：`src/admin-config.ts`、`web-admin/src/server.mjs`。
- 后台读取与展示：`web-admin/src/ops-read.mjs`、`web-admin/src/client.js`。

## 相关文档

- [Web 管理后台](WEB-ADMIN.md)
- [模型及用量](USAGE-AND-MODELS.md)
- [DSH 兼容性](COMPATIBILITY.md)
