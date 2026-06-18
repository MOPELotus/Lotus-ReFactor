const BasePlugin = globalThis.plugin

import { replyText } from "../core/transport/reply.js"

export class LotusHelp extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Help",
      dsc: "Lotus documentation help",
      event: "message",
      priority: 20,
      rule: [
        {
          reg: "^#?(Lotus|lotus|荷花)(帮助|help)$",
          fnc: "help",
        },
        {
          reg: "^#自动签到帮助$",
          fnc: "help",
        },
      ],
    })
  }

  async help() {
    await replyText(this, "[荷花插件]完整文档请查看 README.md 和 docs/README.md，里面按部署、初始化、登录、签到、图鉴、体力、B站、远程 spawn 等模块拆开说明。")
    return true
  }
}
