import { StarRailDpsEngine } from "./engine.js"
import { importRuntimeModule, getRoleUid, pickRole } from "../pluginBridge/common.js"

const ELEMENT_LABELS = Object.freeze({
  physical: "物理",
  wuli: "物理",
  fire: "火",
  huo: "火",
  ice: "冰",
  bing: "冰",
  thunder: "雷",
  elec: "雷",
  lei: "雷",
  wind: "风",
  feng: "风",
  quantum: "量子",
  liangzi: "量子",
  imaginary: "虚数",
  xushu: "虚数",
})

const PATH_LABELS = Object.freeze({
  huimie: "毁灭",
  xunlie: "巡猎",
  zhishi: "智识",
  tongxie: "同谐",
  xuwu: "虚无",
  cunhu: "存护",
  fengrao: "丰饶",
  jiyi: "记忆",
})

const ELEMENT_DAMAGE_KEYS = Object.freeze({
  physical: "physicalAddHurt",
  wuli: "physicalAddHurt",
  fire: "fireAddHurt",
  huo: "fireAddHurt",
  ice: "iceAddHurt",
  bing: "iceAddHurt",
  thunder: "elecAddHurt",
  elec: "elecAddHurt",
  lei: "elecAddHurt",
  wind: "windAddHurt",
  feng: "windAddHurt",
  quantum: "quantumAddHurt",
  liangzi: "quantumAddHurt",
  imaginary: "imaginaryAddHurt",
  xushu: "imaginaryAddHurt",
})

const DEFAULT_TEAM_ALIASES = Object.freeze({
  飞托阮同: ["飞霄", "托帕", "阮梅", "同谐主"],
  飞托阮主: ["飞霄", "托帕", "阮梅", "同谐主"],
  飞霄追击: ["飞霄", "托帕", "阮梅", "同谐主"],
  追击队: ["飞霄", "托帕", "阮梅", "同谐主"],
  黄泉队: ["黄泉", "椒丘", "砂金", "佩拉"],
  黄椒砂佩: ["黄泉", "椒丘", "砂金", "佩拉"],
  黑塔队: ["大黑塔", "翡翠", "阮梅", "藿藿"],
})

const ENHANCED_STAR_RAIL_ROLE_IDS = Object.freeze([1212, 1205, 1005, 1006, 1004, 1102, 1217, 1310, 1306, 1307])

const ROLE_EXTRA_ALIASES = Object.freeze({
  "开拓者·同谐": ["同谐主", "同协主", "和谐主", "开拓者同谐", "同谐开拓者"],
  "开拓者·记忆": ["记忆主", "开拓者记忆", "记忆开拓者"],
  "开拓者·毁灭": ["毁灭主", "物理主", "开拓者毁灭"],
  "开拓者·存护": ["存护主", "火主", "开拓者存护"],
  "开拓者·虚无": ["虚无主", "开拓者虚无"],
  "开拓者·巡猎": ["巡猎主", "开拓者巡猎"],
  "阮•梅": ["阮梅", "阮·梅"],
  "托帕&账账": ["托帕", "账账", "托帕账账", "托帕帐帐"],
  "银狼LV.999": ["银狼lv999", "银狼lv.999", "银狼LV999", "狼尊"],
  "千冶•刃": ["千冶刃", "千冶·刃"],
})

export class StarRailTeamDamageService {
  constructor(options = {}) {
    this.engine = options.engine || new StarRailDpsEngine(options)
    this.loadMiaoModels = options.loadMiaoModels || loadMiaoModels
    this.aliases = options.aliases || DEFAULT_TEAM_ALIASES
  }

