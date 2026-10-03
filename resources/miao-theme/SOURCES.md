# Miao 风格 Skia 图鉴素材来源

- 版式依据：Miao-Plugin `resources/wiki/character-talent.html`、`character-talent.css`，以及 common 样式中的角色属性背景、圆形头像、金色标题、深色天赋面板。
- `bg/*.webp`：本机 Miao-Plugin `resources/common/bg` 原文件；`card-bg.png` 来自 `resources/common/cont/card-bg.png`。
- `fonts/HYWH-65W.ttf`：Miao-Plugin 原字体，未用近似字体替换。
- `character-facts.json`：从 Miao `resources/meta-gs/character/data.json`、`meta-sr/character/data.json` 和 ZZZ-Plugin `resources/data/hakush/data/character/*.json` 提取角色名、稀有度、属性、职业、阵营。
- `portraits/*.webp`：Miao 原神角色 `resources/meta-gs/character/<角色名>/imgs/splash.webp`，保留原始立绘，避免把低分辨率头像放大成角色总览。
- `relic-parts/*.webp`、`relic-parts/index.json`：Miao 原神 `resources/meta-gs/artifact/imgs` 和星铁 `resources/meta-sr/artifact/<套装名>/arti-*.webp`。索引保留角色之外的实际部件名与资源对应关系；星铁不同稀有度部件复用同一张官方图。
- Miao 仓库：<https://github.com/yoimiya-kokomi/miao-plugin>，本机版本 `1988f546f1972fd3911ca15fc1259184709f876b`。原 MIT 授权见 `MIAO-LICENSE.txt`。
- ZZZ-Plugin 仓库：<https://gitee.com/bietiaop/ZZZ-Plugin>，本机版本 `d05aea4721f57792d08a420e49d355340dba6b1a`。
- 星铁混沌回忆的 genshin 深渊素材单独记录于 `../starrail-abyss/SOURCES.md`。

运行时优先使用图鉴后端已下载的真实图片，部件图缺失时使用上述 Miao 原素材。未提供有效图片的条目不加载后端问号占位 SVG。人物、游戏图像和字体的权利归原权利人所有；此来源记录不扩张其授权范围。

稀有度交叉核对：绝区零使用 A／S 级代理人、B／A／S 级音擎，后端的内部编号 2／3／4 不能直接绘制成星级。官方公告示例：<https://zenless.hoyoverse.com/en-us/news/129524>。新角色名称另外核对了官方角色页面：<https://zenless.hoyoverse.com/zh-cn/character/detail?id=155657>。本地参考表未覆盖的条目保留有效源名称，不凭版本印象否定新角色，也不宣称其技能数值已经全部获得官方确认。
