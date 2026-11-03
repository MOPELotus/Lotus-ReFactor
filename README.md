# Lotus-Plugin ReFactor

面向 Yunzai 的荷花插件，使用独立 profile 管理账号、设备和功能设置。完整命令与配置见 [文档目录](docs/README.md)。

**本插件会禁用或替代部分插件的对应功能，安装前请确认功能接管范围。**

## 主要功能

- 米游社统一管理：JavaScript 游戏签到、社区任务、米游币商城兑换与追踪，共用管理入口和账号队列。
- 登录与设备：扫码登录、stoken 刷新、旧登录数据修复、设备绑定；未绑定设备的 profile 自动保存兼容的虚拟设备并申请官方 FP。
- 验证码：本地 JavaScript / ONNX v3 识别、外部识别和人工回退；v3、v4 分开处理，每次重试使用新挑战。
- 音乐与视频：TuneWeave 多平台搜索、扫码登录、点歌、音源回退，以及视频搜索与解析；JavaScript 分段下载，FFmpeg 处理媒体。
- 个人查询与代操作：按 profile 转交或查询战绩、体力、抽卡等数据，保留目标账号上下文并过滤桥接按钮消息。
- 原生 Skia 卡片、图鉴、伤害计算、通知和其他工具，详见各功能文档。

签到和验证码均无需 Python 或 venv。音乐默认标准音质，先发送所选平台的卡片，再发送完整语音；不把试听当作整首歌。

## 安装与配置

在 Yunzai 的 `plugins` 目录安装本仓库并安装插件依赖：

```sh
git clone https://github.com/MOPELotus/Lotus-ReFactor.git Lotus-Plugin
cd Lotus-Plugin
pnpm install --ignore-workspace
```

重启机器人后发送 `#初始化环境`，按配置准备本地验证码模型、TuneWeave 和 FFmpeg。原 `#初始化签到环境`、`#初始化工具环境` 仍是同一入口的兼容别名。全局设置可通过锅巴或 `#荷花面板` 管理；账号和设备按用户 profile 保存。

- [安装说明](docs/installation.md)
- [初始化与下载清单](docs/initialization.md)
- [命令说明](docs/commands.md)
- [登录与 profile](docs/profile-login.md)
- [米游社统一管理](docs/miyoushe.md)
- [验证码](docs/captcha.md)
- [音乐](docs/music.md)

## 从旧版升级

保存本地配置和 `data/` 后，通过 Git 更新源码，在插件目录执行 `pnpm install --ignore-workspace`（或按宿主的 workspace 方式更新依赖）并重启。启动后的延迟维护会按配置准备所需环境，保留已有账号、设备和设置；外部识别服务、远程 TuneWeave 和其他外部环境继续由原部署方管理。自动准备与清理规则见 [初始化说明](docs/initialization.md)。

插件不会自动兑换未经配置的商品。后台追踪遇到验证码只使用自动识别；Web 手动兑换可继续人工验证。商城 v4 仍需在自然触发风控时完成真实业务验收，不触发验证码的兑换走原业务流程。

## 许可证

本项目为源码可见的专有软件（Source-Available Proprietary Software）。允许个人非商业原样使用；禁止二次修改发布、搬运、商用、售卖及去除署名。完整条款见 [LICENSE](LICENSE)。

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
- [Black-Cyan/napcat-plugin-douyin](https://github.com/Black-Cyan/napcat-plugin-douyin)
- [ikenxuan/karin-plugin-kkk](https://github.com/ikenxuan/karin-plugin-kkk)
- [ikenxuan/kkkkkk-10086](https://github.com/ikenxuan/kkkkkk-10086)
- [misaka20002/siliconflow-plugin](https://github.com/misaka20002/siliconflow-plugin)
- [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)
- [HDTianRu/TianRu-plugin](https://github.com/HDTianRu/TianRu-plugin)
- [Marchen-orz/MiyoQian](https://github.com/Marchen-orz/MiyoQian)
- [kissnavel/genshin](https://github.com/kissnavel/genshin)
- [MOPELotus/TuneWeave](https://github.com/MOPELotus/TuneWeave)
- [xfdown/xiaofei-plugin](https://github.com/xfdown/xiaofei-plugin)
- [SmallK111407/earth-k-plugin](https://github.com/SmallK111407/earth-k-plugin)
- [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime)
- [nilaoda/BBDown](https://github.com/nilaoda/BBDown)
- [aria2/aria2](https://github.com/aria2/aria2)
- [python-pillow/Pillow](https://github.com/python-pillow/Pillow)（本地验证码的 JS 重采样实现参考）
- [Ljzd-PRO/nonebot-plugin-mystool](https://github.com/Ljzd-PRO/nonebot-plugin-mystool)
- [PaiGramTeam/SIMNet](https://github.com/paigramteam/simnet)
- [taskmgr818/geetest-v3-click-server](https://github.com/taskmgr818/geetest-v3-click-server)
- [MOPELotus/GT-Manual](https://github.com/MOPELotus/GT-Manual)
- [Hlhs/GT-Manual](https://gitee.com/QQ1146638442/GT-Manual)
- [UIGF-org/mihoyo-api-collect](https://github.com/UIGF-org/mihoyo-api-collect)
- [Android Open Source Project](https://source.android.com/)
- [Google Pixel 固件透明日志](https://developers.google.com/android/binary_transparency/image_info.txt)

敏感数据只允许写入 `data/` 或用户本地配置，不要提交 cookie、stoken、mid、打码平台 key、OTP secret 或远程 spawn 输出。

## 交流与反馈

使用中遇到问题，欢迎加入荷花的小群 `702211431` 反馈。