  async queryProfile({ profile, profileId = 1, command = "" } = {}) {
    const parsed = parseStarRailTeamDamageCommand(command)
    const role = pickRole(profile, "sr")
    const uid = parsed.uid || getRoleUid(role)
    if (!uid) throw new Error(`profile ${profileId} 没有同步星铁 UID`)

    const systemData = await this.engine.ensureSystemData()
    const systemRoles = systemData.system_roles || []
    const selected = resolveStarRailTeamRoles(parsed.roles, {
      roles: systemRoles,
      aliases: this.aliases,
    })
    const { player, profiles, Character } = await this.loadPlayerProfiles(uid).catch(error => {
      globalThis.logger?.debug?.(`[Lotus-Plugin] starrail team damage miao profile skipped: ${error.message}`)
      return { player: null, profiles: {}, Character: null }
    })
    const panelDataById = {}
    const team = selected.map(roleInfo => {
      const profileRole = findStarRailProfile({ player, profiles, Character, roleInfo })
      const panel = extractStarRailPanel(profileRole, roleInfo, uid)
      if (panel) panelDataById[String(roleInfo.item_id)] = panel
      return buildSelectedRole(roleInfo, profileRole, panel)
    })

    const result = await this.engine.calculate({
      roleIds: selected.map(item => item.item_id),
      roles: selected,
      panelDataById,
      battleCycle: parsed.battleCycle,
      enemyTotal: parsed.enemyTotal,
      seed: parsed.seed,
    })
    const normalized = normalizeStarRailDamageResult(result, selected)
    return {
      ok: true,
      uid,
      profileId,
      command,
      parsed,
      team,
      result: normalized,
      renderData: buildStarRailTeamDamageRenderData({
        uid,
        profileId,
        command,
        parsed,
        team,
        result: normalized,
      }),
    }
  }

  async loadPlayerProfiles(uid) {
    const { Player, Character } = await this.loadMiaoModels()
    const player = Player.create(uid, "sr")
    return {
      player,
      profiles: player?.getProfiles?.() || {},
      Character,
    }
  }
}

