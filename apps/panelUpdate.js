const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  loadProfile,
  parseProfileIdFromMessage,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { MiaoPanelBridge } from "../services/pluginBridge/miaoPanel.js"

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
      ],
    })
  }

  async genshinPanel() {
    return this.updatePanel("gs")
  }

  async starRailPanel() {
    return this.updatePanel("sr")
  }

  async updatePanel(game) {
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)
    try {
      const profile = await loadProfile(userId, profileId)
      await replyText(this, `[荷花插件]正在为 profile ${profileId} 更新${game === "sr" ? "星铁" : "原神"}面板。`)
      const result = await new MiaoPanelBridge().updatePanel({
        e: this.e,
        profile,
        profileId,
        game,
        forwardReplies: true,
      })

      const image = await renderStatusCard({
        title: "面板更新",
        subtitle: `QQ ${userId} · Profile ${profileId} · UID ${result.uid}`,
        badge: "完成",
        message: pickMessage(result.messages) || "miao 面板更新流程已结束。",
        userId,
        items: [
          { label: "游戏", value: game === "sr" ? "星铁" : "原神" },
          { label: "Profile", value: String(profileId) },
          { label: "UID", value: result.uid },
          { label: "外部图片", value: result.forwarded.length ? "已转发" : "无" },
        ],
      }, {
        saveId: `lotus-panel-${userId}-${profileId}-${game}`,
      })
      await replyImage(this, image, "[荷花插件]面板更新完成。")
    } catch (error) {
      logger?.error?.(`[Lotus-Plugin] panel update failed: ${error.stack || error.message}`)
      const image = await renderStatusCard({
        title: "面板更新",
        subtitle: `QQ ${userId} · Profile ${profileId}`,
        badge: "失败",
        message: error.message,
        userId,
        items: [
          { label: "游戏", value: game === "sr" ? "星铁" : "原神" },
          { label: "建议", value: "检查 profile 登录态、UID 与 miao-plugin 是否可加载。" },
        ],
      }, {
        saveId: `lotus-panel-error-${userId}-${profileId}-${game}`,
      })
      await replyImage(this, image, `[荷花插件]面板更新失败：${error.message}`)
    }

    return true
  }
}

function pickMessage(messages = []) {
  return messages
    .filter(message => message && message !== "[图片]" && message !== "[按钮]")
    .join("\n")
    .slice(0, 180)
}
