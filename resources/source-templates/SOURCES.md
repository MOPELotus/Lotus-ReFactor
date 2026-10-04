# 原模板与素材来源

本目录保留用于原生 Skia 适配的原 HTML/CSS 和实际素材，便于核对结构与权利归属。页面中的原路径和模板变量保持上游形式；机器人实际入口为 `core/render/source-cards.js`。

- genshin：本机 `plugins/genshin/resources`，所属 Miao-Yunzai 仓库 <https://gitee.com/yoimiya-kokomi/Miao-Yunzai>。账号采用 `html/user/uid-list` 的游戏分组、序号与 UID 横条；体力采用 `html/player/daily-note-gs` 的图标／名称／时间与右侧数值行；媒体采用 `html/mysNews` 的作者、标题、正文和页脚；搜索采用 `html/mysNews-list` 的序号、摘要与图片列表。`note-icons/gs` 从原 CSS 内的 PNG 提取，未重画。
- Miao-Plugin：<https://github.com/yoimiya-kokomi/miao-plugin>，本机版本 `1988f546f1972fd3911ca15fc1259184709f876b`。签到、队伍面板、伤害与成就表采用 `character/profile-stat` 的标题与表格；群排名采用 `character/rank-profile-list` 的横向排名条；状态与计划采用 `help/version-info` 的标题与日志列表；扫码采用 `help/index` 的标题与分组容器，并适配二维码内容。原背景与主体图片来自相应模板的 CSS 引用。
- `miao-stat/fonts/NZBZ.ttf` 与 `tttgbnumber.ttf`：来自 Miao `resources/common/font`。正文原字体、元素背景与面板纹理位于 `../miao-theme/`，其来源与 Miao MIT 授权见该目录的 `SOURCES.md` 和 `MIAO-LICENSE.txt`。
- 四种星铁挑战统一适配 genshin `abyss/abyss-floor`；原素材与字体来源见 `../starrail-abyss/SOURCES.md`。图鉴使用 Miao `wiki/character-talent` 的组件，原生实现为 `core/render/atlas-pages.js`。
- 媒体正文保留 genshin `mysNews` 的作者、标题、封面与正文顺序，结合 Miao `help/index` 的元素背景、深色圆角容器与金色组标题。体力行及表格外框增加圆角，数值列按完整字段单行适配；队伍输出手法横向连续排列，数据来源置于页脚。

字体、原游戏图像与人物素材的权利归相应权利人；以上来源记录不扩张其授权范围。运行数据和私人 profile 不属于此素材目录。
