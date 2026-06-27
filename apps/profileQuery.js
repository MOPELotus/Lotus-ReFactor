const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  isMissingProfileError,
  loadProfile,
  profileLoginRequiredMessage,
  PROFILE_ID_REQUIRED_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { AccountService } from "../core/login/account.js"
import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { splitProfileSuffix } from "../services/pluginBridge/common.js"
import { MiaoProfileQueryBridge } from "../services/pluginBridge/miaoProfileQuery.js"
import { ZzzProfileQueryBridge } from "../services/pluginBridge/zzzPanel.js"
import { StarRailChallengeService } from "../services/starRailChallenge/service.js"

const P = PROFILE_ID_REQUIRED_SUFFIX_PATTERN
const Z = "(?:[%％]|#绝区零)"

export class LotusProfileQuery extends BasePlugin {
  constructor(options = {}) {
    super({
      name: "[Lotus-Plugin] Profile Query",
      dsc: "Lotus profile aware personal UID queries",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: `^#(?:星铁|原神)?(?:面板角色|角色面板|面板)(?:列表)?\\s*${P}$`, fnc: "miaoProfileList" },
        { reg: `^\\*(?:面板角色|角色面板|面板)(?:列表)?\\s*${P}$`, fnc: "miaoProfileList" },
        { reg: `^#(?!绝区零)(?!(?:原神|星铁)?(?:更新面板|面板更新|全部面板更新|更新全部面板))[\\s\\S]{1,}(?:详细|详情|面板|面版|圣遗物|遗器|武器|伤害)\\s*${P}$`, fnc: "miaoProfileDetail" },
        { reg: `^\\*(?!更新|面板更新|全部面板更新|更新全部面板)[\\s\\S]{1,}(?:详细|详情|面板|面版|遗器|武器|伤害)\\s*${P}$`, fnc: "miaoProfileDetail" },
        { reg: `^#(?:星铁|原神)?(?:面板|喵喵)?练度统计\\s*${P}$`, fnc: "miaoProfileStat" },
        { reg: `^\\*(?:面板|喵喵)?练度统计\\s*${P}$`, fnc: "miaoProfileStat" },
        { reg: `^#(?:我的)?(?:风|岩|雷|草|水|火|冰)*(?:武器|角色|练度|五|四|5|4|星)+(?:汇总|统计|列表)(?:force|五|四|5|4|星)*\\s*${P}$`, fnc: "miaoProfileStat" },
        { reg: `^#(?:喵喵)?(?:角色|查询|查询角色|角色查询|人物)\\s*${P}$`, fnc: "miaoAvatarList" },
        { reg: `^#(?:我的)?(?:今日|今天|明日|明天|周(?:[1-6]|一|二|三|四|五|六))*(?:[五四54]星)?(?:技能|天赋)+(?:汇总|统计|列表)?\\s*${P}$`, fnc: "miaoTalentStat" },
        { reg: `^#202\\d{3}(?:幻想|真境|剧诗|幻想真境剧诗)(?:角色|练度)?(?:汇总|统计|列表)?\\s*${P}$`, fnc: "miaoRoleCombatStat" },
        { reg: `^#(?:喵喵|上传|本期)*(?:深渊|深境|深境螺旋)[ |0-9]*(?:数据)?\\s*${P}$`, fnc: "miaoAbyssSummary" },
        { reg: `^#(?:喵喵)*(?:本期|上期)?(?:幻想|幻境|剧诗|幻想真境剧诗)[ |0-9]*(?:数据)?\\s*${P}$`, fnc: "miaoRoleCombatSummary" },
        { reg: `^#(?:喵喵)*(?:本期|上期)?(?:幽境|危战|幽境危战)(?:单人|单挑|组队|多人|合作|最佳)?[ |0-9]*(?:数据)?\\s*${P}$`, fnc: "miaoHardChallengeSummary" },
        { reg: `^\\*(?:往期|上期|本期|最新|当期)?(?:简易)?(?:深渊|忘却|忘却之庭|混沌|混沌回忆|虚构|虚构叙事|末日|末日幻影|异乡|异相|异向|仲裁|异相仲裁)\\s*${P}$`, fnc: "starRailChallenge" },
        { reg: `^#星铁(?:往期|上期|本期|最新|当期)?(?:简易)?(?:深渊|忘却|忘却之庭|混沌|混沌回忆|虚构|虚构叙事|末日|末日幻影|异乡|异相|异向|仲裁|异相仲裁)\\s*${P}$`, fnc: "starRailChallenge" },
        { reg: `^${Z}(?![\\s\\S]*(?:更新|刷新))[\\s\\S]*(?:面板)(?:列表)?\\s*${P}$`, fnc: "zzzPanel" },
        { reg: `^${Z}[\\s\\S]+伤害\\s*${P}$`, fnc: "zzzDamage" },
        { reg: `^${Z}练度(?:统计)?\\s*${P}$`, fnc: "zzzProficiency" },
        { reg: `^${Z}(?:card|卡片|个人信息|角色)\\s*${P}$`, fnc: "zzzCard" },
        { reg: `^${Z}(?:上期|往期)?(?:式舆防卫战|式舆|深渊|防卫战|防卫)\\s*${P}$`, fnc: "zzzAbyss" },
        { reg: `^${Z}(?:上期|往期)?(?:危局强袭战|危局|强袭|强袭战)\\s*${P}$`, fnc: "zzzDeadly" },
        { reg: `^${Z}(?:上期|往期)?(?:临界推演|临界|推演)\\s*${P}$`, fnc: "zzzVoidFrontBattle" },
        { reg: `^${Z}(?:拟真鏖战试炼|鏖战|爬塔)\\s*${P}$`, fnc: "zzzClimbingTower" },
        { reg: `^${Z}(?:monthly|菲林|邦布券|收入|月报)(?:(?:\\d{4})年)?(?:(?:\\d{1,2}|上)月)?\\s*${P}$`, fnc: "zzzMonthly" },
        { reg: `^${Z}(?:monthly|菲林|邦布券|收入|月报)统计\\s*${P}$`, fnc: "zzzMonthlyCollect" },
        { reg: `^${Z}(?:枯萎苗圃|枯萎|苗圃)\\s*${P}$`, fnc: "zzzHollowZero" },
        { reg: `^${Z}(?:迷失之地|迷失)\\s*${P}$`, fnc: "zzzHollowZeroS2" },
        { reg: `^${Z}(?:区域收集|收集|探索|探索度)\\s*${P}$`, fnc: "zzzExplorationDetail" },
      ],
    })
    this.miao = options.miao || new MiaoProfileQueryBridge(options)
    this.zzz = options.zzz || new ZzzProfileQueryBridge(options)
    this.starRail = options.starRail || new StarRailChallengeService(options)
  }

  async miaoProfileList() { return this.runMiao("profileList") }
  async miaoProfileDetail() { return this.runMiao("profileDetail") }
  async miaoProfileStat() { return this.runMiao("profileStat") }
  async miaoAvatarList() { return this.runMiao("avatarList") }
  async miaoTalentStat() { return this.runMiao("talentStat") }
  async miaoRoleCombatStat() { return this.runMiao("roleCombatStat", "gs") }
  async miaoAbyssSummary() { return this.runMiao("abyssSummary", "gs") }
  async miaoRoleCombatSummary() { return this.runMiao("roleCombatSummary", "gs") }
  async miaoHardChallengeSummary() { return this.runMiao("hardChallengeSummary", "gs") }
  async starRailChallenge() { return this.runStarRailChallenge() }

  async zzzPanel() { return this.runZzz("panel") }
  async zzzDamage() { return this.runZzz("damage") }
  async zzzProficiency() { return this.runZzz("proficiency") }
  async zzzCard() { return this.runZzz("card") }
  async zzzAbyss() { return this.runZzz("abyss") }
  async zzzDeadly() { return this.runZzz("deadly") }
  async zzzVoidFrontBattle() { return this.runZzz("voidFrontBattle") }
  async zzzClimbingTower() { return this.runZzz("climbingTower") }
  async zzzMonthly() { return this.runZzz("monthly") }
  async zzzMonthlyCollect() { return this.runZzz("monthlyCollect") }
  async zzzHollowZero() { return this.runZzz("hollowZero") }
  async zzzHollowZeroS2() { return this.runZzz("hollowZeroS2") }
  async zzzExplorationDetail() { return this.runZzz("explorationDetail") }

  async runMiao(method, fixedGame = "") {
    const parsed = splitProfileSuffix(this.e.msg)
    if (!parsed.hasProfileSuffix) return false
    const userId = String(this.e.user_id)
    const game = fixedGame || miaoGameFromMessage(parsed.message)
    return this.runProfileQuery({
      userId,
      profileId: parsed.profileId,
      game,
      command: normalizeMiaoCommand(parsed.message, game),
      runner: profile => this.miao[method]({
        e: this.e,
        profile,
        profileId: parsed.profileId,
        game,
        command: normalizeMiaoCommand(parsed.message, game),
        forwardReplies: true,
      }),
      title: "个人查询",
    })
  }

  async runZzz(method) {
    const parsed = splitProfileSuffix(this.e.msg)
    if (!parsed.hasProfileSuffix) return false
    const userId = String(this.e.user_id)
    const command = normalizeZzzCommand(parsed.message)
    return this.runProfileQuery({
      userId,
      profileId: parsed.profileId,
      game: "zzz",
      command,
      runner: profile => this.zzz[method]({
        e: this.e,
        profile,
        profileId: parsed.profileId,
        command,
        forwardReplies: true,
      }),
      title: "绝区零个人查询",
    })
  }

  async runStarRailChallenge() {
    const parsed = splitProfileSuffix(this.e.msg)
    if (!parsed.hasProfileSuffix) return false
    const userId = String(this.e.user_id)
    const command = normalizeStarRailCommand(parsed.message)
    return this.runProfileQuery({
      userId,
      profileId: parsed.profileId,
      game: "sr",
      command,
      runner: async profile => {
        const result = await this.starRail.queryProfile({
          profile,
          profileId: parsed.profileId,
          command,
        })
        const image = await renderTemplate("starrail-challenge", result.renderData, {
          saveId: `lotus-sr-challenge-${userId}-${parsed.profileId}-${Date.now()}`,
        })
        await replyImage(this, image, `[荷花插件]${result.renderData.title}查询完成。`)
        return {
          ok: true,
          game: "sr",
          uid: result.uid,
          profileId: parsed.profileId,
          messages: [],
          forwarded: ["[图片]"],
        }
      },
      title: "星铁挑战",
    })
  }

  async runProfileQuery({ userId, profileId, game, command, runner, title }) {
    try {
      const loadedProfile = await loadProfile(userId, profileId)
      const profile = await refreshProfileBeforeQuery(userId, profileId, loadedProfile)
      const result = await runner(profile)
      if (!result.forwarded?.length) {
        const message = pickMessage(result.messages) || `${command} 已执行，但外部插件没有返回图片。`
        await replyText(this, `[荷花插件]${message}`)
      }
    } catch (error) {
      if (isMissingProfileError(error)) {
        await replyText(this, `[荷花插件]${profileLoginRequiredMessage(profileId)}`)
        return true
      }
      logger?.error?.(`[Lotus-Plugin] profile query failed: ${error.stack || error.message}`)
      const image = await renderStatusCard({
        title,
        subtitle: `QQ ${userId} · Profile ${profileId}`,
        badge: "失败",
        message: error.message,
        userId,
        items: [
          { label: "游戏", value: gameLabel(game) },
          { label: "命令", value: command },
        ],
      }, {
        saveId: `lotus-profile-query-error-${userId}-${profileId}-${game}`,
      })
      await replyImage(this, image, `[荷花插件]个人查询失败：${error.message}`)
    }
    return true
  }
}

