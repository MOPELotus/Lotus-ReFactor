# 安装与部署

## 环境

- Node.js 按当前 Yunzai/TRSS 环境要求准备。
- 常规用户建议使用 `pnpm install`。
- 维护者自己的 TRSS fork 可继续使用 Yarn v4；公开仓库默认按 `pnpm` 安装。
- Windows 是第一目标平台；Linux 可以使用，但初始化脚本会优先保证 Windows 行为。

## 安装

```bash
git clone --recurse-submodules <repo> Lotus-Plugin
cd Lotus-Plugin
corepack enable
pnpm install
```

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

荷花插件不会直接修改这些插件的文件，而是在运行时注册更高优先级入口或跳过冲突 handler。
