# 飞书 Gateway 网络代理：当前配置与旧版兼容

> **当前操作**：使用 **飞书管理 → 模型与连接 → 网络代理**。文末保留 rc.9–rc.11 迁移背景；发布测试版请执行 [双包预发布门禁](PRERELEASE.md)。旧版回滚操作不应直接应用到现有生产配置，尤其不可手工删除正在使用的凭据或状态文件。

代理地址可**直接在 DSH Web → 飞书管理 → 模型与连接 → 网络代理** 中填写、测试、保存并重启生效，
不再需要手工编辑 `~/.dsh/feishu-channel.env` 或其它 Linux 配置文件。

## 1. 存储与优先级

| 数据 | 位置 | 权限 | 说明 |
| --- | --- | --- | --- |
| 开关与回退策略 | `<stateDir>/admin-config.json` → `config.networkProxy = { enabled, fallbackDirect, urlEnv }` | 0600 | 非敏感；`urlEnv` 仅为兼容旧部署保留 |
| 代理 URL（含可选认证） | `<stateDir>/network-proxy.json` → `{ "version": 1, "url": "http://..." }` | 0600 | **敏感**，只写不读回；任何 API 都不返回原文 |

`<stateDir>` 默认 `$HOME/.dsh/feishu-channel-state`（管理端与启动脚本一致）。

生效优先级（高 → 低）：

1. 管理后台保存的 `network-proxy.json`（`enabled=true` 时）；
2. 环境变量文件里的 `urlEnv` 变量（默认 `FEISHU_CHANNEL_PROXY_URL`，兼容旧部署）；
3. 无代理（直连）。

管理端 `GET /state` 必须报告 `source: 'managed' | 'env' | 'none'`，让用户明确当前用的是哪一份配置。

## 2. URL 校验规则（管理端、启动脚本、Gateway 插件一致）

- 仅允许 `http:` / `https:`；
- 必须有 hostname；端口可选，范围 1–65535；
- 允许可选 userinfo（`http://user:pass@host:port`），仅用于代理认证；
- 不允许 path（`/` 除外）、query、fragment；
- 长度 ≤ 2048；
- 写入前 `new URL()` 解析成功；**错误信息不得回显 URL 或 userinfo**。

## 3. 管理端 API（`web-admin/src/server.mjs`）

`GET /api/feishu-admin/state` 在现有响应上新增：

```json
"networkProxy": {
  "enabled": true,
  "fallbackDirect": true,
  "source": "managed",          // managed | env | none
  "configured": true,
  "display": "http://100.75.51.18:2080",  // 去掉 userinfo/path/query，可给管理员看
  "envName": "FEISHU_CHANNEL_PROXY_URL",
  "envConfigured": true
}
```

`config.networkProxy` 仍只含 `{ enabled, fallbackDirect, urlEnv }`，**永不含 `url`**。

`PUT /api/feishu-admin/config` 的 `networkProxy` 接受：

```json
{ "enabled": true, "fallbackDirect": true, "urlEnv": "FEISHU_CHANNEL_PROXY_URL",
  "url": "http://host:port" }
```

- `url` 为字符串：校验后写入 `network-proxy.json`（原子写、0600、拒绝符号链接）；
- `url` 为 `null`：删除已保存 URL；
- `url` 省略：保持现状；
- `admin-config.json` 中只写 `{ enabled, fallbackDirect, urlEnv }`（`urlEnv` 缺省补 `FEISHU_CHANNEL_PROXY_URL`）；
- 响应保持 `{ ok, revision, restartRequired }`，可附带新的 `networkProxy` 状态对象。

`POST /api/feishu-admin/network-proxy/test`，body `{ "url"?: string }`：

- 有 `url` 用 `url`；否则用当前生效 URL（managed → env）；
- 用 **CONNECT 探测**（Node 内置 `http`/`https`，不新增依赖）访问 `open.feishu.cn:443`
  （bot domain 为 `lark` 时用 `open.larksuite.com:443`），超时 6s；
- 200 返回 `{ ok: true, result: { reachable: boolean, latencyMs: number, target: string, error?: string } }`；
- `error` 只用稳定的错误码/中文短语（如 `ETIMEDOUT`、`ECONNREFUSED`、`ENOTFOUND`、`HTTP_407`、`TLS_ERROR`），
  绝不包含 URL、userinfo 或底层原始 message；
- 未配置任何代理：400 `no proxy configured`。

`POST /api/feishu-admin/network-proxy/import-env`，body `{}`：

- 从 `feishu-channel.env` 读取 `urlEnv` 指定的变量（默认 `FEISHU_CHANNEL_PROXY_URL`）；
- 校验后写入 `network-proxy.json`，返回 `{ ok: true, networkProxy: {...}, restartRequired: true }`；
- 变量不存在：404 `proxy url not found in env file`；
- 不返回变量原文。

安全：所有写接口沿用现有 `security()`（登录 + CSRF + content-type）与 `serializeMutation` 串行化。

