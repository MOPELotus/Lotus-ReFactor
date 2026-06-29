# 工具链-BBDown/ffmpeg/aria2

返回：[上一级](../initialization.md) / [文档目录](../README.md) / [小功能索引](README.md)

## 功能特性

- 自动准备 B 站下载所需的 BBDown、ffmpeg、ffprobe、ffplay 和 aria2c。
- Windows 识别 `.exe` 文件；Linux/macOS 识别无后缀可执行文件，并在初始化时补 `chmod +x`。
- 下载到损坏压缩包、不完整 shared 包或 `.part` 临时文件时，会清理后重新下载。
- B 站下载固定走 BBDown，ffmpeg 和 aria2c 只作为配套工具链。

## 指令用法

```text
#初始化工具环境
```

## 变量说明

此指令没有额外变量。初始化结果会写入运行时缓存目录，正常使用时不需要手动移动工具文件。
