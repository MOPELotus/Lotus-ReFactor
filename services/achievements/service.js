import fs from "node:fs/promises"
import path from "node:path"
import { loadGlobalConfig } from "../../core/config/global.js"
import { resolveData } from "../../core/path.js"
import { resolveAtlasDataRoot } from "../nanokaAtlas/update.js"

const ACHIEVEMENT_DATA_MISSING = "achievement_data_missing"
const COCOGOAT_SOURCE = "椰羊成就"
const DEFAULT_LOCALE = "简体中文"
const DEFAULT_CATEGORY_LIMIT = 120
const CHINESE_NUMBERS = [
  "零",
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
  "十",
  "十一",
  "十二",
  "十三",
  "十四",
  "十五",
  "十六",
  "十七",
  "十八",
  "十九",
  "二十",
]

export class GenshinAchievementService {
  constructor(options = {}) {
    this.dataRoot = options.dataRoot || ""
    this.locale = options.locale || ""
    this.progressDir = options.progressDir || resolveData("achievements")
    this.fs = options.fs || fs
    this.catalogPromise = null
  }

  async buildIndex({ uid } = {}) {
    const catalog = await this.loadCatalog()
    const progress = await this.loadProgress(uid)
    const categories = catalog.categories.map(category => buildCategorySummary(category, progress.done))
    const total = sumCategoryStats(categories)
    return {
      ok: true,
      uid: String(uid || ""),
      renderData: {
        title: "原神成就目录",
        subtitle: uid ? `UID ${uid}` : "未绑定 UID",
        badge: `${total.completed}/${total.total}`,
        message: `已完成 ${total.completed}/${total.total} 个成就，原石 ${total.pointsDone}/${total.pointsTotal}。目录状态来自椰羊 JSON 导入进度与本地 Nanoka 图鉴。`,
        summary: [
          { label: "成就", value: `${total.completed}/${total.total}` },
          { label: "原石", value: `${total.pointsDone}/${total.pointsTotal}` },
          { label: "完成率", value: `${total.percent}%` },
          { label: "分类", value: `${categories.filter(item => item.completed === item.total).length}/${categories.length}` },
        ],
        categories,
        atlasRoot: catalog.dataRoot,
        source: "Nanoka Atlas / 椰羊成就 JSON",
      },
    }
  }

  async buildCategory({ uid, query, limit = DEFAULT_CATEGORY_LIMIT } = {}) {
    const catalog = await this.loadCatalog()
    const category = this.resolveCategoryFromCatalog(catalog, query)
    if (!category) {
      return {
        ok: false,
        reason: "category_not_found",
        query,
      }
    }

    const progress = await this.loadProgress(uid)
    const summary = buildCategorySummary(category, progress.done)
    const groups = buildDisplayGroups(category, progress.done)
    const visibleGroups = groups.slice(0, limit)
    const hiddenCount = Math.max(0, groups.length - visibleGroups.length)

    return {
      ok: true,
      uid: String(uid || ""),
      category,
      renderData: {
        title: category.name,
        subtitle: uid ? `UID ${uid}` : "未绑定 UID",
        badge: `${summary.completed}/${summary.total}`,
        message: `未完成条目优先显示；同名多阶段成就会作为一个条目一起排序。原石 ${summary.pointsDone}/${summary.pointsTotal}。`,
        icon: category.icon,
        summary: [
          { label: "成就", value: `${summary.completed}/${summary.total}` },
          { label: "原石", value: `${summary.pointsDone}/${summary.pointsTotal}` },
          { label: "完成率", value: `${summary.percent}%` },
          { label: "分组", value: hiddenCount ? `${visibleGroups.length}/${groups.length}` : String(groups.length) },
        ],
        groups: visibleGroups,
        hiddenCount,
        totalGroups: groups.length,
        atlasRoot: catalog.dataRoot,
        source: "Nanoka Atlas / 椰羊成就 JSON",
      },
    }
  }

