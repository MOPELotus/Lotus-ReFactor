const BasePlugin = globalThis.plugin

import { PERSONAL_QUERY_RULES } from "../core/intercept/personal-query.js"
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  isMissingProfileError,
  loadProfile,
  profileLoginRequiredMessage,
} from "../core/config/profile.js"
import { AccountService } from "../core/login/account.js"
import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { splitProfileSuffix } from "../services/pluginBridge/common.js"
import { MiaoProfileQueryBridge } from "../services/pluginBridge/miaoProfileQuery.js"
import { ZzzProfileQueryBridge } from "../services/pluginBridge/zzzPanel.js"
import { StarRailChallengeService } from "../services/starRailChallenge/service.js"

export class LotusProfileQuery extends BasePlugin {
  constructor(options = {}) {
    super({
      name: "[Lotus-Plugin] Profile Query",
      dsc: "Lotus profile aware personal UID queries",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: PERSONAL_QUERY_RULES.map(rule => ({ ...rule })),
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
  async zzzRank() {
    const parsed = splitProfileSuffix(this.e.msg)
    const text = parsed.message.replace(/^(?:[%％](?:zzz|绝区零)?|[#/](?:zzz|绝区零)|(?:zzz|绝区零))/i, "").trim()
    // 默认“排名”是纯面板分；明确写“综合榜”才使用加权分。
    // 兼容“面板/圣遗物/驱动盘”别名，并从角色名中剥离关键词。
    const character = text
      .replace(/(?:面板|圣遗物|驱动盘|综合)?(?:排名|排行|榜).*$/, "")
      .replace(/(?:面板|圣遗物|驱动盘|综合)$/, "")
      .trim()
    const mode = /综合/.test(text) ? "weighted" : "panel"
    return this.runProfileQuery({
      userId: String(this.e.user_id), profileId: parsed.profileId, game: "zzz", command: parsed.message,
      runner: profile => this.zzz.groupRank({ e: this.e, profile, profileId: parsed.profileId, command: parsed.message, character, mode, forwardReplies: true }),
      title: `${character || "绝区零"}排名`,
    })
  }

  async runMiao(method, fixedGame = "") {
    const parsed = splitProfileSuffix(this.e.msg)
    const userId = String(this.e.user_id)
    const game = fixedGame || miaoGameFromMessage(parsed.message)
    return this.runProfileQuery({
      userId,
      profileId: parsed.profileId,
      game,
      command: normalizeMiaoCommand(parsed.message, game, method),
      runner: profile => this.miao[method]({
        e: this.e,
        profile,
        profileId: parsed.profileId,
        game,
        command: normalizeMiaoCommand(parsed.message, game, method),
        forwardReplies: true,
      }),
      title: "个人查询",
    })
  }

  async runZzz(method) {
    const parsed = splitProfileSuffix(this.e.msg)
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
    const profileId = parsed.hasProfileSuffix ? parsed.profileId : 1
    const userId = String(this.e.user_id)
    const command = normalizeStarRailCommand(parsed.message)
    return this.runProfileQuery({
      userId,
      profileId,
      game: "sr",
      command,
      runner: async profile => {
        const result = await this.starRail.queryProfile({
          profile,
          profileId,
          command,
        })
        const image = await renderTemplate("starrail-challenge", result.renderData, {
          saveId: `lotus-sr-challenge-${userId}-${profileId}-${Date.now()}`,
        })
        await replyImage(this, image, `[荷花插件]${result.renderData.title}查询完成。`)
        return {
          ok: true,
          game: "sr",
          uid: result.uid,
          profileId,
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

function normalizeMiaoCommand(message = "", game = "gs", method = "") {
  const text = String(message || "").trim()
  if (text.startsWith("*")) return `#星铁${text.replace(/^\*+/, "")}`
  if (game === "sr" && text.startsWith("#") && !/^#星铁/.test(text)) return text.replace(/^#/, "#星铁")
  const command = text.replace(/^#原神/, "#").replace(/^#(喵喵)?当期/, "#$1本期")
  // These upstream switches disable automatic handling of plain commands.
  // Explicit #喵喵 requests remain supported even when the switches are off.
  if (method === "abyssSummary") return command.replace(/^#(?:喵喵|上传|本期)*/, "#喵喵")
  if (["roleCombatSummary", "hardChallengeSummary"].includes(method)) {
    return command.replace(/^#(?:喵喵)*/, "#喵喵")
  }
  return command
}

function normalizeZzzCommand(message = "") {
  const text = String(message || "").trim()
    .replace(/^％/, "%")
    .replace(/^(?:[#/](?:zzz|绝区零)|(?:zzz|绝区零))/i, "%")
    .replace(/^%(?:zzz|绝区零)/i, "%")
    .replace(/^%(?:本期|当期)/, "%")
    .replace(/式舆防卫(?!(?:战))/, "式舆防卫战")
  // ZZZ-Plugin 的 rulePrefix 要求命令带 zzz/绝区零 标识；Lotus 对外
  // 兼容简写 `%蕾米面板`，这里补成上游实际能匹配的 `%zzz蕾米面板`。
  if (/^%(?:zzz|绝区零)/i.test(text)) return text
  return text.startsWith("%") ? `%zzz${text.slice(1)}` : text
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
