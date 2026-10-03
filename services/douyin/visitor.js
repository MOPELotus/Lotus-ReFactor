import { requestText, DouyinError } from "./http.js"

// A visitor identity only. Work responses and download files are never cached.
export class DouyinVisitor {
  constructor({ fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {}) {
    this.fetch = fetchImpl
    this.now = now
    this.timeoutMs = timeoutMs
    this.identity = null
    this.pending = null
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