  async importCocogoatJson({ uid, json } = {}) {
    if (!uid) throw new Error("缺少原神 UID，无法保存成就进度。")
    if (!json || typeof json !== "object") throw new Error("发送的 JSON 内容为空或格式不正确。")
    if (json.source !== COCOGOAT_SOURCE) throw new Error("只支持椰羊导出的 JSON。")

    const catalog = await this.loadCatalog()
    const list = Array.isArray(json.value?.achievements) ? json.value.achievements : []
    const progress = await this.loadProgress(uid)
    const touched = new Map()
    let added = 0
    let duplicate = 0
    let unknown = 0
    let completedInput = 0
    let inferred = 0

    for (const item of list) {
      const id = normalizeAchievementId(item?.id)
      if (!id || !item?.status) continue
      completedInput += 1
      const achievement = catalog.achievementsById.get(id)
      if (!achievement) {
        unknown += 1
        continue
      }

      const result = addDoneRecord(progress.done, id, item, "cocogoat")
      if (result.added) added += 1
      else duplicate += 1
      touched.set(achievement.categoryId, true)

      for (const priorId of catalog.predecessorsById.get(id) || []) {
        if (!progress.done[priorId]) {
          const prior = catalog.achievementsById.get(priorId)
          addDoneRecord(progress.done, priorId, item, "series-inferred")
          if (prior) touched.set(prior.categoryId, true)
          inferred += 1
        }
      }
    }

    progress.uid = String(uid)
    progress.updatedAt = new Date().toISOString()
    await this.saveProgress(uid, progress)

    const categoriesTouched = [...touched.keys()]
      .map(id => catalog.categoriesById.get(id)?.name)
      .filter(Boolean)

    return {
      ok: true,
      uid: String(uid),
      scanned: list.length,
      completedInput,
      added,
      duplicate,
      unknown,
      inferred,
      categoriesTouched,
    }
  }

  async resolveCategory(query) {
    const catalog = await this.loadCatalog()
    return this.resolveCategoryFromCatalog(catalog, query)
  }

  resolveCategoryFromCatalog(catalog, query) {
    const normalized = normalizeCategoryName(query)
    if (!normalized) return null
    const exact = catalog.categoryAliases.get(normalized)
    if (exact) return exact

    const candidates = []
    for (const category of catalog.categories) {
      if (category.normalizedName.includes(normalized) || normalized.includes(category.normalizedName)) {
        candidates.push({
          category,
          score: Math.abs(category.normalizedName.length - normalized.length),
        })
      }
    }
    candidates.sort((a, b) => a.score - b.score || a.category.priority - b.category.priority)
    return candidates[0]?.category || null
  }

  async loadCatalog() {
    if (!this.catalogPromise) this.catalogPromise = this.readCatalog()
    return this.catalogPromise
  }

  async readCatalog() {
    const config = await loadGlobalConfig()
    const dataRoot = resolveAtlasDataRoot(this.dataRoot || config.atlas?.data_root || "data/atlas")
    const locale = this.locale || config.atlas?.locale || DEFAULT_LOCALE
    const dir = path.join(dataRoot, "data", "items", locale, "原神", "成就", "未分类")
    let entries = []
    try {
      entries = await this.fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === "ENOENT") {
        const err = new Error(`成就图鉴数据缺失：${dir}`)
        err.code = ACHIEVEMENT_DATA_MISSING
        throw err
      }
      throw error
    }

