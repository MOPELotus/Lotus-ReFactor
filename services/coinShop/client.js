import https from "node:https"
import { setTimeout as delay } from "node:timers/promises"
import { MIHOYO } from "../../core/mihoyo/constants.js"
import { requestOfficialJson } from "../redeemCodes/http.js"

const READ_API = "https://api-takumi.mihoyo.com"
const EXCHANGE_API = "https://api-takumi.miyoushe.com/mall/v1/web/goods/exchange"
export const SHOP_GAME_BIZ = Object.freeze({ hk4e: "hk4e_cn", hkrpg: "hkrpg_cn", nap: "nap_cn", bh3: "bh3_cn", nxx: "nxx_cn", bh2: "bh2_cn" })

export function isCoinShopLimited(error) {
  return [1028, 1034, 429].includes(Number(error?.retcode)) || /HTTP 429|验证|风控|安全|频繁|请求过快|操作太快|频率限制/.test(String(error?.message || ""))
}

export function beijingTime(ms) {
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ")
}

export function normalizeGood(raw, now = Date.now()) {
  const serverNow = Number(raw.now_time) * 1000 || now
  const stock = raw.total === undefined || raw.total === null ? null : Number(raw.total)
  const available = raw.status === "online" && (raw.unlimit === true || (stock !== null && stock > 0))
  const times = [Number(raw.sale_start_time) * 1000, Number(raw.next_time) * 1000].filter(ms => ms > serverNow)
  const opensAt = available ? serverNow : times.length ? Math.min(...times) : 0
  const endsAt = Number(raw.end) * 1000 || 0
  const status = endsAt && endsAt <= serverNow ? "ended" : available ? "available" : opensAt ? "scheduled" : stock === 0 ? "sold_out" : "unknown"
  return {
    id: String(raw.goods_id || ""), name: String(raw.goods_name || ""), price: Number(raw.price),
    icon: String(raw.icon || ""),
    type: Number(raw.type), gameBiz: String(raw.game_biz || ""), game: String(raw.game || ""),
    stock, unlimited: raw.unlimit === true, nextStock: raw.next_num === undefined ? null : Number(raw.next_num),
    opensAt, endsAt, serverNow, status, saleStartsAt: Number(raw.sale_start_time) * 1000 || 0, startsAt: Number(raw.start) * 1000 || 0,
    limit: Number(raw.account_cycle_limit || 0), exchanged: Number(raw.account_exchange_num || 0),
    limitCycle: String(raw.account_cycle_type || ""),
    requirements: String(raw.goods_detail || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim(),
  }
}

function postExchange(body, headers, signal) {
  // One POST only: a lost response does not prove that coins were not spent.
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const request = https.request(EXCHANGE_API, {
      method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(payload) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    }, response => {
      const chunks = []
      let size = 0
      response.on("data", chunk => {
        size += chunk.length
        if (size > 1024 * 1024) response.destroy(new Error("兑换响应过大"))
        else chunks.push(chunk)
      })
      response.on("error", reject)
      response.on("aborted", () => reject(new Error("兑换响应中断")))
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error(`兑换接口 HTTP ${response.statusCode}`)
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          if (typeof data.retcode !== "number") throw new Error("兑换响应格式异常")
          resolve(data)
        } catch (error) { reject(error) }
      })
    })
    request.on("error", reject)
    request.end(payload)
  })
}

export class CoinShopClient {
  constructor(options = {}) {
    this.getJson = options.getJson || requestOfficialJson
    this.postJson = options.postJson || postExchange
    this.now = options.now || Date.now
  }

  headers(profile = {}, exchange = false) {
    const device = profile.device || {}
    const model = device.model || "Android"
    return {
      Accept: "application/json, text/plain, */*",
      "User-Agent": `Mozilla/5.0 (Linux; Android ${device.android_version || "12"}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 miHoYoBBS/${MIHOYO.appVersion}`,
      "x-rpc-client_type": exchange ? "1" : "5",
      "x-rpc-device_id": String(device.id || ""),
      ...(profile.account?.cookie ? { Cookie: profile.account.cookie } : {}),
      Origin: exchange ? "https://webstatic.miyoushe.com" : "https://user.mihoyo.com",
      Referer: exchange ? "https://webstatic.miyoushe.com/" : "https://user.mihoyo.com/",
      ...(exchange ? {
        "Content-Type": "application/json;charset=utf-8", "x-rpc-app_version": MIHOYO.appVersion,
        "x-rpc-channel": "appstore", "x-rpc-verify_key": MIHOYO.passAppId,
        "x-rpc-device_fp": String(device.fp || ""), "x-rpc-device_model": model,
        "x-rpc-device_name": encodeURIComponent(String(device.name || model)), "x-rpc-sys_version": String(device.android_version || "12"),
      } : {}),
    }
  }

