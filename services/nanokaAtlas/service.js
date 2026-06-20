import { existsSync, readdirSync, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parse as parseYaml } from "yaml"
import { loadGlobalConfig } from "../../core/config/global.js"
import { rootPath } from "../../core/path.js"

const GAME_LABELS = {
  gi: "原神",
  hsr: "星铁",
  zzz: "绝区零",
  nte: "异环",
}

const GAME_IDS_BY_LABEL = {
  原神: "gi",
  星铁: "hsr",
  绝区零: "zzz",
  异环: "nte",
}

const LOCALE_IDS = {
  简体中文: "zh",
  繁體中文: "cht",
  English: "en",
  日本語: "ja",
  한국어: "ko",
}

const INDEX_CACHE = new Map()
const ALIAS_CACHE = {
  loaded: false,
  map: new Map(),
}
const ATLAS_PAGE_INDEX_CACHE = new Map()
const NUMERIC_TOKEN_RE = /[-+]?\d+(?:\.\d+)?%?/g

const GENSHIN_THEATER_DIFFICULTY_LABELS = Object.freeze({
  1: "轻简",
  2: "普通",
  3: "困难",
  4: "卓越",
  5: "月谕",
})

const GENSHIN_THEATER_ELEMENTS = Object.freeze({
  2: { name: "水", key: "Hydro", assets: ["Skill_E_PlayerWater_01", "Skill_S_PlayerWater_01"] },
  3: { name: "火", key: "Pyro", assets: ["Skill_E_PlayerFire_01", "Skill_S_PlayerFire_01"] },
  4: { name: "雷", key: "Electro", assets: ["Skill_E_PlayerElectric_01", "Skill_S_PlayerElectric_01"] },
  5: { name: "风", key: "Anemo", assets: ["Skill_E_PlayerWind_01", "Skill_S_PlayerWind_01"] },
  6: { name: "草", key: "Dendro", assets: ["Skill_E_PlayerGrass_01", "Skill_S_PlayerGrass_01"] },
  7: { name: "冰", key: "Cryo", assets: ["UI_AnimalIcon_Wisp_Ice_01"] },
  8: { name: "岩", key: "Geo", assets: ["Skill_E_PlayerRock_01", "Skill_S_PlayerRock_01"] },
})

const THEATER_ACT_LABELS = [
  "第一幕",
  "第二幕",
  "第三幕",
  "第四幕",
  "第五幕",
  "第六幕",
  "第七幕",
  "第八幕",
  "第九幕",
  "第十幕",
]

const CHINESE_NUMERAL = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]

const CHALLENGE_PAGE_NAMES = new Set([
  "深境螺旋",
  "幻想真境剧诗挑战",
  "混沌回忆",
  "混沌回忆版本",
  "虚构叙事",
  "虚构叙事版本",
  "叙事挑战",
  "异相仲裁",
  "异相仲裁版本",
  "末日幻影",
  "式舆防卫战",
  "危局强袭战",
])

const DAY_MS = 24 * 60 * 60 * 1000

const CHALLENGE_SCHEDULES = Object.freeze({
  genshinAbyss: {
    type: "cycle",
    anchorId: 120,
    anchorStart: "2026-06-16T04:00:00+08:00",
    periodDays: 31,
    orderIds: [119, 120, 20094],
  },
  genshinTheater: {
    type: "cycle",
    anchorId: 26,
    anchorStart: "2026-06-01T04:00:00+08:00",
    periodDays: 31,
  },
  zzzShiyu: {
    type: "cycle",
    anchorId: 62050,
    anchorStart: "2026-06-12T04:00:00+08:00",
    periodDays: 14,
    orderIds: [62049, 62050, 620511, 620521, 620531],
  },
  hsrChaos: {
    type: "cycle",
    anchorId: 1032,
    anchorStart: "2026-05-25T04:00:00+08:00",
    periodDays: 42,
  },
  hsrFiction: {
    type: "cycle",
    anchorId: 2023,
    anchorStart: "2026-05-11T04:00:00+08:00",
    periodDays: 42,
    minId: 2000,
    maxId: 2999,
  },
  hsrApocalypse: {
    type: "cycle",
    anchorId: 3018,
    anchorStart: "2026-06-08T04:00:00+08:00",
    periodDays: 42,
  },
  hsrArbitration: {
    type: "cycle",
    anchorId: 7,
    anchorStart: "2026-06-11T04:00:00+08:00",
    periodDays: 42,
    minId: 1,
    maxId: 999,
  },
  zzzAssault: {
    type: "cycle",
    anchorId: 69038,
    anchorStart: "2026-06-05T04:00:00+08:00",
    periodDays: 14,
    minId: 69001,
    maxId: 69099,
  },
})

const PERSONAL_CHALLENGE_TERMS = new Set([
  "深渊",
  "深境螺旋",
  "幻想",
  "幻想真境剧诗",
  "混沌",
  "混沌回忆",
  "忘却",
  "忘却之庭",
  "末日",
  "末日幻影",
  "虚构",
  "虚构叙事",
  "异相",
  "异相仲裁",
  "防卫",
  "防卫战",
  "式舆",
  "式舆防卫",
  "式舆防卫战",
  "危局",
  "危局强袭战",
  "强袭",
  "强袭战",
])

const GENERIC_ATLAS_SHORTCUT_TERMS = new Set([
  "原神",
  "星铁",
  "崩铁",
  "星穹铁道",
  "绝区零",
  "角色",
  "武器",
  "圣遗物",
  "光锥",
  "遗器",
  "遗器套装",
  "音擎",
  "驱动盘",
  "邦布",
  "敌人",
  "物品",
  "材料",
  "卡牌",
  "七圣召唤",
])

const STATIC_QUERY_ALIASES = Object.freeze({
  星见雅: { game: "绝区零", aliases: ["雅"] },
  雾切之回光: { game: "原神", aliases: ["雾切"] },
  冰封迷途的勇士: { game: "原神", aliases: ["冰风迷途的勇士"] },
})

const SHORTCUT_GAME_BY_PREFIX = Object.freeze({
  "#": "原神",
  "*": "星铁",
  "%": "绝区零",
  "％": "绝区零",
})

const LOADER_GAME_PREFIXES = Object.freeze([
  { prefix: "#星铁", game: "星铁", shortcutPrefix: "*" },
  { prefix: "#星穹铁道", game: "星铁", shortcutPrefix: "*" },
  { prefix: "#崩坏星穹铁道", game: "星铁", shortcutPrefix: "*" },
  { prefix: "#崩铁", game: "星铁", shortcutPrefix: "*" },
  { prefix: "#绝区零", game: "绝区零", shortcutPrefix: "%" },
  { prefix: "#绝区", game: "绝区零", shortcutPrefix: "%" },
  { prefix: "#原神", game: "原神", shortcutPrefix: "#" },
])

const SHORTCUT_PREFIX_BY_GAME = Object.freeze({
  原神: "#",
  星铁: "*",
  绝区零: "%",
})

const DIRECT_SHORTCUT_PAGES_BY_GAME = Object.freeze({
  原神: new Set(["角色", "武器", "圣遗物"]),
  星铁: new Set(["角色", "光锥", "遗器套装"]),
  绝区零: new Set(["角色", "音擎", "驱动盘"]),
})

const ROLE_DETAIL_SUFFIXES_BY_GAME = Object.freeze({
  原神: ["命座", "天赋"],
  星铁: ["星魂", "天赋"],
  绝区零: ["影画", "天赋"],
})

const SHORTCUT_MIN_SCORE = 100
const SHORTCUT_ROUTE_CHUNK_SIZE = 80
const SHORTCUT_ROUTE_NAME_LIMIT = 48

const ROLE_DETAIL_SUFFIX_GAME = Object.freeze({
  命座: "原神",
  星魂: "星铁",
  影画: "绝区零",
})

const ATLAS_QUERY_SUFFIX_RE = /图鉴$/

const ZZZ_ICON_MAP_ASSETS = Object.freeze({
  Icon_Normal: ["Icon_Normal"],
  Icon_Evade: ["Icon_Evade"],
  Icon_Evaded: ["Icon_Evade"],
  Icon_Special: ["IconRoleSkillKeySpecial"],
  Icon_SpecialReady: ["IconRoleSkillKeySpecialV2"],
  Icon_SpecialReady_Rp: ["IconRoleSkillKeySpecialV3_02"],
  Icon_UltimateReady: ["Icon_UltimateReady"],
  Icon_Switch: ["Icon_Switch", "CardSwitch01"],
  Icon_QTE: ["Icon_QTE", "CardSwitch01"],
  Icon_Chain: ["Icon_UltimateReady", "TransformChain01"],
  Icon_Assist: ["Icon_QTE", "CardSwitch01"],
  Icon_CoreSkill: ["Icon_CoreSkill"],
  Icon_JoyStick: ["Icon_JoyStick"],
  Icon_AvatarClass_Attack: ["IconAttack"],
  Icon_AvatarClass_Anomaly: ["IconAnomaly"],
  Icon_AvatarClass_Rupture: ["IconRupture"],
  Icon_AvatarClass_Stun: ["IconStun"],
  Icon_GeneralBuff_PhysDmg: ["IconPhysDmg"],
  Icon_GeneralBuff_Thunder: ["IconThunder"],
  Icon_GeneralBuff_Fire: ["IconFire"],
  Icon_GeneralBuff_Ice: ["IconIce"],
  Icon_GeneralBuff_DungeonBuffEther: ["IconDungeonBuffEther"],
  Icon_GeneralBuff_AuricInk: ["IconAuricInk"],
  Icon_GeneralBuff_HonedEdge: ["IconHonedEdge"],
  Icon_GeneralBuff_Frost: ["IconFrost"],
})

const ZZZ_ICON_MAP_LABELS = Object.freeze({
  Icon_Normal: "普通攻击",
  Icon_Evade: "闪避",
  Icon_Evaded: "闪避反击",
  Icon_Special: "特殊技",
  Icon_SpecialReady: "强化特殊技",
  Icon_SpecialReady_Rp: "强化特殊技",
  Icon_UltimateReady: "终结技",
  Icon_Switch: "切换",
  Icon_QTE: "快速支援",
  Icon_Chain: "连携技",
  Icon_Assist: "支援技",
  Icon_CoreSkill: "核心技",
  Icon_JoyStick: "摇杆",
  Icon_AvatarClass_Attack: "强攻",
  Icon_AvatarClass_Anomaly: "异常",
  Icon_AvatarClass_Rupture: "命破",
  Icon_AvatarClass_Stun: "击破",
  Icon_GeneralBuff_PhysDmg: "物理",
  Icon_GeneralBuff_Thunder: "电属性",
  Icon_GeneralBuff_Fire: "火属性",
  Icon_GeneralBuff_Ice: "冰属性",
  Icon_GeneralBuff_DungeonBuffEther: "以太",
  Icon_GeneralBuff_AuricInk: "玄墨",
  Icon_GeneralBuff_HonedEdge: "锋芒",
  Icon_GeneralBuff_Frost: "霜寒",
})

const PAGE_PRIORITY = Object.freeze({
  角色: 240,
  武器: 220,
  光锥: 220,
  音擎: 220,
  深境螺旋: 210,
  幻想真境剧诗挑战: 210,
  混沌回忆: 210,
  混沌回忆版本: 210,
  虚构叙事: 210,
  虚构叙事版本: 210,
  叙事挑战: 210,
  异相仲裁: 210,
  异相仲裁版本: 210,
  末日幻影: 210,
  式舆防卫战: 210,
  危局强袭战: 210,
  圣遗物: 180,
  遗器套装: 180,
  驱动盘: 180,
  邦布: 120,
  敌人: 110,
  物品详情: 30,
  物品: 20,
  摆设: 10,
})

export class NanokaAtlasService {
  constructor(options = {}) {
    this.config = options.config
    this.fs = options.fs || fs
  }

  async search(query, options = {}) {
    const parsed = parseAtlasQuery(query)
    const challenge = options.challenge || resolveChallengeQuery(parsed.keyword, options.now)
    const keyword = normalizeKeyword(challenge?.search || parsed.keyword)
    if (!keyword && !challenge) return { ok: false, reason: "empty_query", results: [] }
    const game = options.game || challenge?.game || ""
    const aliases = await loadAtlasAliasMap()

    const config = this.config || (await loadGlobalConfig()).atlas || {}
    const root = resolveAtlasRoot(options.dataRoot || config.data_root)
    const locale = options.locale || config.locale || "简体中文"
    const itemsRoot = path.join(root, "data", "items", locale)
    const maxResults = Number(options.maxResults || config.max_results || 8)

    if (!await exists(itemsRoot, this.fs)) {
      return {
        ok: false,
        reason: "atlas_data_missing",
        root,
        results: [],
      }
    }

    const index = await loadAtlasIndex(root, locale, this.fs)
    const results = challenge
      ? await findChallengeResults(index, challenge, root, this.fs, maxResults)
      : await findSearchResults(index, keyword, root, this.fs, maxResults, {
        game,
        pages: options.pages,
        aliases,
        minScore: options.minScore,
        strict: options.strict,
      })

    return {
      ok: results.length > 0,
      reason: results.length ? "" : "not_found",
      root,
      locale,
      query: keyword,
      rawQuery: normalizeKeyword(query),
      challenge,
      game,
      template: challenge ? "atlas-challenge" : "atlas-item",
      modules: index.modules,
      results,
    }
  }

  async canResolveShortcut(query, options = {}) {
    const parsed = parseAtlasShortcutMessage(query)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    const result = await this.search(parsed.query, {
      ...options,
      challenge: parsed.challenge,
      game: parsed.game,
      pages: parsed.pages,
      minScore: parsed.challenge ? undefined : SHORTCUT_MIN_SCORE,
      strict: !parsed.challenge,
      maxResults: 1,
    })
    return {
      ok: result.ok,
      reason: result.reason,
      query: parsed.query,
      result,
    }
  }

  async modules(options = {}) {
    const config = this.config || (await loadGlobalConfig()).atlas || {}
    const root = resolveAtlasRoot(options.dataRoot || config.data_root)
    const locale = options.locale || config.locale || "简体中文"
    const index = await loadAtlasIndex(root, locale, this.fs)
    return index.modules
  }

  async sampleResults(options = {}) {
    const config = this.config || (await loadGlobalConfig()).atlas || {}
    const root = resolveAtlasRoot(options.dataRoot || config.data_root)
    const locale = options.locale || config.locale || "简体中文"
    const index = await loadAtlasIndex(root, locale, this.fs)
    const groups = new Map()

    for (const entry of index.entries) {
      const key = `${entry.game}|${entry.page}`
      const bucket = groups.get(key) || []
      bucket.push(entry)
      groups.set(key, bucket)
    }

    const results = []
    for (const module of index.modules) {
      const entries = groups.get(`${module.game}|${module.page}`) || []
      const entry = chooseModuleSampleEntry(entries)
      if (!entry) continue
      const item = await readAtlasItem(entry.file, root, this.fs, entry).catch(() => null)
      if (!item) continue
      item.template = module.template || item.template
      results.push({
        ok: true,
        reason: "",
        root,
        locale,
        query: `${module.game} ${module.page}`,
        rawQuery: `${module.game} ${module.page}`,
        template: item.template,
        module,
        modules: index.modules,
        results: [item],
      })
    }
    return results
  }

  async status(options = {}) {
    const config = this.config || (await loadGlobalConfig()).atlas || {}
    const root = resolveAtlasRoot(options.dataRoot || config.data_root)
    const locale = options.locale || config.locale || "简体中文"
    const itemsRoot = path.join(root, "data", "items", locale)
    const galleryRoot = path.join(root, "gallery")
    const itemsReady = await exists(itemsRoot, this.fs)
    const galleryReady = await exists(galleryRoot, this.fs)
    let modules = []
    if (itemsReady) {
      try {
        modules = await this.modules({ dataRoot: root, locale })
      } catch {
        modules = []
      }
    }
    return {
      root,
      locale,
      itemsReady,
      galleryReady,
      itemCount: itemsReady ? await countJsonFiles(itemsRoot, this.fs) : 0,
      moduleCount: modules.length,
      modules,
    }
  }
}

export async function buildAtlasShortcutRules(options = {}) {
  const fsImpl = options.fs || fs
  const config = options.config || (await loadGlobalConfig()).atlas || {}
  const root = resolveAtlasRoot(options.dataRoot || config.data_root)
  const locale = options.locale || config.locale || "简体中文"
  const itemsRoot = path.join(root, "data", "items", locale)
  const rules = []
  const stats = {
    directNames: 0,
    roleNames: 0,
    challengeNames: 0,
    rules: 0,
  }

  rules.push(...buildChallengeShortcutRules(stats))

  if (!await exists(itemsRoot, fsImpl)) {
    stats.rules = rules.length
    return {
      ok: false,
      reason: "atlas_data_missing",
      root,
      locale,
      rules,
      stats,
    }
  }

  const index = await loadAtlasIndex(root, locale, fsImpl)
  const aliasMap = await loadAtlasAliasMap()
  const directNamesByPrefix = new Map()
  const roleNamesByGame = new Map()

  for (const entry of index.entries) {
    if (!isDirectShortcutEntry(entry)) continue
    const prefix = SHORTCUT_PREFIX_BY_GAME[entry.game]
    if (!prefix) continue
    const names = await shortcutNamesForEntry(entry, aliasMap, fsImpl)
    if (!names.length) continue
    addSetValues(directNamesByPrefix, prefix, names)
    if (entry.page === "角色") addSetValues(roleNamesByGame, entry.game, names)
  }

  for (const [prefix, names] of directNamesByPrefix.entries()) {
    const list = [...names].sort(shortcutNameSort)
    stats.directNames += list.length
    for (const routePrefix of shortcutRoutePrefixes(prefix)) {
      rules.push(...buildNameShortcutRules(routePrefix, list, "(?:图鉴)?"))
    }
  }

  const allRoleNames = new Set()
  for (const [game, names] of roleNamesByGame.entries()) {
    const prefix = SHORTCUT_PREFIX_BY_GAME[game]
    const suffixes = ROLE_DETAIL_SUFFIXES_BY_GAME[game] || []
    const list = [...names].sort(shortcutNameSort)
    stats.roleNames += list.length
    for (const name of list) allRoleNames.add(name)
    if (prefix && suffixes.length) {
      for (const routePrefix of shortcutRoutePrefixes(prefix)) {
        rules.push(...buildNameShortcutRules(routePrefix, list, `(?:${suffixes.map(escapeRegExp).join("|")})`))
      }
    }
  }
  rules.push(...buildNameShortcutRules("", [...allRoleNames].sort(shortcutNameSort), "(?:命座|星魂|影画|天赋)"))

  stats.rules = rules.length
  return {
    ok: true,
    root,
    locale,
    rules,
    stats,
  }
}

function isDirectShortcutEntry(entry = {}) {
  const pages = DIRECT_SHORTCUT_PAGES_BY_GAME[entry.game]
  return Boolean(pages?.has(entry.page))
}

