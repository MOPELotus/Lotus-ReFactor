import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { resolveData, rootPath } from "../../core/path.js"
import {
  AuthKeyService,
  getServer,
} from "../mihoyoAuthKey/service.js"
import { isCnServer } from "../../core/mihoyo/regions.js"
import { formatLocalFileTimestamp } from "../../core/time.js"
import { MIHOYO } from "../../core/mihoyo/constants.js"
import { getDs2 } from "../../core/mihoyo/ds.js"
import { AccountService } from "../../core/login/account.js"
import { isCookieRefreshableResponse } from "../../core/captcha/mysHandler.js"

export const ZZZ_GACHA_POOLS = Object.freeze({
  "音擎频段": ["3001"],
  "音擎回响": ["13001"],
  "独家频段": ["2001"],
  "独家重映": ["12001"],
  "常驻频段": ["1001"],
  "邦布频段": ["5001"],
})

export const ZZZ_CK_GACHA_POOLS = Object.freeze({
  "音擎频段": ["GACHA_TYPE_WEAPON_UP"],
  "音擎回响": ["GACHA_TYPE_WEAPON_RETURN"],
  "独家频段": ["GACHA_TYPE_CHARACTER_UP"],
  "独家重映": ["GACHA_TYPE_CHARACTER_RETURN"],
  "常驻频段": ["GACHA_TYPE_PERMANENT"],
  "邦布频段": ["GACHA_TYPE_BANGBOO"],
})

const CN_API = "https://public-operation-common.mihoyo.com/common/gacha_record/api/getGachaLog"
const OS_API = "https://public-operation-common-sg.hoyoverse.com/common/gacha_record/api/getGachaLog"
const CN_CK_API = "https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/gacha_record"
const OS_CK_API = "https://sg-public-api.hoyolab.com/event/game_record_zzz/api/zzz/gacha_record"
const ZZZ_DS_SALT_CN = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs"
const ZZZ_DS_SALT_OS = "okr4obncj8bw5a65hbnn5oo6ixjc3l9w"
const CK_ITEM_TYPE = Object.freeze({
  ITEM_TYPE_WEAPON: "音擎",
  ITEM_TYPE_AVATAR: "代理人",
  ITEM_TYPE_BANGBOO: "邦布",
})
const CK_RARITY = Object.freeze({
  B: "2",
  A: "3",
  S: "4",
})

let zzzGachaRequestQueue = Promise.resolve()
let zzzGachaLastRequestAt = 0
let zzzGachaBlockedUntil = 0

