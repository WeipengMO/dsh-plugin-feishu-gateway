# 本地测试 Profile 安装方法

> **隔离测试指南（历史示例）**：本文件包含初期 DSH 0.2.2-rc.1 的手动测试 Profile 和部分旧配置。构建安装当前源码请先按 [首次部署](GETTING-STARTED.md) 使用 `package.json` 中实际版本，切勿复制下文旧版本 tgz 名称或把示例路径直接用于生产。验收流程见 [开发与测试](DEVELOPMENT.md)。

> **重要**：本项目**不修改、不覆盖现有 `web` profile**（`~/.dsh/profiles/web/`）。
> 下面所有操作都针对一个**新建的独立 profile**：`feishu-gateway-test`。
> 本文件描述的是「方法」，本次交付**没有执行** `dsh plugin add`（它是会改动 DSH home 的状态变更）。

---

## 0. 前置条件

```bash
node -v                 # >= 24.9.0
pnpm -v                 # 12.x
dsh --version           # 0.2.2-rc.1
echo "$DSH_HOME"        # 默认 /home/ubuntu/.dsh
cd /home/ubuntu/dsh-workspace/projects/dsh-plugin-feishu-gateway
pnpm install && pnpm run build     # 必须先生成 lib/
```

确认插件清单已满足官方检查：

```bash
node -e "const p=require('./package.json'); console.log(p.engines, p.dsh, p.main)"
# { node: '>=24.9.0', dsh: '>=0.2.2-rc.1 <0.3.0-0' }
# { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } }
# lib/index.js
```

`dsh.bundle.patch` 让 `dsh plugin add` 之后自动把包名写进 `dsh.profile.bundles`
（`dsh-plugin-manager` 的 `reconcile()`），`engines.dsh` 让安装前的兼容性预检通过。

---

## 1. 创建独立 Profile

模板在 [`../profiles/feishu-gateway-test/`](../profiles/feishu-gateway-test/)：

```bash
mkdir -p "$DSH_HOME/profiles/feishu-gateway-test"
cp -r profiles/feishu-gateway-test/. "$DSH_HOME/profiles/feishu-gateway-test/"
```

模板内容：

```
package.json          # dsh.profile.bundles = dsh-base + dsh-headless
cordis.yml            # 永远是 []，由 profile-boot 每次重写
cordis.patch.yml      # 用户补丁层：按 id 覆盖 feishu-gateway 行的 config
pnpm-workspace.yaml   # allowBuilds 白名单（与插件根目录一致）
```

选 `dsh-headless` 而不是 `dsh-web-app`：不会启动第二个 Web 服务、不会占用端口，
但 `dsh-base` 仍提供 `agents` / `agentLoop` / `sessions` / `llm` 四个被 `inject` 声明的服务。

> ⚠️ 不要编辑 `$DSH_HOME/profiles/web/cordis.patch.yml` 或它的 `package.json`。
> 不要编辑 `$DSH_HOME/cordis.patch.yml`（home 层，会影响所有 profile）。

---

## 2. 用官方命令安装本地插件（推荐）

```bash
dsh plugin --profile feishu-gateway-test add \
  /home/ubuntu/dsh-workspace/projects/dsh-plugin-feishu-gateway
```

`dsh plugin` 把剩余参数原样转发给 profile 目录下的 pnpm（`dsh plugin --help` 已验证）。
绝对路径由 CLI 的 `anchorPathSpec` 按调用方 cwd 解析；`link:/abs/path` 也可接受。

这一步会自动完成：

1. 读取本地目录的 `package.json`，执行 `evaluatePluginCompatibility()` 预检
   （`engines.dsh` 满足 `0.2.2-rc.1` → 通过；**不需要 `allow-version`**）；
2. `pnpm add` 把包写入 profile 的 `dependencies`；
3. `reconcile()` 检测到 `dsh.bundle` 声明，把包名追加到 `dsh.profile.bundles`；
4. 生成 / 更新 `pnpm-lock.yaml`。

等价的 GUI 方式：在 Web 的插件页用 `plugin_manager` `install_bundle`，
`target` 填同一个绝对目录（该工具调用需要 Full access；本会话未使用）。

验证安装结果（只读）：

```bash
cat "$DSH_HOME/profiles/feishu-gateway-test/package.json"
dsh plugin --profile feishu-gateway-test version-exemptions   # 应为空，证明没有使用豁免
```

---

## 3. 手动安装（离线 / 无网络环境）

若不方便执行 `dsh plugin add`，可手工写 profile 的 `package.json`：

```json
{
  "name": "dsh-profile-feishu-gateway-test",
  "private": true,
  "dependencies": {
    "dsh-plugin-feishu-gateway": "link:/home/ubuntu/dsh-workspace/projects/dsh-plugin-feishu-gateway"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "dsh-plugin-feishu-gateway"
      ]
    }
  }
}
```

然后在 profile 目录里 `pnpm install`。**注意**：手工方式跳过了 CLI 的安装前兼容性预检，
但**启动时**的检查仍然执行；`engines.dsh` 依然必须满足，否则该行会被拒绝。

---

## 4. 配置该 Profile（按 id 覆盖，不合并）

编辑新 profile 的 `cordis.patch.yml`（**只改这一个文件**）：

```yaml
# 补丁按 id 命中已插入的行；config 是整体替换，不会深合并。
- id: feishu-gateway
  config:
    bots:
      - id: default
        enabled: true
        domain: feishu
        appIdEnv: FEISHU_GATEWAY_DEFAULT_APP_ID
        appSecretEnv: FEISHU_GATEWAY_DEFAULT_APP_SECRET
    allowlist:
      - ou_你的测试账号_open_id
    allowGroups: false
    workspace: /home/ubuntu/dsh-workspace
    stateDir: /home/ubuntu/.dsh/feishu-gateway-test-state
    offline: false
    autoConnect: true
    diagnoseOnStart: true
```

