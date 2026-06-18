const BasePlugin = globalThis.plugin

import { renderStatusCard } from "../core/render/service.js"
import { replyImage } from "../core/transport/reply.js"

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
    const image = await renderStatusCard({
      title: "支持荷花插件",
      subtitle: "lotusshared.cn",
      badge: "DONATE",
      message: "感谢对荷花插件和机器人运营的支持。链接已放在卡片里，敏感信息不会写入仓库。",
      userId: this.e?.user_id || "user",
      items: [
        { label: "捐赠链接", value: "https://lotusshared.cn/2025/12/21/donate/" },
      ],
    }, {
      saveId: `lotus-donate-${this.e?.user_id || "user"}`,
    })
    await replyImage(this, image, "[荷花插件]捐赠卡片生成完成。")
    return true
  }
}
