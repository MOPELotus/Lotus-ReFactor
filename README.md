# **警告：使用本插件会禁用或替代部分插件的部分功能，安装即同意此条款！**

# Lotus-Plugin ReFactor

`Lotus-Plugin` 的重构版，目标是把旧插件拆成可维护、可测试、profile-aware 的实现。主页面只保留概览，完整使用说明请看 [文档目录](docs/README.md)。

## 大功能

- 米游社扫码登录、cookie/stoken 刷新、genshin/miao 兼容桥接。
- 单 QQ 多 profile：`#扫码登录2`、`#刷新cookie2`、`#补签2` 这类后缀指令都按 profile 生效。
- 自动签到：游戏签到、社区签到、签到前刷新、失败通知本人、私聊失败时共同群 at。
- 随机/固定签到调度：前一天生成次日计划，并给用户推送签到时间图片。
- 多 provider 验证码链：`test_nine -> ttocr -> GT-Manual`，同时服务 JS handler 与 Python 签到。
- Python venv 初始化：`MihoyoBBSTools`、`test_nine`、模型和运行依赖默认不污染系统 Python。
- 内置设备信息绑定：社区签到和米游社请求统一注入设备信息与 UA。
- 全 profile 全游戏体力：原神、星铁、绝区零按 profile/UID 汇总，单项失败不影响其他项。
- 抽卡记录与面板更新：按 profile 指定登录态生成 authkey 或调用底层插件逻辑。
- 本地图鉴：接入 nanoka atlas 数据，首次全量抓取，后续按版本差异增量更新。
- B 站解析/下载：长链、短链、BV、av、QQ 分享卡片；下载只走 BBDown，直播只发信息卡和独立播放器链接。
- 远程 spawn、上传、下载：master + 2FA + 审计 + 脱敏 + 超时限制。
- scope 权限系统：替代旧黑白名单模型。
- 统一 Skia Canvas 图片渲染：全局 MiSans，复用 calendar 风格，不再依赖 Puppeteer 截大页面。

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
