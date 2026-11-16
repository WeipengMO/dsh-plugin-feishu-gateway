# 飞书用量统计与模型命令

## 飞书控制命令

- `/models` 列出当前飞书 Gateway Host 已注册、可发现的模型，并标出当前会话模型。
- `/model provider/model` 切换当前聊天绑定的 DSH 原生 Session 模型；
  例如 `/model magpie/group/deepseek`。其他聊天、定时任务和 DSH 默认模型
  不会因此修改。模型目录可能因提供方不可用而不完整。
- `/stop` 请求停止当前聊天任务；已经执行的副作用不会回滚。旧 `/cancel`
  暂作为兼容别名。切换与当前聊天工作串行执行。

模型目录来自运行飞书通道的 DSH Profile，与 DSH Web Profile 独立；
Web 中配置的模型不一定安装到飞书 Profile。模型目录不产生 LLM 对话调用。

## 用量和历史范围

新版将 Gateway 管理的定时任务原生 usage 组件写入用量账本，并按原生消息
标识去重；缺失 usage 时记录未知，不推算为零。飞书投递未启用的定时任务
归入 schedule 分类。现有数据只来源于 Gateway 实际观察到的任务事件，
不能等同于 DSH 所有任务的完整消耗。

旧版本的 schedule-runs.json 最多保留最近 200 条结果。页面只读合并其中
已有的 Token 总数；历史记录没有输入、输出和缓存拆分，显示为部分覆盖，
不会伪造各项明细。无法恢复已不在该账本中的历史。旧记录无法可靠恢复
当时的机器人或聊天归属，以 schedule 分类展示。

“按模型统计”使用条形图展示所选时段有记录的模型；没有记录不代表用量为零。
模型筛选包含 Gateway 当前目录及历史中出现过的模型，但目录中的模型不代表
已完成凭据或真实调用验证。飞书内使用 /models 查看目录和当前会话模型。

## 管理后台的模型与 Fallback 选择

「飞书管理 → 模型与连接」不再使用“留空代表继承原 Profile”的空值约定：Provider 与模型
选项直接来自**运行飞书通道的 DSH Profile**，不是 DSH Web Profile。

- Gateway 通过 `ctx.get('llm')` 的 `listProviders()` / `listModels()` 生成 provider 分组目录，
  写入脱敏的 `stateDir/ops-runtime.json`（`modelCatalog.providers`、`agentRoute`、
  `profileDefaultRoute`）。Web Admin 只读这份白名单快照，不查询自己的模型。
- 表单优先级：Host 当前生效路由（`agentRoute`）→ DSH Profile 默认模型
  （`profileDefaultRoute`）→ 已保存的托管值。目录不可用或通道离线时保留上次快照并标注；
  从未保存过路由时表单为空且不会伪造默认值。已保存但目录中已不存在的路由会以
  “（不在 DSH 目录）”保留为可选项，避免选择框空白。
- 保存时显式写入 `agent: { provider, model, fallback }`。`fallback: null` 表示清除；
  主模型与 Fallback 必须是两个不同且完整的 `provider/model` 路由，否则 API 拒绝保存。
- Fallback 不是 DSH 原生能力：如果主模型请求在**该轮尚未执行任何工具**（无副作用）时失败，
  Gateway 会把该 Session 切换到 Fallback 模型并重试一次；一旦执行过工具，失败按原失败路径
  处理，绝不重放。切换会写入运维事件 `task/fallback-retry`。
- 修改保存后需重启独立飞书通道生效；飞书内 `/models` 会同时显示当前生效的 Fallback 路由。
