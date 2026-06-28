import { importRuntimeModule, getRoleUid, pickRole } from "../pluginBridge/common.js"

const TEAM_ENDPOINT = "https://api.lelaer.com/ys/getTeamResult.php"
const REQUEST_HEADERS = Object.freeze({
  referer: "https://servicewechat.com/wx2ac9dce11213c3a8/192/page-frame.html",
  "user-agent": "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 MicroMessenger/8.0 MiniProgramEnv/android",
})

const ATTR_LABELS = Object.freeze({
  def: "防御力",
  defPlus: "防御力",
  hpPlus: "生命值",
  hp: "生命值",
  atkPlus: "攻击力",
  atk: "攻击力",
  recharge: "元素充能效率",
  mastery: "元素精通",
  cpct: "暴击率",
  cdmg: "暴击伤害",
  heal: "治疗加成",
  pyro: "火",
  hydro: "水",
  cryo: "冰",
  electro: "雷",
  anemo: "风",
  geo: "岩",
  phy: "物理",
  dendro: "草",
})

const DAMAGE_KEYS = Object.freeze({
  fire_dmg: "pyro",
  water_dmg: "hydro",
  ice_dmg: "cryo",
  thunder_dmg: "electro",
  wind_dmg: "anemo",
  rock_dmg: "geo",
  grass_dmg: "dendro",
})

const POSITION_NAMES = ["生之花", "死之羽", "时之沙", "空之杯", "理之冠"]

// Team shortcuts and the mini-program API contract are adapted from AFanSKyQs/FanSky_Qs (Apache-2.0).
const DEFAULT_TEAM_ALIASES = Object.freeze({
  雷九: { alias: ["雷九万班"], chars: ["雷电将军", "九条裟罗", "枫原万叶", "班尼特"] },
  雷国: { alias: ["雷神国家队"], chars: ["雷电将军", "班尼特", "香菱", "行秋"] },
  雷万香班: ["雷电将军", "枫原万叶", "香菱", "班尼特"],
  魈琴钟阿: ["魈", "琴", "钟离", "阿贝多"],
  魈钟班砂: ["魈", "钟离", "班尼特", "砂糖"],
  魈钟班法: ["魈", "钟离", "班尼特", "珐露珊"],
  万达国际: ["枫原万叶", "达达利亚", "班尼特", "香菱"],
  一斗纯岩: ["荒泷一斗", "五郎", "钟离", "阿贝多"],
  魔王武装: ["达达利亚", "行秋", "北斗", "菲谢尔"],
  胡行夜钟: { alias: ["胡夜行钟"], chars: ["胡桃", "行秋", "夜兰", "钟离"] },
  胡行钟阿: { alias: ["胡行阿钟"], chars: ["胡桃", "行秋", "钟离", "阿贝多"] },
  胡行钟砂: ["胡桃", "行秋", "钟离", "砂糖"],
  胡行钟香: ["胡桃", "行秋", "钟离", "香菱"],
  胡桃种门: { alias: ["胡草行久", "草行久胡"], chars: ["草神", "行秋", "久岐忍", "胡桃"] },
  雷达国际: ["雷电将军", "达达利亚", "班尼特", "香菱"],
  心海武装: ["珊瑚宫心海", "行秋", "枫原万叶", "八重神子"],
  神鹤万心: { alias: ["神鹤"], chars: ["神里绫华", "申鹤", "枫原万叶", "珊瑚宫心海"] },
  神甘万心: { alias: ["神甘"], chars: ["神里绫华", "甘雨", "枫原万叶", "珊瑚宫心海"] },
  神罗万心: { alias: ["神罗"], chars: ["神里绫华", "罗莎莉亚", "枫原万叶", "珊瑚宫心海"] },
  神行万猫: ["神里绫华", "行秋", "枫原万叶", "迪奥娜"],
  神行温猫: ["神里绫华", "行秋", "温迪", "迪奥娜"],
  神莫万猫: { alias: ["神猫万莫", "神莫万娜", "神娜万莫"], chars: ["神里绫华", "莫娜", "枫原万叶", "迪奥娜"] },
  神莫温娜: { alias: ["神娜温莫", "神莫温猫", "神猫温莫"], chars: ["神里绫华", "莫娜", "温迪", "迪奥娜"] },
  莫甘温娜: ["莫娜", "甘雨", "温迪", "迪奥娜"],
  万雷国队: ["枫原万叶", "班尼特", "雷电将军", "香菱"],
  融甘: ["甘雨", "香菱", "班尼特", "钟离"],
  可莉三火: ["可莉", "香菱", "班尼特", "枫原万叶"],
  凌人国际: ["神里绫人", "枫原万叶", "香菱", "班尼特"],
  草国: { alias: ["草行久", "草神国家队", "草行久菲"], chars: ["草神", "行秋", "久岐忍", "菲谢尔"] },
  夜宵钟云: { alias: ["宵夜钟云"], chars: ["夜兰", "宵宫", "钟离", "云堇"] },
  烟花武装: ["宵宫", "行秋", "北斗", "班尼特"],
  宵行云班: ["宵宫", "行秋", "云堇", "班尼特"],
  妮绽放: { alias: ["妮露绽放"], chars: ["妮露", "珊瑚宫心海", "草神", "瑶瑶"] },
  玉皇妲帝: { alias: ["刻钟皇草"], chars: ["刻晴", "菲谢尔", "草神", "钟离"] },
  砂糖武装: ["砂糖", "行秋", "北斗", "菲谢尔"],
  砂糖国家队: ["砂糖", "香菱", "行秋", "班尼特"],
})

