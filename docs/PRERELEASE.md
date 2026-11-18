# 测试版发布前检查（0.1.0-beta.1 / npm beta）

适用于 **Gateway 和 Web Admin 两个独立 npm 包**。日常自动发布参见 [GitHub → npm Trusted Publishing](PUBLISHING.md)；本页手动上传仅用于特殊情况下的后备操作。这是一份发布门禁与验收清单，
不是“CI 通过即允许上线”的声明。**先测试、后发布；不得在生产 Profile 试错。**

## 1. 源码与版本

- 目标分支应从最新 `main` 创建，PR 必须通过 CI。记录完整 commit SHA。
- Gateway 版本：根目录 `package.json`；Admin 版本：`web-admin/package.json`。
  手动安装可分别递增；**自动 GitHub Release 发布要求两者版本相同，并与 Release Tag 完全一致**。
- 要求 Node `>=24.9.0`、DSH `>=0.2.2-rc.1 <0.3.0-0`；
  这是声明的兼容范围，并非对所有 DSH 版本的实测证明。
- 确认 npm 上目标版本**尚未发布**。npm 同一包同一版本不可重复覆盖。
  如已有相同版本，需要先递增 RC 版本并同步相应锁文件。
- 测试版禁止使用 `latest` 发布标签，本轮统一使用 npm dist-tag `beta`。

## 2. CI / 双包工件门禁（无需真实凭据）

在干净检出的代码上执行：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run verify
pnpm run test:coverage
pnpm run pack
pnpm run release:check
(cd dist && sha256sum -c SHA256SUMS)
```

`release:check` 自动验证：

- Gateway / Admin 均为预发布版本，且 DSH / Node engine 限制一致；
- 两个 tarball 的包名、版本、Cordis patch 与源码声明相符；
- 关键入口、TS 类型、Gateway 传输、Admin API/UI 和依赖模块都被打入包；
- 打包后 Node 代码的相对 import 指向存在的文件；
- 排除常见的 `.env`、私钥、状态与凭据文件名；
- 生成 `dist/release-manifest.json` 和 `dist/SHA256SUMS`，方便核对工件身份。

**边界**：这是内容检查，不能替代秘密扫描、依赖漏洞审计、真实 DSH 插件加载、
浏览器人工验收与真实飞书租户 E2E。发布前应人工检查两个 `.tgz` 的内容。

CI 会保留两个 `.tgz`、发布 manifest 和校验和，供独立测试机下载安装；
仓库的打包工作流**不会发布 npm、创建 GitHub Release 或写入生产 Profile**。

## 3. 独立真实环境验收

使用独立 DSH Profile、stateDir、飞书测试应用和模型账号，不与生产进程
同时持有同一 App ID 或 Gateway 状态目录。详情见 [隔离测试 Profile](TEST-PROFILE.md)
和 [E2E](E2E.md)。

最低通过项：

| 功能 | 最低验证 |
| --- | --- |
| 双包安装 | Gateway 只装 `feishu-channel`，Admin 只装 `web`（实际测试使用隔离命名） |
| DSH / Cordis | `dsh --version` 与 engines 匹配，两个插件正常加载，无版本豁免 |
| 连续对话 | 三轮上下文连续、`/new` 隔离、`/cancel` 不影响其他聊天 |
| 飞书长连接 | 正常收发、重启恢复、授权用户与未授权用户区别明确 |
| 可靠性 | Inbox/Outbox、去重与失败恢复，不重复执行有副作用工具 |
| 工具与卡片 | 审批允许/拒绝/超时、流式卡片、取消与权限 |
| 模型与 Agent | 主模型、多个 fallback、`/models`、预设保存与加载 |
| 群聊与定时任务 | @ 策略、白名单、定时执行、通知回执与历史 |
| Skills/Agent 档案 | 仅飞书工作区生效，保存/启停后不会改写 DSH 全局文件 |
| 会话整理 | 归档/恢复/解除关联不误删 DSH 历史；可选删除插件不在时安全禁用 |
| Web Admin | 桌面/手机、浅色/深色、缩放布局、列表/弹窗/表单与操作反馈 |
| 升级与回滚 | 先备份、带数据升级、重启生效、可恢复旧包与对应状态 |

对不可执行的真实环境场景写 **BLOCKED / NOT TESTED**，而不是 PASS。
旧版本和历史验收不能替代对当前提交的复测。

## 4. 核对 npm 发布权限（此步骤只读）

```bash
npm whoami
npm view dsh-plugin-feishu-gateway versions --json
npm view dsh-plugin-feishu-admin versions --json
npm view dsh-plugin-feishu-gateway dist-tags --json
npm view dsh-plugin-feishu-admin dist-tags --json
```

`npm view` 如果提示 404，应区分“包尚不存在”和“无访问权限”；
发布前核对包名所有权、2FA、发布令牌和是否允许公开。

## 5. **验收通过后**的手动发布（后备方案）

仅在授权发布时，使用**CI 已验收的同一提交**重新核对工件哈希。
两个包是独立的 npm 版本；示例以实际 `package.json` 自动读取：

```bash
GATEWAY_VERSION=$(node -p "require('./package.json').version")
ADMIN_VERSION=$(node -p "require('./web-admin/package.json').version")
(cd dist && sha256sum -c SHA256SUMS)

npm publish "./dist/dsh-plugin-feishu-gateway-$GATEWAY_VERSION.tgz" --tag beta --access public
npm publish "./dist/dsh-plugin-feishu-admin-$ADMIN_VERSION.tgz" --tag beta --access public
```

不要执行 `npm publish`（不带 `--tag`），以免意外改写 `latest`。
两次发布不是原子操作：任一失败应停止部署，查明哪个版本已发布，
不可对已发布的相同版本直接重试修改内容。

正式 npm 发布之前或之后，均应通过已通过 CI 的同一提交建立预发布 tag / GitHub prerelease，
附两个 tarball、SHA256SUMS、变更说明、兼容 DSH 版本、已知限制与验收记录。
安装时固定各自的**具体 beta 版本**，不要用 `latest`。

## 6. 发布判定

- **READY**：最新提交 CI、工件校验、人工安全检查、双包实际安装、
  关键真实飞书验收与回滚演练均通过；发布者确认 npm 版本未被占用。
- **BLOCKED**：出现 P0/P1 安全缺陷、DSH 安装失败、实际消息丢失/重复产生副作用、
  配置/会话不可逆损坏、真实验收缺失却要求公开宣称可用。
- **RC only**：功能主体通过，但存在明确记录的非阻断问题；在 Release Notes 中列出。

发布之前不自动改写生产配置、清理用户会话或删除旧版本。