export class ZzzGachaService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.authKeyService = options.authKeyService || new AuthKeyService({ fetch: this.fetch })
    this.accountService = options.accountService || new AccountService({ fetch: this.fetch })
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.storageDir = options.storageDir || resolveData("zzzGachaJson")
    this.authCacheFile = options.authCacheFile || resolveData("zzzGachaAuthkey", "cache.json")
    this.zzzPluginDir = options.zzzPluginDir || ""
    this.mirrorZzzPlugin = options.mirrorZzzPlugin !== false
    this.pageDelayMs = Number(options.pageDelayMs ?? 0)
    this.requestDelayMs = Number(options.requestDelayMs ?? 1200)
    this.rateLimitRetries = Number(options.rateLimitRetries ?? 2)
    this.rateLimitBackoffMs = Number(options.rateLimitBackoffMs ?? 15_000)
    this.maxPages = Number(options.maxPages ?? 50)
    this.authkeyTtlMs = Number(options.authkeyTtlMs ?? 24 * 60 * 60 * 1000)
  }

  async updateByProfile({ qq, profile, profileId = 1 } = {}) {
    const role = pickRole(profile, "zzz")
    const uid = getRoleUid(role)
    if (!uid) throw new Error(`profile ${profileId} 没有同步绝区零 UID`)

    const region = role?.region || getServer(uid, "zzz")
    const gameBiz = getZzzGameBiz(region)
    let ckError = null
    if (profile?.account?.cookie) {
      try {
        const result = await this.updateByCookie({
          qq,
          uid,
          cookie: profile.account.cookie,
          device: profile.device,
          region,
          gameBiz,
        })
        return {
          ...result,
          uid,
          profileId,
          region,
          gameBiz,
          source: "cookie",
        }
      } catch (error) {
        ckError = error
        if (isRateLimitedError(error)) throw error
        if (isCookieRefreshableResponse(error?.response) && profile?.account?.stoken) {
          const refreshed = await this.accountService.refresh(qq, profileId)
          try {
            const result = await this.updateByCookie({
              qq,
              uid,
              cookie: refreshed.account?.cookie,
              device: refreshed.device,
              region,
              gameBiz,
            })
            return {
              ...result,
              uid,
              profileId,
              region,
              gameBiz,
              source: "cookie",
              refreshedCookie: true,
            }
          } catch (retryError) {
            ckError = retryError
            if (isRateLimitedError(retryError)) throw retryError
          }
        }
        if (!profile?.account?.stoken_cookie) throw ckError
        logger?.warn?.(`[Lotus-Plugin] zzz ck gacha update failed, fallback to authkey: ${ckError.message}`)
      }
    }

    if (!profile?.account?.stoken_cookie) throw new Error(`profile ${profileId} 缺少 cookie/stoken，无法更新绝区零抽卡记录`)

    const auth = await this.getCachedAuthKey({
      qq,
      profile,
      profileId,
      game: "zzz",
      uid,
      region,
      gameBiz,
      authAppId: "webview_gacha",
    })
    let result
    try {
      result = await this.updateByAuthkey({
        qq,
        uid,
        authkey: auth.authkey,
        region,
        gameBiz,
      })
    } catch (error) {
      if (!isInvalidAuthkeyError(error)) throw error
      await this.clearCachedAuthKey({ qq, profile, profileId, uid, region, gameBiz })
      const freshAuth = await this.getCachedAuthKey({
        qq,
        profile,
        profileId,
        game: "zzz",
        uid,
        region,
        gameBiz,
        authAppId: "webview_gacha",
        force: true,
      })
      result = await this.updateByAuthkey({
        qq,
        uid,
        authkey: freshAuth.authkey,
        region,
        gameBiz,
      })
    }
    return {
      ...result,
      uid,
      profileId,
      region,
      gameBiz,
    }
  }

  async updateByCookie({ qq, uid, cookie, device = {}, region = "prod_gf_cn", gameBiz = "nap_cn" } = {}) {
    if (!qq) throw new Error("qq is required")
    if (!uid) throw new Error("zzz uid is required")
    if (!cookie) throw new Error("zzz cookie is required")

    const previous = await this.loadLog(qq, uid)
    const next = normalizeLog(previous)
    const count = {}

    for (const [poolName, types] of Object.entries(ZZZ_CK_GACHA_POOLS)) {
      next[poolName] ||= []
      const lastSaved = next[poolName][0] || null
      const newData = []
      count[poolName] = 0

      for (const type of types) {
        let endId = "0"
        let page = 1
        while (page <= this.maxPages) {
          const data = await this.fetchCkGachaPage({
            cookie,
            device,
            type,
            endId,
            uid,
            region,
            gameBiz,
          })
          const list = Array.isArray(data?.gacha_item_list) ? data.gacha_item_list : []
          if (!list.length) break

          let reachedSaved = false
          for (const item of list.map(item => normalizeCkGachaItem(item, uid))) {
            if (sameGachaItem(lastSaved, item)) {
              reachedSaved = true
              break
            }
            newData.push(item)
            count[poolName] += 1
          }
          if (reachedSaved) break

          endId = list.at(-1)?.id || endId
          page += 1
          if (this.pageDelayMs > 0) await this.sleep(this.pageDelayMs)
        }
      }

      next[poolName] = dedupeGachaItems([...newData, ...next[poolName]])
    }

    await this.saveLog(qq, uid, next)
    return {
      ok: true,
      uid: String(uid),
      data: next,
      count,
      pools: Object.keys(next).map(name => ({
        name,
        total: next[name]?.length || 0,
        added: count[name] || 0,
      })),
    }
  }

  async updateByAuthkey({ qq, uid, authkey, region = "prod_gf_cn", gameBiz = "nap_cn" } = {}) {
    if (!qq) throw new Error("qq is required")
    if (!uid) throw new Error("zzz uid is required")
    if (!authkey) throw new Error("authkey is required")

    const previous = await this.loadLog(qq, uid)
    const next = normalizeLog(previous)
    const count = {}

    for (const [poolName, types] of Object.entries(ZZZ_GACHA_POOLS)) {
      next[poolName] ||= []
      const lastSaved = next[poolName][0] || null
      const newData = []
      count[poolName] = 0

      for (const type of types) {
        let page = 1
        let endId = "0"
        while (page <= this.maxPages) {
          const data = await this.fetchGachaPage({
            authkey,
            type,
            page,
            endId,
            region,
            gameBiz,
          })
          const list = Array.isArray(data?.list) ? data.list : []
          if (!list.length) break

          let reachedSaved = false
          for (const item of list.map(item => normalizeGachaItem(item, uid))) {
            if (sameGachaItem(lastSaved, item)) {
              reachedSaved = true
              break
            }
            newData.push(item)
            count[poolName] += 1
          }
          if (reachedSaved) break

          endId = list.at(-1)?.id || endId
          page += 1
          if (this.pageDelayMs > 0) await this.sleep(this.pageDelayMs)
        }
      }

      next[poolName] = dedupeGachaItems([...newData, ...next[poolName]])
    }

    await this.saveLog(qq, uid, next)
    return {
      ok: true,
      uid: String(uid),
      data: next,
      count,
      pools: Object.keys(next).map(name => ({
        name,
        total: next[name]?.length || 0,
        added: count[name] || 0,
      })),
    }
  }

  async fetchGachaPage({ authkey, type, page = 1, endId = "0", region, gameBiz }) {
    const url = buildZzzGachaLogUrl({
      authkey,
      gachaType: type,
      initLogGachaBaseType: getZzzBaseType(type),
      page,
      endId,
      region,
      gameBiz,
    })
    const res = await this.requestMihoyoJson(url, {}, { prefix: "绝区零抽卡接口" })
    return res?.data || null
  }

  async fetchCkGachaPage({ cookie, device, type, endId = "0", uid, region, gameBiz }) {
    const { url, query } = buildZzzCkGachaRecordUrl({
      uid,
      region,
      gameBiz,
      gachaType: type,
      endId,
    })
    const headers = buildZzzCkHeaders({
      cookie,
      device,
      query,
      region,
    })
    const res = await this.requestMihoyoJson(url, { headers }, { prefix: "绝区零 CK 抽卡接口" })
    return res?.data || null
  }

  async getCachedAuthKey({ qq, profile, profileId = 1, game, uid, region, gameBiz, authAppId, force = false } = {}) {
    const key = authCacheKey({ qq, profile, profileId, uid, region, gameBiz, authAppId })
    const now = Date.now()
    const cache = await this.loadAuthCache()
    const cached = cache[key]
    if (!force && cached?.authkey && Number(cached.expiresAt || 0) > now) {
      return {
        authkey: cached.authkey,
        cached: true,
        expiresAt: cached.expiresAt,
      }
    }

    const auth = await this.authKeyService.getAuthKey({
      profile,
      game,
      uid,
      region,
      authAppId,
    })
    cache[key] = {
      authkey: auth.authkey,
      createdAt: now,
      expiresAt: now + this.authkeyTtlMs,
    }
    await this.saveAuthCache(cache)
    return {
      ...auth,
      cached: false,
      expiresAt: cache[key].expiresAt,
    }
  }

  async clearCachedAuthKey({ qq, profile, profileId = 1, uid, region, gameBiz, authAppId = "webview_gacha" } = {}) {
    const key = authCacheKey({ qq, profile, profileId, uid, region, gameBiz, authAppId })
    const cache = await this.loadAuthCache()
    if (!cache[key]) return false
    delete cache[key]
    await this.saveAuthCache(cache)
    return true
  }

  async loadAuthCache() {
    try {
      const json = JSON.parse(await fs.readFile(this.authCacheFile, "utf8"))
      return json && typeof json === "object" && !Array.isArray(json) ? json : {}
    } catch (error) {
      if (error?.code === "ENOENT") return {}
      throw error
    }
  }

  async saveAuthCache(cache) {
    await fs.mkdir(path.dirname(this.authCacheFile), { recursive: true })
    await fs.writeFile(this.authCacheFile, JSON.stringify(cache, null, 2), "utf8")
  }

  async loadLog(qq, uid) {
    const lotusLog = await readJsonFile(this.logFile(qq, uid))
    const pluginLog = await this.loadZzzPluginLog(uid)
    return mergeLogs(lotusLog, pluginLog)
  }

  async saveLog(qq, uid, data) {
    const file = this.logFile(qq, uid)
    const pluginFile = this.mirrorZzzPlugin ? await this.zzzPluginLogFile(uid) : ""
    const previous = mergeLogs(
      await readJsonFile(file),
      pluginFile ? await readJsonFile(pluginFile) : {},
    )
    const safeData = mergeLogs(previous, data)

    await backupExistingLogFile(file, { uid, source: "lotus" })
    if (pluginFile && path.resolve(pluginFile) !== path.resolve(file)) {
      await backupExistingLogFile(pluginFile, { uid, source: "zzz-plugin" })
    }

    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(safeData, null, 2), "utf8")
    await this.saveZzzPluginLog(uid, safeData, {
      skipBackup: true,
      skipMerge: true,
    })
    return file
  }

  logFile(qq, uid) {
    return path.join(this.storageDir, String(qq), `${uid}.json`)
  }

  async saveZzzPluginLog(uid, data, options = {}) {
    if (!this.mirrorZzzPlugin) return ""
    const file = await this.zzzPluginLogFile(uid)
    if (!file) return ""
    if (!options.skipBackup) await backupExistingLogFile(file, { uid, source: "zzz-plugin" })
    const safeData = options.skipMerge ? data : mergeLogs(await readJsonFile(file), data)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(safeData, null, 2), "utf8")
    return file
  }

  async loadZzzPluginLog(uid) {
    const file = await this.zzzPluginLogFile(uid)
    if (!file) return {}
    return readJsonFile(file)
  }

  async zzzPluginLogFile(uid) {
    const pluginDir = await this.resolveZzzPluginDir()
    return pluginDir ? path.join(pluginDir, "data", "gacha", `${uid}.json`) : ""
  }

  async resolveZzzPluginDir() {
    if (this.zzzPluginDir) return this.zzzPluginDir
    const candidates = [
      path.join(process.cwd(), "plugins", "ZZZ-Plugin"),
      path.join(rootPath, "..", "ZZZ-Plugin"),
    ].filter(Boolean)

    for (const dir of candidates) {
      try {
        const stat = await fs.stat(dir)
        if (stat.isDirectory()) return dir
      } catch {}
    }
    return ""
  }

  async requestJson(url, options = {}) {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    const response = await this.fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    if (!response.ok) throw new Error(`绝区零抽卡请求失败 HTTP ${response.status}`)
    return data
  }

  async requestMihoyoJson(url, options = {}, { prefix = "米游社接口" } = {}) {
    let lastError = null
    for (let attempt = 0; attempt <= this.rateLimitRetries; attempt += 1) {
      try {
        const res = await scheduleZzzGachaRequest(
          () => this.requestJson(url, options),
          { minIntervalMs: this.requestDelayMs, sleep: this.sleep },
        )
        if (Number(res?.retcode ?? 0) !== 0) throw mihoyoResponseError(res, prefix)
        return res
      } catch (error) {
        lastError = error
        if (!isRateLimitedError(error) || attempt >= this.rateLimitRetries) throw error
        const backoff = this.rateLimitBackoffMs * (attempt + 1)
        markZzzGachaRateLimit(backoff)
        logger?.warn?.(`[Lotus-Plugin] zzz gacha rate limited, retry in ${backoff}ms: ${error.message}`)
      }
    }
    throw lastError
  }
}

