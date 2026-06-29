# 战绩查询-原神、绝区零

返回：[上一级](../daily-note.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 原神战绩按 profile 选择 UID 后转接既有查询能力。
- 绝区零战绩按 profile 选择绝区零 UID 后转接 ZZZ 查询能力。
- profile 后缀只表示 Lotus 内部账号槽位，不会被当作游戏 UID。
- 图鉴期数语义会交给 [挑战查询-图鉴期数](challenge-query.md)，不抢个人战绩入口。

## 指令用法

```text
#深渊[profile]
#幻想[profile]
#危战[profile]

%防卫战[profile]
%危局[profile]
%临界[profile]
%月报[profile]
```

## 变量说明

- `profile`：可选，Lotus 内部 profile 序号，范围 `1..255`；省略时使用 profile 1。