export class GenshinTeamDamageService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.loadMiaoModels = options.loadMiaoModels || loadMiaoModels
    this.aliases = options.aliases || DEFAULT_TEAM_ALIASES
    this.timeoutMs = options.timeoutMs || 15000
  }

  async queryProfile({ profile, profileId = 1, command = "" } = {}) {
    const parsed = parseTeamDamageCommand(command)
    const role = pickRole(profile, "gs")
    const uid = parsed.uid || getRoleUid(role)
    if (!uid) throw new Error(`profile ${profileId} 没有同步原神 UID`)
    if (!this.fetch) throw new Error("fetch is unavailable")

    const { Character, Player } = await this.loadMiaoModels()
    const player = Player.create(uid, "gs")
    const teamNames = resolveTeamNames(parsed.roles, {
      aliases: this.aliases,
      Character,
      player,
    })
    const { request, rolesData, selected } = buildTeyvatTeamRequest({
      uid,
      teamNames,
      Character,
      player,
    })
    const response = await this.requestTeamDamage(request)
    const result = normalizeTeyvatTeamResult(response.result, rolesData)

    return {
      ok: true,
      uid,
      profileId,
      command,
      parsed,
      team: selected.map(item => item.name),
      request,
      result,
      renderData: buildTeamDamageRenderData({
        uid,
        profileId,
        command,
        parsed,
        selected,
        result,
      }),
    }
  }

  async requestTeamDamage(body) {
    const response = await postJsonWithTimeout(this.fetch, TEAM_ENDPOINT, body, this.timeoutMs)
    if (response?.code !== 200 || !response?.result) {
      const reason = response?.info || response?.message || "提瓦特小助手接口无法访问或返回错误"
      throw new Error(reason)
    }
    return response
  }
}

