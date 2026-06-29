# 登录与多 profile

一个 QQ 最多允许 `1..255` 个 Lotus profile。

- `#扫码登录` 绑定 profile 1。
- `#扫码登录2` 绑定 profile 2。
- `#刷新cookie` 刷新当前 QQ 的全部 profile。
- `#刷新cookie2` 只刷新 profile 2。
- `#登录列表` 查看已创建 profile。
- `#清除登录2` 清除 profile 2 的敏感登录信息。

profile 只是 Lotus 内部槽位，不等于米哈游 `ltuid`，也不等于游戏 UID。

登录成功后，荷花插件会保存：

- cookie
- stoken
- mid
- ltoken
- 米哈游角色列表
- genshin/miao 能识别的 NoteUser/MysUser 关系

账号密码登录已经裁剪。外部插件的账号密码入口会被荷花插件阻断，并提示改用扫码登录。

## 配置资料卡

发送：

```text
#荷花配置
#荷花配置2
```

资料卡会显示登录态、设备、角色、签到开关和通知设置。敏感字段会脱敏。

相关小功能：

- [设备信息](features/device.md)
