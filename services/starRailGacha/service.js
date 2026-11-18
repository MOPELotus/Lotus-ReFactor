import { createProfileRequestGuard } from "../../core/login/requestGuard.js"
import { refreshAccountAndSync } from "../../core/login/refresh.js"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { resolveData } from "../../core/path.js"
import { AccountService } from "../../core/login/account.js"
import { requireCnGachaRegion } from "../mihoyoAuthKey/region.js"

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

const runningUpdates = new Set()

export class StarRailGachaService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.accountService = options.accountService || new AccountService({ fetch: this.fetch })
    this.storageDir = options.storageDir || resolveData("starRailGachaJson")
    this.maxPages = Number(options.maxPages ?? 500)
    this.pageDelayMs = Number(options.pageDelayMs ?? 300)
    this.poolDelayMs = Number(options.poolDelayMs ?? 300)
    this.requestTimeoutMs = Number(options.requestTimeoutMs ?? 30_000)
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  async updateByProfile({ qq, profile, profileId = 1 } = {}) {
    const role = pickRole(profile)
    const uid = String(role?.uid || role?.game_uid || "")
    if (!uid) throw new Error(`profile ${profileId} 没有同步星铁 UID`)
    if (!profile?.account?.cookie) throw new Error(`profile ${profileId} 缺少 cookie，无法更新星铁抽卡记录`)

    const region = requireCnGachaRegion({ region: role.region, uid, game: "sr" })
    try {
      return await this.updateByCookie({ qq, profileId, uid, region, cookie: profile.account.cookie, device: profile.device, guard: createProfileRequestGuard(profile) })
    } catch (error) {
      if (!isLoginExpired(error) || !profile?.account?.stoken) throw error
      const refreshed = await refreshAccountAndSync(qq, profileId, { accountService: this.accountService, expectedProfile: profile })
      return {
        ...await this.updateByCookie({
          qq,
          profileId,
          uid,
          region,
          cookie: refreshed.account?.cookie,
          device: refreshed.device,
          guard: createProfileRequestGuard(refreshed),
        }),
        refreshedCookie: true,
      }
    }
  }

  async updateByCookie({ qq, profileId = 1, uid, region, cookie, device = {}, guard } = {}) {
    if (!qq) throw new Error("qq is required")
    if (!uid || !region || !cookie) throw new Error("星铁 UID、region 和 cookie 均不能为空")
    region = requireCnGachaRegion({ region, uid, game: "sr" })

    const key = path.resolve(this.file(qq, uid))
    if (runningUpdates.has(key)) throw new Error("该账号的星铁抽卡记录正在更新，请稍后再试。")
    runningUpdates.add(key)
    try {
      return await this.sync({ qq, profileId, uid, region, cookie, device, guard })
    } finally {
      runningUpdates.delete(key)
    }
  }

  async sync({ qq, profileId, uid, region, cookie, device, guard }) {
    await guard?.()
    const jar = new CookieJar(cookie)
    await this.badgeLogin({ uid, region, jar })
    if (!jar.has("e_hkrpg_token")) throw new Error("星铁活动登录未返回 e_hkrpg_token")

    const context = {
      uid: String(uid),
      region: String(region),
      jar,
      deviceId: String(device?.id || crypto.randomUUID().replaceAll("-", "")),
      guard,
    }
    const brief = await this.requestGacha("brief", context)
    const previous = await this.loadLog(qq, uid)
    const next = normalizeLog(previous, { qq, uid, region, profileId })
    let added = 0
    const addedByPool = new Map()

    const poolEntries = Object.entries(STAR_RAIL_GACHA_TYPES)
    for (const [index, [type, name]] of poolEntries.entries()) {
      const oldRecords = next.pools[type]?.fiveStars || []
      const [cardsData, fiveStarPage] = await Promise.all([
        this.requestGacha("pool_stat", context, { gacha_type: type }),
        this.fetchFiveStars(context, type),
      ])
      const fiveStars = fiveStarPage.records
      const { records: merged, added: poolAdded } = mergeFiveStars(oldRecords, fiveStars)
      addedByPool.set(type, poolAdded)
      const cards = Array.isArray(cardsData?.cards) ? cardsData.cards.map(normalizeCard) : []
      const oldPool = next.pools[type] || {}
      const oldCounters = normalizeCardCounters(oldPool.cardCounters, oldPool.cards)
      const cardCounters = mergeCardCounters(oldCounters, cards)
      const cardDelta = Object.entries(cardCounters).reduce((sum, [id, count]) => sum + count - nonNegativeInt(oldCounters[id]), 0)
      const totalDraws = nonNegativeInt(oldPool.totalDraws) + cardDelta

      next.pools[type] = {
        name,
        cards,
        cardCounters,
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
    await this.saveLog(qq, uid, next, guard)

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
        added: addedByPool.get(type),
        total: pool.fiveStars.length,
        totalDraws: pool.totalDraws,
        pity: pool.pity,
      })),
    }
  }

  async badgeLogin({ uid, region, jar }) {
    region = requireCnGachaRegion({ region, uid, game: "sr" })
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

  async fetchFiveStars(context, type) {
    const records = []
    let pity = null
    let cursor = null
    const seenCursors = new Set()
    for (let page = 1; page <= this.maxPages; page += 1) {
      const extra = { gacha_type: type }
      if (cursor) Object.assign(extra, cursor)
      const data = await this.requestGacha("five_star_list", context, extra)
      if (!Array.isArray(data?.list)) throw new Error(`星铁${STAR_RAIL_GACHA_TYPES[type]}缺少五星记录列表，本次未写入记录。`)
      const list = data.list
      for (const raw of list) {
        if (!raw?.item) {
          if (pity === null) pity = nonNegativeInt(raw?.gacha_count)
          continue
        }
        records.push(normalizeFiveStar(raw))
      }
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
    await context.guard?.()
    requireCnGachaRegion({ region: context.region, uid: context.uid, game: "sr" })
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

  async saveLog(qq, uid, data, guard) {
    const file = this.file(qq, uid)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8")
      await guard?.()
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

function mergeCardCounters(oldCounters, cards) {
  const next = { ...oldCounters }
  for (const card of cards) {
    const key = String(card.gacha_id || "")
    if (!key && card.total_count > 0) throw new Error("星铁卡池总数缺少对应卡池 ID，本次未写入记录。")
    if (key) next[key] = Math.max(nonNegativeInt(next[key]), card.total_count)
  }
  return next
}

function normalizeFiveStar(item = {}) {
  if ([item.id, item.uuid].some(value => typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new Error("星铁五星记录 ID 精度不足，本次未写入记录。")
  }
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
  const normalized = [previous, incoming].map(rows => rows.map(normalizeFiveStar))
  const idsByUuid = new Map()
  for (const row of normalized.flat()) {
    if (!row.id || !row.uuid) continue
    if (idsByUuid.has(row.uuid) && idsByUuid.get(row.uuid) !== row.id) {
      throw new Error("星铁五星记录标识冲突，本次未写入记录。")
    }
    idsByUuid.set(row.uuid, row.id)
  }
  const merged = new Map()
  for (const row of normalized[0]) store(row)
  const oldCount = merged.size
  for (const row of normalized[1]) store(row)

  return {
    records: [...merged.values()].sort((a, b) => compareNumericText(recordKey(b), recordKey(a))),
    added: merged.size - oldCount,
  }

  function store(row) {
    const id = row.id || idsByUuid.get(row.uuid)
    const key = id ? `id:${id}` : row.uuid ? `uuid:${row.uuid}` : ""
    if (!key) throw new Error("星铁五星记录缺少 ID，本次未写入记录。")
    const old = merged.get(key)
    merged.set(key, { ...old, ...row, id: id || "", uuid: row.uuid || old?.uuid || "", item: row.item || old?.item })
  }
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
