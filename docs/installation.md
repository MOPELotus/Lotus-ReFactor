# 安装与部署

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

请在 Yunzai 根目录执行：

```bash
pnpm approve-builds
pnpm rebuild skia-canvas
```

如果 Lotus-Plugin 是 Yunzai workspace 里的子项目，必须把允许构建配置放在 Yunzai 根 `package.json`，子项目里的 `pnpm.onlyBuiltDependencies` 不会生效：

```json
{
  "pnpm": {
    "onlyBuiltDependencies": [
      "skia-canvas"
    ]
  }
}
```

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
