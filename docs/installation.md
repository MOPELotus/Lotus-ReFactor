# 安装与部署

返回：[项目主页](../README.md) / [文档目录](README.md)

## 环境

- Node.js 按当前 Yunzai/TRSS 环境要求准备。
- 常规用户建议使用 `pnpm install`。
- 维护者自己的 TRSS fork 可继续使用 Yarn v4；公开仓库默认按 `pnpm` 安装。
- Windows 是第一目标平台；Linux 可以使用，但初始化脚本会优先保证 Windows 行为。

## 安装

```bash
git clone --recurse-submodules https://github.com/MOPELotus/Lotus-ReFactor.git Lotus-Plugin
cd Lotus-Plugin
corepack enable
pnpm install
```

pnpm v10 会默认拦截依赖的构建脚本。`skia-canvas` 是图片渲染需要的原生依赖，如果安装时出现：

```text
Ignored build scripts: skia-canvas
```

最简单的修法：进入 Yunzai 根目录，也就是包含 Yunzai 自己 `package.json`、并且安装后生成根 `node_modules` 的目录，执行：

```bash
cd /path/to/Yunzai
pnpm approve-builds
pnpm rebuild skia-canvas
```

`pnpm approve-builds` 会让你选择允许执行构建脚本的包。选中 `skia-canvas`，确认后再执行 `pnpm rebuild skia-canvas`。

如果需要手写配置，不要写到 `plugins/Lotus-Plugin/package.json`。你的日志里出现 `Scope: all 18 workspace projects`，说明 pnpm 以 Yunzai 为 workspace 根目录，插件只是其中一个子项目；允许构建配置要写在 Yunzai 根目录的 `pnpm-workspace.yaml`：

```yaml
onlyBuiltDependencies:
  - skia-canvas
```

保存后回到 Yunzai 根目录重新执行 `pnpm install` 或 `pnpm rebuild skia-canvas`。

插件首次加载时会自动生成 `config/global.yaml`。如果已经安装锅巴插件，可以直接在锅巴面板里修改荷花插件的全局配置。

本地验证码的 `onnxruntime-node` 使用包内自带的 CPU 运行库，无需 CUDA。Linux x64 安装脚本可能额外下载 CUDA 组件，可在安装时设置环境变量 `ONNXRUNTIME_NODE_INSTALL=skip` 跳过，例如 `ONNXRUNTIME_NODE_INSTALL=skip pnpm install`；这不会关闭图片渲染所用的显卡。

如果 clone 时没有拉子模块：

```bash
git submodule update --init --recursive
```

## 首次启动与旧版升级

安装依赖并重启机器人后，默认延迟三分钟自动准备本地验证码模型、TuneWeave 和 FFmpeg；已有环境会检查完整性与最新版本，需要时修复或更新。没有变化时不发通知，日常无需手动初始化。`#初始化环境` 用于立即检查或失败后重试。完整规则与下载清单见 [初始化与自动维护](initialization.md)。

从旧版升级前保存本地配置和 `data/`，通过 Git 更新源码，按宿主的 workspace 方式更新依赖并重启。账号、设备和设置会保留；外部识别服务、远程 TuneWeave 和其他外部环境由原部署方维护。签到和验证码无需 Python 或 venv。

主人私聊发送 `#荷花管理面板` 获取独立配置页的限时链接；普通用户使用 `#米游社功能` 管理自己的 profile 与任务。具体入口、权限及有效期见 [网页说明](miyoushe.md)。

## 不建议同时安装

这些插件的部分功能会被荷花插件替代或禁用：

- 逍遥插件的登录、图鉴、抽卡 authkey 相关入口。
- TRSS-Plugin 的米哈游登录入口。
- loveMys 的全局验证码 handler。
- device-plugin 的全局设备注入逻辑。
- 小花火、rconsole 等插件里的 B站解析入口。

荷花插件不会直接修改这些插件的文件。插件启动时会补齐 Yunzai/TRSS 的 `config/config/group.yaml` 禁用项，并注册更高优先级入口；验证码 handler 会替换旧的全局 handler。
