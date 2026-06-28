export const LOTUS_INTERCEPT_PRIORITY = Number.NEGATIVE_INFINITY

export const LOTUS_CONFIG_DISABLED_PLUGIN_NAMES = Object.freeze([
  // TRSS-Plugin overlaps
  "米哈游登录",
  "远程命令",
  "文件操作",
  "脚本执行",

  // miao wiki overlaps. Keep 角色查询/角色面板 for cards and panel transform.
  "角色资料",

  // Nwflower/Atlas overlaps
  "Atlas图鉴",
  "Atlas图鉴管理",
  "Atlas图鉴帮助",
  "Atlas原魔属性计算",

  // achievements-plugin overlaps. Lotus owns achievement import/catalog rendering.
  "成就查漏",
  "achievements-plugin",

  // xiaoyao catch-all adapter
  "xiaoyao-cvs-plugin",

  // ZZZ atlas/wiki overlaps. Keep player challenge apps.
  "[ZZZ-Plugin]wiki",

  // StarRail-plugin overlaps. Lotus owns SR personal queries/challenges.
  "星铁别名设置",
  "星铁plugin-深渊",
  "星穹铁道",
  "星铁plugin抽卡分析",
  "星铁plugin-货币战争",
  "[星铁插件]帮助",
  "星铁plugin基本信息",
  "星铁面板-兼容版",
  "星铁plugin-收入",
  "星铁plugin-体力",
  "星铁plugin-面板",
  "星铁plugin-模拟宇宙",
  "星铁插件-角色信息/攻略",
  "米游社星铁攻略",
  "星铁更新插件",
  "StarRail-Plugin更新日志",

  // xhh overlaps
  "[小花火]bili",
  "[小花火]图鉴",
  "[小花火]签到",
  "[小花火]米游社签到",
  "[小花火]体力小组件",
  "[小花火]原神卡池历史",
  "[小花火]星铁历史卡池",
  "[小花火]米哈游最新视频",
  "[小花火]米哈游视频",

  // rconsole is intentionally disabled as a whole.
  "R插件帮助",
  "R插件查询类",
  "R插件点歌",
  "R插件开关类",
  "R插件工具和学习类",
  "R插件更新插件",

  // Liangshi atlas/wiki overlaps.
  "Wiki",
  "wuwaWiki",

  // FanSky_Qs team damage overlaps.
  "提瓦特小助手",

  // loveMys / related captcha handler overlaps.
  "mys请求错误处理",
  "[loveMys] 插件更新",

  // bujidao / bujidaoRUN overlaps.
  "寄·配置",
  "[寄]深渊查询",
  "[寄]角色查询",
  "寄·米游社更新面板",
  "寄·体力",
  "寄·签到",

  // kissnavel/genshin overlaps. Avoid generic 用户绑定 so base genshin can stay alive.
  "genshin·星铁信息",
  "genshin·绑定设备",
  "genshin·mys请求错误处理",
  "genshin·米游社更新面板",
  "genshin·体力",
  "genshin·崩三体力查询",
  "genshin·签到",

  // JS/Bilibili overlaps
  "bilitv",
  "[Yuki-Plugin] bilibili",
])

export const LOTUS_RUNTIME_DISABLED_PLUGIN_NAMES = LOTUS_CONFIG_DISABLED_PLUGIN_NAMES

export const LOTUS_CAPTCHA_HANDLER_NAMESPACE = "Lotus-Plugin"

export const LEGACY_CAPTCHA_HANDLER_NAMESPACES = Object.freeze([
  "loveMys",
  "@小新枝",
  "genshin",
  "bujidao",
  "ji-plugin",
])
