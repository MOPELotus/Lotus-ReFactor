import {
  listProfileIds,
  loadLoggedInProfile,
  normalizeProfileId,
  parseProfileIdFromMessage,
  saveProfile,
} from "./profile.js"

const GAME_KEYS = {
  原神: "genshin",
  genshin: "genshin",
  gs: "genshin",
  崩坏2: "honkai2",
  崩二: "honkai2",
  honkai2: "honkai2",
  崩坏3: "honkai3rd",
  崩三: "honkai3rd",
  honkai3rd: "honkai3rd",
  未定事件簿: "tears_of_themis",
  未定: "tears_of_themis",
  tears_of_themis: "tears_of_themis",
  星铁: "honkai_sr",
  崩铁: "honkai_sr",
  honkai_sr: "honkai_sr",
  sr: "honkai_sr",
  绝区零: "zzz",
  绝: "zzz",
  zzz: "zzz",
  因缘精灵: "hna",
  hna: "hna",
}

const ROLE_GAME_KEYS = {
  原神: "gs",
  genshin: "gs",
  gs: "gs",
  星铁: "sr",
  崩铁: "sr",
  honkai_sr: "sr",
  sr: "sr",
  绝区零: "zzz",
  绝: "zzz",
  zzz: "zzz",
}

export async function updateProfileSettings({ e, message, nickname = "" } = {}) {
  const userId = String(e?.user_id || "")
  const profileId = parseProfileIdFromSettingsMessage(message)
  const action = parseProfileSettingsCommand(message)
  if (!action.ok) return { ok: false, reason: action.reason, profile: null, profileId }
  if (action.type === "bindNotifyGroup" && !e?.group_id) {
    return { ok: false, reason: "group_required", profile: null, profileId }
  }

  const profile = await loadLoggedInProfile(userId, profileId)
  if (nickname && !profile.user?.nickname) {
    profile.user ||= {}
    profile.user.nickname = nickname
  }

  applyProfileSettingsAction(profile, action)
  if (action.type === "registerGroup" && e?.group_id) {
    profile.profile.notify.fallback_groups ||= []
    const groupId = String(e.group_id)
    if (!profile.profile.notify.fallback_groups.map(String).includes(groupId)) {
      profile.profile.notify.fallback_groups.push(groupId)
    }
  }
  if (action.type === "bindNotifyGroup" && e?.group_id) {
    action.groupId = String(e.group_id)
    profile.profile.notify.fallback_groups = [action.groupId]
  }
  if (action.type === "notify" && action.prefer === "group" && e?.group_id) {
    action.groupId = String(e.group_id)
    profile.profile.notify.fallback_groups = [action.groupId]
  }
  await saveProfile(profile)
  const profiles = await listProfileIds(userId)
  return {
    ok: true,
    action,
    profile,
    profileId,
    profiles,
    message: describeAction(action),
  }
}

