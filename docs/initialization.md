# 初始化

## 基础配置

全局配置样例在 `config/global.example.yaml`。用户 profile 样例在 `config/profile.example.yaml`。

插件加载时如果没有 `config/global.yaml`，会自动按默认配置创建，不需要手动复制样例文件。已安装锅巴插件时，可以在锅巴面板里修改全局配置。

运行时数据会写入：

- `data/users/<qq>.yaml`
- `data/users/<qq>-2.yaml`
- `data/python/`
- `data/tools/`
- `data/atlas/`

这些目录不应提交。

## 签到环境

发送：

```text
#初始化签到环境
```

会检查并准备：

- `data/python/venv`
- `MihoyoBBSTools` 子模块依赖
- `data/python/test_nine_venv`
- `test_nine` 服务依赖
- `data/test_nine/model`
- BBDown、ffmpeg、aria2 工具链

默认使用 venv，不污染系统 Python。高级用户可以在全局配置里切换为 system Python。

## 下载工具

发送：

```text
#初始化工具环境
```

会按系统和架构准备 BBDown、ffmpeg、aria2。B 站下载只保留 BBDown 路径，不再提供“是否使用 BBDown”的开关。

ffmpeg 会下载完整编译包，而不是只拷贝 `ffmpeg` 一个文件；Windows 会识别 `.exe`，Linux/macOS 会识别无后缀可执行文件。解压后会把 BBDown、ffmpeg、ffprobe、ffplay、aria2c 等可执行文件加入插件工具目录，并在非 Windows 系统上自动补 `chmod +x`。

如果下载目录里存在不完整 shared 包、损坏压缩包或 `.part` 临时文件，初始化会按损坏状态重新下载并修复。
