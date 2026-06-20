import { GAME_BIZ, MIHOYO } from "../../core/mihoyo/constants.js"
import { getDs } from "../../core/mihoyo/ds.js"
import { inferServerFromUid } from "../../core/mihoyo/regions.js"

export class AuthKeyService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
  }

  async getAuthKey({ profile, game = "gs", uid, region, authAppId = "webview_gacha" } = {}) {
    if (!profile?.account?.stoken_cookie) throw new Error("profile has no stoken")
    if (!uid) throw new Error("uid is required")
    const targetRegion = region || getServer(uid, game)
    const body = JSON.stringify({
      auth_appid: authAppId,
      game_biz: GAME_BIZ[game] || game,
      game_uid: Number(uid),
      region: targetRegion,
    })

    const res = await this.requestJson(`${MIHOYO.webApi}/binding/api/genAuthKey`, {
      method: "POST",
      headers: {
        "x-rpc-app_version": MIHOYO.appVersion,
        "User-Agent": "okhttp/4.8.0",
        "x-rpc-client_type": "5",
        Referer: "https://app.mihoyo.com",
        Origin: "https://webstatic.mihoyo.com",
        Cookie: profile.account.stoken_cookie,
        DS: getDs(MIHOYO.saltWeb),
        "x-rpc-sys_version": "12",
        "x-rpc-channel": "mihoyo",
        "x-rpc-device_id": profile.device?.id || "00000000000000000000000000000000",
        "x-rpc-device_name": profile.device?.name || "Lotus Device",
        "x-rpc-device_model": profile.device?.model || "Lotus",
        Host: "api-takumi.mihoyo.com",
        "Content-Type": "application/json",
      },
      body,
    })

    const authkey = res?.data?.authkey
    if (!authkey) throw new Error(res?.message || "authkey 获取失败")
    return {
      authkey,
      region: targetRegion,
      game,
      uid: String(uid),
      authAppId,
    }
  }

  async requestJson(url, options = {}) {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    const response = await this.fetch(url, options)
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    if (!response.ok) {
      const error = new Error(`authkey request failed: HTTP ${response.status}`)
      error.data = data
      throw error
    }
    return data
  }
}

export function buildGachaLogUrl({ authkey, game = "gs", region } = {}) {
  if (game === "sr") {
    const params = new URLSearchParams({
      authkey_ver: "1",
      sign_type: "2",
      auth_appid: "webview_gacha",
      authkey,
      game_biz: "hkrpg_cn",
      gacha_type: "11",
      page: "1",
      size: "5",
      end_id: "0",
      region,
      lang: "zh-cn",
    })
    return `https://public-operation-hkrpg.mihoyo.com/common/gacha_record/api/getGachaLog?${params}`
  }

  const params = new URLSearchParams({
    authkey_ver: "1",
    sign_type: "2",
    auth_appid: "webview_gacha",
    init_type: "301",
    gacha_id: "fecafa7b6560db5f3182222395d88aaa6aaac1bc",
    timestamp: String(Math.floor(Date.now() / 1000)),
    lang: "zh-cn",
    device_type: "mobile",
    plat_type: "ios",
    region,
    authkey,
    game_biz: "hk4e_cn",
    gacha_type: "301",
    page: "1",
    size: "5",
    end_id: "0",
  })
  return `https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog?${params}`
}

export function getServer(uid, game = "gs") {
  return inferServerFromUid(uid, game)
}
