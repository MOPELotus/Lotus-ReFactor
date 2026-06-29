# 权限系统

荷花插件使用 scope 型权限，不再使用旧的单一黑白名单模型。

```yaml
permissions:
  default_policy: allow
  users:
    allow: []
    deny: []
  groups:
    allow: []
    deny: []
  scopes:
    checkin.register:
      policy: inherit
    remote.spawn:
      policy: master_only
```

常用指令：

- `#权限列表`
- `#权限允许用户 10001`
- `#权限拒绝用户 10001`
- `#权限移除用户 10001`
- `#权限允许群 123456`
- `#权限拒绝群 123456`
- `#权限移除群 123456`
- `#权限设置 checkin.register allow`
- `#添加黑名单 10001`
- `#删除黑名单 10001`
- `#添加白名单 10001`
- `#删除白名单 10001`
- `#签到黑名单列表`
- `#自动签到白名单`

旧黑白名单指令只是兼容入口，实际写入新权限模型。
