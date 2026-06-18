import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { resolveConfig } from "../path.js"
import {
  CURRENT_GLOBAL_CONFIG_VERSION,
  createDefaultGlobalConfig,
} from "./defaults.js"
import { assertValidGlobalConfig } from "./schema.js"
import { migrateLegacyPermissionControl } from "../permissions/service.js"

export const GLOBAL_CONFIG_FILE = "global.yaml"
export const GLOBAL_EXAMPLE_FILE = "global.example.yaml"

export function globalConfigFilePath(fileName = GLOBAL_CONFIG_FILE) {
  return resolveConfig(fileName)
}

export async function loadGlobalConfig(options = {}) {
  const { createIfMissing = false, fileName = GLOBAL_CONFIG_FILE } = options
  const file = globalConfigFilePath(fileName)

  try {
    const raw = await fs.readFile(file, "utf8")
    return assertValidGlobalConfig(migrateGlobalConfig(YAML.parse(raw)))
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    const config = createDefaultGlobalConfig()
    if (createIfMissing) await saveGlobalConfig(config, { fileName })
    return assertValidGlobalConfig(config)
  }
}

export async function saveGlobalConfig(config, options = {}) {
  const { fileName = GLOBAL_CONFIG_FILE } = options
  const file = globalConfigFilePath(fileName)
  const migrated = assertValidGlobalConfig(migrateGlobalConfig(config))

  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, YAML.stringify(migrated), "utf8")
  return file
}

export function migrateGlobalConfig(config = {}) {
  if (!config || typeof config !== "object") {
    throw new Error("Invalid global config")
  }

  const base = createDefaultGlobalConfig()
  const normalizedConfig = normalizeLegacyGlobalShape(config)
  const legacyPermissions = findLegacyPermissionControl(normalizedConfig)
  const hasExplicitPermissions = Object.prototype.hasOwnProperty.call(normalizedConfig, "permissions")
  const patch = {
    ...normalizedConfig,
    version: CURRENT_GLOBAL_CONFIG_VERSION,
  }
  if (legacyPermissions) {
    patch.permissions = hasExplicitPermissions
      ? mergeLegacyPermissionLists(normalizedConfig.permissions || {}, legacyPermissions)
      : legacyPermissions
  }

  return assertValidGlobalConfig(mergeConfig(base, {
    ...patch,
  }))
}

export function normalizeLegacyGlobalShape(config = {}) {
  const next = structuredClone(config)

  if (typeof next.schedule === "string") {
    next.scheduler ||= {}
    next.scheduler.mode ||= "fixed"
    const fixedTime = cronToTime(next.schedule)
    if (fixedTime) next.scheduler.fixed_time ||= fixedTime
  }

  if (typeof next.logRetentionDays !== "undefined") {
    next.logging ||= {}
    next.logging.retention_days = Number(next.logRetentionDays)
  }

  if (next.bilibili && typeof next.bilibili === "object") {
    next.bilibili = normalizeLegacyBilibili(next.bilibili, next.external_tools)
  }

  if (next.neteasePartner && typeof next.neteasePartner === "object" && !next.netease_partner) {
    next.netease_partner = normalizeLegacyNetease(next.neteasePartner)
  }

  if (looksLikeLoveMysCaptcha(next)) {
    next.captcha = mergeConfig(next.captcha || {}, normalizeLoveMysCaptcha(next))
  } else if (next.captcha && looksLikeLoveMysCaptcha(next.captcha)) {
    next.captcha = mergeConfig(next.captcha, normalizeLoveMysCaptcha(next.captcha))
  }

  normalizeLegacyPermissionScopes(next.permissions)
  return next
}

export function normalizeLoveMysCaptcha(source = {}) {
  const providers = ["test_nine"]
  const query = String(source.query || "")
  const type = String(source.type ?? "").toLowerCase()
  const gtestType = String(source.GtestType ?? source.gtestType ?? "").toLowerCase()

  if (type === "1" || type.includes("ttocr") || source.api || source.resapi || source.key) providers.push("ttocr")
  if (source.startApi === true || type.includes("test") || type === "2") providers.push("test_nine")
  if (source.verifyAddr || source.verify_addr || source.Address || source.address || gtestType === "2") providers.push("gtmanual")

  return {
    providers: unique(providers.length ? providers : ["test_nine", "ttocr", "gtmanual"]),
    ttocr: {
      enable: Boolean(source.key || source.api || source.resapi),
      api: source.api || "http://api.ttocr.com/api/recognize",
      resapi: source.resapi || "http://api.ttocr.com/api/results",
      key: source.key || "",
      query: query || "itemid=388&referer=https://webstatic.mihoyo.com/",
    },
    gtmanual: {
      enable: Boolean(source.verifyAddr || source.verify_addr || source.Address || source.address),
      address: source.Address || source.address || "https://gt.lotusshared.cn/",
      verify_addr: source.verifyAddr || source.verify_addr || "https://gt.lotusshared.cn/GTest/register?key=114514",
    },
    test_nine: {
      enable: true,
      endpoint: source.test_nine_endpoint || source.endpoint || "http://127.0.0.1:9645/pass_uni",
    },
  }
}

