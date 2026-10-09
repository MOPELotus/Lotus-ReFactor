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
- `shell`：必填，支持 `pwsh`、`powershell`、`cmd`、`bash`、`sh`、`zsh`，主机必须已安装对应 Shell，且 `remote.shells` 白名单允许使用。
- `command`：必填，要执行的命令文本。
- `path`：必填，上传或下载的目标路径。

首次使用先由 bot 主人执行 `#远程2FA初始化`。荷花插件会生成一张二维码，使用 Microsoft Authenticator 或其他 TOTP 应用扫码添加。之后远程命令、管理员 spawn、上传、下载都需要把应用里显示的 6 位一次性验证码写在指令里。

默认 secret 保存到 `data/remote/otp.yaml`。如果配置了环境变量 `LOTUS_REMOTE_OTP_SECRET`，会优先使用环境变量，适合容器或受控部署。

## Linux Shell

```text
#远程spawn 123456 bash uname -a
#远程spawn 123456 sh df -h
#远程spawn 123456 zsh pwd
```

Linux Shell 使用 `-c` 执行完整命令文本，支持管道、重定向和多行命令。运行目录为 bot 的当前工作目录，标准输入关闭，适合非交互命令。命令在 bot 所在主机运行，以 bot 的身份执行。超时会终止整个命令进程组，包括管道和后台子进程。

新配置默认包含上述 Shell；已有配置的 `remote.shells` 白名单不会被自动扩大。升级后请通过锅巴配置或 `config/global.yaml` 把需要的 `bash`、`sh`、`zsh` 加入白名单，并开启 `remote.enable`。

管理员入口要求 `remote.allow_admin: true`。Windows 要求 bot 已以管理员权限运行；Linux 要求 bot 已以 root 身份运行。插件不会自动调用 sudo 或绕过 UAC。
