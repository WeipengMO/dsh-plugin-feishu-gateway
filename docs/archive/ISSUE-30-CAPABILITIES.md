# Issue #30: DSH 能力调查与权限边界

## 当前实现

Web Admin 对定时任务读取、预览、命令和结果读取，通过 DSH
`connection.admit(req)` 获取可信 Peer 的 principal；当前只允许 `owner`。
操作按 view、create、edit、run、delete 分类，未知主体或缺少可信 admission
时拒绝。旧 `/ops/commands` 的 schedule 命令也经同一检查；
`/ops` 对无权限主体过滤 schedule 命令结果。请求正文和 HTTP 自定义头不决定身份。
认证错误、跨站限制仍由既有 security 检查处理。

当前 DSH 浏览器连接共享同一个 owner Peer，不能区分多个浏览器用户；
此功能不是按个人分配权限的 RBAC。其他管理接口仍遵循原有授权机制，
不能把这个局部检查当成整套 Web 服务隔离。管理 API 的配置要求不变；
如果 DSH 不提供 admit，定时任务接口返回 503 而不是降级放行。

## 不应开放的能力

- ScheduleService.run 的 AbortSignal 取消的是请求／投递事务，不是已经入队或
  开始执行的一次运行。当前版本没有按 taskId + messageId 精确取消运行的
  公共 Schedule API。Agent.cancel 是会话级，可能取消同一 Session 的其他工作；
  当前不添加运行取消按钮或声称取消成功。
- 原生 Schedule 支持 session/new_once/new 目标，但 Gateway 的归属校验、
  事件观察、审批路由和飞书投递绑定在 Gateway 自有 Session 上。直接切换到
  任意 Session 或每次新建 Session，不能证明结果、审批及权限隔离，暂不开放。
- 当前列表和管理路径仍基于 DSH Host 的原生任务目录；现有 delete-inactive
  调用原生 Host 范围的批量删除。该路径继承 #19 的既有行为，不是本次新增的
  细粒度任务所有权。实现跨 Profile 的安全目标选择前，必须先解决可信任务
  所有权、并发修改和批量操作范围，不能把本次 owner 检查当作任务级 ACL。

## 验证范围

管理接口自动测试覆盖 owner、非 owner、未知主体、admit 缺失、专用接口及
旧命令邮箱绕过。项目完整 verify 和隔离 DSH_HOME 的离线 daemon-smoke
分别运行；后者只验证原生 Session 桥和 Gateway 生命周期，并非新权限能力
的真实浏览器／角色或真实飞书验收。

后续要满足 Issue #30 全部验收，需有可靠的逐次运行取消能力及稳定的执行
关联，完成受控目标所有权设计；并取得可区分身份的可信 DSH 主体或建立
经过设计的独立认证机制，然后在独立测试 Profile 对所有角色和目标实测。