export function parseTeamDamageCommand(command = "") {
  const text = String(command || "").trim()
  const match = text.match(/^#队伍伤害(详情|过程|全图)?\s*([1-9]\d{7,9})?\s*([\s\S]*)$/)
  if (!match) throw new Error("指令格式错误：#队伍伤害神鹤万心 或 #队伍伤害2神里绫华 申鹤 枫原万叶 珊瑚宫心海")
  return {
    detail: Boolean(match[1]),
    uid: match[2] || "",
    roles: splitTeamRoles(match[3] || ""),
    rawRoles: String(match[3] || "").trim(),
  }
}

export function resolveTeamNames(inputRoles = [], { aliases = DEFAULT_TEAM_ALIASES, Character, player } = {}) {
  let roles = [...inputRoles]
  if (roles.length === 1) roles = resolveTeamAlias(roles[0], aliases) || roles
  roles = expandTeamRoleTokens(roles, Character)
  if (!roles.length) {
    roles = Object.values(player.getProfiles?.() || {})
      .slice(0, 4)
      .map(profile => profile?.char?.name)
      .filter(Boolean)
  }
  if (!roles.length) throw new Error("请指定队伍角色，例如 #队伍伤害神鹤万心")
  if (roles.length > 4) roles = roles.slice(0, 4)
  return roles.map(name => normalizeCharacterName(name, Character))
}

export function expandTeamRoleTokens(roles = [], Character) {
  const expanded = []
  for (const role of roles) {
    const text = String(role || "").trim()
    if (!text) continue
    if (Character.get(text, "gs")) {
      expanded.push(text)
      continue
    }
    const segmented = segmentCharacterList(text, Character)
    if (segmented.length >= 2) expanded.push(...segmented)
    else expanded.push(text)
  }
  return expanded
}

export function segmentCharacterList(text = "", Character) {
  const source = String(text || "").trim()
  const result = []
  let index = 0
  while (index < source.length) {
    let matched = ""
    for (let length = Math.min(6, source.length - index); length >= 1; length -= 1) {
      const candidate = source.slice(index, index + length)
      const char = Character.get(candidate, "gs")
      if (char) {
        matched = char.name || candidate
        index += length
        break
      }
    }
    if (!matched) return []
    result.push(matched)
  }
  return result
}

export function resolveTeamAlias(name, aliases = DEFAULT_TEAM_ALIASES) {
  const text = String(name || "").trim()
  for (const [key, value] of Object.entries(aliases)) {
    const chars = Array.isArray(value) ? value : value.chars
    const alias = Array.isArray(value?.alias) ? value.alias : []
    if (text === key || alias.includes(text)) return [...chars]
  }
  return null
}

export function buildTeyvatTeamRequest({ uid, teamNames = [], Character, player } = {}) {
  const request = {
    uid: String(uid),
    server: getTeyvatServer(uid),
    role_data: [],
  }
  const rolesData = {}
  const selected = []
  const missing = []

  for (const name of teamNames) {
    const character = Character.get(name, "gs")
    if (!character) throw new Error(`无法识别角色：${name}`)
    if (isTravelerName(character.name || name)) throw new Error("旅行者暂不支持队伍伤害计算")
    const profile = player.getProfile(character.id)
    if (!profile || !profile.hasData) {
      missing.push(character.name || name)
      continue
    }
    const roleData = normalizeMiaoProfileRole(profile)
    rolesData[roleData.name] = roleData
    selected.push(roleData)
    request.role_data.push(convertMiaoProfileToTeyvatRole(profile, uid))
  }

  if (missing.length) {
    throw new Error(`UID ${uid} 缺少 ${missing.join("、")} 面板数据，请先执行 #更新面板`)
  }
  if (!request.role_data.length) throw new Error(`UID ${uid} 没有可用于队伍伤害的面板数据`)
  return {
    request,
    rolesData,
    selected,
  }
}

export function convertMiaoProfileToTeyvatRole(profile, uid) {
  const attr = profile.attr || {}
  const base = profile.base || {}
  const mark = safeArtisMark(profile)
  const role = {
    uid: String(uid),
    role: profile.char?.name || "",
    role_class: number(profile.cons),
    level: number(profile.level),
    weapon: profile.weapon?.name || "",
    weapon_level: number(profile.weapon?.level),
    weapon_class: `精炼${number(profile.weapon?.affix, 1)}阶`,
    hp: roundInt(attr.hp),
    base_hp: roundInt(base.hp),
    attack: roundInt(attr.atk),
    base_attack: roundInt(base.atk),
    defend: roundInt(attr.def),
    base_defend: roundInt(base.def),
    element: roundInt(attr.mastery),
    crit: pct(attr.cpct),
    crit_dmg: pct(attr.cdmg),
    heal: pct(attr.heal),
    recharge: pct(attr.recharge),
    physical_dmg: pct(attr.phy),
    ability1: number(profile.talent?.a?.level),
    ability2: number(profile.talent?.e?.level),
    ability3: number(profile.talent?.q?.level),
    artifacts: artifactSetText(mark.sets),
    artifacts_detail: artifactDetails(profile, mark),
  }

  for (const [key, elem] of Object.entries(DAMAGE_KEYS)) {
    role[key] = profile.elem === elem ? pct(attr.dmg) : pct(0)
  }
  return role
}

export function normalizeTeyvatTeamResult(raw = {}, rolesData = {}) {
  const { tm, total } = parseTeamTotal(raw.zdl_tips0 || "")
  const pie = (raw.chart_data || []).map(item => {
    const [name, damage] = String(item.name || "").split("\n")
    return {
      char: name || "未知",
      damage: parseDamageWan(damage),
      color: item.label?.color || "#24a9d8",
    }
  }).sort((a, b) => b.damage - a.damage)

  const avatars = {}
  for (const role of raw.role_list || []) {
    const panel = rolesData[role.role] || {}
    avatars[role.role] = {
      name: role.role,
      rarity: number(role.role_star),
      level: stripPrefix(role.role_level, "Lv"),
      cons: number(role.role_class),
      elem: panel.element || "",
      icon: panel.icon || "",
      face: panel.face || panel.icon || "",
      keyProp: role.key_ability || "",
      keyValue: role.key_value || "",
      weapon: panel.weapon || {},
      stats: panel.fightProp || {},
      skills: panel.skills || [],
      relicSet: panel.relicSet || {},
    }
  }

  for (const item of raw.recharge_info || []) {
    const parsed = parseRecharge(item.recharge || "")
    if (parsed.name && avatars[parsed.name]) {
      avatars[parsed.name].recharge = {
        pct: item.rate || "",
        ...parsed,
      }
    }
  }

  return {
    uid: raw.uid || "",
    rank: raw.zdl_tips2 || raw.zdl_result || "",
    dps: raw.zdl_result || "",
    tm,
    total,
    pie,
    avatars,
    actions: String(raw.combo_intro || "").split(",").map(item => item.trim()).filter(Boolean),
    damages: parseTimelineRows(raw.advice || []),
    buffs: parseBuffRows(raw.buff || []),
  }
}

export function buildTeamDamageRenderData({ uid, profileId, command, parsed, selected, result } = {}) {
  const totalDamage = result.total || sumDamage(result.pie)
  return {
    title: "原神队伍伤害",
    subtitle: `UID ${uid} · profile ${profileId}`,
    badge: "GS",
    message: `${command || "#队伍伤害"} · ${selected.map(item => item.name).join(" / ")}`,
    uid,
    profileId,
    detail: parsed?.detail,
    team: selected.map(item => ({
      name: item.name,
      elem: item.element,
      level: item.level,
      cons: item.cons,
      weapon: item.weapon?.name || "",
      weaponLevel: item.weapon?.level || "",
      weaponAffix: item.weapon?.affix || "",
      stats: item.fightProp,
      skills: item.skills,
    })),
    summary: [
      { label: "总伤害", value: formatDamage(totalDamage) },
      { label: "DPS", value: result.dps || "-" },
      { label: "时间", value: result.tm ? `${result.tm}s` : "-" },
      { label: "评级", value: result.rank || "-" },
    ],
    pie: result.pie,
    avatars: Object.values(result.avatars || {}),
    actions: result.actions,
    damages: result.damages,
    buffs: result.buffs,
    source: "提瓦特小助手",
  }
}

function normalizeMiaoProfileRole(profile) {
  const weapon = {
    name: profile.weapon?.name || "",
    rarity: number(profile.weapon?.star || profile.weapon?.rarity),
    affix: number(profile.weapon?.affix),
    level: number(profile.weapon?.level),
    icon: profile.weapon?.img || profile.weapon?.icon || "",
    weaponPath: [profile.weapon?.type, profile.weapon?.name].filter(Boolean).join("/"),
  }
  const mark = safeArtisMark(profile)
  return {
    id: profile.char?.id,
    name: profile.char?.name || "",
    element: ATTR_LABELS[profile.elem] || profile.elem || "",
    cons: number(profile.cons),
    level: number(profile.level),
    icon: profile.char?.face || profile.face || "",
    face: profile.char?.face || profile.face || "",
    weapon,
    fightProp: {
      暴击率: round1(profile.attr?.cpct),
      暴击伤害: round1(profile.attr?.cdmg),
      生命值: roundInt(profile.attr?.hp),
      攻击力: roundInt(profile.attr?.atk),
      防御力: roundInt(profile.attr?.def),
      元素精通: roundInt(profile.attr?.mastery),
      治疗加成: round1(profile.attr?.heal),
      元素充能效率: round1(profile.attr?.recharge),
    },
    skills: [
      normalizeSkill(profile.talent?.a, "A"),
      normalizeSkill(profile.talent?.e, "E"),
      normalizeSkill(profile.talent?.q, "Q"),
    ],
    relicSet: mark.sets || {},
  }
}

function normalizeSkill(skill = {}, fallback = "") {
  return {
    icon: skill.icon || fallback,
    style: skill.level > skill.original ? "extra" : "",
    level: number(skill.level),
  }
}

function artifactDetails(profile, mark = {}) {
  const artis = profile.artis?.artis || {}
  return Object.entries(artis).map(([key, arti], index) => {
    const detail = mark.artis?.[key] || {}
    const row = {
      artifacts_name: arti.name || "",
      artifacts_type: POSITION_NAMES[index] || "",
      level: number(arti.level),
      maintips: ATTR_LABELS[arti.main?.key] || arti.main?.key || detail.main?.key || "",
      mainvalue: cleanValue(detail.main?.value ?? arti.main?.value ?? ""),
    }
    const attrs = Object.values(arti.attrs || {})
    for (let i = 0; i < 4; i += 1) {
      const attr = attrs[i]
      const detailAttr = detail.attrs?.[i]
      row[`tips${i + 1}`] = attr
        ? `${ATTR_LABELS[attr.key] || attr.key}+${cleanValue(detailAttr?.value ?? attr.value ?? "")}`
        : ""
    }
    return row
  })
}

function safeArtisMark(profile) {
  try {
    return profile.getArtisMark?.() || {}
  } catch {
    return {}
  }
}

function artifactSetText(sets = {}) {
  return Object.entries(sets || {})
    .filter(([, count]) => Number(count) >= 1)
    .map(([name, count]) => `${name}${count >= 4 ? 4 : count >= 2 ? 2 : 1}`)
    .join("+")
}

function parseTeamTotal(text = "") {
  const normalized = String(text || "").replace(/你的队伍|，DPS为:/g, "")
  const [tm, total] = normalized.split("秒内造成总伤害")
  return {
    tm: (tm || "").trim(),
    total: parseDamageWan(total),
  }
}

function parseTimelineRows(rows = []) {
  return rows.map(row => {
    const content = String(row.content || "").trim()
    const [time, rest = ""] = content.split(/\s+/, 2)
    const [action, damageText = ""] = rest.split("，")
    return {
      time: stripSecondSuffix(time),
      action: String(action || "").toUpperCase(),
      values: damageText
        ? damageText.split(",").map(item => item.split(/[:：]/).pop()).filter(Boolean)
        : [],
    }
  }).filter(row => row.time || row.action || row.values.length)
}

function parseBuffRows(rows = []) {
  return rows.map(row => {
    const content = String(row.content || "").trim()
    const [time, rest = ""] = content.split(/\s+/, 2)
    const [name = "", ...detail] = rest.split("-")
    return {
      time: stripSecondSuffix(time),
      name: name.toUpperCase(),
      detail: detail.join("-").toUpperCase(),
    }
  }).filter(row => row.time || row.name || row.detail)
}

function parseRecharge(text = "") {
  const match = String(text || "").match(/^(.+?)共获取同色球([\d.]+)个，异色球([\d.]+)个/)
  if (!match) return {}
  return {
    name: match[1],
    same: round1(match[2]),
    diff: round1(match[3]),
  }
}

async function postJsonWithTimeout(fetchImpl, url, body, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...REQUEST_HEADERS,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function loadMiaoModels() {
  return importRuntimeModule("miao-plugin", "models", "index.js")
}

function splitTeamRoles(text = "") {
  return String(text || "")
    .trim()
    .split(/[\s,，、。|｜-]+/g)
    .map(item => item.trim())
    .filter(Boolean)
}

function normalizeCharacterName(name, Character) {
  const char = Character.get(name, "gs")
  if (!char) throw new Error(`无法识别角色：${name}`)
  return char.name || name
}

function getTeyvatServer(uid = "") {
  const first = String(uid || "")[0]
  if (first === "5") return "cn_qd01"
  if (first === "6") return "us"
  if (first === "7") return "eur"
  if (first === "8") return "asia"
  if (first === "9") return "hk"
  return "cn_gf01"
}

function isTravelerName(name = "") {
  return /^(旅行者|空|荧|萤)$/.test(String(name || ""))
}

function pct(value) {
  return `${round1(value)}%`
}

function cleanValue(value) {
  return String(value ?? "").replace(/,/g, "")
}

function number(value, fallback = 0) {
  const n = Number(String(value ?? "").replace(/[^\d.-]/g, ""))
  return Number.isFinite(n) ? n : fallback
}

function roundInt(value) {
  return Math.round(number(value))
}

function round1(value) {
  return Math.round(number(value) * 10) / 10
}

function stripPrefix(value, prefix) {
  return String(value || "").replace(new RegExp(`^${prefix}`), "")
}

function stripSecondSuffix(value) {
  return String(value || "").replace(/s$/i, "")
}

function parseDamageWan(value = "") {
  const text = String(value || "").replace(/,/g, "")
  const n = number(text)
  if (/W|万/i.test(text)) return Math.round(n * 10000)
  return Math.round(n)
}

function sumDamage(pie = []) {
  return pie.reduce((sum, item) => sum + number(item.damage), 0)
}

function formatDamage(value) {
  const n = number(value)
  if (!n) return "-"
  if (n >= 10000) return `${round1(n / 10000)}万`
  return String(Math.round(n))
}
