# **警告：使用本插件会禁用或替代部分插件的部分功能，安装即同意此条款！**

# Lotus-Plugin ReFactor

`Lotus-Plugin` 的重构版，目标是把旧插件拆成可维护、可测试、profile-aware 的实现。主页面只保留概览，完整使用说明请看 [文档目录](docs/README.md)。

## 大功能

- 米游社扫码登录与 cookie/stoken 刷新，兼容 genshin/miao。
- 单 QQ 多 profile，`#扫码登录2`、`#刷新cookie2` 等后缀指令按 profile 生效。
- 自动签到支持游戏签到、社区签到、签到前刷新和用户结果通知。
- 签到调度支持随机/固定时间，并提前通知次日计划。
- 验证码链按顺序尝试 `test_nine`、`ttocr`、`GT-Manual`。
- 默认使用 Python venv，自动准备 `MihoyoBBSTools`、`test_nine`、模型和工具链。
- 内置设备绑定，为社区签到和米游社请求提供设备信息。
- 体力、面板、抽卡按 profile 和 UID 处理原神、星铁、绝区零数据。
- 本地图鉴接入 nanoka atlas，首次全量抓取，后续增量更新。
- B 站支持长链、短链、BV、av、QQ 分享卡片；视频走 BBDown，直播发播放器链接。
- 远程 spawn、上传、下载需要 master 权限、2FA、审计和脱敏。
- scope 权限系统替代旧黑白名单。

## 文档

- [安装与部署](docs/installation.md)
- [初始化](docs/initialization.md)
- [登录与多 profile](docs/profile-login.md)
- [签到与调度](docs/checkin.md)
- [验证码链](docs/captcha.md)
- [图鉴](docs/atlas.md)
- [体力、面板、抽卡](docs/daily-note.md)
- [B 站模块](docs/bilibili.md)
- [远程 spawn](docs/remote-spawn.md)
- [权限系统](docs/permissions.md)
- [指令索引](docs/commands.md)

## 鸣谢

感谢以下项目提供的思路及技术支持：

- [MOPELotus/xiaoyao-cvs-plugin](https://github.com/MOPELotus/xiaoyao-cvs-plugin)
- [ctrlcvs/xiaoyao-cvs-plugin](https://github.com/ctrlcvs/xiaoyao-cvs-plugin)
- [Womsxd/MihoyoBBSTools](https://github.com/Womsxd/MihoyoBBSTools)
- [luguoyixiazi/test_nine](https://github.com/luguoyixiazi/test_nine)
- [luguoyixiazi/model_save](https://huggingface.co/luguoyixiazi/model_save)
- [device-plugin](https://gitee.com/liangho-ng/device-plugin)
- [kissnavel/loveMys](https://github.com/kissnavel/loveMys/)
- [ttocr 文档](https://www.ttocr.com/docs)
- [ZZZure/ZZZ-Plugin](https://github.com/ZZZure/ZZZ-Plugin)
- [Nwflower/Atlas](https://github.com/Nwflower/Atlas)
- [MOPELotus/calendar-plugin](https://github.com/MOPELotus/calendar-plugin)
- [MOPELotus/nanoka-atlas-backend](https://github.com/MOPELotus/nanoka-atlas-backend)
- [TimeRainStarSky/Yunzai](https://github.com/TimeRainStarSky/Yunzai)
- [yoimiya-kokomi/miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin)

敏感数据只允许写入 `data/` 或用户本地配置，不要提交 cookie、stoken、mid、打码平台 key、OTP secret 或远程 spawn 输出。