function findLegacyPermissionControl(config = {}) {
  const legacy = config.permissionControl
    || config.permission_control
    || config.checkin?.permissionControl
    || config.checkin?.permission_control
  if (!legacy || typeof legacy !== "object") return null
  return migrateLegacyPermissionControl(legacy)
}

function normalizeLegacyBilibili(input = {}, externalTools = {}) {
  const next = { ...input }
  const download = { ...(input.download || {}) }

  if (typeof input.sessData !== "undefined" && typeof next.sessdata === "undefined") {
    next.sessdata = input.sessData
  }
  if (typeof input.useAria2 !== "undefined") download.use_aria2 = Boolean(input.useAria2)
  if (typeof input.resolution !== "undefined") download.resolution = Number(input.resolution)
  if (typeof input.durationLimit !== "undefined") download.duration_limit_seconds = Number(input.durationLimit)
  if (typeof input.videoSizeLimit !== "undefined") download.video_size_limit_mb = Number(input.videoSizeLimit)
  if (typeof input.maxSizeLimit !== "undefined") download.max_estimated_size_mb = Number(input.maxSizeLimit)
  if (typeof input.multiPagePolicy !== "undefined") download.multi_page_policy = String(input.multiPagePolicy)
  if (typeof input.enableCache !== "undefined") download.cache_enable = Boolean(input.enableCache)
  if (typeof input.cacheTTL !== "undefined") download.cache_ttl_seconds = Number(input.cacheTTL)
  if (typeof externalTools?.toolsPath !== "undefined") download.tools_path = String(externalTools.toolsPath || "")

  if (Object.keys(download).length) next.download = download
  return next
}

function normalizeLegacyPermissionScopes(permissions = {}) {
  if (!permissions?.scopes || typeof permissions.scopes !== "object") return
  if (permissions.scopes["remote.exec"] && !permissions.scopes["remote.spawn"]) {
    permissions.scopes["remote.spawn"] = permissions.scopes["remote.exec"]
  }
  delete permissions.scopes["remote.exec"]
}

function normalizeLegacyNetease(input = {}) {
  return {
    enable: Boolean(input.enable),
    api_url: input.apiUrl || input.api_url || "http://127.0.0.1:3000",
    schedule: input.schedule || "0 5 0 * * *",
    auto_catch_up: Boolean(input.autoCatchUp ?? input.auto_catch_up),
    accounts: Array.isArray(input.accounts) ? input.accounts : [],
  }
}

function looksLikeLoveMysCaptcha(value = {}) {
  if (!value || typeof value !== "object") return false
  return ["api", "resapi", "verifyAddr", "Address", "GtestType", "startApi"].some(key => key in value)
}

function cronToTime(cron = "") {
  const parts = String(cron || "").trim().split(/\s+/)
  if (parts.length < 5) return ""
  const minute = Number(parts.length >= 6 ? parts[1] : parts[0])
  const hour = Number(parts.length >= 6 ? parts[2] : parts[1])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return ""
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return ""
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

function mergeLegacyPermissionLists(current = {}, legacy = {}) {
  return {
    ...current,
    default_policy: current.default_policy || legacy.default_policy,
    users: {
      allow: unique([...(legacy.users?.allow || []), ...(current.users?.allow || [])]),
      deny: unique([...(legacy.users?.deny || []), ...(current.users?.deny || [])]),
    },
    groups: {
      allow: unique([...(legacy.groups?.allow || []), ...(current.groups?.allow || [])]),
      deny: unique([...(legacy.groups?.deny || []), ...(current.groups?.deny || [])]),
    },
    scopes: {
      ...(legacy.scopes || {}),
      ...(current.scopes || {}),
    },
  }
}

function unique(values = []) {
  return [...new Set(values.map(String).filter(Boolean))]
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
