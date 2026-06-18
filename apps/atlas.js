const BasePlugin = globalThis.plugin

import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import {
  buildAtlasRenderData,
  NanokaAtlasService,
  parseAtlasShortcutMessage,
  selectAtlasTemplate,
} from "../services/nanokaAtlas/service.js"
import { AtlasUpdateService } from "../services/nanokaAtlas/update.js"

export class LotusAtlas extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Atlas",
      dsc: "Lotus nanoka atlas query",
      event: "message",
      priority: 10,
      rule: [
        {
          reg: "^#?(Lotus|lotus|荷花)?图鉴状态$",
          fnc: "status",
        },
        {
          reg: "^#?(Lotus|lotus|荷花)?(更新图鉴|图鉴更新)$",
          fnc: "updateAtlas",
        },
        {
          reg: "^#?(Lotus|lotus|荷花)?(检查图鉴更新|图鉴检查更新)$",
          fnc: "checkAtlasUpdate",
        },
        {
          reg: "^#?(Lotus|lotus|荷花)?(全量更新图鉴|图鉴全量更新)$",
          fnc: "fullUpdateAtlas",
        },
        {
          reg: "^#?(Lotus|lotus|荷花)?图鉴帮助$",
          fnc: "help",
        },
        {
          reg: "^#?(Lotus|lotus|荷花)?图鉴\\s*[\\s\\S]+$",
          fnc: "query",
        },
        {
          reg: "^[#*%][\\s\\S]{1,}$",
          fnc: "shortcutQuery",
        },
      ],
    })
    this.task = [
      {
        name: "荷花插件图鉴版本检查",
        cron: "0 0 */6 * * ?",
        fnc: this.runAtlasAutoUpdate.bind(this),
        log: false,
      },
    ]
  }

  async init() {
    try {
      const globalConfig = await loadGlobalConfig()
      this.task = [
        {
          name: "荷花插件图鉴版本检查",
          cron: globalConfig.atlas?.auto_update?.check_cron || "0 0 */6 * * ?",
          fnc: this.runAtlasAutoUpdate.bind(this),
          log: false,
        },
      ]
    } catch (error) {
      logger?.warn?.(`[Lotus-Plugin] load atlas cron failed, fallback default: ${error.message}`)
    }
  }

  async status() {
    const status = await new NanokaAtlasService().status()
    const image = await renderStatusCard({
      title: "图鉴状态",
      subtitle: status.root,
      badge: status.itemsReady ? "READY" : "MISSING",
      message: status.itemsReady
        ? `已找到 ${status.locale} 图鉴条目。`
        : "图鉴数据未初始化，请准备 nanoka-atlas-backend 输出目录。",
      userId: this.e?.user_id || "user",
      items: [
        { label: "Items", value: status.itemsReady ? `${status.itemCount} 个 JSON` : "缺失" },
        { label: "Modules", value: status.itemsReady ? `${status.moduleCount} 个模块` : "缺失" },
        { label: "Gallery", value: status.galleryReady ? "已找到" : "缺失" },
        { label: "Locale", value: status.locale },
      ],
    }, {
      saveId: `lotus-atlas-status-${this.e.user_id || "user"}`,
    })
    await replyImage(this, image, "[荷花插件]图鉴状态生成完成。")
    return true
  }

  async updateAtlas() {
    const permission = await this.assertUpdatePermission("图鉴更新")
    if (!permission) return true

    await replyText(this, "[荷花插件]正在检查图鉴版本；首次缺数据会全量拉取，后续版本变化才增量更新。")
    const globalConfig = await loadGlobalConfig()
    const result = await new AtlasUpdateService().checkAndRun(globalConfig.atlas || {})
    const image = await renderAtlasUpdateResult(result, this.e.user_id)
    await replyImage(this, image, atlasUpdateMessage(result))
    return true
  }

  async checkAtlasUpdate() {
    const permission = await this.assertUpdatePermission("图鉴版本检查")
    if (!permission) return true

    await replyText(this, "[荷花插件]正在检查图鉴版本差异。")
    const globalConfig = await loadGlobalConfig()
    const result = await new AtlasUpdateService().checkAndRun(globalConfig.atlas || {})
    const image = await renderAtlasUpdateResult(result, this.e.user_id)
    await replyImage(this, image, atlasUpdateMessage(result))
    return true
  }

  async fullUpdateAtlas() {
    const permission = await this.assertUpdatePermission("图鉴全量更新")
    if (!permission) return true

    await replyText(this, "[荷花插件]正在启动 nanoka-atlas-backend 全量抓取，首次初始化会比较久。")
    const globalConfig = await loadGlobalConfig()
    const result = await new AtlasUpdateService().run(globalConfig.atlas || {}, { mode: "initial" })
    const image = await renderAtlasUpdateResult(result, this.e.user_id)
    await replyImage(this, image, result.ok ? "[荷花插件]图鉴全量更新完成。" : "[荷花插件]图鉴全量更新失败。")
    return true
  }

  async assertUpdatePermission(title) {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "atlas.update")
    if (!permission.ok) {
      const image = await renderStatusCard({
        title: "图鉴更新",
        subtitle: "Nanoka Atlas",
        badge: "拒绝",
        message: `只有 bot 主人可以触发${title}。`,
        userId: this.e.user_id,
        items: [
          { label: "原因", value: permission.reason },
        ],
      }, {
        saveId: `lotus-atlas-update-deny-${this.e.user_id || "user"}`,
      })
      await replyImage(this, image, "[荷花插件]没有图鉴更新权限。")
      return false
    }
    return true
  }

  async runAtlasAutoUpdate() {
    const globalConfig = await loadGlobalConfig()
    if (globalConfig.atlas?.auto_update?.enable === false) {
      return { ok: true, skipped: true, reason: "auto_update_disabled" }
    }
    const result = await new AtlasUpdateService().checkAndRun(globalConfig.atlas || {})
    if (result.ok && !result.skipped) {
      logger?.mark?.(`[Lotus-Plugin] atlas ${result.mode || "update"} completed`)
    } else if (!result.ok) {
      logger?.warn?.(`[Lotus-Plugin] atlas update failed: ${result.reason}`)
    }
    return result
  }

  async query() {
    const query = String(this.e.msg || "").replace(/^#?(Lotus|lotus|荷花)?图鉴/i, "").trim()
    if (!query) {
      await replyText(this, "[荷花插件]请在图鉴后面输入要查询的名称。")
      return true
    }

    const result = await new NanokaAtlasService().search(query)
    const image = await renderAtlasSearchResult(result, this.e.user_id)
    await replyImage(this, image, result.ok ? "[荷花插件]图鉴查询完成。" : "[荷花插件]没有找到图鉴结果。")
    return true
  }

  async shortcutQuery() {
    const parsed = parseAtlasShortcutMessage(this.e.msg)
    if (!parsed.ok) return false

    const result = await new NanokaAtlasService().search(parsed.query, {
      challenge: parsed.challenge,
      game: parsed.game,
    })
    if (!result.ok) return false

    const image = await renderAtlasSearchResult(result, this.e.user_id)
    await replyImage(this, image, "[荷花插件]图鉴查询完成。")
    return true
  }

  async help() {
    const image = await renderStatusCard({
      title: "图鉴帮助",
      subtitle: "Nanoka Atlas",
      badge: "HELP",
      message: "图鉴数据由本地 nanoka-atlas-backend 输出目录提供，荷花插件只负责更新、索引、查询和图片渲染；挑战个人数据指令不会被图鉴直查抢占。",
      userId: this.e?.user_id || "user",
      items: [
        { label: "直查", value: "#星见雅 / #雾切之回光 / #雾切 / #冰封迷途的勇士" },
        { label: "显式", value: "#图鉴 神里绫华 / #荷花图鉴 星见雅" },
        { label: "挑战图鉴", value: "#本期幻想 / *上期末日 / %下期防卫战 / #2026-06-16本期深渊" },
        { label: "不抢占", value: "#深渊 / #幻想 / *混沌 / *末日 / %防卫战 仍交给挑战数据插件" },
        { label: "状态", value: "#图鉴状态" },
        { label: "更新", value: "#更新图鉴" },
        { label: "全量", value: "#全量更新图鉴" },
        { label: "数据目录", value: "global.yaml: atlas.data_root" },
        { label: "后端目录", value: "global.yaml: atlas.backend_root" },
      ],
    }, {
      saveId: `lotus-atlas-help-${this.e.user_id || "user"}`,
    })
    await replyImage(this, image, "[荷花插件]图鉴帮助生成完成。")
    return true
  }
}

