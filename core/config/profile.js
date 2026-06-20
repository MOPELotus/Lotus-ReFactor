import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { resolveData } from "../path.js"
import { assertValidProfile } from "./schema.js"

const CURRENT_VERSION = 1
export const MAX_PROFILE_ID = 255
export const PROFILE_ID_SUFFIX_PATTERN = "(?:[1-9]|[1-9]\\d|1\\d\\d|2[0-4]\\d|25[0-5])?"

export function normalizeProfileId(value = 1) {
  const profileId = Number(value || 1)
  if (!Number.isInteger(profileId) || profileId < 1 || profileId > MAX_PROFILE_ID) {
    throw new Error(`Invalid profileId: ${value}. Profile id must be 1-${MAX_PROFILE_ID}.`)
  }
  return profileId
}

export function profileSuffix(profileId = 1) {
  const id = normalizeProfileId(profileId)
  return id === 1 ? "" : `-${id}`
}

export function profileFileName(qq, profileId = 1) {
  if (!qq) throw new Error("qq is required")
  return `${qq}${profileSuffix(profileId)}.yaml`
}

export function profileFilePath(qq, profileId = 1) {
  return resolveData("users", profileFileName(qq, profileId))
}

export function isMissingProfileError(error) {
  return error?.code === "ENOENT"
}

export function profileLoginRequiredMessage(profileId = 1) {
  const id = normalizeProfileId(profileId)
  return `profile ${id} 需要重新扫码登录，请发送 #扫码登录${id === 1 ? "" : id} 后再使用。`
}

export function profileLoginRequiredError(profileId = 1) {
  const error = new Error(profileLoginRequiredMessage(profileId))
  error.code = "LOTUS_PROFILE_LOGIN_REQUIRED"
  error.profileId = normalizeProfileId(profileId)
  return error
}

export function isProfileLoginRequiredError(error) {
  return error?.code === "LOTUS_PROFILE_LOGIN_REQUIRED" || isMissingProfileError(error)
}

export function hasProfileLogin(profile = {}) {
  const account = profile?.account || {}
  return Boolean(
    String(account.cookie || "").trim()
    && String(account.stoken || account.stoken_cookie || "").trim(),
  )
}

export function assertProfileLogin(profile, profileId = profile?.profile?.id || 1) {
  if (!hasProfileLogin(profile)) throw profileLoginRequiredError(profileId)
  return profile
}

export async function loadLoggedInProfile(qq, profileId = 1) {
  const id = normalizeProfileId(profileId)
  let profile
  try {
    profile = await loadProfile(qq, id)
  } catch (error) {
    if (isMissingProfileError(error)) throw profileLoginRequiredError(id)
    throw error
  }
  return assertProfileLogin(profile, id)
}

