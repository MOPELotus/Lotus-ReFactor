import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { resolveData } from "../../core/path.js"
import { AccountService } from "../../core/login/account.js"

export const STAR_RAIL_GACHA_TYPES = Object.freeze({
  GachaType_AvatarUp: "角色活动跃迁",
  GachaType_EquipmentUp: "光锥活动跃迁",
  GachaType_CollabAvatarUp: "联动角色跃迁",
  GachaType_CollabEquipmentUp: "联动光锥跃迁",
  GachaType_Standard: "常驻跃迁",
  GachaType_Newbie: "新手跃迁",
})

const BADGE_LOGIN_URL = "https://api-takumi.mihoyo.com/common/badge/v1/login/account"
const GACHA_API_ROOT = "https://act-api-takumi.mihoyo.com/event/rpg_gacha_record"

export class StarRailGachaService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.accountService = options.accountService || new AccountService({ fetch: this.fetch })
    this.storageDir = options.storageDir || resolveData("starRailGachaJson")
    this.maxPages = Number(options.maxPages ?? 50)
    this.pageDelayMs = Number(options.pageDelayMs ?? 0)
    this.poolDelayMs = Number(options.poolDelayMs ?? 300)
    this.requestTimeoutMs = Number(options.requestTimeoutMs ?? 30_000)
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  async updateByProfile({ qq, profile, profileId = 1 } = {}) {
    const role = pickRole(profile)
    const uid = String(role?.uid || role?.game_uid || "")
    if (!uid) throw new Error(`profile ${profileId} 没有同步星铁 UID`)
    if (!profile?.account?.cookie) throw new Error(`profile ${profileId} 缺少 cookie，无法更新星铁抽卡记录`)

    const region = String(role.region || inferRegion(uid))
    try {
      return await this.updateByCookie({ qq, profileId, uid, region, cookie: profile.account.cookie, device: profile.device })
    } catch (error) {
      if (!isLoginExpired(error) || !profile?.account?.stoken) throw error
      const refreshed = await this.accountService.refresh(qq, profileId)
      return {
        ...await this.updateByCookie({
          qq,
          profileId,
          uid,
          region,
          cookie: refreshed.account?.cookie,
          device: refreshed.device,
        }),
        refreshedCookie: true,
      }
    }
  }

  async updateByCookie({ qq, profileId = 1, uid, region, cookie, device = {} } = {}) {
    if (!qq) throw new Error("qq is required")
    if (!uid || !region || !cookie) throw new Error("星铁 UID、region 和 cookie 均不能为空")

    const jar = new CookieJar(cookie)
    await this.badgeLogin({ uid, region, jar })
    if (!jar.has("e_hkrpg_token")) throw new Error("星铁活动登录未返回 e_hkrpg_token")

    const context = {
      uid: String(uid),
      region: String(region),
      jar,
      deviceId: String(device?.id || crypto.randomUUID().replaceAll("-", "")),
    }
    const brief = await this.requestGacha("brief", context)
    const previous = await this.loadLog(qq, uid)
    const next = normalizeLog(previous, { qq, uid, region, profileId })
    let added = 0

    const poolEntries = Object.entries(STAR_RAIL_GACHA_TYPES)
    for (const [index, [type, name]] of poolEntries.entries()) {
      const oldRecords = next.pools[type]?.fiveStars || []
      const oldIds = new Set(oldRecords.map(recordKey).filter(Boolean))
      const [cardsData, fiveStarPage] = await Promise.all([
        this.requestGacha("pool_stat", context, { gacha_type: type }),
        this.fetchFiveStars(context, type, oldIds),
      ])
      const fiveStars = fiveStarPage.records
      const merged = mergeFiveStars(oldRecords, fiveStars)
      const poolAdded = merged.filter(item => !oldIds.has(recordKey(item))).length
      const cards = Array.isArray(cardsData?.cards) ? cardsData.cards.map(normalizeCard) : []
      const oldPool = next.pools[type] || {}
      const oldCounters = normalizeCardCounters(oldPool.cardCounters, oldPool.cards)
      const cardDelta = countNewDraws(oldCounters, cards)
      const totalDraws = nonNegativeInt(oldPool.totalDraws) + cardDelta

      next.pools[type] = {
        name,
        cards,
        cardCounters: mergeCardCounters(oldCounters, cards),
        fiveStars: merged,
        totalDraws,
        pity: fiveStarPage.pity ?? nonNegativeInt(next.pools[type]?.pity),
      }
      added += poolAdded
      if (this.poolDelayMs > 0 && index < poolEntries.length - 1) await this.sleep(this.poolDelayMs)
    }

    next.version = 1
    next.qq = String(qq)
    next.uid = String(uid)
    next.region = String(region)
    next.profileId = Number(profileId)
    next.source = "mihoyo_star_rail_gacha_miniapp"
    next.updatedAt = new Date().toISOString()
    next.brief = normalizeBrief(brief)
    await this.saveLog(qq, uid, next)

    return {
      ok: true,
      game: "sr",
      source: "cookie",
      uid: String(uid),
      region: String(region),
      profileId: Number(profileId),
      added,
      total: Object.values(next.pools).reduce((sum, pool) => sum + pool.fiveStars.length, 0),
      pools: Object.entries(next.pools).map(([type, pool]) => ({
        type,
        name: pool.name,
        added: pool.fiveStars.filter(item => !new Set(previous?.pools?.[type]?.fiveStars?.map(recordKey) || []).has(recordKey(item))).length,
        total: pool.fiveStars.length,
        totalDraws: pool.totalDraws,
        pity: pool.pity,
      })),
    }
  }

  async badgeLogin({ uid, region, jar }) {
    await this.requestJson(BADGE_LOGIN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Cookie: jar.header(),
        Origin: "https://act.mihoyo.com",
        Referer: "https://act.mihoyo.com/",
        "User-Agent": "Mozilla/5.0 Lotus-StarRail-Gacha",
      },
      body: JSON.stringify({ uid: String(uid), region: String(region), game_biz: "hkrpg_cn", lang: "zh-cn" }),
    }, jar)
  }

  async fetchFiveStars(context, type, stopKeys = new Set()) {
    const records = []
    let pity = null
    let cursor = null
    const seenCursors = new Set()
    for (let page = 1; page <= this.maxPages; page += 1) {
      const extra = { gacha_type: type }
      if (cursor) Object.assign(extra, cursor)
      const data = await this.requestGacha("five_star_list", context, extra)
      const list = Array.isArray(data?.list) ? data.list : []
      let reachedSaved = false
      for (const raw of list) {
        if (!raw?.item) {
          if (pity === null) pity = nonNegativeInt(raw?.gacha_count)
          continue
        }
        const item = normalizeFiveStar(raw)
        if (stopKeys.has(recordKey(item))) {
          reachedSaved = true
          break
        }
        records.push(item)
      }
      if (reachedSaved) break
      if (!data?.has_more) break

      const versionId = String(data.version_id || "")
      const maxId = String(data.next_max_id || "")
      const key = `${versionId}:${maxId}`
      if (!versionId || !maxId || seenCursors.has(key)) throw new Error(`星铁${STAR_RAIL_GACHA_TYPES[type]}分页游标异常`)
      seenCursors.add(key)
      cursor = { version_id: versionId, max_id: maxId }
      if (this.pageDelayMs > 0) await this.sleep(this.pageDelayMs)
      if (page === this.maxPages) throw new Error(`星铁${STAR_RAIL_GACHA_TYPES[type]}分页超过上限`)
    }
    return { records, pity }
  }

  async requestGacha(endpoint, context, extra = {}) {
    const query = new URLSearchParams({
      badge_region: context.region,
      badge_uid: context.uid,
      game_biz: "hkrpg_cn",
      region: context.region,
      uid: context.uid,
      ...extra,
    })
    return this.requestJson(`${GACHA_API_ROOT}/${endpoint}?${query}`, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Cookie: context.jar.header(),
        Origin: "https://act.mihoyo.com",
        Referer: "https://act.mihoyo.com/sr/event/gt-aio/gacha-records/index.html",
        "User-Agent": "Mozilla/5.0 Lotus-StarRail-Gacha",
        "x-rpc-device_id": context.deviceId,
        "x-rpc-jump_source": "wechatmp",
        "x-rpc-platform": "4",
      },
    }, context.jar)
  }

  async requestJson(url, options, jar) {
    const requestOptions = { ...options }
    if (!requestOptions.signal && typeof globalThis.AbortSignal?.timeout === "function") {
      requestOptions.signal = globalThis.AbortSignal.timeout(this.requestTimeoutMs)
    }
    let response
    try {
      response = await this.fetch(url, requestOptions)
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error(`星铁抽卡接口请求超时（${this.requestTimeoutMs}ms）`)
      }
      throw error
    }
    jar?.update(response)
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.retcode !== 0) {
      const error = new Error(body?.message || `HTTP ${response.status}`)
      error.retcode = body?.retcode
      error.response = body
      throw error
    }
    return body?.data || {}
  }

  file(qq, uid) {
    return path.join(this.storageDir, String(qq), `${uid}.json`)
  }

  async loadLog(qq, uid) {
    try {
      return JSON.parse(await fs.readFile(this.file(qq, uid), "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
  }

  async saveLog(qq, uid, data) {
    const file = this.file(qq, uid)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8")
      await fs.rename(temporary, file)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
}

class CookieJar {
  constructor(cookie = "") {
    this.values = new Map()
    for (const part of String(cookie).split(";")) {
      const index = part.indexOf("=")
      if (index > 0) this.values.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
    }
  }

  has(key) { return this.values.has(key) }
  header() { return [...this.values].map(([key, value]) => `${key}=${value}`).join("; ") }

  update(response) {
    const setCookies = typeof response?.headers?.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response?.headers?.get?.("set-cookie")].filter(Boolean)
    for (const value of setCookies) {
      const pair = String(value).split(";", 1)[0]
      const index = pair.indexOf("=")
      if (index > 0) this.values.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
    }
  }
}

function pickRole(profile) {
  const roles = Array.isArray(profile?.account?.game_roles?.sr) ? profile.account.game_roles.sr : []
  const current = String(profile?.account?.current_uid?.sr || "")
  return roles.find(role => String(role.uid || role.game_uid || role) === current) || (current ? { uid: current } : roles[0])
}

function inferRegion(uid) {
  return String(uid).startsWith("9") ? "prod_official_asia" : "prod_gf_cn"
}

function normalizeLog(value, fallback = {}) {
  return value && typeof value === "object"
    ? { ...value, pools: value.pools && typeof value.pools === "object" ? value.pools : {} }
    : { version: 1, ...fallback, pools: {} }
}

function normalizeBrief(value = {}) {
  return {
    version_id: String(value.version_id || ""),
    items: Array.isArray(value.items) ? value.items.map(entry => ({ item: entry.item || null, count: nonNegativeInt(entry.count) })) : [],
  }
}

function normalizeCard(card = {}) {
  return {
    ...card,
    gacha_id: String(card.gacha_id || ""),
    total_count: nonNegativeInt(card.total_count),
    up_count: nonNegativeInt(card.up_count),
  }
}

function normalizeCardCounters(value, fallbackCards = []) {
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, count]) => [String(key), nonNegativeInt(count)]))
  }
  return Object.fromEntries(fallbackCards.map(card => [String(card.gacha_id || ""), nonNegativeInt(card.total_count)]).filter(([key]) => key))
}

