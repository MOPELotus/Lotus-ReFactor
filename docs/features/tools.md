# 工具链与缓存

工具链初始化入口：

- `#初始化工具环境`

会准备：

- BBDown
- ffmpeg 完整构建
- ffprobe
- ffplay
- aria2c

Windows 会识别 `.exe`；Linux/macOS 会识别无后缀可执行文件，并自动补 `chmod +x`。

B 站下载只走 BBDown。ffmpeg 和 aria2 是自动准备的配套工具，不再提供“是否使用 BBDown”的开关。

如果下载目录里出现损坏压缩包、不完整 shared 包、`.part` 临时文件，初始化会自动重下修复。
