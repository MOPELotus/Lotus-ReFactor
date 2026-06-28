const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  isMissingProfileError,
  loadProfile,
  normalizeProfileId,
  profileLoginRequiredMessage,
} from "../core/config/profile.js"
import { AccountService } from "../core/login/account.js"
import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { splitProfileSuffix } from "../services/pluginBridge/common.js"
import { StarRailTeamDamageService } from "../services/starRailTeamDamage/service.js"

export class LotusStarRailTeamDamage extends BasePlugin {
  constructor(options = {}) {
    super({
      name: "[Lotus-Plugin] StarRail Team Damage",
      dsc: "Profile aware StarRail team damage calculator",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: "^\\*(?:队伍伤害|队伤|伤害)(?:详情|过程|全图)?[\\s\\S]*$", fnc: "teamDamage" },
        { reg: "^#星铁(?:队伍伤害|队伤|伤害)(?:详情|过程|全图)?[\\s\\S]*$", fnc: "teamDamage" },
      ],
    })
    this.service = options.service || new StarRailTeamDamageService(options)
  }

  async teamDamage() {
    const parsed = splitStarRailTeamDamageProfile(this.e.msg)
    const profileId = parsed.hasProfileSuffix ? parsed.profileId : 1
    const command = parsed.message
    const userId = String(this.e.user_id)
    try {
      const loadedProfile = await loadProfile(userId, profileId)
      const profile = await refreshProfileBeforeQuery(userId, profileId, loadedProfile)
      const result = await this.service.queryProfile({
        profile,
        profileId,
        command,
      })
      const image = await renderTemplate("starrail-team-damage", result.renderData, {
        saveId: `lotus-sr-team-damage-${userId}-${profileId}-${Date.now()}`,
      })
      await replyImage(this, image, "[荷花插件]星铁队伍伤害查询完成。")
    } catch (error) {
      if (isMissingProfileError(error)) {
        await replyText(this, `[荷花插件]${profileLoginRequiredMessage(profileId)}`)
        return true
      }
      logger?.error?.(`[Lotus-Plugin] starrail team damage failed: ${error.stack || error.message}`)
      const image = await renderStatusCard({
        title: "星铁队伍伤害",
        subtitle: `QQ ${userId} · Profile ${profileId}`,
        badge: "失败",
        message: error.message,
        userId,
        items: [
          { label: "命令", value: command },
          { label: "提示", value: "请先执行 *更新面板；无面板时会尝试默认模板。" },
        ],
      }, {
        saveId: `lotus-sr-team-damage-error-${userId}-${profileId}`,
      })
      await replyImage(this, image, `[荷花插件]星铁队伍伤害查询失败：${error.message}`)
    }
    return true
  }
}

export function splitStarRailTeamDamageProfile(message = "") {
  const suffix = splitProfileSuffix(message)
  if (suffix.hasProfileSuffix) return suffix

  const text = String(message || "").trim()
  const match = text.match(/^((?:\*|#星铁)(?:队伍伤害|队伤|伤害)(?:详情|过程|全图)?)([1-9]\d{0,2})(?=\D)([\s\S]*)$/)
  if (!match) return suffix
  try {
    const profileId = normalizeProfileId(match[2])
    return {
      hasProfileSuffix: true,
      profileId,
      message: `${match[1]}${match[3]}`.trim(),
    }
  } catch {
    return suffix
  }
}

async function refreshProfileBeforeQuery(userId, profileId, profile) {
  if (!profile?.account?.stoken) return profile
  try {
    return await new AccountService().refresh(userId, profileId)
  } catch (error) {
    logger?.debug?.(`[Lotus-Plugin] starrail team damage pre-refresh skipped: ${error.message}`)
    return profile
  }
}
