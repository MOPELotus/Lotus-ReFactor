import { MIHOYO, MIHOYO_PROTOCOL, GAME_BIZ, mihoyoUserAgent } from "./constants.js"
import { getDs2, randomString } from "./ds.js"

export class MihoyoClient {
  constructor(options = {}) {
    const device = options.device || {}
    this.fetch = options.fetch || globalThis.fetch
    const suppliedId = options.deviceId || device.id
    this.deviceId = suppliedId || randomString(32).toUpperCase()
    this.deviceName = options.deviceName || device.name || randomString(8)
    // A saved FP belongs to its supplied ID; a new anonymous session cannot
    // borrow a fixed fingerprint or attach one to a newly invented ID.
    this.deviceFp = suppliedId ? options.deviceFp || device.fp || "" : ""
    this.deviceModel = options.deviceModel || device.model || randomString(16)
    this.androidVersion = options.androidVersion || device.android_version || "11"
  }

  withDevice(device = {}) {
    return new MihoyoClient({ fetch: this.fetch, device })
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
    if (!String(stoken).startsWith("v2_")) params.set("stuid", stuid)
    params.set("stoken", stoken)
    if (!String(stoken).startsWith("v2_") && mid) params.set("mid", mid)
    return this.requestJson(`${MIHOYO.passApi}/account/auth/api/getLTokenBySToken?${params}`, {
      headers: this.tokenHeaders({ stuid, stoken, mid }, params.toString(), "5"),
    })
  }

  async getCookieTokenByStoken({ stuid, stoken, mid, method = "GET" }) {
    if (method !== "GET") throw new Error("stoken exchange only supports GET")
    const params = new URLSearchParams()
    if (String(stoken).startsWith("v2_")) {
      params.set("stoken", stoken)
      return this.requestJson(`${MIHOYO.passApi}/account/auth/api/getCookieAccountInfoBySToken?${params}`, {
        headers: this.tokenHeaders({ stuid, stoken, mid }, params.toString(), "2"),
      })
    }
    params.set("game_biz", "hk4e_cn")
    params.set("uid", stuid)
    params.set("stoken", stoken)
    if (mid) params.set("mid", mid)

    return this.requestJson(`${MIHOYO.webApi}/auth/api/getCookieAccountInfoBySToken?${params}`, {
      method,
      headers: this.tokenHeaders({ stuid, stoken, mid }, params.toString(), "5"),
    })
  }

  tokenHeaders({ stuid, stoken, mid }, query, clientType) {
    if (!stuid || !stoken || (String(stoken).startsWith("v2_") && !mid)) throw new Error("stoken exchange credentials are incomplete")
    if ([stuid, stoken, mid].some(value => /[;\r\n]/.test(String(value || "")))) throw new Error("invalid stoken exchange credentials")
    return {
      Cookie: `stuid=${stuid};stoken=${stoken}${mid ? `;mid=${mid}` : ""}`,
      "User-Agent": mihoyoUserAgent({ model: this.deviceModel, android_version: this.androidVersion }),
      "x-rpc-app_version": MIHOYO_PROTOCOL.bbsCn.version,
      "x-rpc-client_type": clientType,
      "x-rpc-device_id": this.deviceId,
      ...(this.deviceFp ? { "x-rpc-device_fp": this.deviceFp } : {}),
      "x-rpc-device_name": this.deviceName,
      "x-rpc-device_model": this.deviceModel,
      "x-requested-with": "com.mihoyo.hyperion",
      Referer: "https://webstatic.mihoyo.com/",
      "x-rpc-aigis": "",
      DS: getDs2(query, "", MIHOYO_PROTOCOL.bbsCn.x4Salt),
    }
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
      ...(this.deviceFp ? { "x-rpc-device_fp": this.deviceFp } : {}),
      "x-rpc-device_model": this.deviceModel,
      "x-rpc-app_version": MIHOYO_PROTOCOL.passport.version,
      "x-rpc-game_biz": "bbs_cn",
      "x-rpc-sys_version": this.androidVersion,
      "x-rpc-aigis": "",
      "Content-Type": "application/json;",
      "x-rpc-client_type": MIHOYO_PROTOCOL.passport.clientType,
      DS: getDs2("", body, MIHOYO.passSalt),
      "x-rpc-sdk_version": MIHOYO_PROTOCOL.passport.sdkVersion,
      "User-Agent": "okhttp/4.8.0",
      Connection: "Keep-Alive",
      "Accept-Encoding": "gzip, deflate, br",
      "x-rpc-channel": "appstore",
    }
  }

  async requestJson(url, options = {}) {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    const response = await this.fetch(url, { signal: AbortSignal.timeout(20000), ...options })
    const text = await response.text()
    const target = new URL(url)
    const endpoint = `${target.origin}${target.pathname}`
    let data
    try {
      data = text ? JSON.parse(text.replace(/^\((.*)\)$/s, "$1")) : null
    } catch {
      if (response.ok) throw new Error(`invalid json response from ${endpoint} (HTTP ${response.status})`)
    }
    if (!response.ok) {
      const error = new Error(`http ${response.status} ${response.statusText} from ${endpoint}`)
      error.status = response.status
      error.data = data
      throw error
    }
    return data
  }
}