export function buildZzzGachaLogUrl({
  authkey,
  gachaType = "2001",
  initLogGachaBaseType = "2",
  page = 1,
  endId = "0",
  region = "prod_gf_cn",
  gameBiz = "nap_cn",
  timestamp = Math.floor(Date.now() / 1000),
} = {}) {
  const params = new URLSearchParams({
    authkey_ver: "1",
    sign_type: "2",
    auth_appid: "webview_gacha",
    init_log_gacha_type: gachaType,
    init_log_gacha_base_type: initLogGachaBaseType,
    gacha_id: "2c1f5692fdfbb733a08733f9eb69d32aed1d37",
    timestamp: String(timestamp),
    lang: "zh-cn",
    device_type: "mobile",
    plat_type: "ios",
    region,
    authkey,
    game_biz: gameBiz,
    gacha_type: gachaType,
    real_gacha_type: initLogGachaBaseType,
    page: String(page),
    size: "20",
    end_id: endId,
  })
  return `${gameBiz === "nap_global" ? OS_API : CN_API}?${params}`
}

export function buildZzzCkGachaRecordUrl({
  uid,
  region = "prod_gf_cn",
  gameBiz,
  gachaType = "GACHA_TYPE_CHARACTER_UP",
  endId = "0",
} = {}) {
  const query = new URLSearchParams({
    lang: "zh-cn",
    uid: String(uid || ""),
    region,
    gacha_type: gachaType,
    end_id: String(endId || "0"),
  }).toString()
  const api = getZzzGameBiz(region) === "nap_global" || gameBiz === "nap_global" ? OS_CK_API : CN_CK_API
  return {
    url: `${api}?${query}`,
    query,
  }
}