    const categories = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const file = path.join(dir, entry.name)
      const raw = await this.fs.readFile(file, "utf8")
      const json = JSON.parse(raw)
      const category = normalizeCategory(json, file, dataRoot)
      if (category.entries.length) categories.push(category)
    }

    categories.sort((a, b) => a.priority - b.priority || a.id - b.id || a.name.localeCompare(b.name, "zh-Hans-CN"))

    const achievementsById = new Map()
    const categoriesById = new Map()
    const categoryAliases = new Map()
    const predecessorsById = new Map()
    for (const category of categories) {
      categoriesById.set(category.id, category)
      categoryAliases.set(category.normalizedName, category)
      categoryAliases.set(normalizeCategoryName(category.name.replace(/·/g, "")), category)
      for (const entry of category.entries) achievementsById.set(entry.id, entry)
      for (const ids of groupedSeriesIds(category.entries)) {
        for (let index = 1; index < ids.length; index += 1) {
          predecessorsById.set(ids[index], ids.slice(0, index))
        }
      }
    }

    return {
      dataRoot,
      locale,
      categories,
      categoriesById,
      categoryAliases,
      achievementsById,
      predecessorsById,
    }
  }

  progressFile(uid) {
    return path.join(this.progressDir, `${sanitizeUid(uid)}.json`)
  }

  async loadProgress(uid) {
    if (!uid) return createEmptyProgress(uid)
    try {
      const raw = await this.fs.readFile(this.progressFile(uid), "utf8")
      return normalizeProgress(JSON.parse(raw), uid)
    } catch (error) {
      if (error?.code === "ENOENT") return createEmptyProgress(uid)
      throw error
    }
  }

  async saveProgress(uid, progress) {
    const file = this.progressFile(uid)
    await this.fs.mkdir(path.dirname(file), { recursive: true })
    await this.fs.writeFile(file, `${JSON.stringify(normalizeProgress(progress, uid), null, 2)}\n`, "utf8")
    return file
  }
}

