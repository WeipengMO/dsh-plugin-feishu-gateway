# MCP 与外部工具（独立飞书通道）

飞书管理的 **MCP / 外部工具** 页面为飞书通道的 DSH Profile 管理多个可选 MCP Server，不修改全局 Profile，也不直接安装程序或获取凭据。

## 可用连接方式

- **Streamable HTTP**：填写任意可访问的 HTTP(S) MCP Endpoint（可以是另一台机器上的服务）。一个 Server 有唯一名称和独立端点。
- **stdio**：填写已安装在通道主机上的可执行程序及参数，一行一个参数，DSH 负责进程生命周期。
- 远程服务需要 Authorization 时只填写 **DSH credential 引用名**；实际认证值由 DSH 的 credentials provider 在运行时解析，不得将令牌放进 URL、日志或仓库。
- 多个 Server 的命名必须唯一；可以分别停用而保留配置。

## 存储、启动与安全边界

管理端用 `GET/PUT /api/feishu-admin/external-tools` 读写 `<stateDir>/external-tools.json`（0600），经独立的 revision 校验防止覆盖并发编辑。启用的 MCP Server 生成 `<stateDir>/extra-plugins.patch.yml`（0600），均为本机受管文件，不属于代码仓库。

启动脚本按顺序向 DSH 添加：

1. `exec-policy.patch.yml`（若存在）
2. `extra-plugins.patch.yml`（若存在）
3. `FEISHU_CHANNEL_EXTRA_PATCHES` 指定的本机文件（可选，冒号分隔多个**现有普通文件路径**）

额外补丁是运维可信文件，用于组合其他插件。它们不会更改 Web Profile。手工维护的 `extra-plugins.patch.yml` 不会被 UI 强行覆盖；迁移需先由运维在主机侧完成。

保存后需要重启独立飞书通道，正在执行的任务会中断。连接成功与否应在通道日志、DSH 的 MCP 状态及实际工具调用中验证；管理端的“保存成功”**不代表已连上 MCP**。

## 代理与私有网络

「模型与连接 → 网络代理 → 直连例外」可配置私有服务的完整域名、主机 IP 或匹配后缀，启动脚本合并到 `NO_PROXY/no_proxy`。这适用于自建服务、本地模型、企业内网与其他私有网络，并不限定某个专有的网络工具。

CIDR 在本插件的 WebSocket 代理路由中支持，但部分 Node HTTP 客户端对 CIDR 的处理不同；**HTTP MCP Endpoint 推荐填写精确的目标主机或 IP** 以获得可预期的直连行为。对于通过其它启动方式运行的 DSH，需由该启动器独立提供环境变量。

## Agent 工作模式

若已安装 `@deepseek-ai/dsh-agent-preset-registry`，可在独立 Feishu Profile 中定义特定工作模式，再通过「模型与连接」选择该 preset。该功能由原生 DSH 管理；本页面只管理 MCP 实例，不隐式修改 preset/Agent 的系统指令。切换 preset 后发送 `/new` 创建新 Session 生效。
