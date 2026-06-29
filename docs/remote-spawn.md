# 远程 spawn

返回：[项目主页](../README.md) / [文档目录](README.md)

远程命令、上传、下载都必须满足：

- bot master
- 2FA 一次性验证码
- 审计日志
- 输出脱敏
- 超时限制
- 输出长度限制

## 指令用法

```text
#远程2FA初始化
#远程2FA状态
#远程spawn <otp> <shell> <command>
#远程管理员spawn <otp> <shell> <command>
#远程下载 <otp> <path>
#远程上传 <otp> <path>
#远程上传覆盖 <otp> <path>
```

## 变量说明

- `otp`：必填，TOTP 应用显示的 6 位一次性验证码。
- `shell`：必填，要使用的 shell，例如 `pwsh` 或 `bash`。
- `command`：必填，要执行的命令文本。
- `path`：必填，上传或下载的目标路径。

首次使用先由 bot 主人执行 `#远程2FA初始化`。荷花插件会生成一张二维码，使用 Microsoft Authenticator 或其他 TOTP 应用扫码添加。之后远程命令、管理员 spawn、上传、下载都需要把应用里显示的 6 位一次性验证码写在指令里。

默认 secret 保存到 `data/remote/otp.yaml`。如果配置了环境变量 `LOTUS_REMOTE_OTP_SECRET`，会优先使用环境变量，适合容器或受控部署。

管理员权限不默认绕过 UAC。只有配置允许且 bot 进程本身已经以管理员权限运行时，才允许管理员 spawn。
