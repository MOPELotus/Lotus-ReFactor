import { MIHOYO, GAME_BIZ } from "./constants.js"
import { getDs2, randomString } from "./ds.js"

export class MihoyoClient {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.deviceId = options.deviceId || randomString(32).toUpperCase()
    this.deviceName = options.deviceName || randomString(8)
    this.deviceFp = options.deviceFp || "38d7ee0e96649"
    this.deviceModel = options.deviceModel || randomString(16)
  }

  async createQrLogin() {
    return this.requestJson(`${MIHOYO.passApi}/account/ma-cn-passport/app/createQRLogin`, {
      method: "POST",
      headers: this.passHeaders("{}"),
      body: "{}",
    })
  }

  async queryQrLoginStatus(ticket) {
    const body = JSON.stringify({ ticket })
    return this.requestJson(`${MIHOYO.passApi}/account/ma-cn-passport/app/queryQRLoginStatus`, {
      method: "POST",
      headers: this.passHeaders(body),
      body,
    })
  }

  async getLtokenByStoken({ stuid, stoken, mid }) {
    const params = new URLSearchParams()
    params.set("stuid", stuid)
    params.set("stoken", stoken)
    if (mid) params.set("mid", mid)
    return this.requestJson(`${MIHOYO.passApi}/account/auth/api/getLTokenBySToken?${params}`)
  }

  async getCookieTokenByStoken({ stuid, stoken, mid, method = "GET" }) {
    const params = new URLSearchParams()
    params.set("game_biz", "hk4e_cn")
    params.set("uid", stuid)
    params.set("stoken", stoken)
    if (mid) params.set("mid", mid)

    return this.requestJson(`${MIHOYO.webApi}/auth/api/getCookieAccountInfoBySToken?${params}`, {
      method,
    })
  }

  async getGameRolesByCookie(cookie, game = "gs") {
    const params = new URLSearchParams()
    params.set("game_biz", GAME_BIZ[game] || game)
    return this.requestJson(`${MIHOYO.webApi}/binding/api/getUserGameRolesByCookie?${params}`, {
      headers: {
        Cookie: cookie,
      },
    })
  }

  async getAllGameRolesByCookie(cookie) {
    return this.requestJson(`${MIHOYO.webApi}/binding/api/getUserGameRolesByCookie`, {
      headers: {
        Cookie: cookie,
      },
    })
  }

  passHeaders(body) {
    return {
      "x-rpc-device_id": this.deviceId,
      "x-rpc-app_id": MIHOYO.passAppId,
      "x-rpc-device_name": this.deviceName,
      "x-rpc-device_fp": this.deviceFp,
      "x-rpc-device_model": this.deviceModel,
      "x-rpc-app_version": MIHOYO.appVersion,
      "x-rpc-game_biz": "bbs_cn",
      "x-rpc-sys_version": "11",
      "x-rpc-aigis": "",
      "Content-Type": "application/json;",
      "x-rpc-client_type": "2",
      DS: getDs2("", body, MIHOYO.passSalt),
      "x-rpc-sdk_version": "1.3.1.2",
      "User-Agent": "okhttp/4.8.0",
      Connection: "Keep-Alive",
      "Accept-Encoding": "gzip, deflate, br",
      "x-rpc-channel": "appstore",
    }
  }

  async requestJson(url, options = {}) {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    const response = await this.fetch(url, options)
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text.replace(/^\((.*)\)$/s, "$1")) : null
    } catch {
      throw new Error(`invalid json response from ${url}`)
    }
    if (!response.ok) {
      const error = new Error(`http ${response.status} ${response.statusText}`)
      error.data = data
      throw error
    }
    return data
  }
}
