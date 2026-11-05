# 网易云合伙人-自动任务

返回：[文档目录](../README.md) / [小功能索引](README.md)

## 初始化与登录

仅机器人主人可操作，按顺序发送：

```text
#初始化环境
#TuneWeave状态
#合伙人登录
#合伙人测试
```

`#合伙人测试` 会实际提交评分和配置的乐评，也接受 `#合伙人测试（执行）`。`#合伙人日志` 以合并转发查看当天日志中的歌曲、主分、各子项分数、对应乐评及每轮结果。

统一 `#初始化环境` 会准备适合当前系统的 TuneWeave 官方预编译文件，校验 SHA-256 后启动本机服务；已有可用实例直接复用。音乐、视频和合伙人共用同一服务，不再要求为合伙人单独下载。旧 `#初始化TuneWeave` 保留为只准备该服务的入口。初始化完成后，Yunzai 重启会恢复本机服务；默认三分钟后检查最新官方清单与程序完整性，必要时校验更新、重启服务并通知主人，详见 [开机更新](../initialization.md#tuneweave-开机更新)。默认地址为 `http://127.0.0.1:7832`，可通过 `tuneweave.api_url` 指向其他自托管实例；远程实例须自行部署。缺少所需登录或扩展 API 能力时会明确报错。当前发布物支持 Linux x64、Windows x64/arm64、macOS x64/arm64，其他平台需自行部署。

网易云点歌与合伙人共用扫码登录；也可发送 `#音乐登录` 选择网易云。使用网易云音乐 App 扫码，账号凭据由 TuneWeave 服务端托管；Lotus 的 `data/netease/accounts.yaml` 仅保存账户别名、UID 和任务偏好。首次初始化本机服务时，使用 TuneWeave 官方启动 Cookie 配置承接第一个旧账号；该启动凭据只保存在私有 `data/tuneweave/bootstrap.json` 中。首次任务核验默认账号 UID 后，Lotus 账号文件移除旧 Cookie。多个旧账号中的其余账号、外部实例或身份不一致的账号须重新扫码，旧记录会保留。

## 评分与汇报

任务读取、额外任务读取和评分提交全部通过 TuneWeave 的网易云扩展 API。每首作品读取自己的 `supportExtraEvaTypes`（旧数据兼容 `dimensions`），每个子项独立打分；`extraScore` 会完整提交，不能仅发评论与主分。作品没有提供子项时，报告明确标注，不补造评分维度。

每个账号每日目标 20 首，完成数不足 20 时再重试一轮；两轮按作品 ID 合并，已完成作品不重复提交，最终只汇报一次。图片仅显示成功、失败数量；日志记录歌曲、主分、全部子项分数、对应乐评和每轮结果。已完成作品计入成功数。登录成功后启用自动任务，仍按 `netease_partner.schedule` 每日执行；默认每天 00:05，已有自定义 cron 保留。`notify_master: true` 时，自动任务给主人发送汇报图。启动补跑由 `auto_catch_up` 控制；手动与定时任务并发时只执行一轮。

乐评在主人管理面板的“网易云任务”中配置，也可编辑本机 `config/global.yaml` 的 `netease_partner.review`。默认 `mode: fixed`，沿用 `netease_partner.comments` 中的评论库；每轮优先不重复抽取，用完才循环，更新不会覆盖已有评论库。本机乐评库不纳入源码仓库。

`mode: codex` 使用机器人运行用户已登录的本机 Codex CLI，无需配置 API 密钥；`codex_command` 默认 `codex`，也可填写程序绝对路径。`mode: responses` 使用 `api_url` 指定的 Responses 接口及私有 `api_key`，服务须支持 `web_search` 工具。两种 AI 模式均结合本次任务拿到的歌曲、作者、风格与歌词等信息联网查证；缺少或无法确认的资料不编造，不冒充已经试听。Codex CLI 的 `model` 留空沿用本机默认模型；Responses API 必须明确填写 `model`。

`max_chars` 默认 140，可设为 20～500 个字符；这是保守的生成长度限制，并非已确认的平台硬性字数上限。`timeout_ms` 默认 180000 毫秒。AI 生成失败、超时或资料不足时，跳过本首评论并记录原因，不回退到无关套话；账号关闭评论时同样明确标注未发布。日志记录每首作品实际提交的乐评。切换到 AI 模式不会删除原有固定评论库。

自动任务按日去重：当天执行过后，重复 cron 触发不再执行或汇报；失败重试已包含在同一次任务中。手动 `#合伙人测试` 仍可显式执行。

## 数据与配置

- `tuneweave.api_url`：自托管服务地址。
- `tuneweave.request_timeout_ms`：请求超时，默认 30000 毫秒。
- `netease_partner`：定时、通知、登录超时、操作间隔与固定评论库。
- `netease_partner.review`：乐评生成方式、字数与超时限制、Codex CLI 程序及 Responses 接口配置；原来用于网易云服务的顶层 `netease_partner.api_url` 已移除，与这里的 `review.api_url` 无关。
- `data/tuneweave/`：本机可执行文件、私有账户数据与日志。
- `data/netease/accounts.yaml`：Lotus 账号信息；`data/netease/state.yaml`：任务状态。
- `data/logs/nep-latest.json`：当天最新的逐作品评分报告，次日执行覆盖；旧的带时间戳合伙人日志会清理，其他功能日志保留。

账户数据和旧配置备份含有秘密，不应上传。