export function normalizeCategoryName(value = "") {
  let text = String(value || "")
    .trim()
    .replace(/^#/, "")
    .replace(/^成就/, "")
    .replace(/成就$/g, "")
  text = text.replace(/第(\d{1,2})辑/g, (_, number) => `第${toChineseNumber(number)}辑`)
  return text
    .toLowerCase()
    .replace(/[·・.．。,\s_\-—:：/\\|()[\]{}【】（）《》<>〈〉「」『』]/g, "")
}

export function isAchievementDataMissing(error) {
  return error?.code === ACHIEVEMENT_DATA_MISSING
}

function normalizeCategory(json, file, dataRoot) {
  const list = json?.content?.list || {}
  const meta = json?.meta || {}
  const rawEntries = Array.isArray(list.list) ? list.list : []
  const id = Number(list.id ?? meta.recordId ?? 0)
  const icon = firstImagePath(meta)
  const category = {
    id,
    name: String(list.name || meta.name || path.basename(file, ".json")),
    priority: Number(list.priority ?? (id || 9999)),
    file,
    icon,
    dataRoot,
    entries: [],
  }
  category.normalizedName = normalizeCategoryName(category.name)
  category.entries = rawEntries
    .map((item, index) => normalizeAchievement(item, category, index))
    .filter(Boolean)
  return category
}

function normalizeAchievement(item, category, index) {
  const id = normalizeAchievementId(item?.id)
  if (!id) return null
  const points = Number(item?.reward?.item_count ?? item?.reward?.count ?? 0) || 0
  return {
    id,
    categoryId: category.id,
    categoryName: category.name,
    order: Number(item?.priority ?? index + 1),
    name: String(item?.name || `成就 ${id}`),
    desc: cleanText(item?.desc || ""),
    showType: item?.show_type || "",
    param: Number(item?.param ?? 1) || 1,
    points,
    version: String(item?.version || ""),
  }
}

function firstImagePath(meta = {}) {
  const image = Array.isArray(meta.images) ? meta.images.find(item => item?.localPath) : null
  return image?.localPath || ""
}

function buildCategorySummary(category, done = {}) {
  const completed = category.entries.filter(item => Boolean(done[item.id])).length
  const total = category.entries.length
  const pointsDone = category.entries.reduce((sum, item) => sum + (done[item.id] ? item.points : 0), 0)
  const pointsTotal = category.entries.reduce((sum, item) => sum + item.points, 0)
  return {
    id: category.id,
    name: category.name,
    icon: category.icon,
    completed,
    total,
    pointsDone,
    pointsTotal,
    percent: percent(completed, total),
    done: completed >= total && total > 0,
    priority: category.priority,
  }
}

function buildDisplayGroups(category, done = {}) {
  const grouped = new Map()
  for (const entry of category.entries) {
    const key = entry.name
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(entry)
  }

  const groups = []
  for (const [name, entries] of grouped.entries()) {
    entries.sort((a, b) => a.order - b.order || a.id - b.id)
    const completed = entries.filter(entry => Boolean(done[entry.id])).length
    const fullDone = completed === entries.length
    groups.push({
      name,
      desc: entries[0]?.desc || "",
      done: fullDone,
      partial: completed > 0 && !fullDone,
      completed,
      total: entries.length,
      pointsDone: entries.reduce((sum, entry) => sum + (done[entry.id] ? entry.points : 0), 0),
      pointsTotal: entries.reduce((sum, entry) => sum + entry.points, 0),
      order: Math.min(...entries.map(entry => entry.order)),
      stages: entries.map((entry, index) => ({
        ...entry,
        stageIndex: index + 1,
        stageTotal: entries.length,
        done: Boolean(done[entry.id]),
        date: done[entry.id]?.date || "",
        status: done[entry.id]?.status || "",
        progress: `${done[entry.id] ? entry.param : 0}/${entry.param}`,
      })),
    })
  }

  groups.sort((a, b) => Number(a.done) - Number(b.done) || a.order - b.order || a.name.localeCompare(b.name, "zh-Hans-CN"))
  return groups
}

function sumCategoryStats(categories) {
  const total = categories.reduce((sum, item) => sum + item.total, 0)
  const completed = categories.reduce((sum, item) => sum + item.completed, 0)
  const pointsTotal = categories.reduce((sum, item) => sum + item.pointsTotal, 0)
  const pointsDone = categories.reduce((sum, item) => sum + item.pointsDone, 0)
  return {
    total,
    completed,
    pointsTotal,
    pointsDone,
    percent: percent(completed, total),
  }
}

function groupedSeriesIds(entries) {
  const map = new Map()
  for (const entry of entries) {
    if (!map.has(entry.name)) map.set(entry.name, [])
    map.get(entry.name).push(entry)
  }
  return [...map.values()]
    .filter(items => items.length > 1)
    .map(items => items.sort((a, b) => a.order - b.order || a.id - b.id).map(item => item.id))
}

function addDoneRecord(done, id, item = {}, source = "cocogoat") {
  const existed = Boolean(done[id])
  done[id] ||= {
    id,
    date: normalizeDate(item.date || item.timestamp || ""),
    status: item.status || true,
    source,
  }
  return { added: !existed }
}

function normalizeProgress(progress = {}, uid = "") {
  const done = {}
  const source = progress.done || progress.records || progress.achievements || {}
  if (Array.isArray(source)) {
    for (const item of source) {
      const id = normalizeAchievementId(item?.id)
      if (id) done[id] = { id, date: normalizeDate(item.date || ""), status: item.status || true, source: item.source || "legacy" }
    }
  } else if (source && typeof source === "object") {
    for (const [rawId, value] of Object.entries(source)) {
      const id = normalizeAchievementId(rawId)
      if (!id) continue
      done[id] = value && typeof value === "object"
        ? { id, date: normalizeDate(value.date || ""), status: value.status || true, source: value.source || "legacy" }
        : { id, date: "", status: true, source: "legacy" }
    }
  }
  return {
    version: 1,
    uid: String(progress.uid || uid || ""),
    updatedAt: progress.updatedAt || "",
    done,
  }
}

function createEmptyProgress(uid = "") {
  return {
    version: 1,
    uid: String(uid || ""),
    updatedAt: "",
    done: {},
  }
}

function sanitizeUid(uid) {
  return String(uid || "unknown").replace(/[^\dA-Za-z_-]+/g, "_")
}

function normalizeAchievementId(value) {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : 0
}

function normalizeDate(value) {
  if (!value) return ""
  if (typeof value === "number") return new Date(value * 1000).toISOString().slice(0, 10).replace(/-/g, "/")
  return String(value)
}

function cleanText(value = "") {
  return String(value)
    .replace(/<color=[^>]+>/gi, "")
    .replace(/<\/color>/gi, "")
    .replace(/\\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
}

function percent(done, total) {
  if (!total) return 0
  return Math.floor((done / total) * 1000) / 10
}

function toChineseNumber(value) {
  const number = Number(value)
  return CHINESE_NUMBERS[number] || String(value)
}
