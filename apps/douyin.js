const BasePlugin = globalThis.plugin

import { randomUUID } from "node:crypto"
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderTemplate, renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { DouyinService, normalizeDouyinDownloadConfig } from "../services/douyin/service.js"
import { sendMediaFile, mediaFailureMessage } from "../services/media/files.js"
import { buildMediaMessageText, articlePages } from "../services/media/message.js"

export class LotusDouyin extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Douyin", dsc: "Lotus Douyin parser", event: "message", priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: "^#抖音(?:下载|下视频)\\s+[\\s\\S]+$", fnc: "downloadWork" },
        { reg: "https?://(?:[a-zA-Z0-9-]+\\.)?(?:douyin|iesdouyin)\\.com/", fnc: "parse" },
      ],
    })
  }

  async init() {
    await new DouyinService().recoverTasks().catch(error => globalThis.logger?.warn?.(`[Lotus-Plugin] Douyin task recovery: ${error.message}`))
  }

  async parse() {
    const config = await loadGlobalConfig()
    if (!config.douyin.enable) return false
    const service = new DouyinService({ timeoutMs: config.douyin.request_timeout_ms })
    const target = service.extractTarget(buildMediaMessageText(this.e))
    if (!target) return false
    return this.handleWork(service, target, config, true)
  }

  async downloadWork() {
    const config = await loadGlobalConfig()
    if (!config.douyin.enable) { await replyText(this, "[荷花插件]抖音解析已关闭。"); return true }
    const target = String(this.e.msg || "").replace(/^#抖音(?:下载|下视频)\s*/, "").trim()
    return this.handleWork(new DouyinService({ timeoutMs: config.douyin.request_timeout_ms }), target, config, false)
  }

  async handleWork(service, target, config, showInfo) {
    let result
    const saveId = `lotus-douyin-${randomUUID()}`
    try {
      const info = await service.getInfo(target)
      if (showInfo) {
        try {
          await replyImage(this, await renderTemplate("douyin-info", { ...info, userId: this.e.user_id }, { saveId }), `[荷花插件]${info.title}\n作者：${info.owner || "未知"}\n${info.url}`)
          for (const [index, page] of articlePages(info.article).entries()) {
            await replyImage(this, await renderTemplate("douyin-article", { title: info.title, owner: info.owner, page: index + 1, blocks: page, userId: this.e.user_id }, { saveId: `${saveId}-article-${index}` }), page.map(block => block.text || block.urls?.[0] || "").join("\n"))
          }
        } catch (error) {
          await replyText(this, `[荷花插件]${info.title}\n作者：${info.owner || "未知"}\n${info.url}\n信息卡生成失败：${error.message}`)
        }
      }
      const permission = new PermissionService({ permissions: config.permissions }).explain(this.e, "douyin.download")
      if (!permission.ok) { await replyText(this, "[荷花插件]你没有使用抖音下载的权限。"); return true }
      const download = normalizeDouyinDownloadConfig(config.douyin)
      if (!download.enable) {
        if (!showInfo) await replyText(this, "[荷花插件]抖音下载未启用。")
        return true
      }
      result = await service.download(info, download, { onEvent: event => globalThis.logger?.debug?.(`[Lotus-Plugin] Douyin: ${event.message}`) })
      if (!result.ok) throw new Error(mediaFailureMessage(result))
      if (result.warnings.length) await replyText(this, `[荷花插件]${[...new Set(result.warnings)].join("；")}`)
      for (const file of result.files) await sendMediaFile(this.e, file, download)
    } catch (error) {
      globalThis.logger?.warn?.(`[Lotus-Plugin] Douyin ${error.code || "error"}: ${error.message}`)
      try {
        await replyImage(this, await renderStatusCard({ title: "抖音解析", subtitle: "荷花插件 Douyin", badge: "失败", message: error.message, userId: this.e.user_id }, { saveId: `${saveId}-error` }), `[荷花插件]${error.message}`)
      } catch { await replyText(this, `[荷花插件]${error.message}`) }
    } finally {
      if (result?.taskDir) await service.releaseTask(result).catch(error => globalThis.logger?.warn?.(`[Lotus-Plugin] Douyin task cleanup failed: ${error.message}`))
    }
    return true
  }
}