async function refreshProfileBeforeQuery(userId, profileId, profile) {
  if (!profile?.account?.stoken) return profile
  try {
    return await new AccountService().refresh(userId, profileId)
  } catch (error) {
    logger?.debug?.(`[Lotus-Plugin] profile query pre-refresh skipped: ${error.message}`)
    return profile
  }
}

function miaoGameFromMessage(message = "") {
  const text = String(message || "")
  return text.startsWith("*") || /^#星铁/.test(text) ? "sr" : "gs"
}

function normalizeMiaoCommand(message = "", game = "gs") {
  const text = String(message || "").trim()
  if (text.startsWith("*")) return `#星铁${text.replace(/^\*+/, "")}`
  if (game === "sr" && text.startsWith("#") && !/^#星铁/.test(text)) return text.replace(/^#/, "#星铁")
  return text
}

function normalizeZzzCommand(message = "") {
  return String(message || "").trim()
    .replace(/^％/, "%")
    .replace(/^#绝区零/, "%")
}

function normalizeStarRailCommand(message = "") {
  return String(message || "").trim()
    .replace(/^#星铁/, "*")
}

function gameLabel(game) {
  if (game === "sr") return "星铁"
  if (game === "zzz") return "绝区零"
  return "原神"
}

function pickMessage(messages = []) {
  return messages
    .filter(message => message && message !== "[图片]" && message !== "[按钮]")
    .join("\n")
    .slice(0, 180)
}
