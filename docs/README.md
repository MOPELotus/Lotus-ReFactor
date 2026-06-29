# 荷花插件文档

这里是 `Lotus-Plugin ReFactor` 的详细说明。主 README 只放概览，本目录按大功能模块组织；每个模块下面再拆到具体小功能页。

## 安装与运行

- [安装与部署](installation.md)
- [初始化](initialization.md)
  - [工具链-BBDown/ffmpeg/aria2](features/tools.md)

## 账号、Profile 与安全

- [登录与多 profile](profile-login.md)
  - [设备信息-profile 绑定](features/device.md)
- [验证码链](captcha.md)
- [权限系统](permissions.md)
- [远程 spawn](remote-spawn.md)

## 签到

- [签到与调度总览](checkin.md)
  - [自动签到-多 profile](features/checkin.md)
  - [签到调度-随机与固定](features/scheduler.md)

## 游戏数据查询

- [个人查询总览](daily-note.md)
  - [体力查询-原神、星铁、绝区零](features/daily-note.md)
  - [面板查询-原神、星铁、绝区零](features/panel-query.md)
  - [战绩查询-原神、绝区零](features/record-query-genshin-zzz.md)
  - [战绩查询-星铁](features/record-query-starrail.md)
  - [抽卡记录-原神、星铁、绝区零](features/gacha-log.md)
  - [队伍伤害-原神](features/team-damage-genshin.md)
  - [队伍伤害-星铁](features/team-damage-starrail.md)
  - [挑战查询-图鉴期数](features/challenge-query.md)

## 图鉴与成就

- [图鉴总览](atlas.md)
  - [图鉴查询-多游戏资料](features/atlas-gallery.md)
  - [成就图鉴-查漏补缺](features/achievements.md)

## 媒体、外部任务与群管理

- [B 站解析与下载](bilibili.md)
- [网易云合伙人-自动任务](features/netease-partner.md)
- [群管理-成员导出与退群清理](features/group-manager.md)

## 快速索引

- [指令索引](commands.md)
- [小功能索引](features/README.md)

安装本插件会替代部分外部插件的登录、验证码 handler、体力、B站解析等入口。若不希望被替代，请不要同时安装对应功能插件。

使用中遇到问题，欢迎加入荷花的小群 `702211431` 反馈。