export function getZzzBaseType(gachaType) {
  if (String(gachaType) === "13001") return "103"
  if (String(gachaType) === "12001") return "102"
  return String(gachaType || "2001")[0] || "2"
}

export function getZzzGameBiz(region = "prod_gf_cn") {
  return isCnServer(region) ? "nap_cn" : "nap_global"
}

function normalizeLog(log = {}) {
  const result = {}
  for (const poolName of Object.keys(ZZZ_GACHA_POOLS)) {
    result[poolName] = Array.isArray(log?.[poolName])
      ? dedupeGachaItems(log[poolName].map(item => normalizeGachaItem(item, item?.uid)))
      : []
  }
  return result
}

function normalizeGachaItem(item = {}, uid) {
  return {
    uid: String(item.uid || uid),
    gacha_id: String(item.gacha_id || "0"),
    gacha_type: normalizeStoredGachaType(item),
    item_id: String(item.item_id || ""),
    count: String(item.count || "1"),
    time: String(item.time || ""),
    name: String(item.name || ""),
    lang: String(item.lang || "zh-cn"),
    item_type: String(item.item_type || ""),
    rank_type: String(item.rank_type || ""),
    id: String(item.id || ""),
    square_icon: item.square_icon || "",
  }
}

function normalizeCkGachaItem(item = {}, uid) {
  const date = item.date && typeof item.date === "object" ? item.date : null
  return {
    uid: String(uid || item.uid || ""),
    gacha_id: "0",
    // ZZZ-Plugin 的 CK 直刷存档固定写 2；去重已按 uid/id 做格式兼容。
    gacha_type: "2",
    item_id: String(item.item_id || ""),
    count: "1",
    time: date ? formatCkDate(date) : String(item.time || ""),
    name: String(item.item_name || item.name || ""),
    lang: "zh-cn",
    item_type: CK_ITEM_TYPE[item.item_type] || String(item.item_type || ""),
    rank_type: CK_RARITY[item.rarity] || String(item.rank_type || item.rarity || ""),
    id: String(item.id || ""),
    square_icon: item.square_icon || "",
  }
}