export function parseProfileSettingsCommand(message = "") {
  const text = String(message || "").trim()
  try {
    parseProfileIdFromSettingsMessage(text)
  } catch {
    return {
      ok: false,
      reason: "invalid_profile_id",
    }
  }

  if (/^#注册自动签到\d*$/.test(text)) return { ok: true, type: "register" }

  if (/^#注册本群签到\d*$/.test(text)) return { ok: true, type: "registerGroup" }

  if (/^#(绑定|设置|切换)(通知群|签到通知群|本群通知)\d*$/.test(text)) {
    return { ok: true, type: "bindNotifyGroup" }
  }

  let match = text.match(/^#(启用|开启|关闭|禁用)社区签到\d*$/)
  if (match) {
    return {
      ok: true,
      type: "bbs",
      enable: isEnable(match[1]),
    }
  }

  match = text.match(/^#(启用|开启|关闭|禁用)(原神|崩坏2|崩二|崩坏3|崩三|未定事件簿|未定|星铁|崩铁|绝区零|绝|因缘精灵)(游戏)?签到\d*$/)
  if (match) {
    return {
      ok: true,
      type: "game",
      game: GAME_KEYS[match[2]],
      enable: isEnable(match[1]),
    }
  }

  match = text.match(/^#(启用|开启|关闭|禁用)全部游戏签到\d*$/)
  if (match) {
    return {
      ok: true,
      type: "allGames",
      enable: isEnable(match[1]),
    }
  }

  match = text.match(/^#(跟随|继承)(全局)?签到时间\d*$/)
  if (match) return { ok: true, type: "schedule", mode: "inherit" }

  match = text.match(/^#随机签到时间\d*$/)
  if (match) return { ok: true, type: "schedule", mode: "random" }

  match = text.match(/^#(固定|设置)签到时间(\d*)\s+(\d{1,2}:\d{2})$/)
  if (match) {
    const time = normalizeTime(match[3])
    if (!time) return { ok: false, reason: "invalid_time" }
    return { ok: true, type: "schedule", mode: "fixed", time }
  }

  match = text.match(/^#设置通知(私聊|群聊)\d*$/)
  if (match) {
    return {
      ok: true,
      type: "notify",
      prefer: match[1] === "群聊" ? "group" : "private",
    }
  }

  match = text.match(/^#(启用|开启|关闭|禁用)签到通知\d*$/)
  if (match) {
    return {
      ok: true,
      type: "notifyEnable",
      enable: isEnable(match[1]),
    }
  }

  match = text.match(/^#绑定(国际服|海外服)(cookie|Cookie)(\d*)\s+(.+)$/)
  if (match) {
    return {
      ok: true,
      type: "osCookie",
      cookie: match[4].trim(),
    }
  }

  match = text.match(/^#(启用|开启|关闭|禁用)(国际服|海外服)(签到)?\d*$/)
  if (match) {
    return {
      ok: true,
      type: "osEnable",
      enable: isEnable(match[1]),
    }
  }

  match = text.match(/^#设置(国际服|海外服)语言(\d*)\s+([a-zA-Z_-]+)$/)
  if (match) {
    return {
      ok: true,
      type: "osLang",
      lang: match[3],
    }
  }

  match = text.match(/^#绑定云(原神|绝区零)token(\d*)\s+(.+)$/)
  if (match) {
    return {
      ok: true,
      type: "cloudToken",
      game: match[1] === "原神" ? "genshin" : "zzz",
      token: match[3].trim(),
    }
  }

  match = text.match(/^#(启用|开启|关闭|禁用)云(原神|绝区零)(签到)?\d*$/)
  if (match) {
    return {
      ok: true,
      type: "cloudEnable",
      game: match[2] === "原神" ? "genshin" : "zzz",
      enable: isEnable(match[1]),
    }
  }

  match = text.match(/^#(绑定|设置|切换)(原神|星铁|崩铁|绝区零|绝)(uid|UID)(\d*)\s*(\d{8,10})$/)
  if (match) {
    return {
      ok: true,
      type: "roleUid",
      game: ROLE_GAME_KEYS[match[2]],
      uid: match[5],
    }
  }

  return { ok: false, reason: "unknown_command" }
}

export function parseProfileIdFromSettingsMessage(message = "") {
  const text = String(message || "").trim()
  const fixed = text.match(/^#(?:固定|设置)签到时间(\d*)\s+\d{1,2}:\d{2}$/)
  if (fixed) return normalizeProfileId(fixed[1] || 1)
  const osCookie = text.match(/^#绑定(?:国际服|海外服)(?:cookie|Cookie)(\d*)\s+.+$/)
  if (osCookie) return normalizeProfileId(osCookie[1] || 1)
  const osLang = text.match(/^#设置(?:国际服|海外服)语言(\d*)\s+[a-zA-Z_-]+$/)
  if (osLang) return normalizeProfileId(osLang[1] || 1)
  const cloudToken = text.match(/^#绑定云(?:原神|绝区零)token(\d*)\s+.+$/)
  if (cloudToken) return normalizeProfileId(cloudToken[1] || 1)
  const roleUid = text.match(/^#(?:绑定|设置|切换)(?:原神|星铁|崩铁|绝区零|绝)(?:uid|UID)(\d*)\s*\d{8,10}$/)
  if (roleUid) return normalizeProfileId(roleUid[1] || 1)
  return parseProfileIdFromMessage(text)
}

export function applyProfileSettingsAction(profile, action) {
  profile.profile ||= {}
  profile.profile.notify ||= { enable: true, prefer: "private", fallback_groups: [] }
  profile.mihoyobbs ||= {}
  profile.games ||= {}
  profile.games.cn ||= {}
  profile.games.cn.genshin ||= {}
  profile.games.cn.honkai2 ||= {}
  profile.games.cn.honkai3rd ||= {}
  profile.games.cn.tears_of_themis ||= {}
  profile.games.cn.honkai_sr ||= {}
  profile.games.cn.zzz ||= {}
  profile.games.cn.hna ||= {}
  profile.schedule ||= {}
  profile.games.os ||= {}
  profile.account ||= {}
  profile.account.game_roles ||= {}
  profile.account.current_uid ||= {}
  profile.account.game_roles.gs ||= []
  profile.account.game_roles.sr ||= []
  profile.account.game_roles.zzz ||= []
  profile.cloud_games ||= {}
  profile.cloud_games.cn ||= {}
  profile.cloud_games.cn.genshin ||= {}
  profile.cloud_games.cn.zzz ||= {}

  if (action.type === "register") {
    profile.enabled = true
    return profile
  }

  if (action.type === "registerGroup") {
    profile.enabled = true
    profile.profile.notify.fallback_groups ||= []
    return profile
  }

  if (action.type === "bindNotifyGroup") {
    profile.profile.notify.prefer = "group"
    profile.profile.notify.fallback_groups ||= []
    return profile
  }

  if (action.type === "bbs") {
    profile.mihoyobbs.enable = action.enable
    if (action.enable) profile.mihoyobbs.tasks = { ...profile.mihoyobbs.tasks, checkin: true }
    return profile
  }

  if (action.type === "game") {
    profile.games.cn[action.game].checkin = action.enable
    return profile
  }

  if (action.type === "allGames") {
    profile.games.cn.genshin.checkin = action.enable
    profile.games.cn.honkai2.checkin = action.enable
    profile.games.cn.honkai3rd.checkin = action.enable
    profile.games.cn.tears_of_themis.checkin = action.enable
    profile.games.cn.honkai_sr.checkin = action.enable
    profile.games.cn.zzz.checkin = action.enable
    profile.games.cn.hna.checkin = action.enable
    return profile
  }

  if (action.type === "schedule") {
    profile.schedule.mode = action.mode
    profile.schedule.fixed_time = action.mode === "fixed" ? action.time : ""
    return profile
  }

  if (action.type === "notify") {
    profile.profile.notify.prefer = action.prefer
    return profile
  }

  if (action.type === "notifyEnable") {
    profile.profile.notify.enable = action.enable
    return profile
  }

  if (action.type === "osCookie") {
    profile.games.os.enable = true
    profile.games.os.cookie = action.cookie
    return profile
  }

  if (action.type === "osEnable") {
    profile.games.os.enable = action.enable
    return profile
  }

  if (action.type === "osLang") {
    profile.games.os.lang = action.lang
    return profile
  }

  if (action.type === "cloudToken") {
    profile.cloud_games.cn[action.game].enable = true
    profile.cloud_games.cn[action.game].token = action.token
    return profile
  }

  if (action.type === "cloudEnable") {
    profile.cloud_games.cn[action.game].enable = action.enable
    return profile
  }

  if (action.type === "roleUid") {
    const roles = profile.account.game_roles[action.game]
    if (!roles.some(role => String(role.uid || role.game_uid || role) === String(action.uid))) {
      roles.push({ uid: String(action.uid) })
    }
    profile.account.current_uid[action.game] = String(action.uid)
    return profile
  }

  return profile
}

function describeAction(action) {
  if (action.type === "register") return "已注册自动签到 profile。"
  if (action.type === "registerGroup") return "已注册本群作为通知 fallback。"
  if (action.type === "bindNotifyGroup") return `已将${action.groupId ? `群 ${action.groupId}` : "当前群"}设置为签到通知群。`
  if (action.type === "bbs") return action.enable ? "已启用社区签到。" : "已关闭社区签到。"
  if (action.type === "game") return `${gameLabel(action.game)}签到已${action.enable ? "启用" : "关闭"}。`
  if (action.type === "allGames") return `全部游戏签到已${action.enable ? "启用" : "关闭"}。`
  if (action.type === "schedule") {
    if (action.mode === "inherit") return "签到时间已改为跟随全局。"
    if (action.mode === "random") return "签到时间已改为随机。"
    return `签到时间已固定为 ${action.time}。`
  }
  if (action.type === "notify") return `通知偏好已改为${action.prefer === "group" ? "群聊" : "私聊"}。`
  if (action.type === "notifyEnable") return `签到通知已${action.enable ? "开启" : "关闭"}。`
  if (action.type === "osCookie") return "国际服 cookie 已保存。"
  if (action.type === "osEnable") return `国际服任务已${action.enable ? "启用" : "关闭"}。`
  if (action.type === "osLang") return `国际服语言已设置为 ${action.lang}。`
  if (action.type === "cloudToken") return `云${action.game === "genshin" ? "原神" : "绝区零"} token 已保存。`
  if (action.type === "cloudEnable") return `云${action.game === "genshin" ? "原神" : "绝区零"}任务已${action.enable ? "启用" : "关闭"}。`
  if (action.type === "roleUid") return `${roleGameLabel(action.game)} UID 已设置为 ${action.uid}。`
  return "配置已更新。"
}

function normalizeTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return ""
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return ""
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

function isEnable(value) {
  return value === "启用" || value === "开启"
}

function gameLabel(key) {
  return {
    genshin: "原神",
    honkai2: "崩坏2",
    honkai3rd: "崩坏3",
    tears_of_themis: "未定事件簿",
    honkai_sr: "星铁",
    zzz: "绝区零",
    hna: "因缘精灵",
  }[key] || key
}

function roleGameLabel(key) {
  return key === "gs" ? "原神" : key === "sr" ? "星铁" : "绝区零"
}
