const BasePlugin = globalThis.plugin

import { setTimeout as delay } from "node:timers/promises"
import { renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { loadDonateContent, DONATE_URL } from "../services/donate/service.js"

export class LotusDonate extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Donate",
      dsc: "Lotus donate card",
      event: "message",
      priority: 200,
      rule: [
        {
          reg: "^(#)?(荷花)?(捐赠|donate|Donate)$",
          fnc: "donate",
        },
      ],
    })
  }

  async donate() {
    try {
      const image = await renderTemplate("donate", await loadDonateContent(), {
        saveId: `lotus-donate-${this.e?.user_id || "user"}`,
      })
      await replyImage(this, image, "[荷花插件]捐赠图片发送失败，请通过稍后发送的链接查看。")
    } catch (error) {
      globalThis.logger?.warn?.(`[Lotus-Plugin] donate render failed: ${error.message}`)
      await replyText(this, "[荷花插件]捐赠图片生成失败，请通过稍后发送的链接查看。")
    }
    await delay(2000)
    await replyText(this, DONATE_URL)
    return true
  }
}
