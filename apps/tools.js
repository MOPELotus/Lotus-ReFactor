const BasePlugin = globalThis.plugin

import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { initializeEnvironment } from "../services/tools/environment.js"
import { startTuneWeaveLifecycle } from "../services/tuneweave/runtime.js"

export class LotusTools extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Tools",
      dsc: "Lotus runtime tool installer",
      event: "message",
      priority: 10,
      rule: [
        {
          reg: "^#初始化(?:签到|工具)?环境$",
          fnc: "initEnv",
        },
      ],
    })
  }

  async init() {
    let lifecycle = await startTuneWeaveLifecycle()
    this.addCleanup?.(() => lifecycle.dispose(), async () => { lifecycle = await startTuneWeaveLifecycle() })
  }

  async initEnv() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "tools.install")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以初始化插件环境。")
      return true
    }

    await replyText(this, "[荷花插件]正在检查本地验证码模型、TuneWeave 和 FFmpeg，按配置补齐缺失项目。")
    const progress = async message => {
      logger?.mark?.(`[Lotus-Plugin] init tools: ${message}`)
      await replyText(this, `[荷花插件]${message}`)
    }
    const result = await initializeEnvironment(globalConfig, { onProgress: progress })
    const image = await renderToolsResult(result, this.e.user_id)
    await replyImage(this, image, result.ok ? "[荷花插件]插件环境初始化完成。" : "[荷花插件]插件环境有项目初始化失败。")
    return true
  }
}

export async function renderToolsResult(result, userId) {
  return renderStatusCard({
    title: "插件环境",
    subtitle: "验证码 · 音乐 · 视频",
    badge: result.ok ? "完成" : "失败",
    message: result.skipped
      ? "自动安装已关闭。"
      : "本地验证码、音乐视频和合伙人共用初始化；验证码默认按本地、外部、人工顺序回退。",
    userId,
    items: (result.items || []).map(item => ({
      label: item.name,
      value: item.ok
        ? `${item.status || item.reason || "ok"} ${item.path || ""}`.trim()
        : `失败：${item.reason || "unknown"}`,
    })),
  }, {
    saveId: `lotus-tools-${userId || "system"}`,
  })
}