function sameGachaItem(a, b) {
  return Boolean(a && b && String(a.uid) === String(b.uid) && String(a.id) === String(b.id))
}

function mergeLogs(...logs) {
  const result = {}
  for (const poolName of Object.keys(ZZZ_GACHA_POOLS)) {
    const items = []
    for (const log of logs) {
      if (Array.isArray(log?.[poolName])) items.push(...log[poolName])
    }
    result[poolName] = dedupeGachaItems(items.map(item => normalizeGachaItem(item, item?.uid)))
  }
  return result
}

function dedupeGachaItems(items = []) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    const key = `${item.uid}:${item.id}`
    if (!item.id || seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result.sort(compareGachaItemDesc)
}

function normalizeStoredGachaType(item = {}) {
  const real = String(item.real_gacha_type || "")
  if (real) return real

  const raw = String(item.gacha_type || "")
  if (["3001", "13001", "2001", "12001", "1001", "5001"].includes(raw)) {
    return getZzzBaseType(raw)
  }
  return raw
}

function compareGachaItemDesc(a, b) {
  const idCompare = compareBigIntDesc(a?.id, b?.id)
  if (idCompare) return idCompare
  return String(b?.time || "").localeCompare(String(a?.time || ""))
}

function compareBigIntDesc(a, b) {
  try {
    const left = BigInt(String(a || "0"))
    const right = BigInt(String(b || "0"))
    return right > left ? 1 : right < left ? -1 : 0
  } catch {
    return String(b || "").localeCompare(String(a || ""))
  }
}