async function renderAtlasSearchResult(result, userId) {
  const renderData = buildAtlasRenderData(result)
  return renderTemplate(selectAtlasTemplate(renderData), renderData, {
    saveId: `lotus-atlas-${userId || "user"}`,
  })
}

async function renderAtlasUpdateResult(result, userId) {
  const changed = result.check?.diff?.changes || result.diff?.changes || []
  return renderStatusCard({
    title: "图鉴更新",
    subtitle: result.root || "Nanoka Atlas",
    badge: result.skipped ? "跳过" : result.ok ? "完成" : "失败",
    message: atlasUpdateSummary(result),
    userId,
    items: [
      { label: "模式", value: result.skipped ? "skip" : result.mode || "-" },
      { label: "命令", value: `${result.command || "-"} ${(result.args || []).join(" ")}`.trim() },
      { label: "退出码", value: result.code ?? "-" },
      { label: "版本差异", value: changed.length ? changed.map(item => `${item.game}:${item.local?.latest || "-"} -> ${item.remote?.latest || "-"}`).join(" / ") : "无" },
      { label: "同步", value: result.sync?.ok ? `${result.sync.copied.join(" / ")} -> ${result.sync.targetRoot}` : "未执行" },
      { label: "输出", value: (result.stdout || result.stderr || "").slice(0, 100) || "无" },
    ],
  }, {
    saveId: `lotus-atlas-update-${userId || "system"}`,
  })
}

function atlasUpdateSummary(result) {
  if (!result.ok) return `更新失败：${result.reason || "unknown"}`
  if (result.skipped) {
    if (result.reason === "versions_unchanged") return "远端版本号未变化，已跳过增量抓取。"
    if (result.reason === "local_data_missing") return "本地图鉴数据缺失，但配置关闭了缺失时全量拉取。"
    return `已跳过：${result.reason || "skip"}`
  }
  if (result.mode === "initial") return "本地图鉴缺失或手动要求全量，已执行 nanoka-atlas-backend 全量抓取。"
  return "远端版本号变化，已执行 nanoka-atlas-backend 增量抓取。"
}

function atlasUpdateMessage(result) {
  if (!result.ok) return "[荷花插件]图鉴更新失败。"
  if (result.skipped) return "[荷花插件]图鉴版本未变化，已跳过更新。"
  if (result.mode === "initial") return "[荷花插件]图鉴全量更新完成。"
  return "[荷花插件]图鉴增量更新完成。"
}
