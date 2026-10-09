# 抽卡记录-原神、星铁、绝区零

返回：[上一级](../daily-note.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 原神通过对应 profile 的 stoken 生成 `authkey`。
- `#更新小助手抽卡记录[profile]` 自动使用 Lotus profile 的 stoken 获取凭据，从提瓦特小助手后台导入原神国服记录，无需逍遥插件或手动链接。兼容 `#获取提瓦特小助手祈愿历史[profile]` 等原指令别名。
- 小助手同步会将 UID 和含 authkey 的查询链接提交给小助手后台；不会发送 stoken。记录按 ID 去重合并到 Yunzai 的 `data/gachaJson/<qq>/<uid>/`，可直接用现有抽卡分析查看；本次收到数与新增数分别报告，空记录不清除本地数据。
- Lotus 在 Yunzai 禁用列表中加入上游功能名 `提瓦特小助手抽卡记录`，避免 TianRu 的同名入口重复处理。
- 星铁使用 profile Cookie 登录官方抽卡统计活动，读取五星记录与各卡池抽数，不依赖 `authkey`。
- 绝区零优先使用 CK 直刷；只有获取或刷新抽卡链接时才生成 `authkey`。
- 星铁记录以官方稳定记录 ID 增量合并；重复更新不会重复叠加，活动 token 和 Cookie 不落盘。
- 星铁接口不提供完整三星、四星明细；Lotus 保存五星、累计已抽和当前垫抽，数据位于 `data/starRailGachaJson/<qq>/<uid>.json`。
- 缓存和数据路径都按 profile 对应的游戏 UID 区分。
- `更新全部抽卡记录` 会遍历当前用户可用 profile。

## 指令用法

```text
#更新抽卡记录[profile]
#更新小助手抽卡记录[profile]
*更新抽卡记录[profile]
#星铁更新抽卡记录[profile]
%更新抽卡记录[profile]
#绝区零刷新抽卡链接[profile]
#绝区零更新抽卡记录[profile]
#更新全部抽卡记录
```

## 变量说明

- `profile`：可选，Lotus 内部 profile 序号，范围 `1..255`；普通单 profile 指令省略时会按 profile 1 的同一路由执行。