async function readJsonFile(file) {
  if (!file) return {}
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return {}
    throw error
  }
}

async function backupExistingLogFile(file, { uid, source } = {}) {
  if (!file) return ""
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size <= 0) return ""
  } catch (error) {
    if (error?.code === "ENOENT") return ""
    throw error
  }

  const backupDir = resolveData("backups", "zzzGacha", String(uid || "unknown"))
  const target = path.join(
    backupDir,
    `${formatLocalFileTimestamp()}-${safeFilePart(source || "log")}-${path.basename(file)}`,
  )
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(file, target)
  return target
}

function safeFilePart(value = "") {
  return String(value).replace(/[^\w.-]+/g, "_").slice(0, 64) || "log"
}

function formatCkDate(date = {}) {
  return [
    String(date.year || "").padStart(4, "0"),
    String(date.month || "").padStart(2, "0"),
    String(date.day || "").padStart(2, "0"),
  ].join("-") + " " + [
    String(date.hour || 0).padStart(2, "0"),
    String(date.minute || 0).padStart(2, "0"),
    String(date.second || 0).padStart(2, "0"),
  ].join(":")
}

function buildZzzCkHeaders({ cookie, device = {}, query = "", region = "prod_gf_cn" } = {}) {
  const cn = isCnServer(region)
  const sysVersion = String(device?.android_version || device?.raw?.androidVersion || device?.raw?.osVersion || "12")
  const model = String(device?.model || device?.raw?.deviceModel || "Lotus")
  const brand = String(device?.raw?.deviceFingerprint || "").split("/")[0] || device?.raw?.deviceBrand || "Android"
  const display = String(device?.raw?.deviceFingerprint || "").split("/")[3] || model
  const appName = cn ? "miHoYoBBS" : "miHoYoBBSOversea"
  const referer = cn ? "https://act.mihoyo.com/" : "https://act.hoyolab.com/"
  const origin = cn ? "https://act.mihoyo.com" : "https://act.hoyolab.com"

  return {
    "x-rpc-app_version": MIHOYO.appVersion,
    "User-Agent": `Mozilla/5.0 (Linux; Android ${sysVersion}; ${model} Build/${display}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.5563.116 Mobile Safari/537.36 ${appName}/${MIHOYO.appVersion}`,
    "x-rpc-sys_version": sysVersion,
    "x-rpc-client_type": "2",
    "x-rpc-channel": "mihoyo",
    "x-rpc-device_fp": device?.fp || "38d7ee0e96649",
    "x-rpc-device_id": device?.id || fallbackDeviceId(cookie),
    "x-rpc-device_name": `${brand} ${model}`,
    "x-rpc-device_model": model,
    "x-rpc-csm_source": "myself",
    Referer: referer,
    Origin: origin,
    Cookie: cookie,
    DS: getDs2(query, "", cn ? ZZZ_DS_SALT_CN : ZZZ_DS_SALT_OS),
  }
}

