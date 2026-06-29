# **警告：使用本插件会禁用或替代部分插件的部分功能，安装即同意此条款！**

# Lotus-Plugin ReFactor

`Lotus-Plugin` 的重构版，目标是把旧插件拆成可维护、可测试、profile-aware 的实现。主页面只保留概览，完整使用说明请看 [文档目录](docs/README.md)。

本项目为源码可见的专有软件（Source-Available Proprietary Software）。允许个人非商业原样使用；禁止二次修改发布、搬运、商用、售卖及去除署名。完整条款见 [LICENSE](LICENSE)。

## 文档

完整使用说明请从 [文档目录](docs/README.md) 进入。常用入口：

- 安装与运行：[安装与部署](docs/installation.md)、[初始化](docs/initialization.md)
- 账号与安全：[登录与多 profile](docs/profile-login.md)、[验证码链](docs/captcha.md)、[权限系统](docs/permissions.md)
- 签到：[签到与调度](docs/checkin.md)
- 查询与图鉴：[个人查询](docs/daily-note.md)、[图鉴与成就](docs/atlas.md)
- 媒体与管理：[B 站模块](docs/bilibili.md)、[远程 spawn](docs/remote-spawn.md)
- 快速查命令：[指令索引](docs/commands.md)

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
- [zolay-poi/achievements-plugin](https://gitee.com/zolay-poi/achievements-plugin)
- [AFanSKyQs/FanSky_Qs](https://github.com/AFanSKyQs/FanSky_Qs)
- [TimeRainStarSky/Yunzai](https://github.com/TimeRainStarSky/Yunzai)
- [yoimiya-kokomi/miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin)
- [guoba-yunzai/guoba-plugin](https://github.com/guoba-yunzai/guoba-plugin)

敏感数据只允许写入 `data/` 或用户本地配置，不要提交 cookie、stoken、mid、打码平台 key、OTP secret 或远程 spawn 输出。

## 交流与反馈

使用中遇到问题，欢迎加入荷花的小群 `702211431` 反馈。
