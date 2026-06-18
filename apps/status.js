const BasePlugin = globalThis.plugin
import { renderStatusCard } from "../core/render/service.js"
import { replyImage } from "../core/transport/reply.js"

export class LotusStatus extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Status",
      dsc: "Lotus refactor smoke status",
      event: "message",
      priority: 1,
      rule: [
        {
          reg: "^#?(Lotus|lotus|荷花)(状态|status|测试)$",
          fnc: "status",
        },
      ],
    })
  }

  async status() {
    const image = await renderStatusCard({
      title: "荷花插件",
      subtitle: "Refactor smoke hook",
      badge: "LOADED",
      message: "当前重构版已经被 Yunzai/TRSS 测试环境加载，图片渲染链路可用。",
      userId: this.e?.user_id || "stdin",
      items: [
        {
          label: "插件入口",
          value: "apps/status.js",
        },
        {
          label: "输出模式",
          value: "Skia Canvas -> Image",
        },
      ],
    })
    await replyImage(this, image, "荷花插件重构版已加载。")
    return true
  }
}
