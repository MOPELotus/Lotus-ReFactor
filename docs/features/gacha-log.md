# 抽卡记录-原神、星铁、绝区零

返回：[上一级](../daily-note.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 原神和星铁通过对应 profile 的 stoken 生成 `authkey`。
- 绝区零优先使用 CK 直刷；只有获取或刷新抽卡链接时才生成 `authkey`。
- 限流、缓存和数据路径都按 profile 与游戏 UID 区分。
- `更新全部抽卡记录` 会遍历当前用户可用 profile。

## 指令用法

```text
#更新抽卡记录[profile]
*更新抽卡记录[profile]
#星铁更新抽卡记录[profile]
%更新抽卡记录[profile]
#绝区零刷新抽卡链接[profile]
#绝区零更新抽卡记录[profile]
#更新全部抽卡记录
```

## 变量说明

- `profile`：可选，Lotus 内部 profile 序号，范围 `1..255`；省略时使用 profile 1。
