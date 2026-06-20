const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  isMissingProfileError,
  loadProfile,
  parseProfileIdFromMessage,
  profileLoginRequiredMessage,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { renderStatusCard } from "../core/render/service.js"
import { AccountService } from "../core/login/account.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { MiaoPanelBridge } from "../services/pluginBridge/miaoPanel.js"
import { ZzzPanelBridge } from "../services/pluginBridge/zzzPanel.js"

export class LotusPanelUpdate extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Panel Update",
      dsc: "Lotus profile aware miao panel update",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        {
          reg: `^#(原神)?(更新面板|面板更新|全部面板更新|更新全部面板)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "genshinPanel",
        },
        {
          reg: `^#星铁(更新面板|面板更新|全部面板更新|更新全部面板)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "starRailPanel",
        },
        {
          reg: `^\\*(更新面板|面板更新|全部面板更新|更新全部面板)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "starRailPanel",
        },
        {
          reg: `^#绝区零(更新面板|面板更新|全部面板更新|更新全部面板)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "zzzPanel",
        },
        {
          reg: `^[%％](更新面板|面板更新|全部面板更新|更新全部面板)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "zzzPanel",
        },
      ],
    })
  }

  async genshinPanel() {
    return this.updatePanel("gs")
  }

  async starRailPanel() {
    return this.updatePanel("sr")
  }

  async zzzPanel() {
    return this.updatePanel("zzz")
  }

  async updatePanel(game) {
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)
    try {
      const loadedProfile = await loadProfile(userId, profileId)
      const profile = await refreshProfileBeforePanel(userId, profileId, loadedProfile)
      const result = await panelBridgeForGame(game).updatePanel({
        e: this.e,
        profile,
        profileId,
        game,
        forwardReplies: true,
      })

      if (!result.forwarded.length) {
        const message = pickMessage(result.messages) || "面板更新已执行，但外部插件没有返回图片。"
        await replyText(this, `[荷花插件]${message}`)
      }
    } catch (error) {
      if (isMissingProfileError(error)) {
        await replyText(this, `[荷花插件]${profileLoginRequiredMessage(profileId)}`)
        return true
      }

      logger?.error?.(`[Lotus-Plugin] panel update failed: ${error.stack || error.message}`)
      const image = await renderStatusCard({
        title: "面板更新",
        subtitle: `QQ ${userId} · Profile ${profileId}`,
        badge: "失败",
        message: error.message,
        userId,
        items: [
          { label: "游戏", value: gameLabel(game) },
          { label: "建议", value: `检查 profile 登录态、UID 与 ${game === "zzz" ? "ZZZ-Plugin" : "miao-plugin"} 是否可加载。` },
        ],
      }, {
        saveId: `lotus-panel-error-${userId}-${profileId}-${game}`,
      })
      await replyImage(this, image, `[荷花插件]面板更新失败：${error.message}`)
    }

    return true
  }
}

async function refreshProfileBeforePanel(userId, profileId, profile) {
  if (!profile?.account?.stoken) return profile
  try {
    return await new AccountService().refresh(userId, profileId)
  } catch (error) {
    logger?.debug?.(`[Lotus-Plugin] panel pre-refresh skipped: ${error.message}`)
    return profile
  }
}

function panelBridgeForGame(game) {
  if (game === "zzz") return new ZzzPanelBridge()
  return new MiaoPanelBridge()
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