## 4. 启动脚本（`scripts/channel/start-feishu-channel.sh`）

1. 读取 `admin-config.json` 的 `networkProxy`（enabled / urlEnv / fallbackDirect）；
2. `enabled=false`：直接返回，不设置任何代理变量；
3. `enabled=true`：先读 `network-proxy.json`（严格校验：普通文件、非符号链接、JSON `version:1`、URL 合法），
   读不到再用 `urlEnv` 环境变量；
4. 用 curl 做 CONNECT 预检（URL 不打印）；
5. 预检通过：导出 `http_proxy/https_proxy/HTTP_PROXY/HTTPS_PROXY`、`NO_PROXY`、`NODE_USE_ENV_PROXY=1`、
   `FEISHU_GATEWAY_PROXY_SELECTED=proxy`，并把生效 URL 导出为 `urlEnv` 变量（供 Gateway 插件读取）；
6. 预检失败：`fallbackDirect=true` → 清除代理变量、`FEISHU_GATEWAY_PROXY_SELECTED=direct`；
   否则启动失败，错误信息不得含 URL；
7. 启用代理但两份配置都没有 URL：按预检失败处理（回退或失败），日志提示"未配置代理地址"。

## 5. Gateway 插件（`src/`）

- `src/util/proxy-url.ts`：`validateProxyUrl(raw)` / `redactProxyUrl(url)` / `readProxyUrlFromEnv` 共享实现；
- `src/admin-config.ts`：新增 `loadStoredProxyUrl(stateDir)`（普通文件、非符号链接、0600、`version:1`、URL 合法）；
- `src/types.ts`：`NetworkProxyConfig` 增加只读可选 `url?: string`（仅内存，绝不进入日志/摘要）；
- `src/index.ts`：`buildTransports` 解析生效 URL（stored → env）后传给 `LarkTransport`；
- `src/channel/lark-transport.ts`：`enabled && selected !== 'direct' && url` 时用
  `HttpsProxyAgent(url)`（v5 CJS 工厂，保持 rc.9 修复）；
- `src/gateway.ts`：`health()` 增加 `network: { proxySelected: 'proxy' | 'direct' | null }`（非敏感）；
- `redactedConfigSummary` 只报告 `{ enabled, urlEnv, fallbackDirect, configured, selected }`。

## 6. 前端（`web-admin/src/client.js`）

当前「模型与连接 → 网络代理（仅飞书独立 Profile）」：

- 开关「启用代理」；
- 代理地址输入框（普通文本输入，直接显示，不做密码式遮挡），placeholder 示例 `http://127.0.0.1:7890`；
  已保存时输入框留空并提示「已保存：<display>」，不把原文回填到 DOM；
- 状态行：当前来源（管理后台 / 服务器环境变量 / 未配置）与生效地址（脱敏 display）；
- 按钮：「测试连接」（显示耗时或错误码）、「从服务器环境变量导入」（`envConfigured` 时显示）、
  「清除已保存地址」；
- 复选框「代理预检失败则启动时回退直连」；
- 「保存配置」与「保存并重启飞书通道」两个动作（后者保存成功后调用 `POST /restart`）；
- 不再显示「代理 URL 环境变量名（兼容旧部署）」输入项；前端不再发送 `urlEnv`，由后端补默认值；
- 提示：修改后必须重启独立飞书通道才生效；管理端不存储明文到日志。

## 7. 兼容与回滚

- 旧管理端（rc.9）写入的 `{enabled,urlEnv,fallbackDirect}` 新 Gateway 继续接受；`urlEnv` 缺省为
  `FEISHU_CHANNEL_PROXY_URL`；
- 新管理端未保存 URL 时行为与 rc.9 完全一致（环境变量文件仍可用）；
- **不要直接删除 `network-proxy.json` 作为回滚手段**：旧版迁移和当前配置的语义不同。先备份两个 Profile、管理配置和加密/受权限控制的代理文件；核对拟回滚版本能否读取现有字段，再在维护窗口通过 Web Admin 清除或按经过验证的版本迁移方案恢复。详见 [升级与回滚](OPERATIONS.md)。

## 8. 验收

1. 在 UI 输入**测试环境真实可用**的代理地址（示例格式 `http://127.0.0.1:7890`，并不保证该端口存在）→ 测试连接成功 → 保存并重启 → 通道日志出现
   `proxy preflight passed`，飞书 WebSocket 连接成功；
2. 输入错误地址（如 `http://127.0.0.1:9`）→ 测试连接返回 `ECONNREFUSED`，页面不出现 URL；
3. 输入 `ftp://x`、带 path/query 的 URL → 保存被拒绝且提示明确；
4. 清除已保存地址 → 重启后回退到环境变量或直连，`/state` 的 `source` 正确变化；
5. `GET /state`、错误响应、日志中均不出现完整 URL/userinfo；
6. 旧环境变量部署（不保存 URL）仍可正常启动。