export function parseStarRailTeamDamageCommand(command = "") {
  const text = normalizeStarRailTeamDamageCommand(command)
  const match = text.match(/^(?:\*|#星铁)(?:队伍伤害|队伤|伤害)(详情|过程|全图)?\s*([1-9]\d{7,9})?\s*([\s\S]*)$/)
  if (!match) {
    throw new Error("指令格式错误：*队伍伤害飞霄托帕阮梅同谐主 或 #星铁队伍伤害2飞霄 托帕 阮梅 同谐主")
  }
  const body = String(match[3] || "").trim()
  const battleCycle = parseNumberOption(body, /(?:轮次|轮|cycle)\s*(\d{1,2})|(\d{1,2})(?:轮|T)/i, 5)
  const enemyTotal = parseNumberOption(body, /([135])\s*(?:怪|目标|敌)/, 3)
  const cleaned = body
    .replace(/(?:轮次|轮|cycle)\s*\d{1,2}|\d{1,2}(?:轮|T)/gi, " ")
    .replace(/[135]\s*(?:怪|目标|敌)/g, " ")
    .trim()
  return {
    detail: Boolean(match[1]),
    uid: match[2] || "",
    roles: splitTeamRoles(cleaned),
    rawRoles: cleaned,
    battleCycle,
    enemyTotal,
    seed: 20260628,
    normalized: text,
  }
}

export function normalizeStarRailTeamDamageCommand(command = "") {
  return String(command || "").trim()
    .replace(/^#?(?:星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/, "#星铁")
    .replace(/^\*+/, "*")
}

export function resolveStarRailTeamRoles(inputRoles = [], { roles = [], aliases = DEFAULT_TEAM_ALIASES } = {}) {
  let tokens = [...inputRoles]
  if (tokens.length === 1) tokens = resolveTeamAlias(tokens[0], aliases) || tokens
  tokens = expandStarRailRoleTokens(tokens, roles)
  if (!tokens.length) throw new Error("请指定星铁队伍角色，例如 *队伍伤害飞霄托帕阮梅同谐主")
  if (tokens.length > 4) tokens = tokens.slice(0, 4)
  const resolved = tokens.map(token => resolveStarRailRole(token, roles))
  const unsupported = resolved.filter(role => !role.dps_template)
  if (unsupported.length) {
    throw new Error(`${unsupported.map(role => role.nick_name || role.name || role.item_id).join("、")} 暂无队伍伤害模板`)
  }
  return resolved
}

export function expandStarRailRoleTokens(tokens = [], roles = []) {
  const expanded = []
  for (const token of tokens) {
    const text = String(token || "").trim()
    if (!text) continue
    if (resolveStarRailRole(text, roles, { silent: true })) {
      expanded.push(text)
      continue
    }
    const segmented = segmentStarRailRoleList(text, roles)
    if (segmented.length >= 2) expanded.push(...segmented)
    else expanded.push(text)
  }
  return expanded
}

export function segmentStarRailRoleList(text = "", roles = []) {
  const source = normalizeRoleKey(text)
  if (!source) return []
  const entries = buildRoleEntries(roles)
  const result = []
  let index = 0
  while (index < source.length) {
    const remain = source.slice(index)
    const matched = entries.find(entry => remain.startsWith(entry.key))
    if (!matched) return []
    result.push(matched.role.nick_name || matched.role.name || String(matched.role.item_id))
    index += matched.key.length
  }
  return result
}

export function resolveStarRailRole(name, roles = [], options = {}) {
  const key = normalizeRoleKey(name)
  const entry = buildRoleEntries(roles).find(entry => entry.key === key)
  if (entry) return entry.role
  if (options.silent) return null
  throw new Error(`无法识别星铁角色：${name}`)
}

export function resolveTeamAlias(name, aliases = DEFAULT_TEAM_ALIASES) {
  const key = normalizeRoleKey(name)
  for (const [alias, chars] of Object.entries(aliases)) {
    if (normalizeRoleKey(alias) === key) return [...chars]
  }
  return null
}

export function buildStarRailTeamDamageRenderData({ uid, profileId, command, parsed, team, result } = {}) {
  return {
    title: "星铁队伍伤害",
    subtitle: `UID ${uid} · profile ${profileId}`,
    badge: "SR",
    message: `${command || parsed?.normalized || "*队伍伤害"} · ${team.map(item => item.name).join(" / ")}`,
    uid,
    profileId,
    detail: parsed?.detail,
    summary: [
      { label: "总伤害", value: formatDamage(result.totalDamage) },
      { label: "DPS", value: formatDamage(result.teamDps) },
      { label: "轮次", value: `${result.battleCycle || parsed?.battleCycle || 5}` },
      { label: "目标", value: `${result.enemyTotal || parsed?.enemyTotal || 3}怪` },
    ],
    team,
    pie: result.pie,
    actionTrack: result.actionTrack,
    battleRecords: result.battleRecords,
    damageLogs: result.damageLogs,
    source: "星穹铁道工坊",
  }
}

export function normalizeStarRailDamageResult(result = {}, selected = []) {
  const total = number(result.totalDamage)
  const pie = (result.groupRoleDamages || []).map(item => {
    const role = selected.find(role => Number(role.item_id) === Number(item.object_id))
    return {
      char: cleanRoleName(item.name || role?.nick_name || role?.name || "未知"),
      damage: number(item.value),
      color: elementColor(role?.element),
      roleId: item.object_id || role?.item_id,
    }
  }).sort((a, b) => b.damage - a.damage)
  const battleRecords = normalizeBattleRecords(result.battleLogs || result.formatBattleLogs || [], selected)
  return {
    totalDamage: total,
    teamDps: number(result.teamDps),
    battleCycle: result.battleCycle,
    enemyTotal: result.enemyTotal,
    pie,
    actionTrack: normalizeActionTrack(result.actionQueue || [], selected),
    battleRecords,
    damageLogs: normalizeDamageLogs(battleRecords.length ? battleRecords : result.formatBattleLogs || result.battleLogs || [], selected),
    usedPanelCount: (result.dpsCharacterConfigs || []).filter(item => item.uid).length,
  }
}

export function findStarRailProfile({ player = null, profiles = {}, Character = null, roleInfo = {} } = {}) {
  for (const candidate of profileCandidates(roleInfo, Character)) {
    const profile = profileByCandidate({ player, profiles, candidate })
    if (profile?.hasData) return profile
  }
  return null
}

export function profileCandidates(roleInfo = {}, Character = null) {
  const directId = number(roleInfo.item_id)
  const candidates = []
  const push = candidate => {
    if (!candidate?.id && !candidate?.name) return
    const key = `${candidate.id || ""}:${normalizeRoleKey(candidate.name || "")}`
    if (candidates.some(item => `${item.id || ""}:${normalizeRoleKey(item.name || "")}` === key)) return
    candidates.push(candidate)
  }

  const enhancedIds = Character?.enhancedCharIds || ENHANCED_STAR_RAIL_ROLE_IDS
  const enhancedId = enhancedIds.map(Number).includes(directId) ? toEnhancedStarRailId(directId) : 0
  if (enhancedId) push({ id: enhancedId, name: `${roleInfo.nick_name || roleInfo.name || ""}Pro` })
  for (const name of profileNameCandidates(roleInfo)) {
    const char = getMiaoCharacter(Character, name)
    if (char?.id) push({ id: char.id, name: char.name || name })
    push({ name })
  }
  push({ id: directId, name: roleInfo.nick_name || roleInfo.name })
  return candidates
}

function buildRoleEntries(roles = []) {
  const entries = []
  for (const role of roles || []) {
    const names = new Set([
      role.nick_name,
      role.name,
      String(role.item_id || ""),
      ...extraRoleNames(role),
    ].filter(Boolean))
    for (const name of names) {
      const key = normalizeRoleKey(name)
      if (!key) continue
      entries.push({ key, role })
    }
  }
  entries.sort((a, b) => b.key.length - a.key.length || Number(b.role.item_id || 0) - Number(a.role.item_id || 0))
  const seen = new Set()
  return entries.filter(entry => {
    const uniqueKey = `${entry.key}:${entry.role.item_id}`
    if (seen.has(uniqueKey)) return false
    seen.add(uniqueKey)
    return true
  })
}

function extraRoleNames(role = {}) {
  const name = role.nick_name || role.name || ""
  const names = [...(ROLE_EXTRA_ALIASES[name] || [])]
  if (isEnhancedStarRailRoleId(role.item_id)) {
    names.push(`${name}Pro`, `${name}pro`, `加强${name}`, `${name}加强`, `加强版${name}`)
  }
  if (/[&＆]/.test(name)) {
    names.push(name.replace(/[&＆]/g, ""))
    names.push(name.replace(/[&＆]/g, "和"))
    names.push(name.replace(/[&＆]/g, "与"))
    names.push(name.split(/[&＆]/)[0])
  }
  if (/开拓者/.test(name)) {
    const path = name.replace(/^开拓者[·•.・]?/, "")
    if (path) names.push(`${path}主`, `${path}开拓者`)
  }
  return names
}

function profileNameCandidates(role = {}) {
  const name = role.nick_name || role.name || ""
  const names = []
  if (name && isEnhancedStarRailRoleId(role.item_id)) {
    names.push(`${name}Pro`, `${name}pro`, `加强${name}`, `${name}加强`, `加强版${name}`)
  }
  names.push(name, ...(ROLE_EXTRA_ALIASES[name] || []))
  return names.filter(Boolean)
}

function profileByCandidate({ player = null, profiles = {}, candidate = {} } = {}) {
  const ids = [candidate.id, String(candidate.id || "")].filter(Boolean)
  for (const id of ids) {
    if (profiles?.[id]?.hasData) return profiles[id]
    const profile = player?.getProfile?.(id)
    if (profile?.hasData) return profile
  }
  const candidateKey = normalizeRoleKey(candidate.name || "")
  if (candidateKey) {
    const profile = Object.values(profiles || {}).find(item => normalizeRoleKey(item?.name || item?.char?.name || "") === candidateKey)
    if (profile?.hasData) return profile
  }
  return null
}

function getMiaoCharacter(Character = null, name = "") {
  if (!Character?.get || !name) return null
  try {
    return Character.get(name, "sr") || null
  } catch {
    return null
  }
}

function isEnhancedStarRailRoleId(id) {
  return ENHANCED_STAR_RAIL_ROLE_IDS.includes(number(id))
}

function toEnhancedStarRailId(id) {
  const text = String(number(id))
  if (!/^\d{4}$/.test(text)) return 0
  return number(`2${text.slice(1)}`)
}

function normalizeRoleKey(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[ａ-ｚＡ-Ｚ０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "")
    .replace(/[·•・.。&＆_\-—/\\|:：,，、()（）\[\]【】「」『』]/g, "")
}

function splitTeamRoles(text = "") {
  const trimmed = String(text || "").trim()
  if (!trimmed) return []
  const parts = trimmed.split(/[\s,，、。|｜]+/g).map(item => item.trim()).filter(Boolean)
  return parts.length ? parts : [trimmed]
}

function extractStarRailPanel(profile = null, role = {}, uid = "") {
  if (!profile?.hasData) return null
  const attr = profile.attr || {}
  const combatValues = {
    hpBase: number(attr.hpBase),
    hpFinal: number(attr.hp),
    attackBase: number(attr.atkBase),
    attackFinal: number(attr.atk),
    defenseBase: number(attr.defBase),
    defenseFinal: number(attr.def),
    speedBase: number(attr.speedBase),
    speedFinal: number(attr.speed),
    criticalChance: ratio(attr.cpct),
    criticalDamage: ratio(attr.cdmg),
    spRatio: ratio(attr.recharge),
    healRatio: ratio(attr.heal),
    stanceBreakRatio: ratio(attr.stance),
    statusProbability: ratio(attr.effPct),
    statusResistance: ratio(attr.effDef),
  }
  const damageKey = ELEMENT_DAMAGE_KEYS[role.element] || ELEMENT_DAMAGE_KEYS[profile.elem]
  if (damageKey) combatValues[damageKey] = ratio(attr.dmg)
  return {
    uid: String(uid || ""),
    rank: number(profile.cons),
    level: number(profile.level, 80),
    weapon: normalizeProfileWeapon(profile.weapon),
    combatValues: removeEmptyNumbers(combatValues),
    skills: Object.values(profile.talent || {}).map(skill => ({
      type: skill.type || skill.name || "",
      level: number(skill.level ?? skill.original),
    })),
  }
}

function normalizeProfileWeapon(weapon = {}) {
  if (!weapon?.id && !weapon?.name) return null
  return {
    id: number(weapon.id),
    level: number(weapon.level, 80),
    rankLevel: number(weapon.affix, 1),
  }
}

function buildSelectedRole(role = {}, profile = null, panel = null) {
  const attr = profile?.attr || {}
  const weapon = profile?.weapon || {}
  return {
    id: role.item_id,
    name: cleanRoleName(role.nick_name || role.name || profile?.name || role.item_id),
    elem: ELEMENT_LABELS[role.element] || role.element || profile?.elem || "-",
    path: PATH_LABELS[role.profession] || role.profession || "-",
    level: profile?.level || panel?.level || role.dps_template?.level || 80,
    rank: profile?.cons ?? panel?.rank ?? role.dps_template?.rank ?? 0,
    weapon: weapon.name || role.dps_template?.weapon?.name || role.dps_template?.weapon?.id || "-",
    weaponLevel: weapon.level || panel?.weapon?.level || 80,
    weaponRank: weapon.affix || panel?.weapon?.rankLevel || role.dps_template?.weapon?.rankLevel || 1,
    icon: role.avatar || role.long_avatar || role.role_picture || "",
    stats: {
      暴击率: pctText(attr.cpct),
      暴击伤害: pctText(attr.cdmg),
      攻击力: intText(attr.atk),
      速度: intText(attr.speed),
      击破: pctText(attr.stance),
      效果命中: pctText(attr.effPct),
    },
    panelSource: panel ? "喵喵面板" : "默认模板",
  }
}

function normalizeActionTrack(queue = [], selected = []) {
  return queue.slice(0, 12).map((item, index) => ({
    order: index + 1,
    name: cleanRoleName(item.name || roleNameById(selected, item.objectId) || "行动"),
    actionPoints: Math.round(number(item.actionPoints) * 10) / 10,
  }))
}

function normalizeDamageLogs(logs = [], selected = []) {
  if (logs[0]?.lines) {
    const lines = []
    for (const record of logs) {
      for (const line of record.lines || []) {
        lines.push({
          order: lines.length + 1,
          text: line.text,
        })
      }
    }
    return lines.slice(0, 32)
  }
  return logs.slice(0, 18).map((log, index) => {
    if (typeof log === "string") return { order: index + 1, text: cleanLogText(log) }
    const roleName = cleanRoleName(log.roleName || log.role_name || log.name || roleNameById(selected, log.object_id))
    const action = log.action || log.skillName || log.skill_name || log.type || ""
    const damage = log.damage || log.value || log.totalDamage || ""
    const text = cleanLogText([roleName, action, damage ? formatDamage(damage) : ""].filter(Boolean).join(" · "))
    return { order: index + 1, text }
  }).filter(item => item.text)
}

function normalizeBattleRecords(logs = [], selected = []) {
  const records = []
  for (const log of logs || []) {
    if (typeof log === "string") {
      const text = cleanLogText(log)
      if (text) records.push({ order: records.length + 1, title: "行动", lines: [{ type: "text", text }] })
      continue
    }
    if (!log || typeof log !== "object" || isEnemyObjectId(log.object_id)) continue
    const name = cleanRoleName(log.name || roleNameById(selected, log.object_id) || "行动")
    const actionPoint = Math.ceil(number(log.actionPoint ?? log.action_points ?? log.actionPoints))
    const lines = []
    for (const skill of log.skills || []) {
      const desc = cleanLogText(skill.desc || "")
      if (desc) lines.push({ type: "skill", text: desc })
      for (const damage of skill.damages || []) {
        const damageDesc = cleanLogText(damage.desc || "")
        if (damageDesc) lines.push({ type: "damage", text: damageDesc, damage: number(damage.value) })
      }
    }
    for (const other of log.others || []) {
      const text = cleanLogText(other?.desc || other?.text || "")
      if (text) lines.push({ type: "other", text })
    }
    if (!lines.length) {
      const desc = cleanLogText(log.desc || "")
      if (desc && desc !== `${name}的回合`) lines.push({ type: "text", text: desc })
    }
    if (!lines.length) continue
    records.push({
      order: records.length + 1,
      name,
      title: `${name}的回合`,
      actionPoint,
      roleId: log.object_id,
      color: elementColor(selected.find(role => Number(role.item_id) === Number(log.object_id))?.element),
      lines: lines.slice(0, 8),
    })
  }
  return records.slice(0, 36)
}

function isEnemyObjectId(id = "") {
  const value = number(id)
  return value >= 9000000
}

function roleNameById(selected = [], id = "") {
  return selected.find(role => Number(role.item_id) === Number(id))?.nick_name || ""
}

function cleanRoleName(name = "") {
  return String(name || "").replace(/\{NICKNAME\}/g, "开拓者").replace(/[·•]/g, "·")
}

function cleanLogText(value = "") {
  return String(value || "")
    .replace(/\{NICKNAME\}/g, "开拓者")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function removeEmptyNumbers(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => Number.isFinite(Number(item))))
}

function parseNumberOption(text = "", reg, fallback) {
  const match = String(text || "").match(reg)
  if (!match) return fallback
  return number(match[1] || match[2], fallback)
}

async function loadMiaoModels() {
  return importRuntimeModule("miao-plugin", "models", "index.js")
}

function elementColor(elem = "") {
  const label = ELEMENT_LABELS[elem] || elem
  if (/火/.test(label)) return "#e95b4c"
  if (/冰/.test(label)) return "#5cc7da"
  if (/雷/.test(label)) return "#9666d6"
  if (/风/.test(label)) return "#43b597"
  if (/量子/.test(label)) return "#5564d8"
  if (/虚数/.test(label)) return "#d6a443"
  if (/物理/.test(label)) return "#9aa0a6"
  return "#24a9d8"
}

function pctText(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "-"
  return Math.round(n * 10) / 10
}

function intText(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "-"
  return Math.round(n)
}

function ratio(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.abs(n) > 1 ? n / 100 : n
}

function number(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function formatDamage(value) {
  const n = number(value)
  if (!n) return "-"
  if (n >= 100000000) return `${Math.round(n / 10000000) / 10}亿`
  if (n >= 10000) return `${Math.round(n / 1000) / 10}万`
  return String(Math.round(n))
}