async function shortcutNamesForEntry(entry = {}, aliasMap = new Map(), fsImpl = fs) {
  const names = new Set()
  const push = value => {
    const text = normalizeShortcutRouteName(value)
    if (text) names.add(text)
  }

  push(entry.title)
  push(entry.basename)
  for (const alias of entry.aliases || []) push(alias)
  for (const alias of await readShortcutNameSeeds(entry, fsImpl)) push(alias)

  const seeds = [...names]
  for (const seed of seeds) {
    const values = aliasMap.get(normalizeForMatch(seed)) || []
    for (const item of values) {
      if (typeof item === "string") push(item)
      else if (!item.game || !entry.game || item.game === entry.game) push(item.value)
    }
  }

  return [...names]
}

async function readShortcutNameSeeds(entry = {}, fsImpl = fs) {
  if (!entry.file) return []
  try {
    const raw = await fsImpl.readFile(entry.file, "utf8")
    const json = JSON.parse(raw)
    const meta = json.meta || {}
    const list = json.content?.list || {}
    const detail = json.content?.detail || {}
    return [
      meta.name,
      list.name,
      list.zh,
      detail.name,
      detail.partner_info?.full_name,
      displayTitle(meta, list, detail, entry),
      ...(Array.isArray(detail.affix) ? detail.affix.map(item => item?.name) : []),
    ].filter(Boolean)
  } catch {
    return []
  }
}

function normalizeShortcutRouteName(value = "") {
  const text = cleanText(value).replace(/\s+/g, "").trim()
  if (!text) return ""
  if (text.length < 2 || text.length > SHORTCUT_ROUTE_NAME_LIMIT) return ""
  if (/[\r\n#*%^$\\]/.test(text)) return ""
  if (isPanelShortcutQuery(text)) return ""
  if (text.endsWith("图鉴")) return ""
  if (looksLikeNonAtlasCommand(text)) return ""
  if (PERSONAL_CHALLENGE_TERMS.has(normalizeShortcutText(text))) return ""
  if (GENERIC_ATLAS_SHORTCUT_TERMS.has(normalizeShortcutText(text))) return ""
  return text
}

function addSetValues(map, key, values) {
  const set = map.get(key) || new Set()
  for (const value of values) set.add(value)
  map.set(key, set)
}

function buildChallengeShortcutRules(stats) {
  const namesByPrefix = new Map()
  for (const [name, target] of Object.entries(CHALLENGE_TARGETS)) {
    const prefix = SHORTCUT_PREFIX_BY_GAME[target.game]
    if (!prefix) continue
    addSetValues(namesByPrefix, prefix, [name])
  }

  const rules = []
  const datePrefix = "(?:\\d{4}[./年-]\\d{1,2}[./月-]\\d{1,2}日?)?"
  for (const [prefix, names] of namesByPrefix.entries()) {
    const list = [...names].sort(shortcutNameSort)
    stats.challengeNames += list.length
    for (const routePrefix of shortcutRoutePrefixes(prefix)) {
      for (const chunk of chunkArray(list, SHORTCUT_ROUTE_CHUNK_SIZE)) {
        rules.push({
          reg: `^${escapeRegExp(routePrefix)}${datePrefix}(?:上期|本期|当期|下期)(?:${chunk.map(escapeRegExp).join("|")})$`,
          fnc: "shortcutQuery",
        })
      }
    }
  }
  return rules
}

function shortcutRoutePrefixes(prefix) {
  if (prefix === "*") return ["*", "#星铁"]
  if (prefix === "%") return ["%", "％", "#绝区零"]
  if (prefix === "#") return ["#"]
  return [prefix]
}

function buildNameShortcutRules(prefix, names, suffixPattern) {
  if (!names.length) return []
  const rules = []
  for (const chunk of chunkArray(names, SHORTCUT_ROUTE_CHUNK_SIZE)) {
    rules.push({
      reg: `^${escapeRegExp(prefix)}(?:${chunk.map(escapeRegExp).join("|")})${suffixPattern}$`,
      fnc: "shortcutQuery",
    })
  }
  return rules
}

function shortcutNameSort(a, b) {
  return b.length - a.length || a.localeCompare(b, "zh-Hans-CN")
}

function chunkArray(values, size) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function buildAtlasRenderData(searchResult) {
  const results = searchResult.results || []
  const main = results[0] || null
  const challenge = searchResult.challenge
  const displayPage = challenge?.label || main?.page || ""
  const title = challenge
    ? `${challenge.period}${challenge.label}`
    : main?.title || searchResult.query || "图鉴"

  return {
    template: searchResult.template || main?.template || "atlas-item",
    title,
    subtitle: main
      ? `${main.game} · ${displayPage} · ${main.rarity || "未分类"}${main.version ? ` · 图鉴版本 ${main.version}` : ""}`
      : "Nanoka Atlas",
    badge: challenge?.label || atlasBadgeLabel(main?.page) || (main ? "ATLAS" : "未找到"),
    query: searchResult.rawQuery || searchResult.query,
    message: atlasMessage(searchResult, main),
    image: main?.image || "",
    atlasRoot: searchResult.root || "",
    source: main?.source || "",
    item: main,
    view: main?.view || null,
    facts: main?.facts || [],
    chips: main?.chips || [],
    sections: main?.sections || [],
    modules: searchResult.modules || [],
    items: results.map(item => ({
      title: item.title,
      meta: `${item.game} · ${item.page} · ${item.rarity || "未分类"}`,
      desc: item.description || item.period || "暂无描述",
      image: item.image,
    })),
  }
}

function atlasBadgeLabel(page = "") {
  return ({
    幻想真境剧诗挑战: "幻想真境剧诗",
    虚构叙事版本: "虚构叙事",
    异相仲裁版本: "异相仲裁",
    混沌回忆版本: "混沌回忆",
  })[page] || page
}

export function selectAtlasTemplate(renderDataOrResult) {
  const template = renderDataOrResult?.template || renderDataOrResult?.results?.[0]?.template
  if (template === "atlas-challenge") return "atlas-challenge"
  if (template === "atlas-list") return "atlas-result"
  return "atlas-item"
}

export function parseAtlasShortcutMessage(message = "") {
  const raw = stripAtlasMessagePrefix(message)
  if (!raw) return { ok: false, reason: "empty" }
  if (/^#?(?:Lotus|lotus|荷花)?图鉴/i.test(raw)) {
    const query = normalizeKeyword(raw)
    return query ? { ok: true, query, explicit: true } : { ok: false, reason: "empty_query" }
  }

  const normalized = normalizeLoaderShortcutPrefix(raw)
  const prefix = normalized.prefix
  const hasPrefix = ["#", "*", "%", "％"].includes(prefix)
  const game = normalized.game || (hasPrefix ? SHORTCUT_GAME_BY_PREFIX[prefix] : "")
  const originalText = normalized.text
  const text = stripShortcutAtlasSuffix(originalText)
  const explicitSuffix = text !== originalText
  if (!text) return { ok: false, reason: "empty_query" }
  if (isPanelShortcutQuery(originalText)) return { ok: false, reason: "panel_query" }
  if (!explicitSuffix && isPersonalChallengeQuery(text)) return { ok: false, reason: "personal_challenge" }

  const challenge = resolveChallengeQuery(text)
  if (challenge) {
    if (game && challenge.game && game !== challenge.game) {
      return { ok: false, reason: "prefix_game_mismatch", game, challenge }
    }
    return { ok: true, query: text, prefix, game: challenge.game || game, challenge, explicitSuffix, shortcut: true }
  }
  const roleDetail = parseRoleDetailShortcut(text, game)
  if (roleDetail?.conflict) return { ok: false, reason: "prefix_detail_mismatch" }
  if (roleDetail) {
    return {
      ok: true,
      query: roleDetail.query,
      prefix: hasPrefix ? prefix : "",
      game: roleDetail.game,
      pages: ["角色"],
      detailSuffix: roleDetail.suffix,
      explicitSuffix,
      shortcut: true,
    }
  }
  if (!hasPrefix) return { ok: false, reason: "unsupported_prefix" }
  if (GENERIC_ATLAS_SHORTCUT_TERMS.has(normalizeShortcutText(text))) return { ok: false, reason: "generic_query" }
  if (looksLikeNonAtlasCommand(text)) return { ok: false, reason: "known_command" }
  if (text.length < 2) return { ok: false, reason: "too_short" }
  return { ok: true, query: text, prefix, game, explicitSuffix, shortcut: true }
}

function normalizeLoaderShortcutPrefix(raw = "") {
  const text = String(raw || "").trim()
  for (const item of LOADER_GAME_PREFIXES) {
    if (!text.startsWith(item.prefix)) continue
    return {
      prefix: item.shortcutPrefix,
      game: item.game,
      text: text.slice(item.prefix.length).trim(),
      loaderPrefix: item.prefix,
    }
  }

  const prefix = text[0]
  return {
    prefix,
    game: "",
    text: ["#", "*", "%", "％"].includes(prefix) ? text.slice(1).trim() : text,
  }
}

export function isPersonalChallengeQuery(query = "") {
  const text = normalizeShortcutText(query)
  if (!text || resolveChallengeQuery(text)) return false
  return PERSONAL_CHALLENGE_TERMS.has(text)
}

function isPanelShortcutQuery(text = "") {
  const normalized = normalizeShortcutText(text)
  return normalized.endsWith("面板")
    || normalized.endsWith("面版")
    || /(?:面板|面版)[\s\S]*[换变改]/.test(normalized)
}

function stripShortcutAtlasSuffix(text = "") {
  return normalizeKeyword(text).replace(ATLAS_QUERY_SUFFIX_RE, "").trim()
}

function parseRoleDetailShortcut(text = "", prefixGame = "") {
  const clean = normalizeKeyword(text).replace(/\s+/g, "")
  const match = clean.match(/^(.+?)(命座|星魂|影画|天赋)$/)
  if (!match) return null
  const query = match[1]?.trim()
  const suffix = match[2]
  if (!query || GENERIC_ATLAS_SHORTCUT_TERMS.has(normalizeShortcutText(query))) return null
  const suffixGame = ROLE_DETAIL_SUFFIX_GAME[suffix] || ""
  if (prefixGame && suffixGame && prefixGame !== suffixGame) return { conflict: true, suffix }
  return {
    query,
    suffix,
    game: suffixGame || prefixGame || "",
  }
}

export function resolveChallengeQuery(query = "", now = new Date()) {
  const parsed = extractChallengeQuery(query, now)
  if (!parsed) return null
  const period = parsed.period === "本期" ? "当期" : parsed.period
  const type = parsed.type
  const target = CHALLENGE_TARGETS[type]
  if (!target) return null
  return {
    period,
    type,
    label: target.label,
    search: target.search,
    pages: target.pages,
    game: target.game,
    schedule: target.schedule,
    date: parsed.date,
    note: `${period}${target.label} · 以 ${formatDate(parsed.date)} 为查询基准`,
    periodOffset: period === "上期" ? -1 : period === "下期" ? 1 : 0,
    offset: period === "上期" ? 1 : period === "下期" ? -1 : 0,
  }
}

async function findSearchResults(index, keyword, root, fsImpl, maxResults, filters = {}) {
  const variants = buildKeywordVariants(keyword, filters.aliases, filters.game)
  const scored = []

  for (const entry of index.entries) {
    if (!entryMatchesAtlasFilters(entry, filters)) continue
    const score = scoreIndexEntry(entry, variants, keyword)
    if (score > 0) scored.push({ entry, score })
  }

  scored.sort((a, b) => b.score - a.score
    || a.entry.title.length - b.entry.title.length
    || a.entry.title.localeCompare(b.entry.title, "zh-Hans-CN"))

  const loaded = []
  const seen = new Set()
  for (const { entry, score } of scored.slice(0, Math.max(maxResults * 5, maxResults))) {
    if (Number.isFinite(filters.minScore) && score < filters.minScore) continue
    if (seen.has(entry.file)) continue
    seen.add(entry.file)
    const item = await readAtlasItem(entry.file, root, fsImpl, entry).catch(() => null)
    if (!item) continue
    item.score = score + scoreLoadedItem(item, variants, keyword)
    loaded.push(item)
  }

  if (shouldRunDetailFallback(loaded, maxResults, variants, filters)) {
    const detailMatches = await findDetailFallbackMatches(index, variants, root, fsImpl, seen, maxResults, filters)
    loaded.push(...detailMatches)
  }

  if (!filters.strict && !loaded.length && index.source !== "files") {
    const fallback = await findCandidateFiles(index.itemsRoot, keyword, fsImpl)
    for (const candidate of fallback.slice(0, Math.max(maxResults * 3, maxResults))) {
      if (!candidateMatchesAtlasFilters(candidate, index.itemsRoot, filters)) continue
      const item = await readAtlasItem(candidate.file, root, fsImpl, candidate).catch(() => null)
      if (!item) continue
      item.score = scoreCandidateFile(candidate, keyword) + scoreLoadedItem(item, variants, keyword)
      loaded.push(item)
    }
  }

  loaded.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-Hans-CN"))
  return loaded.slice(0, maxResults)
}

async function findDetailFallbackMatches(index, variants, root, fsImpl, seen, maxResults, filters = {}) {
  const matches = []
  const highPriorityEntries = index.entries.filter(entry => (PAGE_PRIORITY[entry.page] || 0) >= 180
    && !seen.has(entry.file)
    && entryMatchesAtlasFilters(entry, filters))
  for (const entry of highPriorityEntries) {
    const raw = await fsImpl.readFile(entry.file, "utf8").catch(() => "")
    const normalized = normalizeForMatch(raw)
    if (!variants.some(variant => normalized.includes(variant.key))) continue
    const item = await readAtlasItem(entry.file, root, fsImpl, entry).catch(() => null)
    if (!item) continue
    item.score = (PAGE_PRIORITY[item.page] || 0) + 120 + scoreLoadedItem(item, variants)
    matches.push(item)
    seen.add(entry.file)
    if (matches.length >= maxResults * 4) break
  }
  return matches
}

function entryMatchesAtlasFilters(entry, filters = {}) {
  if (filters.game && entry.game !== filters.game) return false
  if (filters.pages?.length && !filters.pages.includes(entry.page)) return false
  return true
}

function candidateMatchesAtlasFilters(candidate, itemsRoot, filters = {}) {
  const relative = path.relative(itemsRoot, candidate.file || "")
  const [game, page] = relative.split(path.sep)
  if (filters.game && game !== filters.game) return false
  if (filters.pages?.length && !filters.pages.includes(page)) return false
  return true
}

function needsDetailFallback(loaded, maxResults) {
  if (loaded.length < maxResults) return true
  const topPriority = PAGE_PRIORITY[loaded[0]?.page] || 0
  return topPriority < 180
}

function shouldRunDetailFallback(loaded, maxResults, variants, filters = {}) {
  if (!needsDetailFallback(loaded, maxResults)) return false
  if (!filters.strict) return true
  return Math.max(...variants.map(variant => variant.key.length), 0) >= 3
}

async function findChallengeResults(index, challenge, root, fsImpl, maxResults) {
  const pageSet = new Set(challenge.pages)
  const entries = index.entries.filter(entry => pageSet.has(entry.page))
  const loaded = []

  for (const entry of entries) {
    const item = await readAtlasItem(entry.file, root, fsImpl, entry).catch(() => null)
    if (item) loaded.push(item)
  }

  const sorted = prepareChallengeItems(loaded, challenge)

  if (!sorted.length) return []
  const current = findCurrentChallengeIndex(sorted, challenge.date)
  const selectedIndex = current + (challenge.periodOffset || 0)
  if (selectedIndex < 0 || selectedIndex >= sorted.length) return []
  const selected = {
    ...sorted[selectedIndex],
    template: "atlas-challenge",
    period: buildChallengePeriodNote(challenge, sorted[selectedIndex]),
  }
  selected.sections = enrichChallengeSections([], selected.raw, { ...challenge, dateRange: selected.dateRange })

  const nearby = sorted
    .filter((_, index) => index !== selectedIndex)
    .slice(0, Math.max(0, maxResults - 1))
    .map(item => ({
      ...item,
      template: "atlas-challenge",
    }))

  return [selected, ...nearby]
}

function prepareChallengeItems(items, challenge) {
  const schedule = challenge.schedule || {}
  return items
    .filter(item => isSelectableChallengeItem(item, schedule))
    .map(item => {
      const dateRange = synthesizeChallengeDateRange(item, schedule) || extractDateRange(item.raw)
      return { ...item, dateRange }
    })
    .filter(item => hasSelectableChallengeDuration(item, schedule))
    .sort(compareChallengeItemsAscending)
}

function isSelectableChallengeItem(item, schedule = {}) {
  const id = challengeItemId(item)
  if (Number.isFinite(schedule.minId) && (!Number.isFinite(id) || id < schedule.minId)) return false
  if (Number.isFinite(schedule.maxId) && (!Number.isFinite(id) || id > schedule.maxId)) return false
  return true
}

function synthesizeChallengeDateRange(item, schedule = {}) {
  if (schedule.type !== "cycle") return null
  const id = challengeItemId(item)
  const anchorId = Number(schedule.anchorId)
  const anchorStart = parseLooseDate(schedule.anchorStart)
  const periodDays = Number(schedule.periodDays)
  if (!Number.isFinite(id) || !Number.isFinite(anchorId) || !anchorStart || !Number.isFinite(periodDays)) return null
  const offset = challengeItemOffset(id, anchorId, schedule)
  if (!Number.isFinite(offset)) return null
  const start = new Date(anchorStart.getTime() + offset * periodDays * DAY_MS)
  const end = new Date(start.getTime() + periodDays * DAY_MS - 1000)
  return { start, end }
}

function challengeItemOffset(id, anchorId, schedule = {}) {
  if (Array.isArray(schedule.orderIds)) {
    const ids = schedule.orderIds.map(Number)
    const itemIndex = ids.indexOf(Number(id))
    const anchorIndex = ids.indexOf(Number(anchorId))
    if (itemIndex >= 0 && anchorIndex >= 0) return itemIndex - anchorIndex
  }
  return id - anchorId
}

function hasSelectableChallengeDuration(item, schedule = {}) {
  const minDays = Number(schedule.minDurationDays || 0)
  if (!Number.isFinite(minDays) || minDays <= 0) return true
  const start = item.dateRange?.start?.getTime?.()
  const end = item.dateRange?.end?.getTime?.()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  return end - start >= minDays * DAY_MS
}

function challengeItemId(item) {
  const raw = Number(item?.id)
  if (Number.isFinite(raw)) return raw
  const fileId = String(item?.file || "").match(/(\d+)(?=\.json$)/)
  return fileId ? Number(fileId[1]) : NaN
}

function buildChallengePeriodNote(challenge, item) {
  const range = item?.dateRange
  const dateLine = range?.start || range?.end
    ? `${formatLooseDate(range.start) || "?"} - ${formatLooseDate(range.end) || "?"}`
    : ""
  return [
    challenge.note,
    item?.title ? `匹配条目：${item.title}` : "",
    dateLine ? `周期：${dateLine}` : "",
  ].filter(Boolean).join("\n")
}

async function loadAtlasIndex(root, locale, fsImpl) {
  const mapFile = path.join(root, "data", "map.json")
  const itemsRoot = path.join(root, "data", "items", locale)
  const stat = await safeStat(mapFile, fsImpl)
  const cacheKey = `${root}|${locale}|${stat?.mtimeMs || "no-map"}`
  const cached = INDEX_CACHE.get(cacheKey)
  if (cached) return cached

  let index
  if (stat) {
    const raw = await fsImpl.readFile(mapFile, "utf8")
    const map = JSON.parse(raw)
    index = buildIndexFromMap(map, root, locale, itemsRoot)
  } else {
    index = await buildIndexFromFiles(root, locale, fsImpl)
  }

  INDEX_CACHE.clear()
  INDEX_CACHE.set(cacheKey, index)
  return index
}

function buildIndexFromMap(map, root, locale, itemsRoot) {
  const localeId = LOCALE_IDS[locale] || "zh"
  const entries = []
  const modules = []

  for (const [gameId, gameBlock] of Object.entries(map.games || {})) {
    const gameLabel = gameBlock.game?.folder || GAME_LABELS[gameId] || gameBlock.game?.name || gameId
    const localeBlock = gameBlock.locales?.[localeId]
      || Object.values(gameBlock.locales || {}).find(item => item?.locale?.folder === locale)
    if (!localeBlock?.pages) continue

    for (const [pageId, page] of Object.entries(localeBlock.pages)) {
      const pageLabel = page.folder || page.title || pageId
      const records = Object.values(page.records || {})
      const module = {
        gameId,
        game: gameLabel,
        pageId,
        page: pageLabel,
        count: Number(page.totalRecordCount || page.recordCount || records.length || 0),
        version: page.version || gameBlock.game?.latestVersion || "",
        sample: records[0]?.name || "",
        template: CHALLENGE_PAGE_NAMES.has(pageLabel) ? "atlas-challenge" : "atlas-item",
      }
      modules.push(module)

      for (const record of records) {
        if (!record?.path) continue
        const file = path.join(root, "data", record.path)
        entries.push({
          id: String(record.id || ""),
          title: String(record.name || record.id || path.basename(record.path, ".json")),
          basename: path.basename(record.path, ".json"),
          gameId,
          game: gameLabel,
          pageId,
          page: pageLabel,
          rarity: record.rarity || "",
          file,
          sourcePath: record.path,
          imageCount: Number(record.imageCount || 0),
          version: page.version || gameBlock.game?.latestVersion || "",
          module,
          aliases: buildEntryAliases(record, pageLabel, gameLabel),
        })
      }
    }
  }

  return {
    source: "map",
    root,
    locale,
    itemsRoot,
    entries,
    modules: modules.sort(compareModules),
  }
}

function chooseModuleSampleEntry(entries) {
  const sorted = [...entries].sort((a, b) => sampleEntryScore(b) - sampleEntryScore(a)
    || a.title.length - b.title.length
    || a.title.localeCompare(b.title, "zh-Hans-CN"))
  return sorted[0] || null
}

function sampleEntryScore(entry) {
  let score = 0
  if (entry.imageCount > 0) score += 40
  if (!/^\d+$/.test(entry.title)) score += 25
  if (!/[{#}]/.test(entry.title)) score += 10
  score += PAGE_PRIORITY[entry.page] || 0
  return score
}

async function buildIndexFromFiles(root, locale, fsImpl) {
  const itemsRoot = path.join(root, "data", "items", locale)
  const candidates = await findCandidateFiles(itemsRoot, "", fsImpl)
  const entries = candidates.map(candidate => {
    const rel = path.relative(itemsRoot, candidate.file).split(path.sep)
    const [game, page, rarity] = rel
    return {
      id: "",
      title: candidate.base,
      basename: candidate.base,
      gameId: "",
      game,
      page,
      rarity,
      file: candidate.file,
      sourcePath: path.relative(path.join(root, "data"), candidate.file),
      imageCount: 0,
      version: "",
      aliases: new Set([candidate.base]),
    }
  })
  const moduleMap = new Map()
  for (const entry of entries) {
    const key = `${entry.game}|${entry.page}`
    const prev = moduleMap.get(key) || {
      game: entry.game,
      page: entry.page,
      count: 0,
      sample: entry.title,
      template: CHALLENGE_PAGE_NAMES.has(entry.page) ? "atlas-challenge" : "atlas-item",
    }
    prev.count += 1
    moduleMap.set(key, prev)
  }
  return {
    source: "files",
    root,
    locale,
    itemsRoot,
    entries,
    modules: [...moduleMap.values()].sort(compareModules),
  }
}

async function findCandidateFiles(root, keyword, fsImpl) {
  const result = []
  const queue = [root]
  const lowerKeyword = normalizeForMatch(keyword)
  while (queue.length) {
    const dir = queue.shift()
    const entries = await fsImpl.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        const base = path.basename(entry.name, ".json")
        if (!lowerKeyword || normalizeForMatch(base).includes(lowerKeyword)) {
          result.push({
            file: full,
            base,
            exact: normalizeForMatch(base) === lowerKeyword,
          })
        }
      }
    }
  }
  return result
}

async function readAtlasItem(file, root, fsImpl, entry = {}) {
  const raw = await fsImpl.readFile(file, "utf8")
  const json = JSON.parse(raw)
  const meta = json.meta || {}
  const list = json.content?.list || {}
  const detail = json.content?.detail || {}
  const title = displayTitle(meta, list, detail, entry)
  const page = meta.pageFolder || entry.page || meta.pageId || ""
  const imageResolver = createImageResolver(root, meta.images, meta.gameId)
  const image = resolveImage(root, meta.images)
  const challengePage = CHALLENGE_PAGE_NAMES.has(page)
  const item = {
    title,
    game: GAME_LABELS[meta.gameId] || meta.gameFolder || entry.game || meta.gameName || meta.gameId || "",
    gameFolder: meta.gameFolder || GAME_LABELS[meta.gameId] || entry.game || "",
    page,
    pageId: meta.pageId || entry.pageId || "",
    rarity: displayRarity(meta, list, detail, entry),
    version: meta.version || entry.version || "",
    description: challengePage
      ? firstText([
        detail.leyline?.desc,
        detail.buff?.desc,
        extractChallengeGuides(detail)[0],
        list.effect,
        list.desc,
      ])
      : firstText([
        detail.partner_info?.profile_desc,
        detail.desc,
        detail.description,
        detail.profile_desc,
        list.desc,
        list.description,
        list.effect,
        detail.effect,
        detail.story,
      ]),
    image,
    source: meta.detailSourceUrl || meta.sourceUrl || "",
    file,
    atlasRoot: root,
    id: String(meta.recordId || entry.id || list.id || detail.id || ""),
    template: challengePage ? "atlas-challenge" : "atlas-item",
    raw: json,
  }
  item.chips = buildChips(item)
  item.facts = extractFacts(meta, list, detail, item)
  item.sections = extractSections(item, list, detail)
  item.view = buildItemView(item, list, detail, imageResolver)
  return item
}

function displayTitle(meta, list, detail, entry) {
  if (meta.pageFolder === "角色" && detail.partner_info?.full_name) return String(detail.partner_info.full_name)
  if (["圣遗物", "遗器套装", "驱动盘"].includes(meta.pageFolder) && detail.affix?.[0]?.name) {
    return String(detail.affix[0].name)
  }
  return String(meta.name || detail.name || list.name || list.zh || entry.title || path.basename(entry.file || "", ".json"))
}

function displayRarity(meta, list, detail, entry) {
  if (meta.pageFolder === "角色" && meta.gameId === "zzz") {
    const rank = Number(detail.rarity ?? list.rank ?? entry.rarity)
    if (rank === 3) return "四星"
    if (rank === 4) return "五星"
  }
  return meta.rarity || entry.rarity || list.rank && `${list.rank}星` || list.rarity && `${list.rarity}星` || ""
}

function resolveImage(root, images = []) {
  const picked = images.find(item => item?.localPath && item.status === "downloaded" && !item.placeholder)
    || images.find(item => item?.localPath)
  if (!picked?.localPath) return ""
  return pathToFileURL(path.join(root, picked.localPath)).href
}

function createImageResolver(root, images = [], gameId = "") {
  const entries = images
    .filter(item => item?.localPath && item.status !== "failed" && !item.placeholder)
    .map(item => ({
      fieldPath: String(item.fieldPath || ""),
      originalValue: String(item.originalValue || ""),
      kind: String(item.kind || ""),
      localPath: item.localPath,
      url: pathToFileURL(path.join(root, item.localPath)).href,
    }))
  const match = (entry, pattern) => {
    if (pattern instanceof RegExp) return pattern.test(entry.fieldPath)
    const text = String(pattern)
    return entry.fieldPath === text
      || entry.fieldPath.includes(text)
      || entry.localPath === text
      || entry.localPath.includes(text)
  }
  const localAsset = (names = [], overrideGameId = gameId) => {
    const list = Array.isArray(names) ? names : [names]
    for (const name of list.filter(Boolean)) {
      const file = path.join(root, "gallery", overrideGameId || gameId, `${stripImageExt(String(name))}.webp`)
      if (existsSync(file)) return pathToFileURL(file).href
    }
    return ""
  }
  return {
    first(patterns = []) {
      const list = Array.isArray(patterns) ? patterns : [patterns]
      return entries.find(entry => list.some(pattern => match(entry, pattern)))?.url || ""
    },
    all(patterns = [], limit = 20) {
      const list = Array.isArray(patterns) ? patterns : [patterns]
      const seen = new Set()
      return entries
        .filter(entry => list.some(pattern => match(entry, pattern)))
        .filter(entry => {
          if (seen.has(entry.url)) return false
          seen.add(entry.url)
          return true
        })
        .slice(0, limit)
    },
    iconMap(token = "") {
      const key = String(token || "").trim()
      if (!key) return ""
      const fromMeta = entries.find(entry =>
        entry.kind === "icon_map"
        && (entry.originalValue === `<IconMap:${key}>` || entry.fieldPath.endsWith(`.IconMap.${key}`)))
      if (fromMeta?.url) return fromMeta.url
      return localAsset(ZZZ_ICON_MAP_ASSETS[key] || [key], "zzz")
    },
    localAsset,
    entries,
  }
}

function findAtlasEntity(item, pages, keyword) {
  const value = String(keyword || "").trim()
  if (!value || !item?.atlasRoot) return null
  const list = Array.isArray(pages) ? pages : [pages]
  for (const page of list) {
    const index = getAtlasPageIndex(item, page)
    const hit = index.get(value)
      || index.get(normalizeForMatch(value))
      || index.get(stripDuplicateSuffix(value))
      || index.get(normalizeForMatch(stripDuplicateSuffix(value)))
    if (hit) return hit
    if (/^\d{8,}$/.test(value)) {
      const shortened = value.slice(0, 7)
      const shortHit = index.get(shortened)
      if (shortHit) return shortHit
    }
  }
  return null
}

function getAtlasPageIndex(item, page) {
  const root = item.atlasRoot
  const locale = atlasItemLocale(item)
  const gameFolder = item.gameFolder || item.game
  const key = `${root}|${locale}|${gameFolder}|${page}`
  if (ATLAS_PAGE_INDEX_CACHE.has(key)) return ATLAS_PAGE_INDEX_CACHE.get(key)

  const index = new Map()
  const dir = path.join(root, "data", "items", locale, gameFolder, page)
  const files = listJsonFilesSync(dir)
  for (const file of files) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8"))
      const meta = json.meta || {}
      const list = json.content?.list || {}
      const detail = json.content?.detail || {}
      const name = displayTitle(meta, list, detail, { file })
      const image = resolveImage(root, meta.images || [])
      const record = {
        id: String(meta.recordId || list.id || detail.id || path.basename(file, ".json")),
        name,
        image,
        file,
      }
      for (const alias of [
        record.id,
        name,
        meta.name,
        list.name,
        detail.name,
        path.basename(file, ".json"),
        stripDuplicateSuffix(path.basename(file, ".json")),
      ].filter(Boolean)) {
        index.set(String(alias), record)
        index.set(normalizeForMatch(alias), record)
      }
    } catch {}
  }
  ATLAS_PAGE_INDEX_CACHE.set(key, index)
  return index
}

function listJsonFilesSync(dir) {
  const files = []
  const queue = [dir]
  while (queue.length) {
    const current = queue.pop()
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full)
    }
  }
  return files
}

