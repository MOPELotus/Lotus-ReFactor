import { requestText, DouyinError } from "./http.js"
import { WEB_UA } from "./signature.js"
import { generateNonceSignature } from "./guest-signature.js"

const guestCookies = response => {
  const headers = response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""]
  const cookies = {}
  for (const name of ["ttwid", "__ac_nonce", "UIFID_TEMP", "UIFID"]) {
    const value = headers.map(header => header.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,\\s]+)`))?.[1]).find(Boolean)
    if (value) cookies[name] = value
  }
  return cookies
}

// A visitor identity only. Work responses and download files are never cached.
export class DouyinVisitor {
  constructor({ fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {}) {
    this.fetch = fetchImpl
    this.now = now
    this.timeoutMs = timeoutMs
    this.identity = null
    this.pending = null
    this.sessionPending = null
  }

  /** Bootstrap an anonymous web visitor; no browser or user-supplied Cookie. */
  async getSession({ refresh = false, previous = "", timeoutMs = this.timeoutMs } = {}) {
    const deadline = Date.now() + timeoutMs
    const remaining = () => {
      const budget = deadline - Date.now()
      if (budget <= 0) throw new DouyinError("timeout", "抖音游客校验超时")
      return budget
    }
    const value = await this.get({ refresh, previous: typeof previous === "object" ? previous.ttwid : previous, timeoutMs: remaining() })
    const identity = this.identity
    if (identity.session && identity.sessionExpires > this.now()) return identity.session
    if (this.sessionPending?.value === value) return this.sessionPending.promise
    const pending = { value, promise: this.bootstrap(value, remaining).then(session => {
      if (this.identity === identity) {
        identity.value = session.ttwid
        identity.session = session
        identity.sessionExpires = Math.min(identity.expires, this.now() + 30 * 60 * 1000)
      }
      return session
    }) }
    this.sessionPending = pending
    try { return await pending.promise } finally { if (this.sessionPending === pending) this.sessionPending = null }
  }

  async bootstrap(ttwid, remaining) {
    const url = "https://www.douyin.com/"
    const cookies = { ttwid }
    const request = async () => {
      const { response } = await requestText(this.fetch, url, {
        redirect: "error", headers: { "User-Agent": WEB_UA, Cookie: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ") },
      }, { timeoutMs: remaining(), headersOnly: true })
      if (!response.ok) throw new DouyinError("visitor", `抖音游客校验 HTTP ${response.status}`)
      Object.assign(cookies, guestCookies(response))
    }
    await request()
    if (!cookies.UIFID && !cookies.UIFID_TEMP) {
      if (!cookies.__ac_nonce) throw new DouyinError("visitor", "抖音页面未签发游客校验 nonce")
      cookies.__ac_signature = generateNonceSignature(cookies.__ac_nonce, { url, now: this.now() })
      cookies.__ac_referer = "__ac_blank"
      await request()
    }
    const uifid = cookies.UIFID || cookies.UIFID_TEMP
    if (!uifid) throw new DouyinError("visitor", "抖音页面未签发可用游客 UIFID")
    return { ttwid: cookies.ttwid, uifid }
  }

  async get({ refresh = false, previous = "", timeoutMs = this.timeoutMs } = {}) {
    if (refresh && this.identity?.value === previous) this.identity = null
    if (this.identity && this.identity.expires > this.now()) return this.identity.value
    if (this.pending) return this.pending
    this.pending = this.register(timeoutMs)
    try { return await this.pending } finally { this.pending = null }
  }

  async register(timeoutMs = this.timeoutMs) {
    const { response } = await requestText(this.fetch, "https://ttwid.bytedance.com/ttwid/union/register/", {
      method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: "cn", aid: 1768, needFid: false, service: "www.ixigua.com", migrate_info: { ticket: "", source: "node" }, cbUrlProtocol: "https", union: true }),
    }, { timeoutMs })
    if (!response.ok) throw new DouyinError("visitor", `游客身份获取失败 HTTP ${response.status}`)
    const cookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""]
    const cookie = cookies.find(value => /(?:^|[;,]\s*)ttwid=/.test(value)) || ""
    const value = cookie.match(/(?:^|[;,]\s*)ttwid=([^;]+)/)?.[1]
    if (!value) throw new DouyinError("visitor", "游客接口未返回 ttwid")
    const seconds = Number(cookie.match(/max-age=(\d+)/i)?.[1] || 86400)
    this.identity = { value, expires: this.now() + Math.min(seconds, 86400) * 1000 }
    return value
  }
}

let defaultVisitor
export function getDefaultVisitor() {
  return defaultVisitor ||= new DouyinVisitor()
}
