import fs from "node:fs/promises"
import path from "node:path"
import { resolveData } from "../../core/path.js"
import {
  AuthKeyService,
  getServer,
} from "../mihoyoAuthKey/service.js"

export const ZZZ_GACHA_POOLS = Object.freeze({
  "音擎频段": ["3001"],
  "音擎回响": ["13001"],
  "独家频段": ["2001"],
  "独家重映": ["12001"],
  "常驻频段": ["1001"],
  "邦布频段": ["5001"],
})

const CN_API = "https://public-operation-common.mihoyo.com/common/gacha_record/api/getGachaLog"
const OS_API = "https://public-operation-common-sg.hoyoverse.com/common/gacha_record/api/getGachaLog"

export class ZzzGachaService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.authKeyService = options.authKeyService || new AuthKeyService({ fetch: this.fetch })
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.storageDir = options.storageDir || resolveData("zzzGachaJson")
    this.pageDelayMs = Number(options.pageDelayMs ?? 1000)
    this.maxPages = Number(options.maxPages ?? 50)
  }

  async updateByProfile({ qq, profile, profileId = 1 } = {}) {
    const role = pickRole(profile, "zzz")
    const uid = getRoleUid(role)
    if (!uid) throw new Error(`profile ${profileId} 没有同步绝区零 UID`)
    if (!profile?.account?.stoken_cookie) throw new Error(`profile ${profileId} 缺少 stoken，无法获取 authkey`)

    const region = role?.region || getServer(uid, "zzz")
    const gameBiz = getZzzGameBiz(region)
    const auth = await this.authKeyService.getAuthKey({
      profile,
      game: "zzz",
      uid,
      region,
      authAppId: "webview_gacha",
    })
    const result = await this.updateByAuthkey({
      qq,
      uid,
      authkey: auth.authkey,
      region,
      gameBiz,
    })
    return {
      ...result,
      uid,
      profileId,
      region,
      gameBiz,
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
    const res = await this.requestJson(url)
    if (Number(res?.retcode ?? 0) !== 0) {
      throw new Error(res?.message || `绝区零抽卡接口错误 ${res?.retcode}`)
    }
    return res?.data || null
  }

  async loadLog(qq, uid) {
    try {
      return JSON.parse(await fs.readFile(this.logFile(qq, uid), "utf8"))
    } catch (error) {
      if (error?.code === "ENOENT") return {}
      throw error
    }
  }

  async saveLog(qq, uid, data) {
    const file = this.logFile(qq, uid)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8")
    return file
  }

  logFile(qq, uid) {
    return path.join(this.storageDir, String(qq), `${uid}.json`)
  }

  async requestJson(url) {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    const response = await this.fetch(url, {
      headers: {
        "Content-Type": "application/json",
      },
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    if (!response.ok) throw new Error(`绝区零抽卡请求失败 HTTP ${response.status}`)
    return data
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

export function getZzzBaseType(gachaType) {
  if (String(gachaType) === "13001") return "103"
  if (String(gachaType) === "12001") return "102"
  return String(gachaType || "2001")[0] || "2"
}

export function getZzzGameBiz(region = "prod_gf_cn") {
  return region === "prod_gf_cn" ? "nap_cn" : "nap_global"
}

function normalizeLog(log = {}) {
  const result = {}
  for (const poolName of Object.keys(ZZZ_GACHA_POOLS)) {
    result[poolName] = Array.isArray(log[poolName]) ? log[poolName] : []
  }
  return result
}

function normalizeGachaItem(item = {}, uid) {
  return {
    uid: String(item.uid || uid),
    gacha_id: String(item.gacha_id || "0"),
    gacha_type: String(item.gacha_type || item.real_gacha_type || ""),
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

function sameGachaItem(a, b) {
  return Boolean(a && b && String(a.uid) === String(b.uid) && String(a.id) === String(b.id))
}

function dedupeGachaItems(items = []) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    const key = `${item.uid}:${item.id}:${item.gacha_type}`
    if (!item.id || seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
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
