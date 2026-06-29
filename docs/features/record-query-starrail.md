# 战绩查询-星铁

返回：[上一级](../daily-note.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 星铁挑战查询由 Lotus 自己实现，不依赖 StarRail-plugin。
- 支持混沌回忆、虚构叙事、末日幻影和异相仲裁。
- 不带期数字样时也会捕获当前用户的个人战绩查询。
- 页面按 profile 选择 UID，并自动使用该用户打过的最高难度或最高层记录。

## 指令用法

```text
*混沌[profile]
*虚构[profile]
*末日[profile]
*异相[profile]
```

## 变量说明

- `profile`：可选，Lotus 内部 profile 序号，范围 `1..255`；省略时使用 profile 1。
