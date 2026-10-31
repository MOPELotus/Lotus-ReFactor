const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { replyForward, replyText } from "../core/transport/reply.js"
import { parseRedeemCommand } from "../services/redeemCodes/games.js"
import { RedeemCodeService, formatRedeemResult } from "../services/redeemCodes/service.js"

const defaultService = new RedeemCodeService()

export class LotusRedeemCodes extends BasePlugin {
  constructor(options = {}) {
    super({
      name: "[Lotus-Plugin] Redeem Codes",
      dsc: "官方前瞻兑换码与有效期",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [{ reg: "^[#*%％/]?.*(兑换码|[cC][oO][dD][eE])$", fnc: "redeemCodes" }],
    })
    this.service = options.service || defaultService
  }

  async redeemCodes() {
    const game = parseRedeemCommand(this.e.msg)
    if (!game) return false
    const result = await this.service.query(game.id)
    if (result.status === "available" && result.codes.length) {
      const rewards = result.codes.map((item, index) => item.reward ? `${index + 1}. ${item.reward}` : "").filter(Boolean)
      const summary = [formatRedeemResult({ ...result, codes: [] }), ...(rewards.length ? ["", "各条兑换码奖励：", ...rewards] : [])].join("\n")
      await replyForward(this, [summary, ...result.codes.map(item => item.code)], {
        title: `${result.title || game.name}兑换码`,
      })
    } else {
      await replyText(this, formatRedeemResult(result))
    }
    return true
  }
}
