const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { replyText } from "../core/transport/reply.js"
import { MiaoWikiBridge } from "../services/pluginBridge/miaoWiki.js"

export class LotusMiaoCalendar extends BasePlugin {
  constructor(options = {}) {
    super({
      name: "[Lotus-Plugin] Miao Calendar",
      dsc: "Lotus bridge for miao calendar and material commands",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        {
          reg: "^(#|喵喵)(日历|日历列表)$",
          fnc: "genshinCalendar",
        },
        {
          reg: "^(\\*|#星铁|#星穹铁道|#崩坏星穹铁道|#崩铁)(日历|日历列表)$",
          fnc: "starRailCalendar",
        },
        {
          reg: "^([%％]|#绝区零|#绝区)(日历|日历列表)$",
          fnc: "zzzCalendar",
        },
        {
          reg: "^#(今日|今天|每日|我的|明天|明日|周([1-7]|一|二|三|四|五|六|日))*(素材|材料|天赋)[ |0-9]*$",
          fnc: "todayMaterial",
        },
      ],
    })
    this.bridge = options.bridge || new MiaoWikiBridge()
  }

  async genshinCalendar() {
    return this.renderCalendar("gs")
  }

  async starRailCalendar() {
    return this.renderCalendar("sr")
  }

  async zzzCalendar() {
    return this.renderCalendar("zzz")
  }

  async todayMaterial() {
    try {
      await this.bridge.renderTodayMaterial({ e: this.e })
    } catch (error) {
      await this.replyBridgeError("今日素材", error)
    }
    return true
  }

  async renderCalendar(game) {
    try {
      await this.bridge.renderCalendar({ e: this.e, game })
    } catch (error) {
      await this.replyBridgeError(calendarTitle(game), error)
    }
    return true
  }

  async replyBridgeError(title, error) {
    logger?.warn?.(`[Lotus-Plugin] miao calendar bridge failed: ${error.stack || error.message}`)
    await replyText(this, `[荷花插件]${title}需要 miao-plugin 可加载：${error.message}`)
  }
}

function calendarTitle(game) {
  if (game === "sr") return "星铁日历"
  if (game === "zzz") return "绝区零日历"
  return "日历"
}
