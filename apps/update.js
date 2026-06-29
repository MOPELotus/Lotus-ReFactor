const BasePlugin = globalThis.plugin

import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { checkPluginUpdate } from "../services/pluginUpdate/service.js"

export class LotusUpdate extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Update",
      dsc: "Lotus safe git updater",
      event: "message",
      priority: 20,
      rule: [
        {
          reg: "^#荷花插件更新$",
          fnc: "updatePlugin",
        },
        {
          reg: "^#荷花插件检查更新$",
          fnc: "checkOnly",
        },
      ],
    })
  }

  async updatePlugin() {
    return this.runUpdate({ pull: true })
  }

  async checkOnly() {
    return this.runUpdate({ pull: false })
  }

  async runUpdate(options = {}) {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "plugin.update")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以更新插件。")
      return true
    }

    await replyText(this, options.pull
      ? "[荷花插件]正在检查插件更新，若工作区干净会自动 fast-forward。"
      : "[荷花插件]正在检查插件更新。")

    let result
    try {
      result = await checkPluginUpdate({
        pull: options.pull,
      })
    } catch (error) {
      result = {
        ok: false,
        action: "error",
        message: error.message,
      }
      logger?.error?.(`[Lotus-Plugin] update failed: ${error.stack || error.message}`)
    }

    const image = await renderStatusCard({
      title: "插件更新",
      subtitle: "荷花插件安全更新",
      badge: result.ok ? "OK" : "STOP",
      message: result.message,
      userId: this.e.user_id,
      items: updateItems(result),
    }, {
      saveId: `lotus-update-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, "[荷花插件]插件更新检查完成。")
    return true
  }
}

function updateItems(result) {
  const items = [
    { label: "状态", value: result.action || "unknown" },
  ]
  if (result.branch) items.push({ label: "分支", value: result.branch })
  if (result.upstream) items.push({ label: "上游", value: result.upstream })
  if (Number.isInteger(result.ahead) || Number.isInteger(result.behind)) {
    items.push({ label: "ahead/behind", value: `${result.ahead || 0}/${result.behind || 0}` })
  }
  if (result.previousCommit) items.push({ label: "更新前", value: result.previousCommit })
  if (result.commit) items.push({ label: "当前提交", value: result.commit })
  for (const line of result.dirty || []) {
    items.push({ label: "未提交", value: line.slice(0, 80) })
  }
  for (const line of result.ignoredDirty || []) {
    items.push({ label: "已忽略", value: line.slice(0, 80) })
  }
  if (result.detail) items.push({ label: "详情", value: String(result.detail).slice(0, 80) })
  return items.slice(0, 14)
}