function countNewDraws(oldCounters, cards) {
  return cards.reduce((sum, card) => {
    const key = String(card.gacha_id || "")
    const oldCount = key ? nonNegativeInt(oldCounters[key]) : 0
    return sum + Math.max(0, card.total_count - oldCount)
  }, 0)
}

function mergeCardCounters(oldCounters, cards) {
  const next = { ...oldCounters }
  for (const card of cards) {
    const key = String(card.gacha_id || "")
    if (key) next[key] = Math.max(nonNegativeInt(next[key]), card.total_count)
  }
  return next
}

function normalizeFiveStar(item = {}) {
  return {
    id: String(item.id || ""),
    uuid: String(item.uuid || ""),
    item: item.item || null,
    is_up: Boolean(item.is_up),
    got_item: item.got_item || null,
    gacha_count: nonNegativeInt(item.gacha_count),
  }
}

function recordKey(item = {}) {
  return String(item.id || item.uuid || "")
}

function mergeFiveStars(previous = [], incoming = []) {
  const merged = new Map()
  for (const item of [...previous, ...incoming]) {
    const normalized = normalizeFiveStar(item)
    const key = recordKey(normalized)
    if (!key) continue
    const old = merged.get(key)
    merged.set(key, old ? { ...old, ...normalized, item: normalized.item || old.item } : normalized)
  }
  return [...merged.values()].sort((left, right) => compareNumericText(recordKey(right), recordKey(left)))
}

function compareNumericText(left, right) {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return left.length - right.length || left.localeCompare(right)
  return left.localeCompare(right)
}

function nonNegativeInt(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : 0
}

function isLoginExpired(error) {
  return Number(error?.retcode) === -100 || /登录|login|cookie|token/i.test(String(error?.message || ""))
}
