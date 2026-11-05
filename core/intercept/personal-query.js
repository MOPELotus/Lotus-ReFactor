import { ZZZ_COMMAND_PREFIX } from "./game-prefix.js"
import { PROFILE_ID_REQUIRED_SUFFIX_PATTERN } from "../config/profile.js"
import { WEB_COMMAND_EXCLUSION } from "./web-commands.js"

// 个人查询的无后缀形式也由 Lotus 接管，并与显式 profile 1 走同一条路径。
// 无后缀分支要求命令不以数字结尾，避免把游戏 UID 误判成 profile 指令。
const P = `(?:(?:${PROFILE_ID_REQUIRED_SUFFIX_PATTERN})|(?<!\\d))`
const Z = ZZZ_COMMAND_PREFIX
const SR_CHALLENGE_WORDS = "(?:深渊|忘却|忘却之庭|混沌|混沌回忆|虚构|虚构叙事|末日|末日幻影|异乡|异相|异向|仲裁|异相仲裁)"

// Explicit gacha statistics belong to the gacha bridge, not role proficiency.
const GACHA_STAT = `#(?:原神|星铁)?(?:喵喵)?(?:(?:全部)?(?:抽卡|抽奖|角色|武器|光锥|常驻|集录|up)池?(?:全部)?|全部)统计${P}$`

