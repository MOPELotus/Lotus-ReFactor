const BasePlugin = globalThis.plugin

import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { ToolInstallerService } from "../services/tools/installer.js"

export class LotusTools extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Tools",
      dsc: "Lotus runtime tool installer",
      event: "message",
      priority: 10,
      rule: [
        {
          reg: "^#初始化工具环境$",
          fnc: "initTools",
        },
      ],
    })
  }

  async initTools() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "tools.install")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以初始化工具环境。")
      return true
    }

    await replyText(this, "[荷花插件]正在检查 BBDown、ffmpeg、aria2，缺失时会从 GitHub Release 自动下载。")
    const progress = async message => {
      logger?.mark?.(`[Lotus-Plugin] init tools: ${message}`)
      await replyText(this, `[荷花插件]${message}`)
    }
    const result = await new ToolInstallerService({
      config: globalConfig.tools,
      onProgress: progress,
    }).ensureAll()
    const image = await renderToolsResult(result, this.e.user_id)
    await replyImage(this, image, result.ok ? "[荷花插件]工具环境初始化完成。" : "[荷花插件]工具环境有项目初始化失败。")
    return true
  }
}

export async function renderToolsResult(result, userId) {
  return renderStatusCard({
    title: "工具环境",
    subtitle: result.binDir || "data/tools/bin",
    badge: result.ok ? "完成" : "失败",
    message: result.skipped
      ? "自动安装已关闭。"
      : "BBDown 是 B 站下载唯一下载器；ffmpeg 和 aria2 会一并准备供工具链使用。",
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
