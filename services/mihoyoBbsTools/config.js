import { createDefaultProfile } from "../../core/config/profile.js"

export function buildBbsToolsConfig(profile) {
  const base = createBbsToolsDefaultConfig()
  const account = profile?.account || {}
  const device = profile?.device || {}
  const mihoyobbs = profile?.mihoyobbs || {}
  const games = profile?.games || {}
  const cloudGames = profile?.cloud_games || {}

  return mergeConfig(base, {
    account: {
      cookie: account.cookie || "",
      stuid: account.stuid || "",
      stoken: account.stoken || "",
      mid: account.mid || "",
    },
    device: {
      name: device.name || base.device.name,
      model: device.model || base.device.model,
      id: device.id || "",
      fp: device.fp || "",
    },
    mihoyobbs: {
      enable: Boolean(mihoyobbs.enable),
      checkin: Boolean(mihoyobbs.tasks?.checkin ?? mihoyobbs.checkin),
      checkin_list: mihoyobbs.checkin_list || base.mihoyobbs.checkin_list,
      read: Boolean(mihoyobbs.tasks?.read ?? mihoyobbs.read),
      like: Boolean(mihoyobbs.tasks?.like ?? mihoyobbs.like),
      cancel_like: Boolean(mihoyobbs.tasks?.cancel_like ?? mihoyobbs.cancel_like),
      share: Boolean(mihoyobbs.tasks?.share ?? mihoyobbs.share),
    },
    games: {
      cn: {
        enable: Boolean(games.cn?.enable),
        useragent: buildUserAgent(profile),
        genshin: normalizeGameSwitch(games.cn?.genshin),
        honkai2: normalizeGameSwitch(games.cn?.honkai2),
        honkai3rd: normalizeGameSwitch(games.cn?.honkai3rd),
        tears_of_themis: normalizeGameSwitch(games.cn?.tears_of_themis),
        honkai_sr: normalizeGameSwitch(games.cn?.honkai_sr),
        zzz: normalizeGameSwitch(games.cn?.zzz),
        hna: normalizeGameSwitch(games.cn?.hna),
      },
      os: {
        enable: Boolean(games.os?.enable),
        cookie: games.os?.cookie || "",
        lang: games.os?.lang || "zh-cn",
        genshin: normalizeGameSwitch(games.os?.genshin),
        honkai3rd: normalizeGameSwitch(games.os?.honkai3rd),
        tears_of_themis: normalizeGameSwitch(games.os?.tears_of_themis),
        honkai_sr: normalizeGameSwitch(games.os?.honkai_sr),
        zzz: normalizeGameSwitch(games.os?.zzz),
      },
    },
    cloud_games: {
      cn: {
        enable: Boolean(cloudGames.cn?.genshin?.enable || cloudGames.cn?.zzz?.enable),
        genshin: {
          enable: Boolean(cloudGames.cn?.genshin?.enable),
          token: cloudGames.cn?.genshin?.token || "",
        },
        zzz: {
          enable: Boolean(cloudGames.cn?.zzz?.enable),
          token: cloudGames.cn?.zzz?.token || "",
        },
      },
    },
  })
}

export function createBbsToolsDefaultConfig() {
  const profile = createDefaultProfile({ qq: "0" })
  return {
    enable: true,
    version: 15,
    push: "",
    account: {
      cookie: "",
      stuid: "",
      stoken: "",
      mid: "",
    },
    device: {
      name: "Xiaomi MI 6",
      model: "Mi 6",
      id: "",
      fp: "",
    },
    mihoyobbs: {
      enable: false,
      checkin: false,
      checkin_list: profile.mihoyobbs.checkin_list,
      read: true,
      like: true,
      cancel_like: true,
      share: true,
    },
    games: {
      cn: {
        enable: true,
        useragent: buildUserAgent(profile),
        retries: 3,
        genshin: { checkin: true, black_list: [] },
        honkai2: { checkin: false, black_list: [] },
        honkai3rd: { checkin: false, black_list: [] },
        tears_of_themis: { checkin: false, black_list: [] },
        honkai_sr: { checkin: true, black_list: [] },
        zzz: { checkin: true, black_list: [] },
      },
      os: {
        enable: false,
        cookie: "",
        lang: "zh-cn",
        genshin: { checkin: false, black_list: [] },
        honkai3rd: { checkin: false, black_list: [] },
        tears_of_themis: { checkin: false, black_list: [] },
        honkai_sr: { checkin: false, black_list: [] },
        zzz: { checkin: false, black_list: [] },
      },
    },
    cloud_games: {
      cn: {
        enable: false,
        genshin: { enable: false, token: "" },
        zzz: { enable: false, token: "" },
      },
      os: {
        enable: false,
        lang: "zh-cn",
        genshin: { enable: false, token: "" },
      },
    },
    competition: {
      enable: false,
      genius_invokation: { enable: false, account: [], checkin: false, weekly: false },
    },
    web_activity: {
      enable: false,
      activities: [],
    },
  }
}

export function buildUserAgent(profile) {
  const custom = profile?.games?.cn?.useragent || profile?.games?.cn?.custom_useragent
  if (custom && profile?.games?.cn?.ua_mode === "custom") return custom
  const device = profile?.device || {}
  const android = device.android_version || "12"
  const model = device.model || "Unspecified Device"
  return `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/103.0.5060.129 Mobile Safari/537.36`
}

function normalizeGameSwitch(value = {}) {
  return {
    checkin: Boolean(value.checkin),
    black_list: Array.isArray(value.black_list) ? value.black_list : [],
  }
}

function mergeConfig(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch ?? base
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    result[key] = key in base ? mergeConfig(base[key], value) : value
  }
  return result
}

function isPlainObject(value) {
  return value && typeof value === "object" && value.constructor === Object
}
