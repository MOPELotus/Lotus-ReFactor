const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  isMissingProfileError,
  loadProfile,
  normalizeProfileId,
  profileLoginRequiredMessage,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { getRoleUid, pickRole, splitProfileSuffix } from "../services/pluginBridge/common.js"
import {
  GenshinAchievementService,
  isAchievementDataMissing,
} from "../services/achievements/service.js"

const CATEGORY_RESERVED_TERMS = [
  "队伍伤害",
  "队伤",
  "体力",
  "树脂",
  "便笺",
  "便签",
  "面板",
  "更新",
  "抽卡",
  "签到",
  "登录",
  "图鉴",
  "帮助",
  "菜单",
  "远程",
  "上传",
  "下载",
  "B站",
  "BBDown",
  "深渊",
  "幻想",
  "幽境",
  "危战",
]

export class LotusAchievements extends BasePlugin {
  constructor(options = {}) {
    super({
      name: "[Lotus-Plugin] Achievements",
      dsc: "Genshin achievement atlas progress",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        {
          reg: `^#成就(?:目录|索引|列表|查漏)?${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "index",
        },
        {
          reg: "^#成就(?:导入|录入)(?:[1-9]\\d{0,2})?(?:[\\s\\S]*)$",
          fnc: "importJson",
        },
        {
          reg: "^#(?:成就)?[\\s\\S]{2,40}$",
          fnc: "category",
          log: false,
        },
      ],
    })
    this.service = options.service || new GenshinAchievementService(options)
  }

  async index() {
    const parsed = splitProfileSuffix(this.e.msg)
    const profileId = parsed.hasProfileSuffix ? parsed.profileId : 1
    try {
      const uid = await resolveGenshinUid(this.e, profileId)
      const result = await this.service.buildIndex({ uid })
      const image = await renderTemplate("achievement-index", result.renderData, {
        saveId: `lotus-achievement-index-${this.e.user_id}-${profileId}-${Date.now()}`,
      })
      await replyImage(this, image, "[荷花插件]成就目录生成完成。")
    } catch (error) {
      await this.replyAchievementError(error, "原神成就目录", profileId)
    }
    return true
  }

  async importJson() {
    const parsed = parseImportCommand(this.e.msg)
    const profileId = parsed.profileId
    let json
    try {
      json = await readCocogoatJsonFromEvent(this.e, parsed.body)
      const uid = await resolveGenshinUid(this.e, profileId, json)
      const imported = await this.service.importCocogoatJson({ uid, json })
      const index = await this.service.buildIndex({ uid })
      index.renderData.badge = `+${imported.added}`
      index.renderData.message = [
        `椰羊 JSON 扫描 ${imported.scanned} 条，完成项 ${imported.completedInput} 条；新增 ${imported.added} 条，重复 ${imported.duplicate} 条，未知 ${imported.unknown} 条，系列补全 ${imported.inferred} 条。`,
        imported.categoriesTouched.length ? `更新分类：${imported.categoriesTouched.slice(0, 8).join(" / ")}${imported.categoriesTouched.length > 8 ? " 等" : ""}` : "",
      ].filter(Boolean).join(" ")
      index.renderData.summary = [
        { label: "新增", value: String(imported.added) },
        { label: "重复", value: String(imported.duplicate) },
        { label: "未知", value: String(imported.unknown) },
        { label: "补全", value: String(imported.inferred) },
      ]
      const image = await renderTemplate("achievement-index", index.renderData, {
        saveId: `lotus-achievement-import-${this.e.user_id}-${profileId}-${Date.now()}`,
      })
      await replyImage(this, image, "[荷花插件]椰羊成就 JSON 导入完成。")
    } catch (error) {
      await this.replyAchievementError(error, "成就导入", profileId, [
        { label: "格式", value: "只支持椰羊导出的 JSON" },
        { label: "用法", value: "#成就导入 后发送 JSON 文件，或直接粘贴 JSON 内容" },
      ])
    }
    return true
  }

  async category() {
    const parsed = parseCategoryCommand(this.e.msg)
    if (!parsed.ok) return false
    if (!parsed.explicit && shouldPassThroughCategory(parsed.query)) return false

    try {
      const category = await this.service.resolveCategory(parsed.query)
      if (!category) {
        if (!parsed.explicit) return false
        await this.replyAchievementError(new Error(`没有找到成就分类：${parsed.query}`), "成就分类", parsed.profileId)
        return true
      }

      const uid = await resolveGenshinUid(this.e, parsed.profileId)
      const result = await this.service.buildCategory({
        uid,
        query: parsed.query,
      })
      const image = await renderTemplate("achievement-category", result.renderData, {
        saveId: `lotus-achievement-category-${this.e.user_id}-${parsed.profileId}-${Date.now()}`,
      })
      await replyImage(this, image, `[荷花插件]${category.name} 成就生成完成。`)
      return true
    } catch (error) {
      if (!parsed.explicit && isAchievementDataMissing(error)) return false
      await this.replyAchievementError(error, "成就分类", parsed.profileId)
      return true
    }
  }

  async replyAchievementError(error, title, profileId = 1, extraItems = []) {
    if (isMissingProfileError(error)) {
      await replyText(this, `[荷花插件]${profileLoginRequiredMessage(profileId)}`)
      return true
    }
    const userId = String(this.e?.user_id || "")
    logger?.warn?.(`[Lotus-Plugin] achievement failed: ${error.stack || error.message}`)
    const image = await renderStatusCard({
      title,
      subtitle: `QQ ${userId} · Profile ${profileId}`,
      badge: "失败",
      message: isAchievementDataMissing(error)
        ? "成就图鉴数据缺失，请先执行图鉴全量更新或检查 atlas.data_root。"
        : error.message,
      userId,
      items: [
        { label: "命令", value: String(this.e?.msg || "").slice(0, 80) },
        ...extraItems,
      ],
    }, {
      saveId: `lotus-achievement-error-${userId}-${profileId}-${Date.now()}`,
    })
    await replyImage(this, image, `[荷花插件]${title}失败：${error.message}`)
    return true
  }
}

function parseImportCommand(message = "") {
  const text = String(message || "").trim()
  const match = text.match(/^#成就(?:导入|录入)([1-9]\d{0,2})?/)
  let profileId = 1
  if (match?.[1]) profileId = normalizeProfileId(match[1])
  return {
    profileId,
    body: text.slice(match?.[0]?.length || 0).trim(),
  }
}

function parseCategoryCommand(message = "") {
  const suffix = splitProfileSuffix(message)
  const text = suffix.message.trim()
  if (!text.startsWith("#")) return { ok: false }
  const explicit = /^#成就/.test(text)
  let query = explicit ? text.replace(/^#成就/, "") : text.replace(/^#/, "")
  query = query.trim()
  if (!query || /^(?:目录|索引|列表|查漏|导入|录入)$/.test(query)) return { ok: false }
  return {
    ok: true,
    explicit,
    query,
    profileId: suffix.hasProfileSuffix ? suffix.profileId : 1,
  }
}

function shouldPassThroughCategory(query = "") {
  const text = String(query || "")
  if (CATEGORY_RESERVED_TERMS.some(term => text.includes(term))) return true
  if (/[?？!！]/.test(text)) return true
  return false
}

async function resolveGenshinUid(e, profileId = 1, json = null) {
  const explicit = String(e?.msg || "").match(/[1-9]\d{7,9}/)?.[0]
    || String(json?.uid || json?.value?.uid || json?.value?.account?.uid || "").match(/^[1-9]\d{7,9}$/)?.[0]
  if (explicit) return explicit

  const profile = await loadProfile(String(e.user_id), profileId)
  const uid = getRoleUid(pickRole(profile, "gs"))
  if (uid) return uid
  throw new Error(`profile ${profileId} 没有原神 UID，请先扫码登录或刷新账号角色。`)
}

async function readCocogoatJsonFromEvent(e, inlineText = "") {
  const inline = extractJsonCandidate(inlineText)
  if (inline) return JSON.parse(inline)

  const file = findJsonFile(e)
  if (!file) throw new Error("请发送椰羊导出的 JSON 文件，或在命令后粘贴 JSON 内容。")
  const url = await resolveFileUrl(e, file)
  if (!url) throw new Error("无法获取 JSON 文件地址。")
  const text = await readTextFromUrl(url)
  return JSON.parse(text)
}

function extractJsonCandidate(text = "") {
  const value = String(text || "").trim()
  if (!value) return ""
  const start = value.indexOf("{")
  const end = value.lastIndexOf("}")
  if (start < 0 || end <= start) return ""
  return value.slice(start, end + 1)
}

function findJsonFile(e) {
  const messages = [
    ...(Array.isArray(e?.message) ? e.message : []),
    e?.file ? { type: "file", ...e.file } : null,
  ].filter(Boolean)

  for (const message of messages) {
    const file = message.type === "application"
      ? { ...message, type: "file", name: message.filename, fid: message.id }
      : message
    const name = file.name || file.filename || file.file_name || file.url || ""
    if (file.type === "file" && /\.json(?:[?#].*)?$/i.test(String(name))) return file
  }
  return null
}

async function resolveFileUrl(e, file) {
  if (file.url) return file.url
  const fid = file.fid || file.file_id || file.id
  if (!fid) return ""
  if (e.isGroup) return e.group?.getFileUrl?.(fid)
  return e.friend?.getFileUrl?.(fid)
}

async function readTextFromUrl(url) {
  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`下载 JSON 失败：HTTP ${response.status}`)
    return response.text()
  }
  if (/^file:\/\//i.test(url)) {
    return fsReadUrl(url)
  }
  return fsReadUrl(url)
}

async function fsReadUrl(url) {
  const { fileURLToPath } = await import("node:url")
  const fs = await import("node:fs/promises")
  const file = /^file:\/\//i.test(url) ? fileURLToPath(url) : url
  return fs.readFile(file, "utf8")
}
