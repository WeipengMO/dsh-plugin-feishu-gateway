# 开发、测试与版本维护

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `src/` | Gateway、消息队列、原生 Session、定时任务、审批和模型配置 |
| `web-admin/src/` | Web Admin 管理 API、前端页面、会话整理和权限校验 |
| `tests/` | Gateway 单元与集成（主要 Mock） |
| `web-admin/test/` | Web Admin API、安全与前端构建测试 |
| `scripts/channel/` | 独立 Gateway 启动与服务状态脚本 |
| `scripts/e2e/` | 真实或模拟 Host/Feishu 的验收 Harness |
| `docs/` | 用户指南及技术参考；历史资料在 `docs/archive/` |
| `research/` | 早期 DSH API 调研和研究报告（非当前实现声明） |

## 当前版本与依赖

两个 npm 包**独立编号**：根目录 [package.json](../package.json) 是 Gateway，`web-admin/package.json` 是 Admin。文档和安装命令不要写死某次 rc 的 tgz 文件名。DSH 和 Node 最低版本以两个包的 `engines` 为准，安装前确认匹配。

## 本地验证

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm run test
pnpm --dir web-admin test
pnpm run test:coverage
pnpm run pack
```

也可执行 `pnpm run verify` 完成文档链接检查、类型检查、构建和主要测试。仅验证 Markdown 链接可访问本仓库中的文件，不验证外部网站或标题锚点。打包只验证 tarball 可生成，**不代表** DSH Host / Web 或飞书真实租户已加载成功。

## 实机验收等级

- **Mock/CI**：复现受控模型、API、读写与安全契约；与真实网络、SDK 和用户权限无关。
- **隔离 DSH Profile**：确认加载、Session 恢复、Web 插槽、原生调度和工作区操作；不可修改正式 stateDir。
- **真实飞书租户**：以实际发送/接收、群聊权限、卡片、审批和重启验收为准；[E2E 指南](E2E.md)。
- 验收报告按**具体提交、版本、环境和日期**记录，不应把早期通过的结果直接套用到新功能。

## 文档维护规则

1. 只在 [首次部署](GETTING-STARTED.md) / [运维](OPERATIONS.md) 维护当前安装和服务管理指令。
2. [README](../README.md) 只做介绍、最短安装和文档导航，避免不断追加 Issue 和 rc 更新日志。
3. 功能文档说明“做什么、在哪操作、安全边界、验收”，不写已经过期的版本安装包。
4. 已完成的一次性验收、旧版发布说明和设计草稿进入 [历史资料](archive/README.md)。
5. 尚未实现的行为必须标注“待实现”并关联 Issue，不在 UI/文档中使用暗示完成的按钮和措辞。
6. PR 通过 CI 之后仍应先进行真实 DSH/飞书环境的适配验证，再合并发布。
