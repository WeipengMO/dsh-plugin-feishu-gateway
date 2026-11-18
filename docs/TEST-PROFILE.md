# 隔离测试 Profile

当需要在真实 DSH Host 验证本仓库的变更时，应使用**与生产完全分离**的 DSH Profile、工作区、Gateway `stateDir`、环境凭据和飞书测试应用；不要复用生产 `sessions.json` 或 owner lock。

## 准备

1. 检查 [Gateway engines](../package.json)、[Admin engines](../web-admin/package.json) 与实际 `dsh --version` 匹配。
2. 运行 `pnpm install --frozen-lockfile`、`pnpm run verify`、`pnpm run pack` 与 `pnpm run release:check`；核验两个 tarball 和 `dist/SHA256SUMS`。
3. 新建隔离测试用的 Gateway Profile（可参照仓库 [测试配置目录](../profiles/feishu-gateway-test/)），并确认 `cordis.patch.yml` 与状态路径不指向正式飞书服务。
4. 使用仓库实际源码版本包名安装：

```bash
GATEWAY_VERSION=$(node -p "require('./package.json').version")
ADMIN_VERSION=$(node -p "require('./web-admin/package.json').version")
(cd dist && sha256sum -c SHA256SUMS)
dsh plugin --profile feishu-gateway-test add "./dist/dsh-plugin-feishu-gateway-$GATEWAY_VERSION.tgz"
dsh --profile feishu-gateway-test --dump-config
# 在已单独配置为 DSH Web 运行时的隔离测试 Profile 中安装 Admin：
dsh plugin --profile feishu-web-test add "./dist/dsh-plugin-feishu-admin-$ADMIN_VERSION.tgz"
dsh --profile feishu-web-test --dump-config
```

以上 `feishu-web-test` 是**示例名称**，必须先按实际 DSH 版本创建并配置成真正可启动的 Web Profile（包含 `webServer`、`connection` 和 Web UI 服务），不是任意 CLI Profile。测试 Gateway 与 Admin 必须共享测试状态契约，但使用各自独立 Profile，**不得复用生产** `web`、`feishu-channel`、状态目录或正式飞书 App ID。插件安装完成也不等于运行中服务已加载，须启动或重启隔离的测试进程，检查实际界面和长连接。

## 三种测试模式

- **Mock / 离线**：不需要真实飞书凭据，检验 Cordis 装载、SessionBridge、消息状态及安全规则。
- **真实 DSH + 模型**：检验真正的模型路由、原生工具与 Session 连续性；不需要自动向正式飞书用户发送消息。
- **真实飞书测试应用**：检验事件订阅、权限、卡片、群聊、定时通知与重启恢复；严格限制测试账号。

仓库 Harness 入口和测试命令见 [真实端到端验收](E2E.md)。只在测试 Profile 中执行会产生外部副作用的操作；完成后撤销临时权限、停止独立服务，并确认没有影响生产通道。

## 注意

- `pnpm run verify` 与 DSH 环境启动成功并不等价。
- 遇到版本不匹配，不建议用 `dsh plugin allow-version` 绕过安全检查。
- 每个测试结论都标注当时真实版本，不以历史 rc 的结果证明新分支通过。
- Gateway 和 Admin 是两个独立 npm 包；只安装 Gateway 无法证明 Web Admin 可用。双包升级与回滚方法见 [预发布指南](PRERELEASE.md)。
