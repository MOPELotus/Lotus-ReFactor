import crypto from "node:crypto"
import { deviceHeaders } from "../../core/devices/service.js"
import { getDs2 } from "../../core/mihoyo/ds.js"
import { isCnServer, resolveServer } from "../../core/mihoyo/regions.js"
import { getRoleUid, pickRole } from "../pluginBridge/common.js"

const CN_DS_SALT = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs"
const OS_DS_SALT = "okr4obncj8bw5a65hbnn5oo6ixjc3l9w"

const TYPE_META = Object.freeze({
  boss: {
    kind: "boss",
    index: 0,
    label: "末日幻影",
    endpoint: "challenge_boss",
  },
  story: {
    kind: "story",
    index: 1,
    label: "虚构叙事",
    endpoint: "challenge_story",
  },
  hall: {
    kind: "hall",
    index: 2,
    label: "混沌回忆",
    endpoint: "challenge",
  },
  peak: {
    kind: "peak",
    index: 3,
    label: "异相仲裁",
    endpoint: "challenge_peak",
  },
})

const CURRENT_ROTATION_START = new Date("2024-06-24T04:00:00+08:00").getTime()

export class StarRailChallengeService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
  }

  async queryProfile({ profile, profileId = 1, command = "*混沌" } = {}) {
    if (!this.fetch) throw new Error("fetch is unavailable")
    const parsed = parseStarRailChallengeCommand(command)
    const role = pickRole(profile, "sr")
    const uid = getRoleUid(role)
    if (!uid) throw new Error(`profile ${profileId} 没有同步星铁 UID`)
    const cookie = profile?.account?.cookie
    if (!cookie) throw new Error(`profile ${profileId} 未保存 cookie`)

    const server = resolveServer({
      server: role?.region,
      uid,
      game: "sr",
    })
    const context = {
      uid,
      server,
      isCn: isCnServer(server),
      cookie,
      profile,
      deviceFp: profile?.device?.fp || fallbackDeviceFp(profile),
      deviceId: profile?.device?.id || fallbackDeviceId(cookie),
    }

    const results = []
    if (parsed.kind === "all") {
      for (const kind of ["hall", "story", "boss"]) {
        results.push(await this.queryChallenge({ ...context, parsed: { ...parsed, kind } }))
      }
    } else if (parsed.kind === "current") {
      const current = currentChallengeKind()
      results.push(await this.queryChallenge({ ...context, parsed: { ...parsed, kind: current } }))
    } else {
      results.push(await this.queryChallenge({ ...context, parsed }))
    }

    return {
      ok: true,
      profileId,
      uid,
      command,
      parsed,
      results,
      renderData: buildStarRailChallengeRenderData({
        uid,
        profileId,
        command,
        parsed,
        results,
      }),
    }
  }

  async queryChallenge({ uid, server, isCn, cookie, profile, deviceFp, deviceId, parsed } = {}) {
    const meta = TYPE_META[parsed.kind]
    if (!meta) throw new Error(`暂不支持的星铁挑战类型：${parsed.kind}`)
    const scheduleType = resolveScheduleType(parsed)
    const requestOptions = {
      uid,
      server,
      isCn,
      cookie,
      profile,
      deviceFp,
      deviceId,
      endpoint: meta.endpoint,
      scheduleType,
    }

    let res = null
    let simple = Boolean(parsed.simple)
    if (!simple) {
      res = await this.requestChallenge({ ...requestOptions, detailed: true })
      if (!isOkResponse(res)) simple = true
    }
    if (simple) {
      const simpleRes = await this.requestChallenge({ ...requestOptions, detailed: false })
      if (!isOkResponse(simpleRes)) throw mihoyoResponseError(simpleRes, meta.label)
      res = simpleRes
    }

    return normalizeChallengeResult({
      data: res.data || {},
      uid,
      meta,
      scheduleType,
      simple,
      recent: parsed.recent,
      currentType: TYPE_META[currentChallengeKind()].index,
    })
  }

  async requestChallenge({ uid, server, isCn, cookie, profile, deviceFp, deviceId, endpoint, scheduleType, detailed = true } = {}) {
    const host = isCn ? "https://api-takumi-record.mihoyo.com" : "https://bbs-api-os.hoyolab.com"
    const query = new URLSearchParams({
      role_id: uid,
      schedule_type: scheduleType,
      server,
    })
    if (detailed) {
      query.set("isPrev", "")
      query.set("need_all", "true")
    }
    const queryText = query.toString()
    const url = `${host}/game_record/app/hkrpg/api/${endpoint}?${queryText}`
    const headers = buildHeaders({
      query: queryText,
      isCn,
      cookie,
      profile,
      deviceFp,
      deviceId,
    })
    const response = await this.fetch(url, {
      method: "GET",
      headers,
    })
    if (!response?.ok) {
      throw new Error(`星铁挑战接口 HTTP ${response?.status || "请求失败"}`)
    }
    return response.json()
  }
}