// Shared by personal-query dispatch and the achievement/atlas pass-through guards.
export const PERSONAL_QUERY_RULES = Object.freeze([
  { reg: `^#(?:星铁|原神)?(?:强制)?(?:刷新|更新)(?:所有|角色)*(?:天赋|技能|行迹)${P}$`, fnc: "miaoRefreshTalent" },
  { reg: `^#(?:星铁|原神)?(?:加载|重新加载|重载)面板${P}$`, fnc: "miaoReloadProfile" },
  { reg: `^#(?:星铁|原神)?(?:删除全部面板|删除面板|删除面板数据)${P}$`, fnc: "miaoDeleteProfile" },
  { reg: `^#星铁(?:我的)?(?:今日|今天|明日|明天|周[1-6一二三四五六])*(?:[五四54]星)?(?:技能|天赋|行迹)+(?:汇总|统计|列表)?${P}$`, fnc: "miaoTalentStat" },
  { reg: `^${Z}抽卡(?:分析|记录|统计)${P}$`, fnc: "zzzGachaView" },
  { reg: `^#(?:星铁|原神)?(?:圣遗物|遗器)列表${P}$`, fnc: "miaoArtisList" },
  { reg: `^#(?!(?:zzz|ZZZ|绝区零))(?:星铁|原神)?(?!(?:重置|重设|刷新|更新|重新加载|开启|打开|启用|关闭|禁用))(?:群|群内)?.+(?:排名|排行)(?:榜)?${P}$`, fnc: "miaoGroupRank" },
  { reg: `^#(?:星铁|原神)?(?:群|群内)?(?:排名|排行)?(?:最强|最高|最高分|最牛|第一|极限)+.+${P}$`, fnc: "miaoGroupRank" },
  { reg: `^#星铁(?:喵喵)?(?:角色|查询|查询角色|角色查询|人物)${P}$`, fnc: "miaoAvatarList" },
  { reg: `^#星铁(?:我的)?(?:物理|火|冰|雷|风|量子|虚数)*(?:角色|练度|五|四|5|4|星)+(?:汇总|统计|列表)(?:force|五|四|5|4|星)*${P}$`, fnc: "miaoProfileStat" },
  { reg: `^#(?:星铁|原神)?(?:面板角色|角色面板|面板)(?:列表)?\\s*${P}$`, fnc: "miaoProfileList" },
  { reg: `^\\*(?:面板角色|角色面板|面板)(?:列表)?\\s*${P}$`, fnc: "miaoProfileList" },
  { reg: `^#(?!(?:zzz|ZZZ|绝区零))(?!(?:原神|星铁)?(?:更新面板|面板更新|全部面板更新|更新全部面板))[\\s\\S]{1,}(?:详细|详情|面板|面版|圣遗物|遗器|武器|伤害)\\s*${P}$`, fnc: "miaoProfileDetail" },
  { reg: `^\\*(?!更新|面板更新|全部面板更新|更新全部面板)[\\s\\S]{1,}(?:详细|详情|面板|面版|遗器|武器|伤害)\\s*${P}$`, fnc: "miaoProfileDetail" },
  { reg: `^#(?:星铁|原神)?(?:面板|喵喵)?练度统计\\s*${P}$`, fnc: "miaoProfileStat" },
  { reg: `^\\*(?:面板|喵喵)?练度统计\\s*${P}$`, fnc: "miaoProfileStat" },
  { reg: `^#(?:我的)?(?:风|岩|雷|草|水|火|冰)*(?:武器|角色|练度|五|四|5|4|星)+(?:汇总|统计|列表)(?:force|五|四|5|4|星)*\\s*${P}$`, fnc: "miaoProfileStat" },
  { reg: `^#(?:喵喵)?(?:角色|查询|查询角色|角色查询|人物)\\s*${P}$`, fnc: "miaoAvatarList" },
  { reg: `^#(?!(?:今日|今天|明日|明天|周(?:[1-6]|一|二|三|四|五|六))(?:技能|天赋)$)(?:我的)?(?:今日|今天|明日|明天|周(?:[1-6]|一|二|三|四|五|六))*(?:[五四54]星)?(?:技能|天赋)+(?:汇总|统计|列表)?\\s*${P}$`, fnc: "miaoTalentStat" },
  { reg: `^#202\\d{3}(?:幻想|真境|剧诗|幻想真境剧诗)(?:角色|练度)?(?:汇总|统计|列表)?\\s*${P}$`, fnc: "miaoRoleCombatStat" },
  { reg: `^#(?![\\s\\S]*\\d{4,}\\s*$)(?:原神)?(?:喵喵|上传|本期|当期)*(?:深渊|深境|深境螺旋)[ |0-9]*(?:数据)?\\s*${P}$`, fnc: "miaoAbyssSummary" },
  { reg: `^#(?![\\s\\S]*\\d{4,}\\s*$)(?:原神)?(?:喵喵)*(?:本期|当期|上期)?(?:幻想|幻境|剧诗|幻想真境剧诗)[ |0-9]*(?:数据)?\\s*${P}$`, fnc: "miaoRoleCombatSummary" },
  { reg: `^#(?![\\s\\S]*\\d{4,}\\s*$)(?:原神)?(?:喵喵)*(?:本期|当期|上期)?(?:幽境|危战|幽境危战)(?:单人|单挑|组队|多人|合作|最佳)?[ |0-9]*(?:数据)?\\s*${P}$`, fnc: "miaoHardChallengeSummary" },
  { reg: `^\\*(?:往期|上期|本期|最新|当期)?(?:简易)?${SR_CHALLENGE_WORDS}\\s*${P}$`, fnc: "starRailChallenge" },
  { reg: `^#星铁(?:往期|上期|本期|最新|当期)?(?:简易)?${SR_CHALLENGE_WORDS}\\s*${P}$`, fnc: "starRailChallenge" },
  { reg: `^\\*(?:简易)?${SR_CHALLENGE_WORDS}\\s*$`, fnc: "starRailChallenge" },
  { reg: `^#星铁(?:简易)?${SR_CHALLENGE_WORDS}\\s*$`, fnc: "starRailChallenge" },
  { reg: `^${Z}(?![\\s\\S]*(?:更新|刷新))[\\s\\S]*(?:面板)(?:列表)?\\s*${P}$`, fnc: "zzzPanel" },
  { reg: `^(?![\\s\\S]*(?:更新|刷新))(?![^\\n]*\\d{4,}\\s*$)${Z}[^\\d]*(?:(?:排名|排行|综合榜)|(?:面板|圣遗物|驱动盘))\\s*${P}$`, fnc: "zzzRank" },
  { reg: `^${Z}[\\s\\S]+伤害\\s*${P}$`, fnc: "zzzDamage" },
  { reg: `^${Z}练度(?:统计)?\\s*${P}$`, fnc: "zzzProficiency" },
  { reg: `^${Z}(?:card|卡片|个人信息|角色)\\s*${P}$`, fnc: "zzzCard" },
  { reg: `^${Z}(?:本期|当期|上期|往期)?(?:式舆防卫战|式舆防卫|式舆|深渊|防卫战|防卫)\\s*${P}$`, fnc: "zzzAbyss" },
  { reg: `^${Z}(?:本期|当期|上期|往期)?(?:危局强袭战|危局|强袭|强袭战)\\s*${P}$`, fnc: "zzzDeadly" },
  { reg: `^${Z}(?:本期|当期|上期|往期)?(?:临界推演|临界|推演)\\s*${P}$`, fnc: "zzzVoidFrontBattle" },
  { reg: `^${Z}(?:拟真鏖战试炼|鏖战|爬塔)\\s*${P}$`, fnc: "zzzClimbingTower" },
  { reg: `^${Z}(?:monthly|菲林|邦布券|收入|月报)(?:(?:\\d{4})年)?(?:(?:\\d{1,2}|上)月)?\\s*${P}$`, fnc: "zzzMonthly" },
  { reg: `^${Z}(?:monthly|菲林|邦布券|收入|月报)统计\\s*${P}$`, fnc: "zzzMonthlyCollect" },
  { reg: `^${Z}(?:枯萎苗圃|枯萎|苗圃)\\s*${P}$`, fnc: "zzzHollowZero" },
  { reg: `^${Z}(?:迷失之地|迷失)\\s*${P}$`, fnc: "zzzHollowZeroS2" },
  { reg: `^${Z}(?:区域收集|收集|探索|探索度)\\s*${P}$`, fnc: "zzzExplorationDetail" },
].map(rule => ({ ...rule, reg: rule.reg.replace(/^\^/, `^${WEB_COMMAND_EXCLUSION}${rule.fnc === "miaoProfileStat" ? `(?!${GACHA_STAT})` : ""}`) })))

const compiled = PERSONAL_QUERY_RULES.map(rule => ({ ...rule, pattern: new RegExp(rule.reg) }))

export function matchPersonalQuery(message = "") {
  const text = String(message || "").trim().replace(/^＃/, "#")
  return compiled.find(rule => rule.pattern.test(text)) || null
}
