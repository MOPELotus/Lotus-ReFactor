# 面板查询-原神、星铁、绝区零

返回：[上一级](../daily-note.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 按 profile 选择登录态和游戏 UID，再构造一次性查询上下文。
- 原神和星铁面板转接 miao/genshin 的既有数据能力。
- 绝区零面板使用对应 profile 的绝区零 UID 和设备信息。
- 批量修复只清理原神和星铁面板缓存，并按间隔重新更新。

## 指令用法

```text
#更新面板[profile]
#星铁更新面板[profile]
*更新面板[profile]
#绝区零更新面板[profile]
%更新面板[profile]
#修复原铁面板 间隔<秒数>

#面板角色[profile]
*面板角色[profile]
#<角色名>面板[profile]
*<角色名>面板[profile]
%练度统计[profile]
#练度统计[profile]
#角色查询[profile]
#天赋统计[profile]
```

## 变量说明

- `profile`：可选，Lotus 内部 profile 序号，范围 `1..255`；省略时使用 profile 1。
- `角色名`：必填，要查询的角色名或别名。
- `秒数`：必填，批量修复时每个账号之间的等待秒数。