export function parseStarRailChallengeCommand(command = "") {
  const text = normalizeStarRailCommand(command)
  const simple = /简易/.test(text)
  const recent = /往期/.test(text)
  const last = /上期/.test(text)
  const current = /(?:最新|当期)/.test(text)
  const body = text
    .replace(/^(?:\*|#星铁)/, "")
    .replace(/(?:往期|上期|本期|最新|当期|简易)/g, "")
    .trim()

  let kind = ""
  if (/^(?:深渊)$/.test(body)) kind = current ? "current" : "all"
  else if (/(?:忘却|忘却之庭|混沌|混沌回忆)/.test(body)) kind = "hall"
  else if (/(?:虚构|虚构叙事)/.test(body)) kind = "story"
  else if (/(?:末日|末日幻影)/.test(body)) kind = "boss"
  else if (/(?:异乡|异相|异向|仲裁|异相仲裁)/.test(body)) kind = "peak"

  if (!kind) throw new Error(`无法识别星铁挑战查询：${command}`)
  return {
    kind,
    simple,
    recent,
    last,
    current,
    normalized: text,
  }
}

export function buildStarRailChallengeRenderData({ uid, profileId, command, parsed, results } = {}) {
  const title = results?.length === 1
    ? `星铁${results[0].label}`
    : "星铁挑战战绩"
  const period = parsed?.last ? "上期" : parsed?.recent ? "往期" : "本期"
  return {
    title,
    subtitle: `UID ${uid} · profile ${profileId}`,
    badge: "SR",
    message: `${command || parsed?.normalized || ""} · ${period}${parsed?.simple ? " · 简易" : ""}`,
    uid,
    profileId,
    summary: [
      { label: "UID", value: String(uid || "") },
      { label: "Profile", value: String(profileId || 1) },
      { label: "查询", value: command || parsed?.normalized || "" },
      { label: "模式", value: parsed?.simple ? "简易" : "详细优先" },
    ],
    results: results || [],
  }
}

function normalizeStarRailCommand(command = "") {
  return String(command || "").trim()
    .replace(/^#?(?:星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/, "#星铁")
    .replace(/^\*+/, "*")
}

function resolveScheduleType(parsed = {}) {
  if ((parsed.recent || parsed.last) && parsed.kind === "peak") return "3"
  return parsed.last ? "2" : "1"
}

function currentChallengeKind(now = Date.now()) {
  const period = Math.max(0, Math.floor((now - CURRENT_ROTATION_START) / (14 * 24 * 60 * 60 * 1000)))
  return ["boss", "story", "hall"][period % 3]
}

function normalizeChallengeResult({ data, uid, meta, scheduleType, simple, recent, currentType } = {}) {
  const activeData = { ...data }
  if (Array.isArray(activeData.groups) && activeData.groups.length > 1) {
    const activeGroup = scheduleType === "1"
      ? activeData.groups.find(group => group.status === "New")
      : activeData.groups.find(group => group.status === "End")
    if (activeGroup) activeData.groups = [activeGroup]
  }

  let period = ""
  let floors = []
  let peak = null
  if (meta.index === TYPE_META.peak.index) {
    const records = Array.isArray(activeData.challenge_peak_records)
      ? activeData.challenge_peak_records
      : []
    const selected = recent
      ? records
      : [scheduleType === "2" ? records[1] : records[0]].filter(Boolean)
    peak = selected.map(record => formatPeakRecord(record, activeData))
    period = peak[0]?.period || ""
  } else {
    const group = activeData.groups?.[0] || {}
    period = [
      formatMihoyoTime(meta.index === TYPE_META.hall.index ? activeData.begin_time : group.begin_time),
      formatMihoyoTime(meta.index === TYPE_META.hall.index ? activeData.end_time : group.end_time),
    ].filter(Boolean).join(" - ")
    floors = (activeData.all_floor_detail || [])
      .filter(floor => !floor?.is_fast)
      .map(formatFloor)
      .filter(hasFloorRecord)
  }

  return {
    uid,
    kind: meta.kind,
    label: meta.label,
    challengeType: meta.index,
    scheduleType,
    period,
    simple,
    current: currentType === meta.index,
    stars: activeData.star_num ?? activeData.total_star ?? "",
    extraStars: activeData.extra_star_num ?? "",
    maxFloor: activeData.max_floor ?? "",
    battleNum: activeData.battle_num ?? "",
    floors,
    peak,
  }
}

function formatFloor(floor = {}) {
  const nodes = ["node_1", "node_2", "node_3"]
    .map((key, index) => formatNode(floor[key], `节点${index + 1}`))
    .filter(Boolean)
  return {
    title: floor.name || floor.floor || "关卡",
    score: floor.score ?? "",
    stars: floor.star_num ?? "",
    round: floor.round_num ?? "",
    tierce: Boolean(floor.is_tierce),
    nodes,
  }
}

function formatNode(node, label) {
  if (!node) return null
  const formatted = {
    label,
    score: node.score ?? "",
    round: node.round_num ?? "",
    defeated: node.boss_defeated,
    time: formatMihoyoTime(node.challenge_time, true) || node.challengeTime || "",
    buff: node.buff ? `${node.buff.name_mi18n || node.buff.name || ""}${node.buff.desc_mi18n ? `：${node.buff.desc_mi18n}` : ""}` : "",
    avatars: (node.avatars || []).map(formatAvatar),
  }
  return hasNodeRecord(formatted) ? formatted : null
}

function hasFloorRecord(floor = {}) {
  return hasValue(floor.score)
    || hasValue(floor.stars)
    || hasValue(floor.round)
    || (floor.nodes || []).some(hasNodeRecord)
}

function hasNodeRecord(node = {}) {
  return hasValue(node.score)
    || hasValue(node.round)
    || Boolean(node.time)
    || node.defeated === true
    || node.defeated === false
    || Boolean(node.buff)
    || Boolean(node.avatars?.length)
}

function hasValue(value) {
  return value !== "" && value !== null && value !== undefined
}

function formatPeakRecord(record = {}, root = {}) {
  const group = record.group || {}
  const bossRecord = record.boss_record || null
  return {
    title: `${group.game_version ? `${group.game_version} ` : ""}${group.name_mi18n || "异相仲裁"}`,
    period: [formatMihoyoTime(group.begin_time), formatMihoyoTime(group.end_time)].filter(Boolean).join(" - "),
    icon: bossRecord?.challenge_peak_rank_icon || root.challenge_peak_best_record_brief?.challenge_peak_rank_icon || group.theme_pic_path || "",
    bossStars: record.boss_stars ?? "",
    mobStars: record.mob_stars ?? "",
    battleNum: root.challenge_peak_best_record_brief?.total_battle_num ?? "",
    boss: bossRecord ? {
      title: record.boss_info?.name_mi18n || "王棋关卡",
      icon: record.boss_info?.icon || "",
      stars: bossRecord.star_num ?? "",
      round: bossRecord.round_num ?? "",
      cleared: Boolean(bossRecord.has_challenge_record),
      hard: Boolean(bossRecord.hard_mode),
      time: formatMihoyoTime(bossRecord.challenge_time, true) || "",
      avatars: (bossRecord.avatars || []).map(formatAvatar),
    } : null,
    mobs: (record.mob_infos || []).map((info, index) => {
      const mob = record.mob_records?.[index] || {}
      return {
        title: [info.name, info.monster_name].filter(Boolean).join(" · ") || `骑士关卡 ${index + 1}`,
        icon: info.monster_icon || "",
        stars: mob.star_num ?? "",
        round: mob.round_num ?? "",
        cleared: Boolean(mob.has_challenge_record),
        fast: Boolean(mob.is_fast),
        time: formatMihoyoTime(mob.challenge_time, true) || "",
        avatars: (mob.avatars || []).map(formatAvatar),
      }
    }),
  }
}

function formatAvatar(avatar = {}) {
  return {
    name: avatar.name_mi18n || avatar.name || "",
    icon: avatar.icon || "",
    rarity: avatar.rarity || "",
    rank: avatar.rank ?? "",
    level: avatar.level ?? "",
    element: avatar.element || "",
  }
}

function formatMihoyoTime(value, withTime = false) {
  if (!value) return ""
  if (typeof value === "string") return value
  const year = Number(value.year)
  const month = Number(value.month)
  const day = Number(value.day)
  if (!year || !month || !day) return ""
  const date = `${year}.${pad2(month)}.${pad2(day)}`
  if (!withTime) return date
  return `${date} ${pad2(value.hour || 0)}:${pad2(value.minute || 0)}`
}

function buildHeaders({ query = "", isCn = true, cookie = "", profile = {}, deviceFp = "", deviceId = "" } = {}) {
  const cn = {
    appVersion: "2.73.1",
    userAgent: "Mozilla/5.0 (Linux; Android 13; XQ-BC52 Build/61.2.A.0.472A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.5563.116 Mobile Safari/537.36 miHoYoBBS/2.73.1",
    clientType: "5",
    origin: "https://webstatic.mihoyo.com",
    referer: "https://webstatic.mihoyo.com/",
    salt: CN_DS_SALT,
  }
  const os = {
    appVersion: "2.57.1",
    userAgent: "Mozilla/5.0 (Linux; Android 13; XQ-BC52 Build/61.2.A.0.472A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.5563.116 Mobile Safari/537.36 miHoYoBBSOversea/2.57.1",
    clientType: "2",
    origin: "https://act.hoyolab.com",
    referer: "https://act.hoyolab.com/",
    salt: OS_DS_SALT,
  }
  const client = isCn ? cn : os
  const headers = {
    "x-rpc-app_version": client.appVersion,
    "x-rpc-client_type": client.clientType,
    "User-Agent": client.userAgent,
    Referer: client.referer,
    Origin: client.origin,
    DS: getDs2(query, "", client.salt),
    Cookie: cookie,
    ...deviceHeaders(profile.device),
  }
  headers["x-rpc-device_fp"] ||= deviceFp
  headers["x-rpc-device_id"] ||= deviceId
  headers["x-rpc-device_name"] ||= profile.device?.name || "Sony XQ-BC52"
  headers["x-rpc-device_model"] ||= profile.device?.model || "XQ-BC52"
  headers["x-rpc-csm_source"] = "myself"
  return headers
}

function isOkResponse(res = {}) {
  return Number(res?.retcode) === 0
}

function mihoyoResponseError(res = {}, label = "星铁挑战") {
  const retcode = Number(res?.retcode)
  const message = res?.message || "接口返回异常"
  if (retcode === 1034 || retcode === 10035) return new Error(`${label}遇到验证码：${message}`)
  if (retcode === 10041 || retcode === 5003) return new Error(`${label}账号异常，暂时无法查询`)
  if (retcode === 10102) return new Error(`${label}数据未公开或未绑定角色`)
  return new Error(`${label}查询失败：${message}`)
}

function fallbackDeviceId(seed = "") {
  return crypto.createHash("md5").update(String(seed || "lotus-sr-device")).digest("hex").slice(0, 32)
}

function fallbackDeviceFp(profile = {}) {
  const seed = `${profile?.user?.qq || ""}:${profile?.profile?.id || 1}:${profile?.account?.ltuid || ""}`
  return `38${crypto.createHash("md5").update(seed || "lotus").digest("hex").slice(0, 11)}`
}

function pad2(value) {
  return String(value).padStart(2, "0")
}