export async function listProfileIds(qq) {
  if (!qq) throw new Error("qq is required")
  const dir = resolveData("users")
  const pattern = new RegExp(`^${escapeRegExp(String(qq))}(?:-(\\d+))?\\.yaml$`)

  try {
    const files = await fs.readdir(dir)
    return files
      .map(file => file.match(pattern))
      .filter(Boolean)
      .map(match => normalizeProfileId(match[1] || 1))
      .sort((a, b) => a - b)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

export async function listAllProfiles() {
  const dir = resolveData("users")
  try {
    const files = await fs.readdir(dir)
    const profiles = []
    for (const file of files) {
      const match = file.match(/^(.+?)(?:-(\d+))?\.yaml$/)
      if (!match) continue
      profiles.push(await loadProfile(match[1], match[2] || 1))
    }
    return profiles.sort((a, b) => {
      const aq = String(a.user?.qq || "")
      const bq = String(b.user?.qq || "")
      if (aq !== bq) return aq.localeCompare(bq)
      return (a.profile?.id || 1) - (b.profile?.id || 1)
    })
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

export function parseProfileIdFromMessage(message = "") {
  const match = String(message).trim().match(/(\d+)$/)
  return normalizeProfileId(match?.[1] || 1)
}

export function createDefaultProfile({ qq, profileId = 1, nickname = "" } = {}) {
  const id = normalizeProfileId(profileId)
  if (!qq) throw new Error("qq is required")

  return {
    version: CURRENT_VERSION,
    enabled: false,
    user: {
      qq: String(qq),
      nickname,
    },
    profile: {
      id,
      name: id === 1 ? "default" : `profile-${id}`,
      notify: {
        enable: true,
        prefer: "private",
        fallback_groups: [],
      },
    },
    account: {
      ltuid: "",
      cookie: "",
      stuid: "",
      stoken: "",
      mid: "",
      ltoken: "",
      game_roles: {
        gs: [],
        sr: [],
        zzz: [],
      },
      current_uid: {
        gs: "",
        sr: "",
        zzz: "",
      },
    },
    device: {
      bound: false,
      name: "",
      model: "",
      id: "",
      fp: "",
      android_version: "",
      raw: null,
    },
    schedule: {
      mode: "inherit",
      fixed_time: "",
      allow_random: true,
    },
    mihoyobbs: {
      enable: false,
      tasks: {
        checkin: false,
        read: true,
        like: true,
        cancel_like: true,
        share: true,
      },
      checkin_list: [1, 2, 3, 4, 5, 6, 8, 9, 10],
    },
    games: {
      cn: {
        enable: true,
        ua_mode: "device",
        genshin: {
          checkin: true,
          black_list: [],
        },
        honkai2: {
          checkin: false,
          black_list: [],
        },
        honkai3rd: {
          checkin: false,
          black_list: [],
        },
        tears_of_themis: {
          checkin: false,
          black_list: [],
        },
        honkai_sr: {
          checkin: true,
          black_list: [],
        },
        zzz: {
          checkin: true,
          black_list: [],
        },
        hna: {
          checkin: false,
          black_list: [],
        },
      },
      os: {
        enable: false,
        cookie: "",
        lang: "zh-cn",
        genshin: {
          checkin: false,
          black_list: [],
        },
        honkai3rd: {
          checkin: false,
          black_list: [],
        },
        tears_of_themis: {
          checkin: false,
          black_list: [],
        },
        honkai_sr: {
          checkin: false,
          black_list: [],
        },
        zzz: {
          checkin: false,
          black_list: [],
        },
      },
    },
    cloud_games: {
      cn: {
        genshin: {
          enable: false,
          token: "",
        },
        zzz: {
          enable: false,
          token: "",
        },
      },
    },
  }
}

export async function loadProfile(qq, profileId = 1) {
  const file = profileFilePath(qq, profileId)
  const raw = await fs.readFile(file, "utf8")
  const profile = YAML.parse(raw)
  return migrateProfile(profile, { qq, profileId })
}

export async function saveProfile(profile) {
  assertValidProfile(profile)
  const qq = profile?.user?.qq
  const profileId = profile?.profile?.id
  const file = profileFilePath(qq, profileId)

  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, YAML.stringify(profile), "utf8")
  return file
}

export async function ensureProfile({ qq, profileId = 1, nickname = "" } = {}) {
  try {
    return await loadProfile(qq, profileId)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }

  const profile = createDefaultProfile({ qq, profileId, nickname })
  await saveProfile(profile)
  return profile
}

export function migrateProfile(profile, fallback = {}) {
  if (!profile || typeof profile !== "object") {
    throw new Error("Invalid profile yaml")
  }

  const profileId = normalizeProfileId(profile?.profile?.id || fallback.profileId || 1)
  const qq = String(profile?.user?.qq || fallback.qq || "")
  const base = createDefaultProfile({
    qq,
    profileId,
    nickname: profile?.user?.nickname || "",
  })

  return assertValidProfile(mergeProfile(base, {
    ...profile,
    version: CURRENT_VERSION,
    user: {
      ...base.user,
      ...profile.user,
      qq,
    },
    profile: {
      ...base.profile,
      ...profile.profile,
      id: profileId,
    },
  }))
}

function mergeProfile(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch ?? base

  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    result[key] = key in base ? mergeProfile(base[key], value) : value
  }
  return result
}

function isPlainObject(value) {
  return value && typeof value === "object" && value.constructor === Object
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
