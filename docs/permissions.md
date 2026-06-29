# 权限系统

返回：[项目主页](../README.md) / [文档目录](README.md)

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

## 指令用法

```text
#权限列表
#权限配置
#权限允许用户 <用户ID>
#权限拒绝用户 <用户ID>
#权限移除用户 <用户ID>
#权限允许群 <群号>
#权限拒绝群 <群号>
#权限移除群 <群号>
#权限设置 <scope> <策略>

#添加黑名单 <用户ID>
#删除黑名单 <用户ID>
#添加白名单 <用户ID>
#删除白名单 <用户ID>
#签到黑名单列表
#自动签到白名单
```

## 变量说明

- `用户ID`：必填，目标 QQ。
- `群号`：必填，目标群号。
- `scope`：必填，权限域，例如 `checkin.register`。
- `策略`：必填，支持 `allow`、`deny`、`inherit`、`master_only` 等配置策略。

旧黑白名单指令只是兼容入口，实际写入新权限模型。
