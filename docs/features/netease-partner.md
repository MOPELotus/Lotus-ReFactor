# 网易云合伙人-自动任务

返回：[文档目录](../README.md) / [小功能索引](README.md)

## 初始化与登录

仅机器人主人可操作，按顺序发送：

```text
#初始化TuneWeave
#TuneWeave状态
#合伙人登录
#合伙人测试
```

`#合伙人测试` 会实际提交评分和配置的乐评，也接受 `#合伙人测试（执行）`。`#合伙人日志` 以合并转发查看当天日志中的歌曲、主分、各子项分数、对应乐评及每轮结果。

初始化独立下载适合当前系统的 TuneWeave 官方预编译文件，校验 SHA-256 后启动本机服务；已有可用实例直接复用。它不随工具环境初始化自动下载。初始化完成后，Yunzai 重启会恢复本机服务。默认地址为 `http://127.0.0.1:7832`，可通过 `tuneweave.api_url` 指向其他自托管实例；远程实例须自行部署。缺少所需登录或扩展 API 能力时会明确报错。当前发布物支持 Linux x64、Windows x64/arm64、macOS x64/arm64，其他平台需自行部署。

使用网易云音乐 App 扫码，账号凭据由 TuneWeave 服务端托管；Lotus 的 `data/netease/accounts.yaml` 仅保存账户别名、UID 和任务偏好。首次初始化本机服务时，使用 TuneWeave 官方启动 Cookie 配置承接第一个旧账号；该启动凭据只保存在私有 `data/tuneweave/bootstrap.json` 中。首次任务核验默认账号 UID 后，Lotus 账号文件移除旧 Cookie。多个旧账号中的其余账号、外部实例或身份不一致的账号须重新扫码，旧记录会保留。

## 评分与汇报

任务读取、额外任务读取和评分提交全部通过 TuneWeave 的网易云扩展 API。每首作品读取自己的 `supportExtraEvaTypes`（旧数据兼容 `dimensions`），每个子项独立打分；`extraScore` 会完整提交，不能仅发评论与主分。作品没有提供子项时，报告明确标注，不补造评分维度。

每个账号每日目标 20 首，完成数不足 20 时再重试一轮；两轮按作品 ID 合并，已完成作品不重复提交，最终只汇报一次。图片仅显示成功、失败数量；日志记录歌曲、主分、全部子项分数、对应乐评和每轮结果。已完成作品计入成功数。登录成功后启用自动任务，仍按 `netease_partner.schedule` 每日执行；默认每天 00:05，已有自定义 cron 保留。`notify_master: true` 时，自动任务给主人发送汇报图。启动补跑由 `auto_catch_up` 控制；手动与定时任务并发时只执行一轮。

乐评使用本机 `config/global.yaml` 的 `netease_partner.comments`，更新不会覆盖此文件；本机乐评库不纳入源码仓库。每轮优先不重复抽取，用完才循环，日志记录每首作品实际提交的乐评；账号关闭评论时明确标注未发布。

## 数据与配置

- `tuneweave.api_url`：自托管服务地址。
- `tuneweave.request_timeout_ms`：请求超时，默认 30000 毫秒。
- `netease_partner`：保留定时、通知、登录超时、操作间隔和评论配置；原 `api_url` 已移除。
- `data/tuneweave/`：本机可执行文件、私有账户数据与日志。
- `data/netease/accounts.yaml`：Lotus 账号信息；`data/netease/state.yaml`：任务状态。
- `data/logs/nep-latest.json`：当天最新的逐作品评分报告，次日执行覆盖；旧的带时间戳合伙人日志会清理，其他功能日志保留。

账户数据和旧配置备份含有秘密，不应上传。
