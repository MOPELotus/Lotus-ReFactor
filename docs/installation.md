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

如果 clone 时没有拉子模块：

```bash
git submodule update --init --recursive
```

## 不建议同时安装

这些插件的部分功能会被荷花插件替代或禁用：

- 逍遥插件的登录、图鉴、抽卡 authkey 相关入口。
- TRSS-Plugin 的米哈游登录入口。
- loveMys 的全局验证码 handler。
- device-plugin 的全局设备注入逻辑。
- 小花火、rconsole 等插件里的 B站解析入口。

荷花插件不会直接修改这些插件的文件。插件启动时会补齐 Yunzai/TRSS 的 `config/config/group.yaml` 禁用项，并注册更高优先级入口；验证码 handler 会替换旧的全局 handler。