  async read(route, params, profile) {
    const url = `${READ_API}${route}?${new URLSearchParams(params)}`
    let lastError
    for (let attempt = 0; attempt < 3; attempt++) {
      let body
      try { body = await this.getJson(url, { headers: this.headers(profile), timeoutMs: 8000 }) }
      catch (error) { if (isCoinShopLimited(error)) throw error; lastError = error; if (attempt < 2) await delay(150 * (attempt + 1)); continue }
      if (body.retcode !== 0) {
        const error = new Error(body.message || `官方接口错误 ${body.retcode}`)
        error.retcode = body.retcode
        throw error
      }
      if (!body.data) throw new Error("官方接口未返回数据")
      return body.data
    }
    throw new Error(`商城查询连接失败：${lastError?.code || lastError?.message || "未知错误"}`)
  }

  async list({ game = "", page = 1, profile } = {}) {
    const data = await this.read("/mall/v1/web/goods/list", { app_id: "1", point_sn: "myb", page_size: "20", page: String(page), game: game === "all" ? "" : game }, profile)
    const goods = []
    const raw = data.list || []
    for (let index = 0; index < raw.length; index += 4) {
      goods.push(...await Promise.all(raw.slice(index, index + 4).map(async item => {
        if (item.status === "not_in_sell" && !Number(item.sale_start_time)) {
          try { return await this.detail(String(item.goods_id), profile) }
          catch (error) { if (isCoinShopLimited(error)) throw error; return { ...normalizeGood(item, this.now()), status: "unknown", opensAt: 0 } }
        }
        return { ...normalizeGood(item, this.now()), game: String(item.game || game) }
      })))
    }
    return { goods, games: data.games || [], total: Number(data.total || 0), page }
  }

  async detail(goodsId, profile) {
    const raw = await this.read("/mall/v1/web/goods/detail", { app_id: "1", point_sn: "myb", goods_id: goodsId }, profile)
    return normalizeGood(raw, this.now())
  }

  async listAll({ game, profile } = {}) {
    const goods = []
    for (let page = 1; page <= 20; page++) {
      const data = await this.list({ game, profile, page })
      goods.push(...data.goods)
      if (page * 20 >= data.total || data.goods.length === 0) return goods
    }
    throw new Error("该分区商品数量过多，请缩小追踪范围")
  }

  async points(profile) {
    const data = await this.read("/common/homutreasure/v1/web/user/point", { app_id: "1", point_sn: "myb" }, profile)
    const points = Number(data.points)
    if (!Number.isFinite(points) || points < 0) throw new Error("米游币余额格式异常")
    return points
  }

  async addresses(profile) {
    const data = await this.read("/account/address/list", { t: String(this.now()) }, profile)
    return (data.list || []).map(address => ({
      id: String(address.id),
      label: `${String(address.connect_name || address.name || "收件人").slice(0, 1)}** ****${String(address.connect_mobile || "").slice(-4)}`,
    }))
  }

  async roles(profile, gameBiz) {
    const data = await this.read("/binding/api/getUserGameRolesByCookie", { game_biz: gameBiz }, profile)
    return (data.list || []).filter(role => role.game_biz === gameBiz && /^\d+$/.test(String(role.game_uid || "")) && String(role.region || "").trim())
      .map(role => ({ uid: String(role.game_uid), region: String(role.region), gameBiz: String(role.game_biz), nickname: String(role.nickname || ""), regionName: String(role.region_name || "") }))
  }

  async exchange(plan, profile, signal) {
    if (plan.type === 2 && (!plan.role || !plan.role.region || plan.role.gameBiz !== (plan.gameBiz || plan.role.gameBiz))) throw new Error("兑换角色与商品游戏不匹配")
    const body = { app_id: 1, point_sn: "myb", goods_id: plan.goodsId, exchange_num: 1 }
    if (plan.addressId) {
      const address = Number(plan.addressId)
      if (!Number.isSafeInteger(address) || address <= 0) throw new Error("收货地址 ID 格式异常")
      body.address_id = address
    }
    if (plan.role) Object.assign(body, { uid: plan.role.uid, region: plan.role.region, game_biz: plan.role.gameBiz })
    return this.postJson(body, this.headers(profile, true), signal)
  }
}
