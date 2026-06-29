# 自动签到-多 profile

返回：[上一级](../checkin.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 签到按 profile 执行，刷新登录态、游戏签到、社区签到和通知都使用同一个 profile。
- 单个 profile 失败不会影响同一用户的其他 profile。
- 结果优先私聊通知；私聊不可用时在共同群聊 at 用户。
- 国际服和云游戏只在用户绑定对应 cookie/token 后参与签到。

## 指令用法

```text
#注册自动签到[profile]
#注册本群签到[profile]
#测试签到[profile]
#开始签到[profile]
#手动签到[profile]
#补签[profile]

#启用<游戏>签到[profile]
#关闭<游戏>签到[profile]
#启用全部游戏签到[profile]
#关闭全部游戏签到[profile]

#启用社区签到[profile]
#关闭社区签到[profile]

#开启签到通知[profile]
#关闭签到通知[profile]
#绑定通知群[profile]
#设置通知私聊[profile]
#设置通知群聊[profile]
```

## 变量说明

- `profile`：可选，Lotus 内部 profile 序号，范围 `1..255`；省略时使用 profile 1。
- `游戏`：必填，支持 `原神`、`星铁`、`绝区零` 等已接入的游戏名。