function atlasItemLocale(item) {
  const relative = path.relative(path.join(item.atlasRoot || "", "data", "items"), item.file || "")
  const [locale] = relative.split(path.sep)
  return locale || "简体中文"
}

function buildEntryAliases(record, page, game) {
  const aliases = new Set([
    record.name,
    record.id,
    stripDuplicateSuffix(record.name),
    path.basename(record.path || "", ".json"),
    stripDuplicateSuffix(path.basename(record.path || "", ".json")),
  ].filter(Boolean).map(String))
  return aliases
}

async function loadAtlasAliasMap() {
  if (ALIAS_CACHE.loaded) return ALIAS_CACHE.map

  const aliases = new Map()
  for (const [canonical, config] of Object.entries(STATIC_QUERY_ALIASES)) {
    addAliasPair(aliases, canonical, config.aliases, config.game)
  }

  for (const file of atlasMiaoAliasFiles()) {
    const exports = await readJsAliasExports(file.path, file.exports)
    for (const name of file.exports) {
      addAliasObject(aliases, exports[name], file.game)
    }
  }

  for (const file of atlasZzzAliasFiles()) {
    addAliasObject(aliases, readYamlAliasObject(file), "绝区零")
  }

  ALIAS_CACHE.loaded = true
  ALIAS_CACHE.map = aliases
  return aliases
}

function atlasMiaoAliasFiles() {
  const files = []
  for (const base of atlasMiaoPluginRoots()) {
    files.push(
      { path: path.join(base, "resources", "meta-gs", "character", "alias.js"), exports: ["alias"], game: "原神" },
      { path: path.join(base, "resources", "meta-gs", "weapon", "alias.js"), exports: ["alias", "abbr"], game: "原神" },
      { path: path.join(base, "resources", "meta-gs", "artifact", "alias.js"), exports: ["alias", "abbr", "setAbbr"], game: "原神" },
      { path: path.join(base, "resources", "meta-sr", "character", "alias.js"), exports: ["alias"], game: "星铁" },
      { path: path.join(base, "resources", "meta-sr", "weapon", "alias.js"), exports: ["alias", "abbr"], game: "星铁" },
      { path: path.join(base, "resources", "meta-sr", "artifact", "alias.js"), exports: ["alias", "abbr", "setAbbr"], game: "星铁" },
    )
  }
  return uniqueExistingFiles(files)
}

function atlasZzzAliasFiles() {
  const files = atlasZzzPluginRoots().map(base => path.join(base, "defSet", "alias.yaml"))
  return uniqueExistingFiles(files)
}

function atlasMiaoPluginRoots() {
  return [
    path.join(process.cwd(), "plugins", "miao-plugin"),
    path.join(process.cwd(), "plugins", "Miao-Plugin"),
    path.join(process.cwd(), "plugins", "miao-plugin-fork"),
    path.join(rootPath, "reference-projects", "mine", "miao-plugin"),
  ]
}

function atlasZzzPluginRoots() {
  return [
    path.join(process.cwd(), "plugins", "ZZZ-Plugin"),
    path.join(process.cwd(), "plugins", "zzz-plugin"),
    path.join(rootPath, "reference-projects", "external", "ZZZ-Plugin"),
  ]
}

