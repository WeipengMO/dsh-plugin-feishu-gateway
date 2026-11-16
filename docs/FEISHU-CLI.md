# 独立飞书 CLI 权限排查

Gateway 通过 DSH 原生 Agent 调用独立安装的 lark-cli；CLI 不依赖 OpenClaw，也不属于本项目运行依赖。CLI 的应用身份、凭据、权限和群成员资格独立于 Gateway。

## 确认运行身份

在 DSH 服务使用的用户和环境中执行：

```sh
command -v lark-cli
lark-cli --version
lark-cli whoami
lark-cli auth status
lark-cli doctor
```

不要输出或提交密钥、令牌或完整配置。不同用户、HOME、PATH 或 CLI profile 可能选择不同身份。

## 处理 app_scope_not_applied

例如 application +slash-command-list --as bot 返回 99991672，missing_scopes 为 application:app_slash_command:read，表示 CLI 当前飞书应用尚未申请该接口所需权限；修改项目代码或编译产物不能直接授予权限。

1. 用 lark-cli whoami 确认实际 appId 和身份，并检查错误中的 missing_scopes。
2. 在飞书开放平台打开该 CLI appId 对应的应用，申请所需权限，完成平台要求的版本发布和管理员审批。
3. 在同一运行环境重试 lark-cli application +slash-command-list --as bot。检查 JSON 中的 ok 和 error，不要只依赖退出码。若失败，记录脱敏错误码、missing_scopes 和 log_id。

此权限仅供查询应用斜杠命令，不是 Gateway 或所有 CLI 操作的通用前提。不同操作还可能需要其他应用权限、用户授权、资源共享或群成员资格。auth scopes 的 tokenType 必须与目标身份对应，用户 scope 列表不能证明机器人权限。

曾观察到 CLI 应用 cli_a978… 与 Gateway 应用 cli_a930… 不同，以实时配置为准。不要通过绑定 OpenClaw 解决此问题，也不要擅自切换 CLI profile、覆盖凭据或更改身份策略。
