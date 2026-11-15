# Gateway 0.2.0-rc.4：卡片状态底栏灰色小字

本版本在 0.2.0-rc.3 的布局基础上只调整**视觉样式**：

- 最终回答正文保持默认字体大小和颜色。
- 正文下方保留横线和逐行的模型、Token 用量、速度、用时。
- 底栏单独使用飞书新版 CardKit `markdown` 元素的 `text_size: "notation"`（12px）与 `<font color='grey'>…</font>`。
- 每行独立包裹灰色字体标签，保留原有换行。
- 未能获得的字段继续隐藏，不新增模型请求、提示词或 Token 消耗。
- 单卡片交付、移除取消按钮、原生审批及 DurableOutbox 兜底逻辑不变。

参考飞书官方 [富文本组件文档](https://open.feishu.cn/document/feishu-cards/feishu-card-cardkit/components/markdown?lang=zh-CN)，灰色字体与辅助信息 12px 均为受支持样式。

Gateway 版本升为 `0.2.0-rc.4`；Web Admin 保持 `0.2.0-rc.1`。安装包：`dist/dsh-plugin-feishu-gateway-0.2.0-rc.4.tgz`。

```bash
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run verify
pnpm run pack
dsh plugin --profile feishu-channel add "$PWD/dist/dsh-plugin-feishu-gateway-0.2.0-rc.4.tgz"
```

安装后须在无在途任务的维护窗口重启飞书通道进程以加载新插件。不要清除现有 Session、Inbox、Outbox 或凭据。**本次仓库改动没有自动部署、重启或执行真实飞书 CardKit 显示验证**；实机验收应检查桌面与移动端的灰色小字、换行、正文不变及仅一张最终卡片。