function fallbackDeviceId(seed = "") {
  return crypto.createHash("md5").update(String(seed || "lotus-zzz")).digest("hex")
}

async function scheduleZzzGachaRequest(fn, { minIntervalMs = 0, sleep } = {}) {
  const run = zzzGachaRequestQueue.catch(() => null).then(async () => {
    const waitUntil = Math.max(
      zzzGachaLastRequestAt + Math.max(0, Number(minIntervalMs) || 0),
      zzzGachaBlockedUntil,
    )
    const waitMs = waitUntil - Date.now()
    if (waitMs > 0) await sleep(waitMs)
    try {
      return await fn()
    } finally {
      zzzGachaLastRequestAt = Date.now()
    }
  })
  zzzGachaRequestQueue = run.catch(() => null)
  return run
}

function markZzzGachaRateLimit(ms = 0) {
  zzzGachaBlockedUntil = Math.max(zzzGachaBlockedUntil, Date.now() + Math.max(0, Number(ms) || 0))
}

function mihoyoResponseError(res = {}, prefix = "米游社接口") {
  const error = new Error(res?.message || `${prefix}错误 ${res?.retcode}`)
  error.retcode = res?.retcode
  error.response = res
  return error
}

function isRateLimitedError(error) {
  return /visit too frequently|too frequent|rate limit|请求过于频繁|访问过于频繁|频繁/i.test(
    String(error?.message || error?.response?.message || ""),
  )
}

function pickRole(profile, game) {
  const currentUid = profile?.account?.current_uid?.[game]
  const roles = Array.isArray(profile?.account?.game_roles?.[game])
    ? profile.account.game_roles[game]
    : []
  if (currentUid) {
    return roles.find(role => String(role.uid || role.game_uid || role) === String(currentUid))
      || { uid: currentUid }
  }
  return roles[0] || null
}

function getRoleUid(role) {
  return role ? String(role.uid || role.game_uid || role || "") : ""
}

function authCacheKey({ qq, profile, profileId, uid, region, gameBiz, authAppId } = {}) {
  const accountKey = profile?.account?.ltuid
    || profile?.account?.stuid
    || profile?.account?.account_id
    || profile?.account?.mid
    || profile?.account?.cookie
    || profile?.account?.stoken_cookie
    || ""
  return [
    String(qq || profile?.qq || ""),
    String(profileId || 1),
    String(uid || ""),
    String(region || ""),
    String(gameBiz || ""),
    String(authAppId || "webview_gacha"),
    shortHash(`${accountKey}|${profile?.account?.stoken_cookie || ""}`),
  ].join(":")
}

function shortHash(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16)
}

function isInvalidAuthkeyError(error) {
  const code = Number(error?.retcode)
  if ([-100, -101, -110, -1001, -10001, 10001, -120].includes(code)) return true
  return /auth\s*key|authkey|登录|失效|过期|invalid|expired/i.test(String(error?.message || ""))
}
