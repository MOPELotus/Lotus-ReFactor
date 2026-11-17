const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { replyForward, replyText } from "../core/transport/reply.js"
import { AUTO_REDEEM_GAMES, parseRedeemCommand } from "../services/redeemCodes/games.js"
import { RedeemCodeService, formatRedeemResult } from "../services/redeemCodes/service.js"
import { planetLaunchMessages } from "../services/redeemCodes/planetLaunch.js"
import { AutoPreviewRedeem } from "../services/redeemCodes/auto.js"
import { MiyousheManagement } from "../services/miyoushe/management.js"
import { parseProfileIdFromMessage, PROFILE_ID_SUFFIX_PATTERN } from "../core/config/profile.js"

const defaultService = new RedeemCodeService()
const autoRedeem = new AutoPreviewRedeem({ lookup: defaultService })

export class LotusRedeemCodes extends BasePlugin {
  constructor(options = {}) {
    super({
      name: "[Lotus-Plugin] Redeem Codes",
      dsc: "官方前瞻兑换码与自动兑换",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: "^#星布谷地公测兑换码$", fnc: "planetLaunchCodes" },
        { reg: `^#(?:注册|关闭)自动兑换前瞻(?:兑换码|码|（兑换码）|\\(兑换码\\))?${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "autoRedeemSetting" },
        { reg: "^[#*%％/]?.*(兑换码|[cC][oO][dD][eE])$", fnc: "redeemCodes" },
      ],
    })
    this.service = options.service || defaultService
    this.now = options.now || Date.now
    this.task = [{ name: "荷花插件前瞻码自动兑换", cron: "0 */5 * * * ? *", log: false, fnc: () => autoRedeem.run() }]
  }

  async autoRedeemSetting() {
    const enabled = this.e.msg.startsWith("#注册")
    const profileId = parseProfileIdFromMessage(this.e.msg)
    try {
      const settings = await new MiyousheManagement().settings(String(this.e.user_id), profileId, {
        autoRedeem: { enabled, ...(enabled ? { games: Object.keys(AUTO_REDEEM_GAMES) } : {}) },
      }, this.e)
      await replyText(this, settings.autoRedeem.enabled
        ? `Profile ${profileId} 已开启原神、星铁、绝区零国服前瞻码自动兑换。结果按签到通知渠道发送，可在米游社功能页调整游戏。`
        : `Profile ${profileId} 已关闭前瞻码自动兑换。`)
    } catch (error) {
      await replyText(this, `前瞻自动兑换设置未保存：${error.code === "ENOENT" ? "请先扫码登录对应 Profile" : error.status === 403 || error.message.includes("扫码登录") ? error.message : "请检查账号状态后重试"}。`)
    }
    return true
  }

  async planetLaunchCodes() {
    const { expired, messages } = planetLaunchMessages(this.now())
    if (expired) await replyText(this, messages.join("\n"))
    else await replyForward(this, messages, { title: "星布谷地公测兑换码" })
    return true
  }

  async redeemCodes() {
    const game = parseRedeemCommand(this.e.msg)
    if (!game) return false
    const result = await this.service.query(game.id)
    if (result.status === "available" && result.codes.length) {
      const [title, ...details] = formatRedeemResult({ ...result, codes: [] }).split("\n").filter(Boolean)
      const codes = result.codes.flatMap(item => item.reward ? [item.code, item.reward] : [item.code])
      await replyForward(this, [title, ...codes, ...details], {
        title: `${result.title || game.name}兑换码`,
      })
    } else {
      await replyText(this, formatRedeemResult(result))
    }
    return true
  }
}
