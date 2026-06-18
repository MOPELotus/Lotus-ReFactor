# 远程 spawn

远程命令、上传、下载都必须满足：

- bot master
- 2FA 一次性验证码
- 审计日志
- 输出脱敏
- 超时限制
- 输出长度限制

示例：

```text
#远程2FA初始化
#远程2FA状态
#远程spawn 123456 pwsh Get-Process
#远程下载 123456 C:\path\file.txt
#远程上传 123456 C:\target\file.txt
```

首次使用先由 bot 主人执行 `#远程2FA初始化`。荷花插件会生成一张二维码，使用 Microsoft Authenticator 或其他 TOTP 应用扫码添加。之后远程命令、管理员 spawn、上传、下载都需要把应用里显示的 6 位一次性验证码写在指令里。

默认 secret 保存到 `data/remote/otp.yaml`。如果配置了环境变量 `LOTUS_REMOTE_OTP_SECRET`，会优先使用环境变量，适合容器或受控部署。

管理员权限不默认绕过 UAC。只有配置允许且 bot 进程本身已经以管理员权限运行时，才允许管理员 spawn。