function uniqueExistingFiles(files) {
  const seen = new Set()
  const result = []
  for (const item of files) {
    const file = typeof item === "string" ? item : item.path
    const key = path.resolve(file).toLowerCase()
    if (seen.has(key) || !existsSync(file)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

async function readJsAliasExports(file, exportNames = []) {
  try {
    const stat = await fs.stat(file)
    const mod = await import(`${pathToFileURL(file).href}?lotusAlias=${stat.mtimeMs}`)
    const ret = {}
    for (const name of exportNames) ret[name] = mod[name]
    return ret
  } catch {
    return readJsAliasExportsFallback(file, exportNames)
  }
}

function readJsAliasExportsFallback(file, exportNames = []) {
  const source = readFileSync(file, "utf8")
  const ret = {}
  for (const name of exportNames) {
    const literal = extractExportObjectLiteral(source, name)
    if (!literal) continue
    try {
      ret[name] = Function(`"use strict"; return (${literal});`)()
    } catch {
      // Ignore malformed third-party alias snippets; base atlas search still works.
    }
  }
  return ret
}

function extractExportObjectLiteral(source, name) {
  const marker = new RegExp(`export\\s+const\\s+${name}\\s*=`, "u")
  const match = marker.exec(source)
  if (!match) return ""
  const start = source.indexOf("{", match.index + match[0].length)
  if (start < 0) return ""
  return extractBalancedObjectLiteral(source, start)
}

function extractBalancedObjectLiteral(source, start) {
  let depth = 0
  let quote = ""
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = ""
      }
      continue
    }
    if (char === "/" && next === "/") {
      lineComment = true
      index++
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      index++
      continue
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char
      continue
    }
    if (char === "{") depth++
    if (char === "}") {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return ""
}

function readYamlAliasObject(file) {
  try {
    return parseYaml(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function addAliasObject(map, object, game = "") {
  if (!object || typeof object !== "object") return
  for (const [canonical, aliases] of Object.entries(object)) {
    addAliasPair(map, canonical, aliases, game)
  }
}

function addAliasPair(map, canonical, aliases, game = "") {
  const values = Array.isArray(aliases) ? aliases : String(aliases || "").split(/[,，]/)
  for (const alias of values) {
    const aliasText = String(alias || "").trim()
    const canonicalText = String(canonical || "").trim()
    if (!aliasText || !canonicalText || aliasText === canonicalText) continue
    addAliasValue(map, canonicalText, aliasText, game)
    addAliasValue(map, aliasText, canonicalText, game)
  }
}

function addAliasValue(map, key, value, game = "") {
  const normalized = normalizeForMatch(key)
  if (!normalized) return
  const list = map.get(normalized) || []
  if (!list.some(item => item.value === value && item.game === game)) list.push({ value, game })
  map.set(normalized, list)
}

function buildKeywordVariants(keyword, aliases = new Map(), game = "") {
  const text = normalizeKeyword(keyword)
  const values = new Set([text])
  const aliasValues = aliases.get(normalizeForMatch(text)) || []
  for (const item of aliasValues) {
    if (typeof item === "string") {
      values.add(item)
    } else if (!item.game || !game || item.game === game) {
      values.add(item.value)
    }
  }
  if (text.includes("冰封")) values.add(text.replaceAll("冰封", "冰风"))
  return [...values].filter(Boolean).map(value => ({
    raw: value,
    key: normalizeForMatch(value),
    alias: value !== text,
  }))
}

function scoreIndexEntry(entry, variants, originalKeyword) {
  let best = 0
  for (const variant of variants) {
    for (const alias of entry.aliases || []) {
      const text = normalizeForMatch(alias)
      if (!text || !variant.key) continue
      let score = 0
      if (text === variant.key) score += variant.alias ? 155 : 180
      else if (text.startsWith(variant.key)) score += variant.alias ? 70 : 100
      else if (text.includes(variant.key)) score += variant.alias ? 45 : 65
      else if (variant.key.includes(text) && text.length >= 2) score += 45
      if (score) {
        score += PAGE_PRIORITY[entry.page] || 0
        if (entry.imageCount > 0) score += 5
        if (entry.title === originalKeyword) score += 20
        best = Math.max(best, score)
      }
    }
  }
  return best
}

function scoreLoadedItem(item, variants) {
  let score = 0
  const searchable = [
    item.title,
    item.description,
    ...item.facts.map(fact => `${fact.label}${fact.value}`),
    ...item.sections.map(section => `${section.title}${section.body}`),
  ].map(normalizeForMatch)
  for (const variant of variants) {
    if (searchable.some(value => value === variant.key)) score += 80
    else if (searchable.some(value => value.includes(variant.key))) score += 35
  }
  return score
}

function scoreCandidateFile(candidate, keyword) {
  let score = 0
  const base = normalizeForMatch(candidate.base)
  const key = normalizeForMatch(keyword)
  if (base === key) score += 100
  if (base.startsWith(key)) score += 40
  if (base.includes(key)) score += 20
  score -= Math.max(0, candidate.base.length - keyword.length)
  return score
}

function extractFacts(meta, list, detail, item) {
  const facts = []
  addFact(facts, "游戏", item.game)
  addFact(facts, "模块", item.page)
  addFact(facts, "稀有度", item.rarity)
  addFact(facts, "图鉴版本", item.version)
  addFact(facts, "ID", item.id)

  for (const fact of extractStatFacts(item, detail)) {
    addFact(facts, fact.label, fact.value)
  }

  addFact(facts, "类型", valueLabel(detail.weapon_type || detail.weapon_type_name || list.type || detail.type))
  addFact(facts, "属性", valueLabel(detail.element_type || detail.special_element_type?.title || detail.element || list.element))
  addFact(facts, "阵营", valueLabel(detail.camp || detail.partner_info?.camp || list.camp))
  addFact(facts, "命途", valueLabel(detail.base_type || detail.path || list.base_type))
  addFact(facts, "派系", valueLabel(detail.faction || list.faction))
  addFact(facts, "生日", detail.partner_info?.birthday)
  addFact(facts, "起始", formatLooseDate(extractDateRange({ content: { list, detail } }).start))
  addFact(facts, "结束", formatLooseDate(extractDateRange({ content: { list, detail } }).end))

  return facts.slice(0, 10)
}

function extractSections(item, list, detail) {
  const sections = []
  if (item.template === "atlas-challenge") {
    return enrichChallengeSections(sections, { content: { list, detail } })
  }

  if (item.page === "角色") {
    extractCharacterSections(sections, item, detail)
  } else if (["武器", "光锥", "音擎"].includes(item.page)) {
    extractWeaponSections(sections, item, detail, list)
  } else if (["圣遗物", "遗器套装", "驱动盘"].includes(item.page)) {
    extractRelicSections(sections, detail, list)
  } else {
    extractGenericSections(sections, item, list, detail)
  }

  const materialLines = extractMaterials(detail.materials || detail.ascension || detail.level, 8)
  if (materialLines.length) addSection(sections, "培养材料", materialLines.join(" / "))

  return dedupeSections(sections).slice(0, 7)
}

function enrichChallengeSections(sections, raw = {}, challenge = null) {
  const list = raw.content?.list || {}
  const detail = raw.content?.detail
  const date = challenge?.dateRange || extractDateRange(raw)
  addSection(sections, "周期", [
    challenge?.note,
    date.start || date.end ? `${formatLooseDate(date.start) || "?"} - ${formatLooseDate(date.end) || "?"}` : "",
  ].filter(Boolean).join("\n"))

  const environment = extractChallengeEnvironment(detail, list).slice(0, 8)
  if (environment.length) addSection(sections, "环境与关卡增益", environment.map(formatChallengeFact).join("\n"))

  const optionalBuffs = extractChallengeOptionalBuffs(detail).slice(0, 8)
  if (optionalBuffs.length) addSection(sections, "可选增益", optionalBuffs.map(formatChallengeFact).join("\n"))

  const roomLines = extractChallengeRooms(detail).slice(0, 12)
  if (roomLines.length) addSection(sections, "层数与敌人", roomLines.join("\n"))

  const guideLines = extractChallengeGuides(detail).slice(0, 5)
  if (guideLines.length) addSection(sections, "机制提示", guideLines.join("\n"))

  return dedupeSections(sections).slice(0, 7)
}

function extractChallengeRooms(detail) {
  const lines = []
  const pushRoom = (key, room, options = {}) => {
    if (!room || typeof room !== "object") return
    const title = cleanText(room.title || room.name || options.title)
    const level = room.monster_level ? `Lv.${room.monster_level}` : ""
    const first = collectMonsterNames(room.first || room.first_half || room.first_half_monster || options.first).slice(0, 4)
    const second = collectMonsterNames(room.second || room.second_half || room.second_half_monster || options.second).slice(0, 4)
    const monsters = collectMonsterNames(room.monster_list || room.monster_preview_list || room.monsters || room.enemy || room).slice(0, 5)
    const weak = valueLabel(room.monster_weakness)
    const pieces = [key, title, level].filter(Boolean)
    if (first.length || second.length) {
      lines.push(`${pieces.join(" · ")}：上半 ${first.join(" / ") || "未列出"}；下半 ${second.join(" / ") || "未列出"}`)
    } else if (monsters.length) {
      lines.push(`${pieces.join(" · ")}：${monsters.join(" / ")}${weak ? `；弱点 ${weak}` : ""}`)
    } else if (title || level) {
      lines.push(pieces.join(" · "))
    }
  }

  if (Array.isArray(detail)) {
    for (const level of detail.slice(0, 12)) {
      const sides = collectChallengeLevelNameSides(level).slice(0, 3)
      const name = challengeLevelTitle(level, detail)
      const desc = cleanText(level.desc, level.param).replace(/\n/g, " ").slice(0, 120)
      const sideText = sides.length
        ? sides.map(side => `${side.label} ${side.monsters.join(" / ") || "未列出"}`).join("；")
        : "敌人 未列出"
      lines.push(`${name || "关卡"}：${sideText}${desc ? `｜${desc}` : ""}`)
    }
    return [...new Set(lines)].filter(Boolean)
  }

  for (const [floorKey, floor] of Object.entries(detail?.floor || {})) {
    for (const [roomKey, room] of Object.entries(floor?.room || {})) {
      pushRoom(`${floorKey}层${roomKey}间`, room, { title: floor?.name })
    }
  }

  for (const [difficultyKey, value] of Object.entries(detail?.difficulty_config || {})) {
    for (const [key, room] of Object.entries(value?.room || {})) pushRoom(`难度${difficultyKey} 房间${key}`, room)
    for (const [key, room] of Object.entries(value?.hard_room || {})) pushRoom(`难度${difficultyKey} 高难房间${key}`, room)
  }

  for (const value of Object.values(detail?.zone || {})) {
    for (const [key, room] of Object.entries(value?.layer_room || {})) {
      pushRoom(`${value.name || "区域"} ${key}`, room, { title: value.stage_num ? `第${value.stage_num}防线` : "" })
    }
  }

  for (const level of detail?.level || []) {
    const sides = collectChallengeLevelNameSides(level).slice(0, 3)
    const challenge = toArray(level.challenge).map(item => cleanText(item.name, item.param)).filter(Boolean).slice(0, 3).join(" / ")
    const sideText = sides.length
      ? sides.map(side => `${side.label} ${side.monsters.join(" / ") || "首领配置"}`).join("；")
      : "敌人 首领配置"
    lines.push(`${challengeLevelTitle(level, detail.level)}：${sideText}${challenge ? `｜目标 ${challenge}` : ""}`)
  }
  for (const level of toArray(detail?.pre_level)) {
    const monsters = collectMonsterNames(level.event_id_list).slice(0, 6)
    lines.push(`${cleanText(level.name || "骑士试炼")}：${monsters.join(" / ") || "首领配置"}`)
  }
  for (const level of [detail?.boss_level, detail?.boss_config].filter(Boolean)) {
    const monsters = collectMonsterNames(level.event_id_list).slice(0, 6)
    const title = cleanText(level.name || level.hard_name || "星启模式")
    lines.push(`${title}：${monsters.join(" / ") || "首领配置"}`)
  }
  return [...new Set(lines)].filter(Boolean)
}

function collectChallengeLevelNameSides(level) {
  const sides = []
  const push = (label, value) => {
    const monsters = collectMonsterNames(value).slice(0, 6)
    if (monsters.length) sides.push({ label, monsters })
  }
  push("上半", level.event_id_list1 || level.boss_monster_config1 || level.boss_monster_id1 || level.npc_monster_id_list1)
  push("下半", level.event_id_list2 || level.boss_monster_config2 || level.boss_monster_id2 || level.npc_monster_id_list2)
  push("第三路", level.event_id_list3 || level.boss_monster_config3 || level.boss_monster_id3 || level.npc_monster_id_list3)
  push(level.pre_id ? "星启模式" : "敌人", level.event_id_list || level.boss_monster_config || level.boss_monster_id || level.npc_monster_id_list)
  return sides
}

function challengeLevelTitle(level, levels = []) {
  const own = cleanText(level?.name || level?.group_name || "")
  if (!level?.pre_id) return own || "关卡"
  const previous = toArray(levels).find(item => String(item?.id || "") === String(level.pre_id))
  const previousTitle = cleanText(previous?.name || previous?.group_name || "")
  return `${previousTitle || own || "关卡"} · 星启模式`
}

function extractChallengeGuides(detail) {
  const values = []
  const collect = (value) => {
    if (!value) return
    if (typeof value === "string") values.push(cleanText(value))
    else if (Array.isArray(value)) value.forEach(collect)
    else if (typeof value === "object") {
      const params = value.param || value.param_list
      if (value.desc) values.push(cleanText(value.desc, params))
      if (value.answer) values.push(cleanText(value.answer, params))
      if (value.text_guide_list) collect(value.text_guide_list)
      if (value.difficulty_guide_list) collect(value.difficulty_guide_list)
      if (value.phase_list) collect(value.phase_list)
      if (value.tag_list) collect(value.tag_list)
    }
  }
  collect(detail.text_guide_list)
  collect(detail.difficulty_guide_list)
  collect(detail.phase_list)
  for (const level of detail.level || []) {
    collect(level.boss_monster_config1)
    collect(level.boss_monster_config2)
  }
  return [...new Set(values)].filter(Boolean)
}

function extractCharacterSections(sections, item, detail) {
  const statLines = extractStatFacts(item, detail).map(fact => `${fact.label}：${fact.value}`)
  if (statLines.length) addSection(sections, "满级基础数值", statLines.join(" / "))

  const skills = extractSkillLines(item, detail).slice(0, 8)
  if (skills.length) addSection(sections, "技能说明与等级数值", skills.join("\n\n"))

  const constellationLines = extractConstellationLines(item, detail).slice(0, 6)
  if (constellationLines.length) addSection(sections, constellationTitle(item), constellationLines.join("\n"))

  const passiveLines = extractPassiveLines(detail).slice(0, 5)
  if (passiveLines.length) addSection(sections, "天赋与额外能力", passiveLines.join("\n"))

  addSection(sections, "角色说明", firstText([
    detail.partner_info?.profile_desc,
    detail.desc,
    detail.chara_info,
    detail.partner_info?.impression_f,
    detail.partner_info?.impression_m,
  ]))
}

function extractWeaponSections(sections, item, detail, list) {
  const statLines = extractStatFacts(item, detail).map(fact => `${fact.label}：${fact.value}`)
  if (statLines.length) addSection(sections, "满级基础数值", statLines.join(" / "))

  const effectLines = extractWeaponEffectLines(item, detail).slice(0, 6)
  if (effectLines.length) addSection(sections, weaponEffectTitle(item), effectLines.join("\n\n"))

  addSection(sections, "武器说明", firstText([detail.desc, detail.desc2, detail.desc3, list.desc, list.effect]))
  addSection(sections, "故事", firstText([detail.story, detail.background]))
}

function extractRelicSections(sections, detail, list) {
  const affixLines = toArray(detail.affix).map((affix, index) => {
    const need = toArray(detail.need)[index]
    const label = need ? `${need}件套` : `${index + 1}段效果`
    return `${label} ${affix.name || ""}：${cleanText(affix.desc, affix.param_list).replace(/\n/g, " ")}`
  }).filter(Boolean)
  const hsrLines = Object.entries(detail.require_num || {}).map(([need, effect]) =>
    `${need}件套 ${detail.name || ""}：${cleanText(effect.desc, effect.param_list).replace(/\n/g, " ")}`)
  const zzzLines = [
    detail.desc2 ? `2件套 ${detail.name || ""}：${cleanText(detail.desc2).replace(/\n/g, " ")}` : "",
    detail.desc4 ? `4件套 ${detail.name || ""}：${cleanText(detail.desc4).replace(/\n/g, " ")}` : "",
  ].filter(Boolean)
  const suitLines = [...affixLines, ...hsrLines, ...zzzLines]
  if (suitLines.length) addSection(sections, "套装效果", suitLines.join("\n"))

  const parts = Object.values(detail.parts || {})
    .map(part => part?.name)
    .filter(Boolean)
    .slice(0, 5)
  if (parts.length) addSection(sections, "部位", parts.join(" / "))

  if (!suitLines.length) {
    addSection(sections, "套装效果", firstText([
      detail.suit_effect,
      detail.set_effect,
      detail.desc,
      detail.effect,
      list.effect,
      list.desc,
    ]))
  }
  const effectLines = toArray(detail.effects || detail.skill || detail.set || detail.suit)
    .map(item => cleanText(item.desc || item.effect || item.name, item.param || item.param_list))
    .filter(Boolean)
    .slice(0, 6)
  if (effectLines.length) addSection(sections, "效果明细", effectLines.join("\n"))
}

function extractGenericSections(sections, item, list, detail) {
  addSection(sections, "简介", item.description)
  addSection(sections, "效果", firstText([detail.effect, list.effect, detail.desc2, list.desc2]))
  addSection(sections, "专属信息", firstText([
    detail.special_element_type?.desc,
    detail.partner_info?.impression_f,
    detail.partner_info?.impression_m,
  ]))

  const statLines = extractPrimitiveObject(detail.stats || detail.weapon_prop || list.stats, 6)
  if (statLines.length) addSection(sections, "数值", statLines.join(" / "))

  addSection(sections, "故事", firstText([detail.story, detail.background, detail.partner_info?.trust_lv?.["3"]]))
}

function buildItemView(item, list, detail, images) {
  const base = {
    kind: viewKind(item),
    game: item.game,
    page: item.page,
    title: item.title,
    rarity: item.rarity || "未分类",
    version: item.version,
    versionLabel: item.version ? `图鉴版本 ${item.version}` : "",
    image: item.image,
    description: cleanText(item.description),
    meta: buildViewMeta(item, list, detail),
    stats: extractStatFacts(item, detail),
    materials: extractMaterialObjects(item, detail, images),
  }

  if (base.kind === "challenge") {
    const theaterOverview = extractGenshinTheaterOverview(item, list, detail, images)
    return {
      ...base,
      period: item.period || "",
      environment: extractChallengeEnvironment(detail, list, images),
      optionalBuffs: extractChallengeOptionalBuffs(detail, images),
      theaterOverview,
      rooms: theaterOverview ? [] : extractChallengeRoomCards(item, detail, images),
      guides: extractChallengeGuides(detail),
    }
  }

  if (base.kind === "character") {
    const skills = extractSkillCards(item, detail, images)
    return {
      ...base,
      portrait: images.first(["derived.avatarDrawCard", "detail.skin", "detail.partner_info.role_icon", "detail.icon", "icon"]) || item.image,
      skills,
      skillColumns: item.game === "原神" ? [skills] : splitCardsBalanced(skills, 2),
      constellations: extractConstellationCards(item, list, detail, images),
      passives: extractPassiveCards(item, detail, images),
      enhancements: extractEnhancementCards(item, detail, images),
    }
  }

  if (base.kind === "weapon") {
    return {
      ...base,
      refinements: combineVariantCards(extractRefinementCards(item, detail)),
      story: cleanText(detail.story || detail.background),
    }
  }

  if (base.kind === "relic") {
    return {
      ...base,
      effects: extractRelicEffectCards(detail, list),
      parts: extractRelicParts(item, detail, images),
      story: cleanText(detail.story || detail.background),
    }
  }

  if (base.kind === "bangboo") {
    const skills = extractBangbooSkillCards(detail, images)
    return {
      ...base,
      skills,
      skillColumns: splitCardsBalanced(skills, 2),
    }
  }

  return base
}

function viewKind(item) {
  if (item.template === "atlas-challenge") return "challenge"
  if (item.page === "角色") return "character"
  if (item.page === "邦布") return "bangboo"
  if (["武器", "光锥", "音擎"].includes(item.page)) return "weapon"
  if (["圣遗物", "遗器套装", "驱动盘"].includes(item.page)) return "relic"
  return "generic"
}

function splitCardsBalanced(cards, columns = 2) {
  const list = toArray(cards)
  if (list.length <= 1 || columns <= 1) return [list]
  if (columns !== 2) {
    return Array.from({ length: columns }, (_, index) => list.filter((_, itemIndex) => itemIndex % columns === index))
  }

  const weights = list.map(cardWeight)
  const total = weights.reduce((sum, value) => sum + value, 0)
  let bestIndex = 1
  let bestDelta = Infinity
  let left = 0
  for (let index = 1; index < list.length; index++) {
    left += weights[index - 1]
    const delta = Math.abs(total / 2 - left)
    if (delta < bestDelta) {
      bestDelta = delta
      bestIndex = index
    }
  }
  return [list.slice(0, bestIndex), list.slice(bestIndex).filter(Boolean)].filter(column => column.length)
}

function cardWeight(card = {}) {
  return [
    card.title,
    card.type,
    card.desc,
    ...toArray(card.descLines).map(line => `${line.title || ""}${line.text || ""}`),
    ...toArray(card.levelRows).map(row => `${row.level || ""}${row.text || ""}`),
    ...toArray(card.tables).flatMap(table => [
      ...toArray(table.headers),
      ...toArray(table.rows).flatMap(row => [row.label, ...toArray(row.values)]),
    ]),
  ].join("").length || 1
}

function buildViewMeta(item, list, detail) {
  return [
    { label: "游戏", value: item.game },
    { label: "模块", value: item.page },
    { label: "稀有度", value: item.rarity },
    { label: "图鉴版本", value: item.version },
    { label: "ID", value: item.id },
    { label: "类型", value: valueLabel(detail.weapon_type || detail.weapon_type_name || list.type || detail.type) },
    { label: "属性", value: valueLabel(detail.element_type || detail.special_element_type?.title || detail.element || list.element) },
    { label: "阵营", value: valueLabel(detail.camp || detail.partner_info?.camp || list.camp) },
    { label: "命途", value: valueLabel(detail.base_type || detail.path || list.base_type) },
    { label: "生日", value: detail.partner_info?.birthday },
  ].filter(item => item.value)
}

function extractSkillCards(item, detail, images) {
  if (item.game === "原神" && Array.isArray(detail.skills)) return extractGenshinSkillCards(detail.skills, images)
  if (item.game === "星铁" && detail.skills) return extractHsrSkillCards(detail.skills, detail.skill_trees, images)
  if (item.game === "绝区零" && detail.skill) return extractZzzSkillCards(detail.skill, images)
  return []
}

function extractGenshinSkillCards(skills, images) {
  return skills.map((skill, index) => {
    const levels = numericValues(skill.promote)
    return {
      title: skill.name || "技能",
      type: cleanText(skill.type || ""),
      icon: images.first([`detail.skills.${index}.promote.0.icon`, `detail.skills.${index}.icon`]),
      desc: cleanText(skill.desc),
      tables: levels.length ? [buildParamMatrix(
        "等级数值",
        (levels[0]?.desc || []).filter(Boolean),
        levels,
        level => `Lv${level.level}`,
        level => level.param || [],
      )] : [],
    }
  }).filter(card => card.title || card.desc)
}

function extractHsrSkillCards(skills, skillTrees, images) {
  return toArray(skills).map((skill, index) => {
    const levels = numericValues(skill.level)
    const levelRows = compressLevelRows(levels, level => cleanText(skill.desc, level.param_list))
    return {
      title: skill.name || "技能",
      type: skill.type_name || skill.type || "",
      icon: findHsrSkillIcon(skill, skillTrees, index, images),
      desc: cleanText(skill.simple_desc || skill.desc, levels[0]?.param_list || []),
      levelRows,
    }
  }).filter(card => card.title || card.desc)
}

function compressLevelRows(levels, textForLevel) {
  const groups = []
  for (const level of levels || []) {
    const text = String(textForLevel(level) || "")
    if (!text) continue
    const skeleton = text.replace(NUMERIC_TOKEN_RE, "{}")
    let group = groups.find(item => item.skeleton === skeleton)
    if (!group) {
      group = { skeleton, rows: [] }
      groups.push(group)
    }
    group.rows.push({
      level: level.level,
      text,
      tokens: text.match(NUMERIC_TOKEN_RE) || [],
    })
  }
  return groups.flatMap(group => {
    if (group.rows.length <= 1) {
      return group.rows.map(row => ({ level: `Lv${row.level}`, text: row.text }))
    }
    const first = group.rows[0]
    let tokenIndex = 0
    const text = first.text.replace(NUMERIC_TOKEN_RE, () => {
      const values = group.rows.map(row => row.tokens[tokenIndex] || first.tokens[tokenIndex] || "")
      tokenIndex += 1
      return dedupePrimitive(values).join("/")
    })
    const firstLevel = group.rows[0].level
    const lastLevel = group.rows.at(-1).level
    const level = firstLevel === lastLevel
      ? `Lv${firstLevel}`
      : `Lv${firstLevel}-${lastLevel}`
    return [{ level, text }]
  })
}

function findHsrSkillIcon(skill, skillTrees = {}, index = 0, images) {
  const skillId = Number(skill?.id)
  const preferredKey = `point${String(index + 1).padStart(2, "0")}`
  const groups = [
    skillTrees?.[preferredKey],
    ...Object.values(skillTrees || {}),
  ].filter(Boolean)
  for (const group of groups) {
    for (const point of Object.values(group || {})) {
      const ids = toArray(point?.level_up_skill_id).map(Number)
      if (point?.icon && skillId && ids.includes(skillId)) return point.icon
    }
  }
  for (const group of groups) {
    const point = Object.values(group || {}).find(item => item?.icon)
    if (point?.icon) return point.icon
  }
  return images.first([`detail.skill_trees.${preferredKey}.1.icon`, /detail\.skill_trees\.point\d+\.1\.icon/])
}

function extractZzzSkillCards(skillMap, images) {
  return Object.entries(skillMap).map(([key, skill]) => {
    const description = toArray(skill.description)
    const descLines = description
      .filter(item => item?.desc)
      .map(item => ({
        title: item.name || "说明",
        text: cleanText(item.desc),
        parts: richTextParts(item.desc, item.param || item.param_list, images),
      }))
    const paramRows = description
      .flatMap(item => toArray(item?.param))
      .flatMap(item => buildZzzParamRows(item))
      .filter(Boolean)
    return {
      title: skill.name || zzzSkillTitle(key),
      type: zzzSkillTitle(key),
      icon: images.iconMap(zzzSkillIconMapToken(key)),
      iconText: zzzSkillIconText(key),
      descLines,
      tables: paramRows.length ? [{
        title: "等级数值",
        headers: ["项目", ...Array.from({ length: 12 }, (_, index) => `Lv${index + 1}`)],
        rows: paramRows,
      }] : [],
    }
  }).filter(card => card.title || card.descLines?.length || card.tables?.length)
}

function extractBangbooSkillCards(detail, images) {
  return Object.entries(detail.skill || {}).map(([key, skill]) => {
    const levels = numericValues(skill.level)
    const first = levels[0] || {}
    const rows = toArray(first.property).map((property, index) => ({
      label: cleanText(property),
      values: levels.map((level, levelIndex) =>
        resolveBangbooParamValue(level.param, index, Number(level.level || levelIndex + 1), detail.skill_prop)),
    })).filter(row => row.label && row.values.some(Boolean))
    return {
      title: first.name || zzzBangbooSkillTitle(key),
      type: zzzBangbooSkillTitle(key),
      icon: images.iconMap(zzzBangbooSkillIconMapToken(key)),
      iconText: zzzBangbooSkillIconText(key),
      desc: cleanText(first.desc),
      tables: rows.length ? [{
        title: "等级数值",
        headers: ["项目", ...levels.map((level, index) => `Lv${level.level || index + 1}`)],
        rows,
      }] : [],
    }
  }).filter(card => card.title || card.desc || card.tables?.length)
}

function resolveBangbooParamValue(raw, index, level, skillProp = {}) {
  const value = String(raw || "").split("|")[index] || ""
  const match = value.match(/\{Skill:(\d+),\s*Prop:(\d+)}/)
  if (!match) return cleanText(value)
  const prop = skillProp?.[match[1]]?.[match[2]]
  if (!prop) return ""
  return formatZzzValue(Number(prop.main || 0) + Number(prop.growth || 0) * Math.max(0, level - 1), prop.format)
}

function zzzBangbooSkillTitle(key) {
  return {
    a: "主动技",
    b: "额外能力",
    c: "邦布连携技",
  }[key] || cleanText(key || "技能")
}

function zzzBangbooSkillIconMapToken(key) {
  return {
    a: "Icon_Special",
    b: "Icon_CoreSkill",
    c: "Icon_UltimateReady",
  }[key] || ""
}

function zzzBangbooSkillIconText(key) {
  return {
    a: "主",
    b: "额",
    c: "连",
  }[key] || "技"
}

function zzzSkillIconMapToken(key) {
  return {
    basic: "Icon_Normal",
    dodge: "Icon_Evade",
    special: "Icon_Special",
    chain: "Icon_UltimateReady",
    assist: "Icon_Switch",
    core: "Icon_CoreSkill",
  }[key] || ""
}

function zzzSkillTitle(key) {
  return {
    basic: "普通攻击",
    dodge: "闪避",
    special: "特殊技",
    chain: "连携技",
    assist: "支援技",
    core: "核心技",
  }[key] || cleanText(key || "技能")
}

function zzzSkillIconText(key) {
  return {
    basic: "普",
    dodge: "闪",
    special: "特",
    chain: "连",
    assist: "援",
    core: "核",
  }[key] || "技"
}

function buildParamMatrix(title, rows, levels, levelLabel, paramsForLevel) {
  return {
    title,
    headers: ["项目", ...levels.map(levelLabel)],
    rows: rows.map(row => {
      const [label, formula = label] = String(row || "").split("|")
      return {
        label: cleanText(label),
        values: levels.map(level => cleanText(formatGameText(formula, paramsForLevel(level)))),
      }
    }).filter(row => row.label && row.values.some(Boolean)),
  }
}

function buildZzzParamRows(item) {
  const name = cleanText(item?.name)
  return Object.values(item?.param || {}).map((value, index) => {
    const label = Object.values(item?.param || {}).length > 1 ? `${name}${index + 1}` : name
    return {
      label,
      values: Array.from({ length: 12 }, (_, level) => formatZzzValue((value.main ?? value.damage_percentage ?? 0) + (value.growth ?? value.damage_percentage_growth ?? 0) * level, value.format)),
    }
  })
}

function extractConstellationCards(item, list, detail, images) {
  if (item.game === "原神") {
    return toArray(detail.constellations).map((constellation, index) => ({
      level: `${index + 1}命`,
      title: constellation.name || "",
      icon: images.first([`detail.constellations.${index}.icon`]),
      desc: cleanText(constellation.desc, constellation.param_list),
    }))
  }
  if (item.game === "星铁") {
    return toArray(detail.ranks).map((rank, index) => ({
      level: `${index + 1}魂`,
      title: rank.name || "",
      icon: images.first([`detail.ranks.${index + 1}.icon`]),
      desc: cleanText(rank.desc, rank.param_list),
    }))
  }
  if (item.game === "绝区零") {
    return toArray(detail.talent || detail.potential_detail || detail.potential).map((mindscape, index) => ({
      level: `${mindscape.level || index + 1}影`,
      title: mindscape.name || "",
      desc: cleanText(mindscape.desc, mindscape.param || mindscape.param_list),
      hideIcon: true,
    }))
  }
  return []
}

function extractPassiveCards(item, detail, images) {
  if (item.game === "绝区零" && detail.passive?.level) {
    const highest = numericValues(detail.passive.level).at(-1)
    const names = toArray(highest?.name)
    const descs = toArray(highest?.desc)
    return names.map((name, index) => ({
      title: name,
      icon: images.first(["detail.passive", "detail.icon"]),
      desc: cleanText(descs[index] || descs[0]),
    })).filter(card => card.title || card.desc)
  }
  const values = [
    ...toArray(detail.passives),
    ...toArray(detail.passive),
  ]
  return values.map((passive, index) => ({
    title: passive.name || passive.title || passive.skill_name || "被动",
    icon: images.first([`detail.passives.${index}.icon`, `detail.passive.${index}.icon`]),
    desc: cleanText(passive.desc || passive.description || passive.effect, passive.param || passive.param_list),
  })).filter(card => card.title || card.desc)
}

function extractEnhancementCards(item, detail, images) {
  const cards = []
  if (item.game === "原神") {
    for (const trace of toArray(detail.chara_info?.trace_effect || detail.trace_effect)) {
      cards.push({
        title: trace.name || "绘想游迹",
        icon: images.first([`trace_effect`, trace.icon].filter(Boolean)),
        desc: cleanText(trace.desc),
      })
    }
  }
  if (item.game === "星铁") {
    for (const group of Object.values(detail.skill_trees || {})) {
      const point = toArray(group).find(item => item?.point_desc || item?.point_type === 3)
      if (!point?.point_desc) continue
      cards.push({
        title: point.point_name || "行迹能力",
        icon: point.icon || images.first([`detail.skill_trees.${String(point.anchor || "").toLowerCase()}`, point.icon].filter(Boolean)),
        desc: cleanText(point.point_desc, point.param_list),
      })
    }
  }
  if (item.game === "绝区零") {
    const potentials = Object.values(detail.extra_level || {}).map(level => ({
      title: `激发潜能 Lv${level.max_level || ""}`,
      icon: images.first(["detail.icon", "icon"]),
      desc: Object.values(level.extra || {})
        .filter(extra => Number(extra.value) !== 0)
        .map(extra => `${extra.name}+${formatZzzValue(extra.value, extra.format)}`)
        .join(" / "),
    })).filter(card => card.desc)
    cards.push(...potentials)
  }
  return cards.filter(card => card.title || card.desc)
}

function extractRefinementCards(item, detail) {
  if (item.game === "原神" && detail.refinement) {
    return numericValues(detail.refinement).map((refinement, index) => ({
      level: `精${index + 1}`,
      title: refinement.name || "",
      desc: cleanText(refinement.desc, refinement.param_list),
    }))
  }
  if (item.game === "星铁" && detail.refinements) {
    return numericValues(detail.refinements.level).map((level, index) => ({
      level: `叠影${level.level || index + 1}`,
      title: detail.refinements.name || "",
      desc: cleanText(detail.refinements.desc, level.param_list),
    }))
  }
  if (item.game === "绝区零") {
    return numericValues(detail.talents).map((talent, index) => ({
      level: `${index + 1}星`,
      title: talent.name || "",
      desc: cleanText(talent.desc, talent.param || talent.param_list),
    }))
  }
  return []
}

function combineVariantCards(cards) {
  const list = toArray(cards).filter(card => card?.desc || card?.title)
  if (list.length <= 1) return list
  const title = list.find(card => card.title)?.title || ""
  const mergedDesc = compressVariantDescriptions(list)
  if (!mergedDesc) return list
  return [{
    level: list.map(card => card.level).filter(Boolean).join(" / "),
    title,
    desc: mergedDesc,
  }]
}

function compressVariantDescriptions(cards) {
  const first = cards[0]?.desc || ""
  if (!first) return ""
  const valuesByIndex = []
  let pattern = first
  const numberPattern = /[-+]?\d+(?:\.\d+)?%?/g
  const firstNumbers = first.match(numberPattern) || []
  if (!firstNumbers.length) return cards.map(card => `${card.level}：${card.desc}`).join("\n")

  for (let index = 0; index < firstNumbers.length; index++) {
    const column = cards.map(card => (card.desc || "").match(numberPattern)?.[index]).filter(Boolean)
    if (column.length === cards.length && new Set(column).size > 1) valuesByIndex[index] = column
  }
  firstNumbers.forEach((number, index) => {
    const variants = valuesByIndex[index]
    if (!variants) return
    pattern = pattern.replace(number, variants.join("/"))
  })
  return pattern
}

function extractRelicEffectCards(detail, list = {}) {
  const effects = []
  const affixes = toArray(detail.affix)
  if (affixes.length) {
    return affixes.map((affix, index) => ({
      label: toArray(detail.need)[index] ? `${toArray(detail.need)[index]}件套` : `${index + 1}段效果`,
      title: affix.name || "",
      desc: cleanText(affix.desc, affix.param_list),
    }))
  }
  for (const [need, effect] of Object.entries(detail.require_num || {})) {
    effects.push({
      label: `${need}件套`,
      title: detail.name || "",
      desc: cleanText(effect.desc, effect.param_list),
    })
  }
  for (const [need, effect] of Object.entries(list.set || detail.set || {})) {
    effects.push({
      label: `${need}件套`,
      title: detail.name || "",
      desc: cleanText(effect.zh || effect.desc || effect.effect, effect.ParamList || effect.param_list || effect.param),
    })
  }
  if (detail.desc2) effects.push({ label: "2件套", title: detail.name || "", desc: cleanText(detail.desc2) })
  if (detail.desc4) effects.push({ label: "4件套", title: detail.name || "", desc: cleanText(detail.desc4) })
  return dedupeCardList(effects, card => `${card.label}|${card.desc}`)
}

function extractRelicParts(item, detail, images) {
  return Object.entries(detail.parts || {}).map(([key, part]) => ({
    name: part.name || key,
    icon: images.first([`detail.parts.${key}.icon`, key, part.icon]) || relicPartIconName(item, key),
  }))
}

function relicPartIconName(item, key) {
  if (!key) return ""
  if (item.game === "原神") return `UI_RelicIcon_${key}`
  if (item.game === "星铁") return String(key)
  if (item.game === "绝区零") return `Equipment_${key}`
  return String(key)
}

function extractGenshinTheaterOverview(item, list, detail, images) {
  if (item.game !== "原神" || item.page !== "幻想真境剧诗挑战" || !detail?.difficulty_config) return null
  const difficultyEntry = Object.entries(detail.difficulty_config)
    .filter(([, value]) => value?.room && typeof value.room === "object")
    .sort(([a], [b]) => Number(b) - Number(a))[0]
  if (!difficultyEntry) return null

  const [difficultyKey, difficulty] = difficultyEntry
  const avatarConfig = detail.avatar_config || {}
  const date = extractDateRange({ content: { list, detail } })
  const acts = Object.entries(difficulty.room || {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([roomKey, room]) => theaterRoomCard(item, images, roomKey, room, THEATER_ACT_LABELS[Number(roomKey) - 1] || `第${roomKey}幕`))
  const hardActs = Object.entries(difficulty.hard_room || {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([roomKey, room], index) => theaterRoomCard(item, images, roomKey, room, `圣牌${CHINESE_NUMERAL[index + 1] || index + 1}`))
  const bossMonsters = dedupeMiniCards(acts.flatMap(act => act.monsters || [])).slice(0, 10)
  const hardMonsters = dedupeMiniCards(hardActs.flatMap(act => act.monsters || [])).slice(0, 12)

  const openCharacters = theaterAvatarCards(item, avatarConfig.invite_avatar_list || list.invite, images)
  const invitedCharacters = theaterAvatarCards(item, avatarConfig.buff_avatar_list || list.buff, images)
  const elements = theaterElementCards(avatarConfig.element_list || list.element, images)
  const groups = [
    { title: "开幕角色", items: openCharacters },
    { title: "特邀角色", items: invitedCharacters },
    { title: "首领阵容", items: bossMonsters },
    { title: "圣牌挑战", items: hardMonsters },
  ].filter(group => group.items?.length)

  return {
    title: "幻想真境剧诗",
    difficultyKey: String(difficultyKey),
    difficultyLabel: "月谕",
    sourceDifficultyLabel: GENSHIN_THEATER_DIFFICULTY_LABELS[difficultyKey] || `难度${difficultyKey}`,
    version: theaterVersionLabel(item.version),
    month: theaterMonthLabel(date.start),
    period: [formatLooseDate(date.start), formatLooseDate(date.end)].filter(Boolean).join(" - "),
    minLevel: difficulty.minimum_avatar_level ? `最低角色等级 Lv${difficulty.minimum_avatar_level}` : "",
    bossLimit: difficulty.boss_max_room_number ? `首领最大幕次 ${difficulty.boss_max_room_number}` : "",
    elements,
    groups,
    acts,
    hardActs,
  }
}

function theaterRoomCard(item, images, roomKey, room, title) {
  const desc = cleanText(room?.desc).replace(/\n/g, " ")
  const roomTitle = cleanText(room?.title)
  const monsters = collectMonsterCards(room?.monster_preview_list, images, item)
  return {
    title,
    roomKey,
    subtitle: [room?.monster_level ? `Lv${room.monster_level}` : "", roomTitle].filter(Boolean).join(" · "),
    desc,
    monsters: dedupeMiniCards(monsters),
  }
}

function theaterAvatarCards(item, values, images) {
  return toArray(values).map(value => {
    const id = typeof value === "object" ? value.id || value.avatar_id || value.value : value
    if (!id) return null
    const entity = findAtlasEntity(item, "角色", String(id))
    return {
      id: String(id),
      name: entity?.name || `角色 ${id}`,
      icon: entity?.image || images.localAsset([`UI_AvatarIcon_${id}`], "gi"),
      desc: cleanText(value?.desc).replace(/\n/g, " "),
    }
  }).filter(Boolean)
}

function theaterElementCards(values, images) {
  return dedupePrimitive(toArray(values).filter(value => Number(value) > 0)).map(value => {
    const info = GENSHIN_THEATER_ELEMENTS[Number(value)] || {}
    return {
      id: String(value),
      name: info.name || `元素${value}`,
      icon: images.localAsset(info.assets || [], "gi"),
      key: info.key || "",
    }
  })
}

function dedupeMiniCards(cards = []) {
  const seen = new Set()
  return cards.filter(card => {
    const key = `${card.id || ""}|${card.name || ""}|${card.icon || ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return card.name || card.icon
  })
}

function theaterVersionLabel(version) {
  const [major, minor] = String(version || "").split(".")
  return major && minor ? `${major}.${minor}` : String(version || "")
}

function theaterMonthLabel(date) {
  if (!date) return ""
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}`
}

function extractChallengeRoomCards(item, detail, images) {
  if (Array.isArray(detail)) return detail.map(level => ({
    title: challengeLevelTitle(level, detail),
    subtitle: [
      cleanText(level.desc, level.param).replace(/\n/g, " "),
      level.damage_type?.length ? `弱点 ${valueLabel(level.damage_type)}` : "",
    ].filter(Boolean).join(" · "),
    goals: toArray(level.challenge).map(item => cleanText(item.name, item.param)).filter(Boolean),
    sides: collectChallengeLevelCardSides(level, images, item),
  }))

  const cards = []
  for (const [floorKey, floor] of Object.entries(detail?.floor || {})) {
    for (const [roomKey, room] of Object.entries(floor?.room || {})) {
      cards.push({
        title: `${floorKey}-${roomKey}`,
        subtitle: room.level ? `Lv${room.level}` : "",
        goals: toArray(room.cond).map(cond => Array.isArray(cond) ? cond.join("/") : cleanText(cond)),
        sides: [
          { label: "上半", monsters: toArray(room.first).map((monster, index) => monsterCard(monster, images.first([`detail.floor.${floorKey}.room.${roomKey}.first.${index}.icon`]), null, item)) },
          { label: "下半", monsters: toArray(room.second).map((monster, index) => monsterCard(monster, images.first([`detail.floor.${floorKey}.room.${roomKey}.second.${index}.icon`]), null, item)) },
        ],
      })
    }
  }
  for (const [difficultyKey, value] of Object.entries(detail?.difficulty_config || {})) {
    for (const [roomKey, room] of Object.entries({ ...(value.room || {}), ...(value.hard_room || {}) })) {
      const monsters = toArray(room.monster_preview_list)
        .map((monster, index) => monsterCard(monster, images.first([`detail.difficulty_config.${difficultyKey}.room.${roomKey}.monster_preview_list.${index}.icon`, `detail.difficulty_config.${difficultyKey}.hard_room.${roomKey}.monster_preview_list.${index}.icon`, monster.icon]), null, item))
      if (!monsters.length && !room.title && !room.desc) continue
      cards.push({
        title: `难度${difficultyKey} · 房间${roomKey}`,
        subtitle: room.monster_level ? `Lv${room.monster_level}` : "",
        desc: cleanText(room.desc).replace(/\n/g, " "),
        sides: [
          { label: "敌人", monsters },
        ],
      })
    }
  }
  for (const [zoneKey, zone] of Object.entries(detail?.zone || {})) {
    for (const [roomKey, room] of Object.entries(zone.layer_room || {})) {
      cards.push({
        title: zone.name || `区域${zoneKey}`,
        subtitle: [`第${zone.stage_num || "?"}防线`, room.monster_level || zone.monster_level ? `Lv${room.monster_level || zone.monster_level}` : ""].filter(Boolean).join(" · "),
        goals: [zone.s_rank_goal ? `S ${zone.s_rank_goal}` : "", zone.a_rank_goal ? `A ${zone.a_rank_goal}` : "", zone.b_rank_goal ? `B ${zone.b_rank_goal}` : ""].filter(Boolean),
        sides: [
          { label: roomKey, monsters: Object.entries(room.monster_list || {}).map(([id, monster]) => monsterCard(monster, images.first([`detail.zone.${zoneKey}.layer_room.${roomKey}.monster_list.${id}.image`, `detail.zone.${zoneKey}.layer_room.${roomKey}.monster_icon`]), room.monster_weakness, item)) },
        ],
      })
    }
  }
  for (const level of detail?.level || []) {
    const sides = collectChallengeLevelCardSides(level, images, item)
    cards.push({
      title: challengeLevelTitle(level, detail.level),
      subtitle: [
        sides[0]?.monsters?.[0]?.level || "",
        level.damage_type1?.length ? `上半弱点 ${valueLabel(level.damage_type1)}` : "",
        level.damage_type2?.length ? `下半弱点 ${valueLabel(level.damage_type2)}` : "",
        level.damage_type3?.length ? `第三路弱点 ${valueLabel(level.damage_type3)}` : "",
        level.damage_type?.length ? `弱点 ${valueLabel(level.damage_type)}` : "",
      ].filter(Boolean).join(" · "),
      goals: toArray(level.challenge).map(item => cleanText(item.name, item.param)).filter(Boolean),
      sides,
    })
  }
  for (const level of toArray(detail?.pre_level)) {
    const sides = collectChallengeLevelCardSides(level, images, item)
    cards.push({
      title: cleanText(level.name || "骑士试炼"),
      subtitle: level.damage_type?.length ? `弱点 ${valueLabel(level.damage_type)}` : "",
      goals: toArray(level.tag_list).map(tag => cleanText(tag.name, tag.param)).filter(Boolean).slice(0, 3),
      sides,
    })
  }
  for (const level of [detail?.boss_level, detail?.boss_config].filter(Boolean)) {
    const sides = collectChallengeLevelCardSides(level, images, item)
    cards.push({
      title: cleanText(level.name || level.hard_name || "星启模式"),
      subtitle: level.damage_type?.length ? `弱点 ${valueLabel(level.damage_type)}` : "",
      goals: toArray(level.tag_list || level.buff_list).map(tag => cleanText(tag.name, tag.param)).filter(Boolean).slice(0, 3),
      sides,
    })
  }
  return cards
}

function collectChallengeLevelCardSides(level, images, item) {
  const sides = []
  const push = (label, value) => {
    const monsters = collectMonsterCards(value, images, item).slice(0, 8)
    if (monsters.length) sides.push({ label, monsters })
  }
  push("上半", level.event_id_list1 || level.boss_monster_config1 || level.boss_monster_id1 || level.npc_monster_id_list1)
  push("下半", level.event_id_list2 || level.boss_monster_config2 || level.boss_monster_id2 || level.npc_monster_id_list2)
  push("第三路", level.event_id_list3 || level.boss_monster_config3 || level.boss_monster_id3 || level.npc_monster_id_list3)
  push(level.pre_id ? "星启模式" : "敌人", level.event_id_list || level.boss_monster_config || level.boss_monster_id || level.npc_monster_id_list)
  return sides
}

function collectMonsterCards(value, images, item) {
  return collectMonsterRefs(value)
    .map(ref => typeof ref === "object"
      ? monsterCard(ref, images.first([ref.icon, ref.name].filter(Boolean)), null, item)
      : monsterCard({ id: ref }, "", null, item))
    .filter(card => card.name || card.icon)
}

function monsterCard(monster, icon = "", weakness = null, item = null) {
  const indexed = monster?.id ? findAtlasEntity(item, ["敌人", "敌人数值"], normalizeMonsterId(monster.id)) : null
  return {
    id: monster?.id ? normalizeMonsterId(monster.id) : indexed?.id || "",
    name: cleanText(monster?.name || monster?.title || indexed?.name || (monster?.id ? `敌人 ${normalizeMonsterId(monster.id)}` : "敌人")),
    icon: icon || indexed?.image || monsterIconName(monster?.id),
    hp: monster?.hp ? formatInteger(monster.hp) : monster?.stats?.hp ? formatInteger(monster.stats.hp) : "",
    level: monster?.level ? `Lv${monster.level}` : "",
    weakness: valueLabel(weakness || monster?.monster_weakness),
  }
}

function extractMaterialObjects(item, detail, images) {
  const materials = []
  collectMaterials(detail.materials, materials)
  collectMaterials(detail.ascension?.materials || detail.ascension?.mats || detail.ascension, materials)
  collectMaterials(detail.promote?.materials || detail.promote?.mats, materials)
  return mergeMaterials(materials, item, images).slice(0, 24)
}

function collectMaterials(value, target) {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) collectMaterials(item, target)
    return
  }
  if (Array.isArray(value.mats)) {
    for (const material of value.mats) collectMaterials(material, target)
    return
  }
  if (Array.isArray(value.materials)) {
    for (const material of value.materials) collectMaterials(material, target)
    return
  }
  const name = value.name || value.title
  if (name && ("count" in value || "num" in value || "amount" in value || "id" in value)) {
    target.push({
      name,
      id: value.id,
      count: Number(value.count ?? value.num ?? value.amount ?? 0) || "",
      icon: value.icon || "",
    })
    return
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectMaterials(child, target)
  }
}

function mergeMaterials(materials, item, images) {
  const merged = new Map()
  for (const material of materials) {
    if (!material?.name) continue
    const key = `${material.id || ""}|${material.name}`
    const current = merged.get(key) || {
      name: cleanText(material.name),
      id: material.id,
      count: 0,
      icon: "",
    }
    current.count += Number(material.count || 0)
    current.icon ||= resolveMaterialIcon(material, item, images)
    merged.set(key, current)
  }
  return [...merged.values()].map(material => ({
    name: material.name,
    count: material.count ? String(material.count) : "",
    icon: material.icon,
  }))
}

function resolveMaterialIcon(material, item, images) {
  const indexed = findAtlasEntity(item, ["物品", "物品详情"], material.id || material.name)
  if (indexed?.image) return indexed.image
  const gameId = GAME_IDS_BY_LABEL[item.game] || ""
  const names = []
  if (material.icon) names.push(material.icon)
  if (material.id) {
    if (gameId === "gi") names.push(`UI_ItemIcon_${material.id}`)
    if (gameId === "hsr") names.push(`ItemIcon_${material.id}`, `IconItem_${material.id}`, String(material.id))
    if (gameId === "zzz") names.push(`Item_${material.id}`, `Icon_Item_${material.id}`, String(material.id))
  }
  return images.first(names) || names[0] || ""
}

function extractSkillLines(item, detail) {
  if (item.game === "原神" && Array.isArray(detail.skills)) return extractGenshinSkillLines(detail.skills)
  if (item.game === "星铁" && detail.skills) return extractHsrSkillLines(detail.skills)
  if (item.game === "绝区零" && detail.skill) return extractZzzSkillLines(detail.skill)
  return []
}

function extractGenshinSkillLines(skills) {
  return skills.slice(0, 5).map(skill => {
    const levels = pickLevelEntries(skill.promote)
    const [first, last] = levels
    const scaleLines = formatScalingRows(first?.desc || [], first?.param || [], last?.param || [], last?.level || first?.level)
      .slice(0, 5)
    const desc = cleanText(skill.desc).replace(/\n/g, " ").slice(0, 120)
    return [
      `【${skill.name || "技能"}】${first && last ? ` Lv${first.level}->Lv${last.level}` : ""}`,
      scaleLines.join(" / ") || desc,
    ].filter(Boolean).join("\n")
  }).filter(Boolean)
}

function extractHsrSkillLines(skills) {
  return toArray(skills).slice(0, 6).map(skill => {
    const levels = pickLevelEntries(skill.level)
    const [first, last] = levels
    const firstDesc = cleanText(skill.desc, first?.param_list || [])
    const lastDesc = cleanText(skill.desc, last?.param_list || [])
    const header = `【${[skill.type_name, skill.name].filter(Boolean).join(" · ") || "技能"}】`
    if (first && last && firstDesc && lastDesc && firstDesc !== lastDesc) {
      return `${header}\nLv${first.level}：${firstDesc}\nLv${last.level}：${lastDesc}`
    }
    return `${header}\n${firstDesc || cleanText(skill.simple_desc)}`
  }).filter(Boolean)
}

function extractZzzSkillLines(skillMap) {
  return Object.entries(skillMap).slice(0, 5).map(([, skill]) => {
    const description = toArray(skill.description)
    const descLines = description
      .filter(item => item?.desc)
      .slice(0, 2)
      .map(item => `${item.name || "说明"}：${cleanText(item.desc).replace(/\n/g, " ").slice(0, 130)}`)
    const paramLines = description
      .flatMap(item => toArray(item?.param))
      .map(formatZzzSkillParam)
      .filter(Boolean)
      .slice(0, 5)
    return [
      `【${skill.name || descLines[0]?.split("：")[0] || "技能"}】`,
      ...descLines,
      paramLines.length ? `倍率/数值：${paramLines.join(" / ")}` : "",
    ].filter(Boolean).join("\n")
  }).filter(Boolean)
}

function extractConstellationLines(item, detail) {
  if (item.game === "原神") {
    return toArray(detail.constellations).map((constellation, index) =>
      `${index + 1}命 ${constellation.name || ""}：${cleanText(constellation.desc, constellation.param_list).replace(/\n/g, " ")}`)
  }
  if (item.game === "星铁") {
    return toArray(detail.ranks).map((rank, index) =>
      `${index + 1}魂 ${rank.name || ""}：${cleanText(rank.desc, rank.param_list).replace(/\n/g, " ")}`)
  }
  if (item.game === "绝区零") {
    return toArray(detail.talent || detail.potential_detail || detail.potential).map((mindscape, index) =>
      `${index + 1}影 ${mindscape.name || ""}：${cleanText(mindscape.desc, mindscape.param || mindscape.param_list).replace(/\n/g, " ")}`)
  }
  return []
}

function extractPassiveLines(detail) {
  const values = [
    ...toArray(detail.passives),
    ...toArray(detail.skill_trees).filter(item => item?.level_up_skill_id || item?.desc),
    ...toArray(detail.passive),
    ...toArray(detail.talent),
  ]
  return values.map(item => {
    if (!item) return ""
    const name = item.name || item.title || item.skill_name || "能力"
    const desc = cleanText(item.desc || item.description || item.effect, item.param || item.param_list)
    return desc ? `${name}：${desc.replace(/\n/g, " ")}` : cleanText(name)
  }).filter(Boolean)
}

function extractWeaponEffectLines(item, detail) {
  if (item.game === "原神" && detail.refinement) {
    return numericValues(detail.refinement).map((refinement, index) =>
      `精${index + 1} ${refinement.name || ""}：${cleanText(refinement.desc, refinement.param_list).replace(/\n/g, " ")}`)
  }
  if (item.game === "星铁" && detail.refinements) {
    const levels = pickLevelEntries(detail.refinements.level)
    return levels.map(level =>
      `叠影${level.level} ${detail.refinements.name || ""}：${cleanText(detail.refinements.desc, level.param_list).replace(/\n/g, " ")}`)
  }
  if (item.game === "绝区零") {
    const talents = numericValues(detail.talents)
    return talents.map((talent, index) =>
      `${index + 1}星 ${talent.name || ""}：${cleanText(talent.desc, talent.param || talent.param_list).replace(/\n/g, " ")}`)
  }
  return [cleanText(detail.desc2 || detail.effect || detail.desc)].filter(Boolean)
}

function extractStatFacts(item, detail) {
  if (item.page === "角色") return extractCharacterStatFacts(item, detail)
  if (item.page === "邦布") return extractBangbooStatFacts(detail)
  if (["武器", "光锥", "音擎"].includes(item.page)) return extractWeaponStatFacts(item, detail)
  return []
}

function extractCharacterStatFacts(item, detail) {
  if (item.game === "原神") {
    const hp1 = genshinCharacterStat(detail, "hp", 1)
    const hp90 = genshinCharacterStat(detail, "hp", 90)
    const atk1 = genshinCharacterStat(detail, "atk", 1)
    const atk90 = genshinCharacterStat(detail, "atk", 90)
    const def1 = genshinCharacterStat(detail, "def", 1)
    const def90 = genshinCharacterStat(detail, "def", 90)
    return [
      { label: "Lv1生命", value: formatInteger(hp1) },
      { label: "Lv90生命", value: formatInteger(hp90) },
      { label: "Lv1攻击", value: formatInteger(atk1) },
      { label: "Lv90攻击", value: formatInteger(atk90) },
      { label: "Lv1防御", value: formatInteger(def1) },
      { label: "Lv90防御", value: formatInteger(def90) },
      { label: "暴击率", value: genshinCharacterPercent(detail, "crit_rate") },
      { label: "暴击伤害", value: genshinCharacterPercent(detail, "crit_dmg") },
    ].filter(fact => fact.value)
  }
  if (item.game === "星铁") {
    const first = firstNumericValue(detail.stats) || {}
    const last = lastNumericValue(detail.stats) || {}
    const maxLevel = 80
    return [
      { label: "Lv1生命", value: formatInteger(hsrLevelStat(first, "hp", 1)) },
      { label: `Lv${maxLevel}生命`, value: formatInteger(hsrLevelStat(last, "hp", maxLevel)) },
      { label: "Lv1攻击", value: formatInteger(hsrLevelStat(first, "attack", 1)) },
      { label: `Lv${maxLevel}攻击`, value: formatInteger(hsrLevelStat(last, "attack", maxLevel)) },
      { label: "Lv1防御", value: formatInteger(hsrLevelStat(first, "defence", 1)) },
      { label: `Lv${maxLevel}防御`, value: formatInteger(hsrLevelStat(last, "defence", maxLevel)) },
      { label: "速度", value: formatPlainNumber(last.speed_base) },
      { label: "暴击率", value: formatMaybePercent(last.critical_chance) },
      { label: "暴击伤害", value: formatMaybePercent(last.critical_damage) },
    ].filter(fact => fact.value !== "" && fact.value != null)
  }
  if (item.game === "绝区零") {
    const level1 = zzzCharacterLevelStats(detail, 1)
    const maxLevel = zzzCharacterMaxLevel(detail)
    const max = zzzCharacterLevelStats(detail, maxLevel)
    const stat = detail.stats || {}
    return [
      { label: "Lv1生命", value: formatInteger(level1.hp) },
      { label: `Lv${maxLevel}生命`, value: formatInteger(max.hp) },
      { label: "Lv1攻击", value: formatInteger(level1.attack) },
      { label: `Lv${maxLevel}攻击`, value: formatInteger(max.attack) },
      { label: "Lv1防御", value: formatInteger(level1.defence) },
      { label: `Lv${maxLevel}防御`, value: formatInteger(max.defence) },
      { label: "冲击力", value: formatPlainNumber(stat.break_stun) },
      { label: "暴击率", value: formatZzzValue(stat.crit, "%") },
      { label: "暴击伤害", value: formatZzzValue(stat.crit_dmg ?? stat.crit_damage, "%") },
    ].filter(fact => fact.value !== "" && fact.value != null)
  }
  return []
}

function extractBangbooStatFacts(detail) {
  const stat = detail.stats || {}
  return [
    { label: "生命值", value: formatInteger(stat.hp_max) },
    { label: "攻击力", value: formatInteger(stat.attack) },
    { label: "防御力", value: formatInteger(stat.defence) },
    { label: "冲击力", value: formatPlainNumber(stat.break_stun) },
    { label: "异常掌控", value: formatPlainNumber(stat.element_abnormal_power) },
    { label: "暴击率", value: formatZzzValue(stat.crit, "%") },
    { label: "暴击伤害", value: formatZzzValue(stat.crit_dmg ?? stat.crit_damage, "%") },
    { label: "耐久", value: formatPlainNumber(stat.endurance) },
  ].filter(fact => fact.value !== "" && fact.value != null)
}

function extractWeaponStatFacts(item, detail) {
  if (item.game === "原神") {
    return Object.entries(detail.stats_modifier || {})
      .flatMap(([key, stat]) => [
        {
          label: `Lv1${statLabel(key)}`,
          value: formatGenshinWeaponStat(key, genshinWeaponStat(detail, key, 1)),
        },
        {
          label: `Lv90${statLabel(key)}`,
          value: formatGenshinWeaponStat(key, genshinWeaponStat(detail, key, 90)),
        },
      ])
      .filter(fact => fact.value)
      .slice(0, 6)
  }
  if (item.game === "星铁") {
    const first = Array.isArray(detail.stats) ? detail.stats[0] : firstNumericValue(detail.stats)
    const last = Array.isArray(detail.stats) ? detail.stats.at(-1) : lastNumericValue(detail.stats)
    const maxLevel = Number(last?.max_level || 80)
    return [
      { label: "Lv1生命", value: formatInteger(hsrLightconeStat(first, "hp", 1)) },
      { label: `Lv${maxLevel}生命`, value: formatInteger(hsrLightconeStat(last, "hp", maxLevel)) },
      { label: "Lv1攻击", value: formatInteger(hsrLightconeStat(first, "attack", 1)) },
      { label: `Lv${maxLevel}攻击`, value: formatInteger(hsrLightconeStat(last, "attack", maxLevel)) },
      { label: "Lv1防御", value: formatInteger(hsrLightconeStat(first, "defence", 1)) },
      { label: `Lv${maxLevel}防御`, value: formatInteger(hsrLightconeStat(last, "defence", maxLevel)) },
    ].filter(fact => fact.value !== "" && fact.value != null)
  }
  if (item.game === "绝区零") {
    const maxLevel = zzzWeaponMaxLevel(detail)
    const level1 = zzzWeaponLevelStats(detail, 1)
    const max = zzzWeaponLevelStats(detail, maxLevel)
    const baseLabel = valueLabel(detail.base_property?.name) || "基础属性"
    const randLabel = valueLabel(detail.rand_property?.name) || "副属性"
    return [
      { label: `Lv1${baseLabel}`, value: formatInteger(level1.base) },
      { label: `Lv${maxLevel}${baseLabel}`, value: formatInteger(max.base) },
      { label: `Lv1${randLabel}`, value: formatZzzProperty(level1.rand, detail.rand_property?.format) },
      { label: `Lv${maxLevel}${randLabel}`, value: formatZzzProperty(max.rand, detail.rand_property?.format) },
    ].filter(fact => fact.value !== "" && fact.value != null)
  }
  return []
}

function genshinCharacterStat(detail, key, level) {
  const base = {
    hp: detail.base_hp,
    atk: detail.base_atk,
    def: detail.base_def,
  }[key]
  const modifier = detail.stats_modifier?.[key]?.[String(level)]
  return addNumbers(Number(base) * Number(modifier), genshinAscensionBonus(detail.stats_modifier?.ascension, {
    hp: "fight_prop_base_hp",
    atk: "fight_prop_base_attack",
    def: "fight_prop_base_defense",
  }[key], level))
}

function genshinCharacterPercent(detail, key) {
  const base = {
    crit_rate: detail.crit_rate,
    crit_dmg: detail.crit_dmg,
  }[key]
  const bonus = genshinAscensionBonus(detail.stats_modifier?.ascension, {
    crit_rate: "fight_prop_critical",
    crit_dmg: "fight_prop_critical_hurt",
  }[key], 90)
  return formatMaybePercent(addNumbers(base, bonus))
}

function genshinWeaponStat(detail, key, level) {
  const stat = detail.stats_modifier?.[key]
  const value = Number(stat?.base) * Number(stat?.levels?.[String(level)])
  const ascension = key === "atk"
    ? genshinAscensionBonus(detail.ascension, "fight_prop_base_attack", level)
    : 0
  return addNumbers(value, ascension)
}

function formatGenshinWeaponStat(key, value) {
  if (/critical|prop|percent|hurt|mastery|efficiency/i.test(key)) return formatMaybePercent(value)
  return formatInteger(value)
}

function genshinAscensionBonus(value, prop, level = 90) {
  if (!prop) return 0
  const list = numericValues(value)
  if (!list.length) return 0
  const index = level >= 90 ? list.length - 1 : -1
  if (index < 0) return 0
  return Number(list[index]?.[prop] || 0)
}

function hsrLevelStat(stat, key, level) {
  if (!stat) return ""
  return addNumbers(stat[`${key}_base`], Number(stat[`${key}_add`] || 0) * Math.max(0, Number(level) - 1))
}

function hsrLightconeStat(stat, key, level) {
  if (!stat) return ""
  return addNumbers(stat[`base_${key}`], Number(stat[`base_${key}_add`] || 0) * Math.max(0, Number(level) - 1))
}

function zzzCharacterMaxLevel(detail) {
  return Number(lastNumericValue(detail.level)?.level_max || 60)
}

function zzzCharacterLevelStats(detail, level) {
  const stat = detail.stats || {}
  const stage = zzzStageForLevel(detail.level, level)
  const extra = zzzStageForLevel(detail.extra_level, level, "max_level")
  const baseAttackBonus = zzzExtraProperty(extra, 12101)
  return {
    hp: addNumbers(stat.hp_max, Number(stat.hp_growth || 0) / 10000 * Math.max(0, Number(level) - 1), stage.hp_max),
    attack: addNumbers(stat.attack, Number(stat.attack_growth || 0) / 10000 * Math.max(0, Number(level) - 1), stage.attack, baseAttackBonus),
    defence: addNumbers(stat.defence, Number(stat.defence_growth || 0) / 10000 * Math.max(0, Number(level) - 1), stage.defence),
  }
}

function zzzWeaponMaxLevel(detail) {
  const entries = Object.keys(detail.level || {}).map(Number).filter(Number.isFinite)
  return entries.length ? Math.max(...entries) : 60
}

function zzzWeaponLevelStats(detail, level) {
  const baseValue = Number(detail.base_property?.value || 0)
  const randValue = Number(detail.rand_property?.value || 0)
  const levelKey = String(Number(level) <= 1 ? 0 : Number(level))
  const levelEntry = detail.level?.[levelKey] || lastNumericValue(detail.level) || {}
  const starEntry = Number(level) <= 1 ? detail.stars?.["0"] || {} : lastNumericValue(detail.stars) || {}
  return {
    base: baseValue * (1 + Number(levelEntry.rate || 0) / 10000) + baseValue * Number(starEntry.star_rate || 0) / 10000,
    rand: randValue * (1 + Number(starEntry.rand_rate || 0) / 10000),
  }
}

function zzzStageForLevel(value, level, maxKey = "level_max") {
  const list = numericValues(value)
  if (!list.length) return {}
  return list.find(stage => Number(level) <= Number(stage?.[maxKey] || Infinity)) || list.at(-1)
}

function zzzExtraProperty(stage, prop) {
  const extra = stage?.extra || {}
  const entry = extra[String(prop)] || Object.values(extra).find(item => Number(item?.prop) === Number(prop))
  return Number(entry?.value || 0)
}

function extractChallengeEnvironment(detail, list, images = null) {
  const facts = []
  const push = (title, desc, params) => {
    const text = cleanText(desc, params).replace(/\n/g, " ")
    if (text) facts.push({ title: cleanText(title) || "说明", body: text, parts: richTextParts(desc, params, images) })
  }

  if (Array.isArray(detail)) {
    for (const item of detail.slice(0, 6)) push(item.name, item.desc, item.param)
    return dedupeFacts(facts)
  }

  push(detail?.buff?.name || "增益", detail?.buff?.desc, detail?.buff?.param)
  push(detail?.leyline?.name || "地脉异常", detail?.leyline?.desc, detail?.leyline?.param)
  push("", list.desc || list.effect)

  for (const [floor, value] of Object.entries(detail?.floor || {}).slice(-4)) {
    const buffs = toArray(value.buff).map(item => cleanText(item)).filter(Boolean).join(" / ")
    if (buffs) facts.push({ title: `${floor}层`, body: buffs })
    if (value.first_half_buff) facts.push({ title: `${floor}层上半`, body: cleanText(value.first_half_buff), parts: richTextParts(value.first_half_buff, [], images) })
    if (value.second_half_buff) facts.push({ title: `${floor}层下半`, body: cleanText(value.second_half_buff), parts: richTextParts(value.second_half_buff, [], images) })
  }

  for (const zone of Object.values(detail?.zone || {})) {
    for (const buff of Object.values(zone.layer_buff || {})) {
      push(zone.name || "区域增益", buff.title ? `${buff.title}：${buff.desc}` : buff.desc)
    }
  }

  return dedupeFacts(facts)
}

function extractChallengeOptionalBuffs(detail, images = null) {
  const facts = []
  const push = (title, desc, params) => {
    const text = cleanText(desc, params).replace(/\n/g, " ")
    if (text) facts.push({ title: cleanText(title) || "增益", body: text, parts: richTextParts(desc, params, images) })
  }

  for (const item of [
    ...toArray(detail?.buff_list1),
    ...toArray(detail?.buff_list2),
    ...toArray(detail?.buff_list3),
  ]) {
    push(item.name || item.title || "增益", item.desc, item.param || item.param_list)
  }

  for (const zone of Object.values(detail?.zone || {})) {
    for (const buff of Object.values(zone.selectable_buff || {})) {
      push(buff.title || zone.name || "可选增益", buff.desc)
    }
  }

  for (const item of toArray(detail?.avatar_config?.buff_avatar_list)) {
    push(item.name || item.avatar_name || "角色增益", item.desc || item.buff_desc, item.param || item.param_list)
  }

  for (const item of toArray(detail?.shop_config)) {
    push(item.name || item.title || "商店增益", item.desc || item.effect, item.param || item.param_list)
  }

  return dedupeFacts(facts)
}

function dedupeFacts(facts) {
  const seen = new Set()
  return facts
    .filter(fact => fact?.title || fact?.body)
    .filter(fact => {
      const key = `${fact.title}|${fact.body}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function dedupeCardList(cards, keyFn) {
  const seen = new Set()
  return cards.filter(card => {
    const key = keyFn(card)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function formatChallengeFact(fact) {
  if (typeof fact === "string") return fact
  if (!fact) return ""
  if (fact.title && fact.body) return `${fact.title}：${fact.body}`
  return fact.title || fact.body || ""
}

function extractDateRange(raw = {}) {
  const list = raw.content?.list || {}
  const detail = raw.content?.detail || {}
  return {
    start: parseLooseDate(list.begin || list.live_begin || list.open || detail.begin_time || detail.open || detail.open_time),
    end: parseLooseDate(list.end || list.live_end || list.close || detail.end_time || detail.close || detail.close_time),
  }
}

function compareChallengeItems(a, b) {
  const aStart = a.dateRange?.start?.getTime?.() || 0
  const bStart = b.dateRange?.start?.getTime?.() || 0
  if (aStart !== bStart) return bStart - aStart
  const aId = Number(a.id)
  const bId = Number(b.id)
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) return bId - aId
  return b.title.localeCompare(a.title, "zh-Hans-CN")
}

function compareChallengeItemsAscending(a, b) {
  const aStart = a.dateRange?.start?.getTime?.() || 0
  const bStart = b.dateRange?.start?.getTime?.() || 0
  if (aStart !== bStart) return aStart - bStart
  const aId = Number(a.id)
  const bId = Number(b.id)
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) return aId - bId
  return a.title.localeCompare(b.title, "zh-Hans-CN")
}

function findCurrentChallengeIndex(items, date) {
  const time = date.getTime()
  const inRange = items.findIndex(item => {
    const start = item.dateRange?.start?.getTime?.()
    const end = item.dateRange?.end?.getTime?.()
    return Number.isFinite(start) && Number.isFinite(end) && start <= time && time <= end
  })
  return inRange >= 0 ? inRange : 0
}

function extractChallengeQuery(query, now) {
  let text = normalizeShortcutText(query)
  const extractedDate = extractExplicitDate(text)
  if (extractedDate) {
    text = extractedDate.text
  }
  const match = text.match(/^(当期|本期|上期|下期)(深渊|深境螺旋|幻想|幻想真境剧诗|混沌|混沌回忆|忘却|忘却之庭|末日|末日幻影|虚构|虚构叙事|异相|异相仲裁|防卫战|式舆防卫战|危局|危局强袭战|强袭战)$/)
  if (!match) return null
  return {
    period: match[1],
    type: match[2],
    date: extractedDate?.date || (now instanceof Date ? now : new Date(now)),
  }
}

function extractExplicitDate(text) {
  const pattern = /(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})日?/u
  const match = text.match(pattern)
  if (!match) return null
  const date = new Date(`${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}T12:00:00+08:00`)
  return {
    date,
    text: text.replace(pattern, "").trim(),
  }
}

function buildChips(item) {
  return [
    item.game,
    item.page,
    item.rarity,
    item.version ? `图鉴版本 ${item.version}` : "",
  ].filter(Boolean).slice(0, 5)
}

function formatGameText(text, params = []) {
  const list = normalizeParamList(params)
  return String(text || "")
    .replace(/\{param(\d+):([^}]+)}/g, (match, index, format) => {
      const value = list[Number(index) - 1]
      return value == null ? match : formatTemplateParam(value, format)
    })
    .replace(/#(\d+)(?:\[[^\]]+])?(%?)/g, (match, index, percentMark) => {
      const value = list[Number(index) - 1]
      if (value == null) return match
      return percentMark ? formatPercent(value) : formatPlainNumber(value)
    })
}

function formatTemplateParam(value, format = "") {
  const text = String(format).toUpperCase()
  if (text.includes("P")) {
    const fixed = Number(text.match(/F(\d+)/)?.[1] || 1)
    return formatPercent(value, fixed)
  }
  if (text.includes("F")) {
    const fixed = Number(text.match(/F(\d+)/)?.[1] || 0)
    return trimFixed(Number(value), fixed)
  }
  return formatPlainNumber(value)
}

function formatScalingRows(rows, firstParams = [], lastParams = [], lastLevel = "") {
  return toArray(rows).map(row => {
    const [label, formula = label] = String(row || "").split("|")
    if (!cleanText(label)) return ""
    const first = cleanText(formatGameText(formula, firstParams))
    const last = cleanText(formatGameText(formula, lastParams))
    if (!first) return ""
    if (last && last !== first) return `${cleanText(label)}：${first} -> Lv${lastLevel} ${last}`
    return `${cleanText(label)}：${first}`
  }).filter(Boolean)
}

function formatZzzSkillParam(item) {
  const value = Object.values(item?.param || {})[0]
  if (!value) return ""
  const main = formatZzzValue(value.main ?? value.damage_percentage, value.format)
  const growth = formatZzzValue(value.growth ?? value.damage_percentage_growth, value.format)
  if (!main) return ""
  return `${cleanText(item.name)} ${main}${growth ? `（成长 +${growth}）` : ""}`
}

function formatZzzValue(value, format = "") {
  if (value == null || value === "") return ""
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  if (String(format).includes("%")) return `${trimFixed(number / 100, 1)}%`
  return trimFixed(number, 1)
}

function formatZzzProperty(value, format = "") {
  if (value == null || value === "") return ""
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  if (String(format).includes("%")) return `${trimFixed(number / 100, 1)}%`
  return trimFixed(number, 1)
}

function normalizeParamList(params) {
  if (params == null) return []
  if (Array.isArray(params)) return params
  if (typeof params === "object") {
    if (Array.isArray(params.param_list)) return params.param_list
    if (Array.isArray(params.param)) return params.param
  }
  return [params]
}

function pickLevelEntries(levels) {
  const values = numericValues(levels)
  if (!values.length) return []
  if (values.length === 1) return [values[0], values[0]]
  return [values[0], values.at(-1)]
}

function pickFirstLast(values) {
  const list = toArray(values).filter(Boolean)
  if (!list.length) return []
  if (list.length === 1) return [list[0]]
  return [list[0], list.at(-1)]
}

function numericValues(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value !== "object") return []
  return Object.entries(value)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, item]) => item)
    .filter(Boolean)
}

function firstNumericValue(value) {
  return numericValues(value)[0]
}

function lastNumericValue(value) {
  return numericValues(value).at(-1)
}

function toArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === "object") return Object.values(value)
  return [value]
}

function collectMonsterNames(value, state = { names: [] }) {
  if (!value || state.names.length >= 12) return state.names
  if (Array.isArray(value)) {
    for (const item of value) collectMonsterNames(item, state)
    return state.names
  }
  if (typeof value !== "object") return state.names
  if (value.name && !state.names.includes(cleanText(value.name))) state.names.push(cleanText(value.name))
  let followedKnownKey = false
  for (const key of [
    "monster_list",
    "monster_preview_list",
    "monsters",
    "enemy",
    "first",
    "second",
    "event_id_list1",
    "event_id_list2",
    "event_id_list3",
    "event_id_list",
    "boss_monster_config1",
    "boss_monster_config2",
    "boss_monster_config3",
    "boss_monster_config",
    "boss_config",
    "pre_level",
    "boss_level",
    "tag_list",
  ]) {
    if (value[key]) {
      followedKnownKey = true
      collectMonsterNames(value[key], state)
    }
  }
  if (!followedKnownKey && !value.name) {
    for (const item of Object.values(value)) collectMonsterNames(item, state)
  }
  return state.names
}

function collectMonsterRefs(value, state = { refs: [], seen: new Set() }, pathText = "") {
  if (!value || state.refs.length >= 30) return state.refs
  if (Array.isArray(value)) {
    for (const item of value) collectMonsterRefs(item, state, pathText)
    return state.refs
  }
  if (typeof value === "number" || typeof value === "string" && /^\d{5,}$/.test(value)) {
    if (isMonsterIdPath(pathText)) pushMonsterRef(state, normalizeMonsterId(value))
    return state.refs
  }
  if (typeof value !== "object") return state.refs
  if (value.name || value.title) {
    const ref = {
      id: value.id || value.monster_id || value.monster_template_id,
      name: cleanText(value.name || value.title),
      icon: value.icon || value.image || value.image_path || "",
      hp: value.hp,
      stats: value.stats,
      level: value.level || value.monster_level,
      monster_weakness: value.monster_weakness,
    }
    pushMonsterRef(state, ref)
  }
  for (const [key, child] of Object.entries(value)) {
    collectMonsterRefs(child, state, `${pathText}.${key}`)
  }
  return state.refs
}

function isMonsterIdPath(pathText = "") {
  const key = String(pathText).split(".").filter(Boolean).at(-1) || ""
  return /^monster\d+$/i.test(key)
    || /^boss_monster_id\d*$/i.test(key)
    || /^npc_monster_id(?:_list)?\d*$/i.test(key)
    || /^monster_(?:id|template_id)$/i.test(key)
}

function pushMonsterRef(state, ref) {
  const key = typeof ref === "object" ? `${ref.id || ""}|${ref.name || ""}` : String(ref)
  if (!key || state.seen.has(key)) return
  state.seen.add(key)
  state.refs.push(ref)
}

function dedupePrimitive(values = []) {
  return [...new Set(values.map(value => String(value || "")).filter(Boolean))]
}

function normalizeMonsterId(value) {
  const text = String(value || "").replace(/\D/g, "")
  if (text.length >= 9) return text.slice(0, 7)
  return text
}

function monsterIconName(id) {
  const normalized = normalizeMonsterId(id)
  return normalized ? `Monster_${normalized}` : ""
}

function multiplyStat(base, modifier, key = "") {
  const value = Number(base) * Number(modifier)
  if (!Number.isFinite(value) || value === 0) return ""
  if (key.includes("critical") || key.includes("prop")) return formatMaybePercent(value)
  return formatInteger(value)
}

function statLabel(key) {
  const labels = {
    atk: "基础攻击力",
    hp: "生命值",
    def: "防御力",
    fight_prop_attack_percent: "攻击力",
    fight_prop_defense_percent: "防御力",
    fight_prop_hp_percent: "生命值",
    fight_prop_critical: "暴击率",
    fight_prop_critical_hurt: "暴击伤害",
    fight_prop_element_mastery: "元素精通",
    fight_prop_charge_efficiency: "元素充能效率",
    fight_prop_physical_add_hurt: "物理伤害加成",
  }
  return labels[key] || key
}

function formatMaybePercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return value == null ? "" : String(value)
  if (number > 0 && number <= 1.5) return formatPercent(number)
  return trimFixed(number, 1)
}

function formatPercent(value, fixed = 1) {
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return `${trimFixed(number * 100, fixed)}%`
}

function formatPlainNumber(value) {
  if (value == null || value === "") return ""
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return trimFixed(number, Math.abs(number) < 10 && !Number.isInteger(number) ? 1 : 0)
}

function formatInteger(value) {
  if (value == null || value === "") return ""
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return Math.round(number).toLocaleString("zh-Hans-CN")
}

function trimFixed(value, fixed = 1) {
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return number.toFixed(fixed).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")
}

function addNumbers(...values) {
  let sum = 0
  let seen = false
  for (const value of values) {
    const number = Number(value)
    if (!Number.isFinite(number)) continue
    sum += number
    seen = true
  }
  return seen ? sum : ""
}

function constellationTitle(item) {
  if (item.game === "原神") return "命座效果"
  if (item.game === "星铁") return "星魂效果"
  if (item.game === "绝区零") return "影画效果"
  return "突破效果"
}

function weaponEffectTitle(item) {
  if (item.game === "星铁") return "光锥特效与叠影"
  if (item.game === "绝区零") return "音擎特效与星级"
  return "武器特效与精炼"
}

function addFact(facts, label, value) {
  const text = cleanText(valueLabel(value))
  if (!text || facts.some(item => item.label === label)) return
  facts.push({ label, value: text.slice(0, 80) })
}

function addSection(sections, title, body) {
  const text = cleanText(body)
  if (!text) return
  sections.push({
    title,
    body: text.slice(0, 1500),
  })
}

function dedupeSections(sections) {
  const seen = new Set()
  return sections.filter(section => {
    const key = `${section.title}|${section.body}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function firstText(values) {
  for (const value of values) {
    const text = cleanText(value)
    if (text) return text.slice(0, 420)
  }
  return ""
}

function cleanText(value, params = []) {
  if (value == null) return ""
  if (Array.isArray(value)) return value.map(item => cleanText(item, params)).filter(Boolean).join("\n")
  if (typeof value === "object") {
    const objectParams = value.param || value.param_list || params
    if (value.name && value.desc) return `${value.name}：${cleanText(value.desc, objectParams)}`
    if (value.desc) return cleanText(value.desc, objectParams)
    if (value.name) return cleanText(value.name)
    return ""
  }
  return localizeInlineText(formatGameText(String(value), params)
    .replace(/<color=[^>]+>/gi, "")
    .replace(/<\/?color>/gi, "")
    .replace(/<\/?(?:unbreak|u|i|b)>/gi, "")
    .replace(/<IconMap:([^>]+)>/g, (_, token) => iconMapLabel(token))
    .replace(/\{Skill:[^}]+}/g, "")
    .replace(/\{param\d+:[^}]+}/g, "数值")
    .replace(/#\d+(?:\[[^\]]+])?%?/g, "数值")
    .replace(/\/?\s*\(test\)/gi, "")
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " "))
    .trim()
}

function richTextParts(value, params = [], images = null) {
  if (value == null) return []
  const raw = formatGameText(String(value), params)
  const parts = []
  let lastIndex = 0
  for (const match of raw.matchAll(/<IconMap:([^>]+)>/g)) {
    const index = match.index ?? 0
    pushRichText(parts, raw.slice(lastIndex, index))
    const token = String(match[1] || "").trim()
    const label = iconMapLabel(token)
    parts.push({
      type: "icon",
      label,
      icon: images?.iconMap?.(token) || "",
    })
    lastIndex = index + match[0].length
  }
  pushRichText(parts, raw.slice(lastIndex))
  return parts.filter(part => part.icon || part.text || part.label)
}

function pushRichText(parts, value) {
  const text = cleanText(value)
  if (text) parts.push({ type: "text", text })
}

function iconMapLabel(token = "") {
  const key = String(token || "").trim()
  return ZZZ_ICON_MAP_LABELS[key] || key.replace(/^Icon_/, "").replace(/_/g, " ")
}

function localizeInlineText(text) {
  return String(text || "")
    .replace(/\bIcon_[A-Za-z0-9_]+\b/g, match => iconMapLabel(match))
    .replace(/While the active character is protected by a Shield, when they deal DMG to opponents, their attacks will unleash a shockwave at the opponent's position that deals True DMG\. This can trigger once every 3s\./g, "当前场上角色处于护盾庇护下时，攻击命中敌人会在敌人位置释放冲击波，造成真实伤害。该效果每3秒至多触发一次。")
    .replace(/When an off-field character triggers Cryo-related reactions to opponents, a shockwave will be released at the opponent's position, dealing True DMG\. This effect can be triggered once every 3\.5s\./g, "后台角色对敌人触发冰元素相关反应时，将在敌人位置释放冲击波，造成真实伤害。该效果每3.5秒至多触发一次。")
    .replace(/When the active character deals Cryo DMG to opponents with Charged Attacks, their attacks will unleash a shockwave at the opponent's position that deals True DMG\. This can trigger once every 3s\./g, "当前场上角色通过重击对敌人造成冰元素伤害时，攻击会在敌人位置释放冲击波，造成真实伤害。该效果每3秒至多触发一次。")
    .replace(/\bAnemo\b/g, "风元素")
    .replace(/\bPyro\b/g, "火元素")
    .replace(/\bHydro\b/g, "水元素")
    .replace(/\bElectro\b/g, "雷元素")
    .replace(/\bCryo\b/g, "冰元素")
    .replace(/\bGeo\b/g, "岩元素")
    .replace(/\bDendro\b/g, "草元素")
    .replace(/\bPhysical\b/g, "物理")
    .replace(/\bFire\b/g, "火")
    .replace(/\bIce\b/g, "冰")
    .replace(/\bThunder\b/g, "雷")
    .replace(/\bLightning\b/g, "雷")
    .replace(/\bWind\b/g, "风")
    .replace(/\bQuantum\b/g, "量子")
    .replace(/\bImaginary\b/g, "虚数")
    .replace(/\bEther\b/g, "以太")
    .replace(/\bElectric\b/g, "电")
    .replace(/\bElectricity\b/g, "电")
    .replace(/When the active character triggers Swirl on an opponent, a shockwave will be unleashed at the opponent's position, dealing True DMG\. This effect can be triggered once every 2s\./g, "当前场上角色对敌人触发扩散反应时，将在敌人位置释放冲击波，造成真实伤害。该效果每2秒至多触发一次。")
}

function valueLabel(value) {
  if (value == null || value === "") return ""
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return localizeInlineText(String(value))
  if (Array.isArray(value)) return value.map(valueLabel).filter(Boolean).slice(0, 5).join(" / ")
  if (typeof value === "object") {
    if (value.name) return value.name
    if (value.title) return value.title
    const values = Object.values(value).map(valueLabel).filter(Boolean)
    return values.slice(0, 4).join(" / ")
  }
  return ""
}

function stripImageExt(value = "") {
  return String(value).replace(/\.(png|webp|jpg|jpeg|avif)$/i, "")
}

function extractPrimitiveObject(value, max) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  return Object.entries(value)
    .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))
    .slice(0, max)
    .map(([key, item]) => `${key}: ${item}`)
}

function extractMaterials(value, max) {
  if (!value || typeof value !== "object") return []
  const lines = []
  const pushMaterial = (item) => {
    if (!item || typeof item !== "object") return false
    const name = item.name || item.title
    const count = item.count ?? item.num ?? item.amount
    if (!name) return false
    lines.push(`${name}${count != null ? ` x ${count}` : ""}`)
    return true
  }
  const visit = (node, prefix = "") => {
    if (lines.length >= max || !node || typeof node !== "object") return
    if (pushMaterial(node)) return
    if (Array.isArray(node)) {
      for (const item of node) {
        if (lines.length >= max) return
        if (!pushMaterial(item)) visit(item, prefix)
      }
      return
    }
    for (const [key, item] of Object.entries(node)) {
      if (lines.length >= max) return
      if (["string", "number"].includes(typeof item)) lines.push(`${prefix}${key}: ${item}`)
      else if (item && typeof item === "object") visit(item, `${key}/`)
    }
  }
  visit(value)
  return lines
}

function parseAtlasQuery(query) {
  return {
    keyword: normalizeKeyword(query),
  }
}

function normalizeKeyword(value) {
  return stripAtlasMessagePrefix(value)
    .replace(/^#?(Lotus|lotus|荷花)?图鉴/i, "")
    .replace(/^[#*%％]/, "")
    .trim()
}

function normalizeShortcutText(value) {
  return normalizeKeyword(value)
    .replace(/\s+/g, "")
    .trim()
}

function stripAtlasMessagePrefix(value) {
  return String(value || "")
    .trim()
    .replace(/^\s*[\[【](?:Lotus|荷花插件?|荷花)[\]】]\s*/i, "")
}

function normalizeForMatch(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[·・]/g, "")
    .replace(/[「」『』"'“”‘’【】[\]()（）]/g, "")
    .toLowerCase()
}

function stripDuplicateSuffix(value = "") {
  return String(value).replace(/__\d+$/, "")
}

function formatLooseDate(value) {
  if (!value) return ""
  return formatDate(value)
}

function parseLooseDate(value) {
  if (!value) return null
  const text = String(value).trim()
  if (!text) return null
  const normalized = text.includes("T") ? text : text.replace(" ", "T")
  const date = new Date(normalized.includes("+") || normalized.endsWith("Z") ? normalized : `${normalized}+08:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function failureMessage(searchResult) {
  if (searchResult.reason === "atlas_data_missing") {
    return "图鉴数据未初始化，请先准备 nanoka-atlas-backend 输出目录，并在配置里设置 atlas.data_root。"
  }
  return "没有找到匹配条目。"
}

function atlasMessage(searchResult, main) {
  const challenge = searchResult.challenge
  const desc = main?.description || ""
  if (challenge && desc) return `${challenge.note}\n${desc}`
  if (challenge) return `${challenge.note}\n已按「${challenge.label}」选择本地图鉴周期条目。`
  if (main) return desc || `已载入「${main.title}」图鉴数据。`
  return desc || failureMessage(searchResult)
}

async function countJsonFiles(root, fsImpl) {
  let count = 0
  const queue = [root]
  while (queue.length) {
    const dir = queue.shift()
    const entries = await fsImpl.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile() && entry.name.endsWith(".json")) count++
    }
  }
  return count
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function resolveAtlasRoot(value = "data/atlas") {
  const text = String(value || "data/atlas")
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(rootPath, text)
}

async function exists(file, fsImpl) {
  try {
    await fsImpl.access(file)
    return true
  } catch {
    return false
  }
}

async function safeStat(file, fsImpl) {
  try {
    return await fsImpl.stat(file)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function compareModules(a, b) {
  return a.game.localeCompare(b.game, "zh-Hans-CN")
    || a.page.localeCompare(b.page, "zh-Hans-CN")
}

function looksLikeNonAtlasCommand(text) {
  return /^(扫码登录|米哈游登录|锅巴登录|登录|刷新cookie|绑定设备|体力|全部体力|多体力|更新抽卡记录|更新面板|帮助|菜单|签到|注册自动签到|远程|spawn|上传|下载|测试)/i.test(text)
    || /(?:面板|面版)[\s\S]*[换变改]/.test(normalizeShortcutText(text))
}

const CHALLENGE_TARGETS = Object.freeze({
  深渊: {
    label: "深境螺旋",
    search: "深境螺旋",
    game: "原神",
    pages: ["深境螺旋"],
    schedule: CHALLENGE_SCHEDULES.genshinAbyss,
  },
  深境螺旋: {
    label: "深境螺旋",
    search: "深境螺旋",
    game: "原神",
    pages: ["深境螺旋"],
    schedule: CHALLENGE_SCHEDULES.genshinAbyss,
  },
  幻想: {
    label: "幻想真境剧诗",
    search: "幻想真境剧诗",
    game: "原神",
    pages: ["幻想真境剧诗挑战"],
    schedule: CHALLENGE_SCHEDULES.genshinTheater,
  },
  幻想真境剧诗: {
    label: "幻想真境剧诗",
    search: "幻想真境剧诗",
    game: "原神",
    pages: ["幻想真境剧诗挑战"],
    schedule: CHALLENGE_SCHEDULES.genshinTheater,
  },
  剧诗: {
    label: "幻想真境剧诗",
    search: "幻想真境剧诗",
    game: "原神",
    pages: ["幻想真境剧诗挑战"],
    schedule: CHALLENGE_SCHEDULES.genshinTheater,
  },
  混沌: {
    label: "混沌回忆",
    search: "混沌回忆",
    game: "星铁",
    pages: ["混沌回忆"],
    schedule: CHALLENGE_SCHEDULES.hsrChaos,
  },
  混沌回忆: {
    label: "混沌回忆",
    search: "混沌回忆",
    game: "星铁",
    pages: ["混沌回忆"],
    schedule: CHALLENGE_SCHEDULES.hsrChaos,
  },
  忘却: {
    label: "混沌回忆",
    search: "混沌回忆",
    game: "星铁",
    pages: ["混沌回忆"],
    schedule: CHALLENGE_SCHEDULES.hsrChaos,
  },
  忘却之庭: {
    label: "混沌回忆",
    search: "混沌回忆",
    game: "星铁",
    pages: ["混沌回忆"],
    schedule: CHALLENGE_SCHEDULES.hsrChaos,
  },
  虚构: {
    label: "虚构叙事",
    search: "虚构叙事",
    game: "星铁",
    pages: ["虚构叙事", "叙事挑战"],
    schedule: CHALLENGE_SCHEDULES.hsrFiction,
  },
  虚构叙事: {
    label: "虚构叙事",
    search: "虚构叙事",
    game: "星铁",
    pages: ["虚构叙事", "叙事挑战"],
    schedule: CHALLENGE_SCHEDULES.hsrFiction,
  },
  末日: {
    label: "末日幻影",
    search: "末日幻影",
    game: "星铁",
    pages: ["末日幻影"],
    schedule: CHALLENGE_SCHEDULES.hsrApocalypse,
  },
  末日幻影: {
    label: "末日幻影",
    search: "末日幻影",
    game: "星铁",
    pages: ["末日幻影"],
    schedule: CHALLENGE_SCHEDULES.hsrApocalypse,
  },
  异相: {
    label: "异相仲裁",
    search: "异相仲裁",
    game: "星铁",
    pages: ["异相仲裁", "虚构叙事"],
    schedule: CHALLENGE_SCHEDULES.hsrArbitration,
  },
  异相仲裁: {
    label: "异相仲裁",
    search: "异相仲裁",
    game: "星铁",
    pages: ["异相仲裁", "虚构叙事"],
    schedule: CHALLENGE_SCHEDULES.hsrArbitration,
  },
  防卫战: {
    label: "式舆防卫战",
    search: "式舆防卫战",
    game: "绝区零",
    pages: ["式舆防卫战"],
    schedule: CHALLENGE_SCHEDULES.zzzShiyu,
  },
  式舆防卫战: {
    label: "式舆防卫战",
    search: "式舆防卫战",
    game: "绝区零",
    pages: ["式舆防卫战"],
    schedule: CHALLENGE_SCHEDULES.zzzShiyu,
  },
  危局: {
    label: "危局强袭战",
    search: "危局强袭战",
    game: "绝区零",
    pages: ["危局强袭战"],
    schedule: CHALLENGE_SCHEDULES.zzzAssault,
  },
  危局强袭战: {
    label: "危局强袭战",
    search: "危局强袭战",
    game: "绝区零",
    pages: ["危局强袭战"],
    schedule: CHALLENGE_SCHEDULES.zzzAssault,
  },
  强袭战: {
    label: "危局强袭战",
    search: "危局强袭战",
    game: "绝区零",
    pages: ["危局强袭战"],
    schedule: CHALLENGE_SCHEDULES.zzzAssault,
  },
})
