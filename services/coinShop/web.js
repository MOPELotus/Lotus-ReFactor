import http from "node:http"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import { listProfileIds, loadLoggedInProfile, normalizeProfileId } from "../../core/config/profile.js"

const digest = value => crypto.createHash("sha256").update(value).digest("hex")
const secret = () => crypto.randomBytes(32).toString("base64url")
const cookieName = "lotus_coin_shop"

export class CoinShopWeb {
  constructor(options = {}) {
    this.service = options.service
    this.loadProfile = options.loadProfile || loadLoggedInProfile
    this.listProfiles = options.listProfiles || listProfileIds
    this.now = options.now || Date.now
    this.tickets = new Map()
    this.sessions = new Map()
    this.server = null
    this.shared = null
    this.config = null
  }

  async start(config = {}, bot = globalThis.Bot) {
    if (this.server || this.shared) return this.status()
    this.config = { enable: true, mode: "auto", host: "127.0.0.1", port: 18164, path: "/lotus/coin-shop", public_url: "", icp_number: "", session_hours: 8, ...config }
    const cfg = this.config
    if (cfg.enable === false) return { enabled: false }
    if (!/^\/[a-zA-Z0-9_/-]+$/.test(cfg.path) || cfg.path === "/" || cfg.path.includes("//")) throw new Error("商城挂载路径格式错误")
    cfg.path = cfg.path.replace(/\/$/, "")
    if (cfg.public_url && !/^https?:$/.test(new URL(cfg.public_url).protocol)) throw new Error("商城外部地址需使用 HTTP 或 HTTPS")
    if (!["auto", "shared", "standalone"].includes(cfg.mode)) throw new Error("商城服务模式错误")
    if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535 || !Number.isFinite(cfg.session_hours) || cfg.session_hours < 1 || cfg.session_hours > 24) throw new Error("商城端口或会话时长配置错误")
    const handler = (req, res) => void this.handle(req, res)
    const app = bot?.express
    if (cfg.mode !== "standalone" && app?.use) {
      const stack = app._router?.stack || app.router?.stack
      if (!Array.isArray(stack)) throw new Error("无法安全挂载 TRSS 共用端口，请改用 standalone 模式")
      const length = stack.length
      app.use(cfg.path, handler)
      const layers = stack.splice(length)
      // Handle only our path before TRSS's generic request logger, so session
      // cookies and one-time login tickets never enter the host's request logs.
      stack.unshift(...layers)
      this.shared = { app, stack, layers, bot }
    } else {
      if (cfg.mode === "shared") throw new Error("当前 Yunzai 未提供可共用的 HTTP 服务")
      const server = http.createServer(handler)
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(cfg.port, cfg.host, resolve) })
      this.server = server
    }
    try { await this.service.start() }
    catch (error) { await this.close(); throw error }
    return this.status()
  }

  status() {
    if (!this.config) return { enabled: false, url: "", port: null }
    const address = this.server?.address() || this.shared?.bot.server?.address?.()
    const port = address?.port || this.config?.port
    const configured = this.config?.public_url || (this.shared?.bot.url ? new URL(this.config.path + "/", this.shared.bot.url).href : `http://127.0.0.1:${port}${this.config?.path || ""}/`)
    let url = configured.endsWith("/") ? configured : configured + "/"
    if (new URL(url).pathname === "/") url = new URL(this.config.path + "/", url).href
    return { enabled: Boolean(this.server || this.shared), mode: this.shared ? "shared" : "standalone", port, url }
  }

  issueTicket(qq, botId = "") {
    if (!this.status().enabled) throw new Error("米游币网页尚未启动，请检查本机 coin_shop 配置")
    this.prune()
    for (const [key, ticket] of this.tickets) if (ticket.qq === String(qq)) this.tickets.delete(key)
    const value = secret()
    this.tickets.set(digest(value), { qq: String(qq), botId: String(botId), expires: this.now() + 10 * 60000 })
    return `${this.status().url}#ticket=${value}`
  }

  prune() {
    for (const records of [this.tickets, this.sessions]) for (const [key, item] of records) if (item.expires <= this.now()) records.delete(key)
  }

  async close() {
    if (this.shared) {
      for (const layer of this.shared.layers) { const i = this.shared.stack.indexOf(layer); if (i >= 0) this.shared.stack.splice(i, 1) }
      this.shared = null
    }
    if (this.server) { await new Promise(resolve => this.server.close(resolve)); this.server = null }
    this.sessions.clear()
    this.tickets.clear()
  }

  async body(req) {
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body
    let bytes = 0
    const chunks = []
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > 8192) throw Object.assign(new Error("请求内容过长"), { status: 413 })
      chunks.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }
    catch { throw Object.assign(new Error("请求 JSON 格式错误"), { status: 400 }) }
  }

  json(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(data))
  }

  async handle(req, res) {
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("Referrer-Policy", "no-referrer")
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'")
    try {
      this.prune()
      const original = req.originalUrl || req.url
      const url = new URL(original, "http://localhost")
      const base = this.config.path
      if (url.pathname === base) { res.writeHead(302, { Location: base + "/" }); res.end(); return }
      if (!url.pathname.startsWith(base + "/")) { this.json(res, 404, { error: "页面不存在" }); return }
      const route = url.pathname.slice(base.length)
      if (req.method === "GET" && ["/", "/app.js", "/style.css"].includes(route)) {
        const file = route === "/" ? "index.html" : route.slice(1)
        const data = await fs.readFile(new URL(`./web/${file}`, import.meta.url))
        res.setHeader("Content-Type", file.endsWith("html") ? "text/html; charset=utf-8" : file.endsWith("js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8")
        if (file.endsWith("html")) {
          const number = String(this.config.icp_number || "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
          res.end(data.toString("utf8").replace("<!--coin-shop-footer-->", number ? `<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${number}</a>` : ""))
        } else res.end(data)
        return
      }
      if (!route.startsWith("/api/")) { this.json(res, 404, { error: "页面不存在" }); return }
      const mutating = req.method !== "GET"
      if (mutating) {
        const allowed = new Set([new URL(this.status().url).origin, `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`])
        if (!allowed.has(req.headers.origin)) throw Object.assign(new Error("请求来源不匹配"), { status: 403 })
      }
      if (route === "/api/session" && req.method === "POST") {
        const input = await this.body(req)
        const ticket = typeof input.ticket === "string" ? this.tickets.get(digest(input.ticket)) : null
        if (!ticket) throw Object.assign(new Error("登录链接无效或已过期，请私聊机器人获取新链接"), { status: 401 })
        this.tickets.delete(digest(input.ticket))
        const sessionId = secret(), csrf = secret()
        const maxAge = Math.floor(this.config.session_hours * 3600)
        this.sessions.set(digest(sessionId), { ...ticket, csrf, expires: this.now() + maxAge * 1000 })
        res.setHeader("Set-Cookie", `${cookieName}=${sessionId}; Path=${base}/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.status().url.startsWith("https:") ? "; Secure" : ""}`)
        this.json(res, 200, { csrf, qq: ticket.qq, now: this.now() })
        return
      }
      const value = String(req.headers.cookie || "").split(/;\s*/).find(part => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1)
      const session = value ? this.sessions.get(digest(value)) : null
      if (!session) throw Object.assign(new Error("请私聊机器人发送 #米游币兑换，获取专属登录链接"), { status: 401 })
      if (mutating && req.headers["x-csrf-token"] !== session.csrf) throw Object.assign(new Error("页面凭证已失效，请刷新页面"), { status: 403 })
      if (req.method === "GET" && route === "/api/session") { this.json(res, 200, { csrf: session.csrf, qq: session.qq, now: this.now() }); return }
      if (req.method === "POST" && route === "/api/logout") {
        this.sessions.delete(digest(value)); res.setHeader("Set-Cookie", `${cookieName}=; Path=${base}/; HttpOnly; SameSite=Strict; Max-Age=0`)
        this.json(res, 200, { ok: true }); return
      }
      if (req.method === "GET" && route === "/api/profiles") {
        const profiles = await Promise.all((await this.listProfiles(session.qq)).map(async id => {
          try { const p = await this.loadProfile(session.qq, id); return { id, name: p.profile?.name || `profile ${id}`, loggedIn: true, deviceBound: Boolean(p.device?.id && p.device?.fp) } }
          catch { return { id, name: `profile ${id}`, loggedIn: false, deviceBound: false } }
        }))
        this.json(res, 200, { profiles }); return
      }
      if (req.method === "GET" && route === "/api/plans") {
        this.json(res, 200, { plans: (await this.service.listPlans(session.qq)).map(publicPlan), now: this.now() }); return
      }
      if (req.method === "GET" && route === "/api/trackers") {
        this.json(res, 200, { trackers: (await this.service.tracking.list(session.qq)).map(publicPlan) }); return
      }
      if (req.method === "GET" && route === "/api/tracking-targets") {
        this.json(res, 200, await this.service.tracking.destinations({ qq: session.qq, profileId: normalizeProfileId(url.searchParams.get("profile") || 1), game: url.searchParams.get("game"), itemType: Number(url.searchParams.get("itemType")) })); return
      }
      if (req.method === "POST" && route === "/api/trackers") {
        const input = await this.body(req)
        const { profileId, mode, game, itemType, goodsIds, keywords, maxPrice, spendLimit, followSameName, addressId, pollMinutes, leadSeconds, intervalMs, afterSeconds } = input
        const tracker = await this.service.tracking.create({ qq: session.qq, botId: session.botId, profileId, mode, game, itemType, goodsIds, keywords, maxPrice, spendLimit, followSameName, addressId, pollMinutes, leadSeconds, intervalMs, afterSeconds })
        this.json(res, 200, { tracker: publicPlan(tracker) }); return
      }
      const trackerMatch = route.match(/^\/api\/trackers\/([a-f0-9]{12})\/(pause|resume)$/)
      if (req.method === "POST" && trackerMatch) {
        this.json(res, 200, { tracker: publicPlan(await this.service.tracking.setEnabled(session.qq, trackerMatch[1], trackerMatch[2] === "resume")) }); return
      }
      const profileId = normalizeProfileId(url.searchParams.get("profile") || 1)
      if (req.method === "GET" && route === "/api/catalog") {
        const page = Number(url.searchParams.get("page") || 1), game = url.searchParams.get("game") || ""
        if (!Number.isInteger(page) || page < 1 || page > 100 || !/^[a-zA-Z0-9_]*$/.test(game)) throw new Error("商城分区或页码格式错误")
        const profile = await this.loadProfile(session.qq, profileId)
        const [catalog, balance] = await Promise.allSettled([this.service.client.list({ game, page, profile }), this.service.client.points(profile)])
        if (catalog.status === "rejected") throw catalog.reason
        this.json(res, 200, { ...catalog.value, balance: balance.status === "fulfilled" ? balance.value : null, balanceError: balance.status === "rejected" ? balance.reason.message : "", deviceBound: Boolean(profile.device?.id && profile.device?.fp), now: this.now() }); return
      }
      const goodMatch = route.match(/^\/api\/goods\/(\d+)$/)
      if (req.method === "GET" && goodMatch) {
        const profile = await this.loadProfile(session.qq, profileId)
        const good = await this.service.client.detail(goodMatch[1], profile)
        const targets = await this.service.destinations({ qq: session.qq, profileId, goodsId: good.id })
        this.json(res, 200, { good, targets }); return
      }
      if (req.method === "POST" && route === "/api/plans") {
        const input = await this.body(req)
        if (!/^\d+$/.test(String(input.goodsId || "")) || typeof input.immediate !== "boolean") throw new Error("兑换商品或操作格式错误")
        const plan = await this.service.reserve({ qq: session.qq, profileId: normalizeProfileId(input.profileId),
          goodsId: String(input.goodsId), uid: String(input.uid || ""), addressId: String(input.addressId || ""),
          botId: session.botId, immediate: input.immediate })
        this.json(res, 200, { plan: publicPlan(plan) })
        void this.service.scan().catch(error => globalThis.logger?.warn?.(`[Lotus-Plugin] 兑换计划调度失败：${error.message}`))
        return
      }
      const planMatch = route.match(/^\/api\/plans\/([a-f0-9]{12})\/(cancel|resolve)$/)
      if (req.method === "POST" && planMatch) {
        const input = await this.body(req)
        if (planMatch[2] === "resolve" && typeof input.redeemed !== "boolean") throw new Error("请确认官方兑换记录中的结果")
        const plan = planMatch[2] === "cancel" ? await this.service.cancel(session.qq, planMatch[1]) : await this.service.resolveUnknown(session.qq, planMatch[1], input.redeemed)
        this.json(res, 200, { plan: publicPlan(plan) }); return
      }
      this.json(res, 404, { error: "接口不存在" })
    } catch (error) {
      if (!res.headersSent) this.json(res, error.status || 400, { error: error.message })
      else res.end()
    }
  }
}

function publicPlan({ accountId, qq, botId, ...plan }) { return plan }
