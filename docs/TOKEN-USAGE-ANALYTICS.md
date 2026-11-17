# Token 用量历史趋势与日历热图（Issue #17）

> **用量统计技术说明**：展示的数据来自 Gateway 已记录的模型/任务 usage，不代表 DSH 所有历史调用或账单费用。用户操作入口见 [Web 管理](WEB-ADMIN.md)，模型与命令见 [模型及用量](USAGE-AND-MODELS.md)。

## 数据链路

Gateway 复用 DSH SessionBridge.waitForReply() 已汇总的模型 usage，不发起额外 LLM 请求。仅针对尝试过原生 Session submit 的任务，终态记录一个脱敏结算事件；未返回 usage 的失败、超时、取消任务也会记录为「未知」，而不是 0。

- 历史目录：<stateDir>/ops-usage/YYYY-MM-DD.jsonl。按 UTC 日分文件、追加写，目录权限 0700、文件 0600。
- 字段：version、结算时间、ref、botId、状态、可选 model/session/user/chat、inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens。
- ref、session、user、chat 是稳定 SHA-256 截断关联标识；从不存飞书原始 ID、消息正文、工具参数或凭据。这些哈希是关联标识，而不是授权令牌。
- 合计口径与现有任务卡片保持一致：input + output + cacheRead + cacheWrite。
- 无 usage 的任务不写 Token 数值。可用 Token 与缺失 usage 次数分开展示。
- 按 botId+任务 ref 去重；有 usage 的重复记录优先于未知记录，质量相同取最后记录。
- 进程崩溃在 finally 执行之前可能造成数据缺口；不能把缺口推断为零用量。

旧 ops-events.jsonl 继续作为短期滚动审计，不作为历史统计来源。

## 管理端

飞书管理 → 用量统计：日历热图、悬浮显示日期/输入/输出/总量/调用次数，今天/近 7 天/近 30 天/本月/自选日期，按日/周/月聚合，以及柱状图/折线图、峰值日、累计已知用量、日均/周均和缺失 usage 计数。支持按模型、机器人、用户哈希、聊天哈希、Session 哈希过滤，并切换输入/输出/总量指标；CSV 导出当前筛选后的聚合统计。

接口：
- GET /api/feishu-admin/ops/usage
- GET /api/feishu-admin/ops/usage/export

查询参数：from/to（YYYY-MM-DD）、tz（IANA 时区，例如 Asia/Shanghai）、period（day/week/month）、metric（total/input/output）、model、botId、user、chat、session。单次最多 366 天。当地自然日按结算时间的指定时区归属，周从周一开始。历史采集之前的日历格为「无覆盖」，不表示当日用量为零。

这两个 API 复用原生 DSH Web 的 connection.requestRejection 会话授权和同源安全校验；不得转发为公开端点。运维者需限制 DSH Web 登录范围，普通飞书用户不能从聊天获得管理端统计。

## 保留时长

为 Gateway 进程的 systemd Environment 或实际加载的环境文件增加：

    DSH_FEISHU_USAGE_RETENTION_DAYS=365

默认 365，可配置范围 7–730 天；修改后重启 Gateway。每个新 UTC 日第一次写入时清理保留期外的旧日期文件，不触碰不符合命名规则的文件和链接。采集从部署版本开始，不回填历史短期日志；删除历史文件后不可恢复细粒度筛选数据。

## 成本估算

尚未提供可信的各模型输入、输出、缓存单价及币种，因此本实现**不显示费用**。费用估算在 Issue 中属于可选需求，后续应按模型定价配置且与实际账单明确区分。

## 验收

1. 构建并部署 Gateway 与 Web Admin 两个插件，重启相应服务，实际运行一个有 native DSH usage 的飞书任务。
2. 检查原生任务 Token 与用量页中的已知数据一致；未返回 usage 的任务计入「缺失」但不增加已知 Token。
3. 在当地午夜前后进行时区查询；重复事件不应双计。浏览器不应因查询 366 天统计而请求任何 LLM。
4. 未认证管理接口及 CSV 请求必须返回 401/403；CSV 应与页面聚合匹配，不含原始会话消息。
5. pnpm run verify 和 GitHub CI 需通过。真实 Feishu/LLM 端到端验证需在部署环境完成。
