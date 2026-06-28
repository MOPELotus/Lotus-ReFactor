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

const IMPORT_WAIT_MS = 5 * 60 * 1000
const pendingAchievementImports = new Map()

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
          reg: "^[\\s\\S]*$",
          fnc: "importPendingJson",
          log: false,
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
    const inline = extractJsonCandidate(parsed.body)
    const file = findJsonFile(this.e)

    if (!inline && !file) {
      setPendingAchievementImport(this.e, {
        profileId: parsed.profileId,
        uidHint: parsed.uidHint,
      })
      await replyText(
        this,
        `[荷花插件]请在 5 分钟内发送椰羊导出的 JSON 文件（Profile ${parsed.profileId}）。`,
      )
      return true
    }

    try {
      const json = await readCocogoatJsonFromEvent(this.e, parsed.body)
      await this.finishImport({
        profileId: parsed.profileId,
        uidHint: parsed.uidHint,
        json,
      })
    } catch (error) {
      await this.replyAchievementError(error, "成就导入", parsed.profileId, [
        { label: "格式", value: "只支持椰羊导出的 JSON" },
        { label: "用法", value: "#成就导入 后发送 JSON 文件，或直接粘贴 JSON 内容" },
      ])
    }
    return true
  }

  async importPendingJson() {
    const pending = getPendingAchievementImport(this.e)
    if (!pending) return false

    const file = findJsonFile(this.e)
    if (!file) return false

    try {
      const json = await readCocogoatJsonFromEvent(this.e)
      await this.finishImport({
        profileId: pending.profileId,
        uidHint: pending.uidHint,
        json,
      })
      clearPendingAchievementImport(this.e)
    } catch (error) {
      await this.replyAchievementError(error, "成就导入", pending.profileId, [
        { label: "格式", value: "只支持椰羊导出的 JSON" },
        { label: "重试", value: "待导入状态会保留至超时，可重新发送 JSON 文件" },
      ])
    }
    return true
  }

  async finishImport({ profileId = 1, uidHint = "", json } = {}) {
    const uid = await resolveGenshinUid(this.e, profileId, json, uidHint)
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
  const body = text.slice(match?.[0]?.length || 0).trim()
  return {
    profileId,
    body,
    uidHint: extractUid(body),
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

async function resolveGenshinUid(e, profileId = 1, json = null, uidHint = "") {
  const explicit = extractUid(uidHint)
    || extractUid(e?.msg)
    || extractUid(json?.uid)
    || extractUid(json?.value?.uid)
    || extractUid(json?.value?.account?.uid)
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
  const source = await resolveFileSource(e, file)
  if (!source) throw new Error("无法获取 JSON 文件地址。")
  const text = await readTextFromFileSource(source)
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

function extractUid(value = "") {
  return String(value || "").match(/[1-9]\d{7,9}/)?.[0] || ""
}

function findJsonFile(e) {
  const rawTexts = [
    e?.msg,
    e?.raw_message,
    e?.rawMessage,
    e?.message?.raw_message,
    e?.message?.rawMessage,
  ].filter(value => typeof value === "string")

  const messages = [
    ...(Array.isArray(e?.message) ? e.message : []),
    e?.message && typeof e.message === "object" && !Array.isArray(e.message) ? e.message : null,
    typeof e?.message === "string" ? e.message : null,
    e?.file ? { type: "file", ...(typeof e.file === "object" ? e.file : { file: e.file }) } : null,
    ...rawTexts.flatMap(parseCqFileSegments),
  ].filter(Boolean)

  for (const message of messages) {
    const file = normalizeFileSegment(message)
    if (!file) continue
    const name = file.name || file.filename || file.file_name || file.file || file.url || ""
    if (isJsonFile(name)) return file
  }
  return null
}

function normalizeFileSegment(message) {
  if (!message) return null
  if (typeof message === "string") return parseCqFileSegments(message)[0] || null

  const data = message.data && typeof message.data === "object" ? message.data : {}
  const type = String(message.type || data.type || "").toLowerCase()
  if (type && type !== "file" && type !== "application") return null

  const file = {
    ...data,
    ...message,
    type: type || "file",
  }
  const name = file.name || file.filename || file.file_name || file.file || file.url || ""
  return isJsonFile(name) ? file : null
}

function parseCqFileSegments(text = "") {
  const result = []
  for (const match of String(text || "").matchAll(/\[CQ:file,([^\]]*)\]/g)) {
    const params = {}
    for (const item of match[1].split(",")) {
      const index = item.indexOf("=")
      if (index < 1) continue
      const key = item.slice(0, index).trim()
      const value = decodeCqValue(item.slice(index + 1))
      params[key] = value
    }
    result.push({
      type: "file",
      ...params,
      name: params.name || params.filename || params.file_name || params.file || "",
    })
  }
  return result
}

function decodeCqValue(value = "") {
  return String(value)
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&")
}

function isJsonFile(name = "") {
  return /\.json(?:[?#].*)?$/i.test(String(name || ""))
}

async function resolveFileSource(e, file) {
  const direct = unwrapFileSource(file?.url || file?.file_url || file?.path || file?.file_path)
  if (direct) return direct

  const fid = String(file?.fid || file?.file_id || file?.id || "")
  if (!fid) return null

  const groupId = getEventGroupId(e)
  const userId = String(e?.user_id || e?.sender?.user_id || "")
  const resolvers = [
    () => isGroupEvent(e) ? e.group?.getFileUrl?.(fid) : null,
    () => isGroupEvent(e) && groupId ? e.bot?.getGroupFileUrl?.(groupId, fid) : null,
    () => e?.friend?.getFileUrl?.(fid),
    () => e?.bot?.getFriendFileUrl?.(userId, fid),
    () => e?.bot?.getPrivateFileUrl?.(userId, fid),
    () => e?.bot?.getFileUrl?.(fid),
  ]

  for (const resolve of resolvers) {
    try {
      const source = unwrapFileSource(await resolve())
      if (source) return source
    } catch {}
  }

  // NapCat 的 CQ file_id 不是普通下载链接；需要经 OneBot get_file 取回本地路径或 URL。
  return requestOneBotFile(e, fid)
}

async function requestOneBotFile(e, fileId) {
  const params = { file_id: String(fileId) }
  const targets = collectOneBotApiTargets(e)
  const calls = [
    ["getFile", [[params], [String(fileId)]]],
    ["get_file", [[params], [String(fileId)]]],
    ["sendApi", [["get_file", params], [{ action: "get_file", params }]]],
    ["callApi", [["get_file", params], [{ action: "get_file", params }]]],
    ["call_api", [["get_file", params], [{ action: "get_file", params }]]],
    ["requestApi", [["get_file", params], [{ action: "get_file", params }]]],
    ["request", [["get_file", params], [{ action: "get_file", params }]]],
  ]

  for (const target of targets) {
    for (const [method, variants] of calls) {
      const fn = target?.[method]
      if (typeof fn !== "function") continue
      for (const args of variants) {
        try {
          const source = unwrapFileSource(await fn.apply(target, args))
          if (source) return source
        } catch {}
      }
    }
  }
  return null
}

function collectOneBotApiTargets(e) {
  const bot = e?.bot || globalThis.Bot?.[e?.self_id] || null
  const candidates = [
    bot,
    bot?.adapter,
    bot?.client,
    bot?.onebot,
    bot?.api,
    bot?.adapter?.client,
    bot?.adapter?.onebot,
    bot?.adapter?.api,
    bot?.client?.api,
    bot?.onebot?.api,
  ]
  return [...new Set(candidates.filter(item => item && typeof item === "object"))]
}

function unwrapFileSource(value) {
  if (typeof value === "string") return value ? { url: value } : null
  if (!value || typeof value !== "object") return null

  const nested = unwrapFileSource(value.data)
  if (nested) return nested

  const base64 = String(value.base64 || value.base64_data || "")
  if (base64) return { base64 }

  const url = value.url || value.file_url || value.download_url || value.path || value.file_path || value.file || ""
  return url ? { url: String(url) } : null
}

async function readTextFromFileSource(source) {
  if (source?.base64) return Buffer.from(source.base64, "base64").toString("utf8")
  const url = String(source?.url || "")
  if (!url) throw new Error("JSON 文件内容为空。")
  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`下载 JSON 失败：HTTP ${response.status}`)
    return response.text()
  }
  return fsReadUrl(url)
}

async function fsReadUrl(url) {
  const { fileURLToPath } = await import("node:url")
  const fs = await import("node:fs/promises")
  const file = /^file:\/\//i.test(url) ? fileURLToPath(url) : url
  return fs.readFile(file, "utf8")
}

function getEventGroupId(e) {
  return String(e?.group_id || e?.group?.group_id || e?.group?.id || "")
}

function isGroupEvent(e) {
  return Boolean(getEventGroupId(e) || e?.isGroup || e?.message_type === "group")
}

function getAchievementImportKey(e) {
  const userId = String(e?.user_id || "")
  if (!userId) return ""
  const groupId = getEventGroupId(e)
  if (isGroupEvent(e) && groupId) return `group:${groupId}:${userId}`
  return `private:${userId}`
}

function setPendingAchievementImport(e, { profileId = 1, uidHint = "" } = {}) {
  const key = getAchievementImportKey(e)
  if (!key) return
  pendingAchievementImports.set(key, {
    profileId: normalizeProfileId(profileId),
    uidHint: extractUid(uidHint),
    expiresAt: Date.now() + IMPORT_WAIT_MS,
  })
}

function getPendingAchievementImport(e) {
  const key = getAchievementImportKey(e)
  if (!key) return null
  const pending = pendingAchievementImports.get(key)
  if (!pending) return null
  if (pending.expiresAt <= Date.now()) {
    pendingAchievementImports.delete(key)
    return null
  }
  return pending
}

function clearPendingAchievementImport(e) {
  const key = getAchievementImportKey(e)
  if (key) pendingAchievementImports.delete(key)
}
