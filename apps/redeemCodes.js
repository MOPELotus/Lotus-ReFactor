const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { replyForward, replyText } from "../core/transport/reply.js"
import { parseRedeemCommand } from "../services/redeemCodes/games.js"
import { RedeemCodeService, formatRedeemResult } from "../services/redeemCodes/service.js"
import { planetLaunchMessages } from "../services/redeemCodes/planetLaunch.js"

const defaultService = new RedeemCodeService()

export class LotusRedeemCodes extends BasePlugin {
  constructor(options = {}) {
    super({
      name: "[Lotus-Plugin] Redeem Codes",
      dsc: "官方前瞻兑换码与有效期",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: "^#星布谷地公测兑换码$", fnc: "planetLaunchCodes" },
        { reg: "^[#*%％/]?.*(兑换码|[cC][oO][dD][eE])$", fnc: "redeemCodes" },
      ],
    })
    this.service = options.service || defaultService
    this.now = options.now || Date.now
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
