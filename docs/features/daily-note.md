# 体力查询-原神、星铁、绝区零

返回：[上一级](../daily-note.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 按 profile 和游戏 UID 收集体力数据，不把 profile 序号当作 UID。
- `全部体力` 会遍历当前 QQ 的 profile、游戏和 UID。
- 单个 UID 查询失败不会中断其他 UID。
- 原神、星铁和绝区零都使用对应 profile 的本人登录态。

## 指令用法

```text
#全部体力[profile]
#多体力[profile]
#全体力[profile]

#体力[profile]
#树脂[profile]
#便笺[profile]
*体力[profile]
#星铁体力[profile]
%体力[profile]
#绝区零体力[profile]
```

## 变量说明

- `profile`：可选，Lotus 内部 profile 序号，范围 `1..255`；省略时使用 profile 1；用于 `全部体力` 时只收集指定 profile。