---

## 5. 三种运行模式

### A. 完全离线 / Mock（**无需任何飞书凭据，推荐先跑这个**）

```yaml
- id: feishu-gateway
  config:
    bots:
      - id: default
        enabled: true
        domain: feishu
    allowlist: [ou_test]
    offline: true
    autoConnect: true
```

`offline: true`（或环境变量 `FEISHU_GATEWAY_OFFLINE=1`）时 `createGateway()` 使用
`MockFeishuTransport`：不加载 `@larksuiteoapi/node-sdk`、不开 socket、不发 HTTP。
这一模式仍会走真实的 `ctx.agents` 原生 Session（如果 profile 有模型路由）或降级为诊断回复。

**注意：`MockFeishuTransport` 不会自动产生入站消息。** 即使成功启动该 Profile，
也只能看到加载日志，看不到消息流。所以 v0.1.0 的功能测试**不需要启动 DSH**：

```bash
pnpm run verify                      # 全 Mock 单元 / 集成 / 故障注入（含真实 Cordis 生命周期）
pnpm run demo "你好"               # 本地全链路：打印入站 → Session → 出站回复 + 健康计数
pnpm run demo "你好" ou_stranger   # 白名单外用户 → 无回复（验证拒绝策略）
dsh --profile feishu-gateway-test --dump-config   # 只读：验证 bundle 配置树能组合
```

### B. 连接飞书测试应用（有测试凭据时）

```bash
export FEISHU_GATEWAY_DEFAULT_APP_ID='cli_xxxxxxxx'
export FEISHU_GATEWAY_DEFAULT_APP_SECRET='xxxxxxxx'
# 把该 Profile 的 cordis.patch.yml 里 offline 改为 false，然后：
dsh --profile feishu-gateway-test "你的任务"
```

凭据只从环境变量读取；日志只打印 `env:FEISHU_GATEWAY_DEFAULT_APP_SECRET` 这样的**来源名**。
测试应用配置见 [FEISHU-APP.md](FEISHU-APP.md)。**不要使用任何现有正式应用的凭据。**

> ⚠️ **两个实测坑**（本机 0.2.2-rc.1 验证）：
> 1. 模板用 `dsh-headless`，**必须带任务参数**，裸跑会报 `a task is required`；
>    `--help` / `--dump-config` 只打印信息，不挂载插件。
> 2. `dsh-base` 的默认模型路由是 `deepseek-official`，而本模板**没有 LLM 适配器配置**，
>    带任务启动会在启动阶段报 `MISSING_CREDENTIAL: llm-deepseek: no API key ...` 并退出，
>    插件来不及 `apply()`。要在完整 DSH 运行时里激活插件，需先给该 Profile 补
>    `llm-pi-ai` + `agent-default-model` 两行配置（可只读复制 `web` 的
>    `cordis.patch.yml` 中同 id 的行，**不要改动 web**）并注入对应的 API key 环境变量。
>
> 因此「安装 + 配置树 + 模块加载」已可用 `--dump-config` / `import()` 验证；
> **L4 完整运行时激活在本模板默认配置下不可用**，L1/L2 才是 v0.1.0 的主要测试手段。

### C. 不自动连接（只验证装载 / 配置）

```yaml
- id: feishu-gateway
  config:
    autoConnect: false
    offline: true
    bots: []
```

用于确认插件能被 Cordis 装载、`ctx.provide('feishuGateway', ...)` 生效、卸载无残留。

---

## 6. 启动后的检查（仅当 L4/L5 真正启动成功时）

> 若按默认模板启动，会先遇到 §5B 的两个坑；此时改用 §5A 的
> `pnpm run verify` / `pnpm run demo` 验证功能，用 `--dump-config` 验证安装。

```bash
# 日志里应出现（已脱敏）：
# [feishu-gateway] configuration {"bots":[{"id":"default",...}],"allowlistSize":1,...}
# [feishu-gateway] transport default -> connected
# [feishu-gateway] created native DSH session feishu-default-oc_xxx
```

诊断数据（只读服务 `ctx.feishuGateway`）：

```js
// 在 DSH 内可用，或通过插件诊断接口
ctx.get('feishuGateway').health()
ctx.get('feishuGateway').diagnostics()
```

状态文件位置：`stateDir` 下的 `dedup.json` / `inbox.jsonl` / `outbox.json` / `sessions.json`。
删除该目录即可完全重置测试状态。

---

## 7. 卸载与清理（不影响 web）

```bash
dsh plugin --profile feishu-gateway-test remove dsh-plugin-feishu-gateway
rm -rf "$DSH_HOME/profiles/feishu-gateway-test"
rm -rf "$DSH_HOME/feishu-gateway-test-state"
```

插件自身的卸载清理由 `ctx.effect` disposer 完成：关闭 WS、取消在途任务、
`AgentHandle.dispose()`、移除所有 `ctx.on` 监听器。

---

## 8. 本次交付实际执行了什么

| 操作 | 是否执行 |
| --- | --- |
| 读写 `$DSH_HOME/profiles/web/` | ❌ 从未 |
| `dsh plugin --profile ... add ...` | ❌ 未执行（状态变更，仅文档化） |
| `plugin_manager` 工具 | ❌ 未使用 |
| `dsh plugin allow-version` / `compatibility.json` | ❌ 从未 |
| 连接真实飞书应用 | ❌ 从未 |
| `dsh plugin --help` / `dsh --version` | ✅ 只读 |
| `pnpm install` / `build` / `test` 在本项目目录 | ✅ |
