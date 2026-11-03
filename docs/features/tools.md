# 工具链-TuneWeave/FFmpeg

返回：[项目主页](../../README.md) / [文档目录](../README.md)

发送 `#初始化环境`，统一检查本地验证码模型、TuneWeave 和 FFmpeg。旧 `#初始化工具环境`、`#初始化签到环境` 都调用这个流程，不再分为两套。开机延迟后会自动准备和更新环境，无变化时静默；此指令用于立即执行或失败后重试，旧自动安装开关不再阻止统一环境准备。点歌、视频和合伙人共用同一服务。完整清单及开机延迟更新说明见 [初始化](../initialization.md)。

B站媒体通过 TuneWeave 解析，JavaScript 执行并发分段下载、重试和备用地址切换，FFmpeg 负责音视频合流与转码。并发数通过 `bilibili.download.concurrency` 设置，范围为 1–16，默认 4；服务器不支持 Range 时使用完整流下载。

FFmpeg 保留完整编译包，包括随包提供的 ffprobe、ffplay。Windows 识别 `.exe`，Linux/macOS 识别无后缀程序并设置可执行权限。

不再安装或启动 BBDown、aria2c，不再创建 Python/venv。旧工具和环境目录不会自动删除。
