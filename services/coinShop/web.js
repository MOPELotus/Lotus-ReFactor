import http from "node:http"
import { MiyousheManagement } from "../miyoushe/management.js"
import { readPanelConfig, savePanelConfig } from "../panel/config.js"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import { listProfileIds, loadLoggedInProfile, normalizeProfileId } from "../../core/config/profile.js"
import { WebSessionStore } from "./sessions.js"

const digest = value => crypto.createHash("sha256").update(value).digest("hex")
const secret = () => crypto.randomBytes(32).toString("base64url")
const cookieName = "lotus_coin_shop"

export class CoinShopWeb {
  constructor(options = {}) {
    this.service = options.service
    this.miyoushe = options.miyoushe || new MiyousheManagement(options)
    this.isOwner = options.isOwner || (session => session.owner === true)
    this.readPanel = options.readPanel || readPanelConfig
    this.savePanel = options.savePanel || savePanelConfig
    this.loadProfile = options.loadProfile || loadLoggedInProfile
    this.listProfiles = options.listProfiles || listProfileIds
    this.now = options.now || Date.now
    this.tickets = new Map()
    this.sessions = new Map()
    this.sessionStore = options.sessionFile ? new WebSessionStore(options.sessionFile, this.now) : null
    this.sessionsReady = null
    this.sessionWrites = Promise.resolve()
    this.server = null
    this.shared = null
    this.config = null
    this.routes = new Map()
  }

  async start(config = {}, bot = globalThis.Bot) {
    const tickets = Object.fromEntries(["ticket_minutes", "panel_ticket_minutes"].map(key => [key, config[key] ?? this.config?.[key] ?? 10]))
    for (const value of Object.values(tickets)) {
      if (!Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(this.now() + value * 60000)) throw new Error("网页登录链接有效期须为正整数分钟")
    }
    const sessions = { session_hours: config.session_hours ?? this.config?.session_hours ?? 8,
      panel_session_hours: config.panel_session_hours ?? this.config?.panel_session_hours ?? 24 }
    for (const value of Object.values(sessions)) {
      if (!Number.isFinite(value) || value * 3600 < 1 || !Number.isSafeInteger(this.now() + value * 3600000)) throw new Error("浏览器令牌有效期须为正数小时，不能短于一秒")
    }
    if (this.server || this.shared) { Object.assign(this.config, tickets, sessions); return this.status() }
    if (this.sessionStore) {
      this.sessionsReady ||= this.sessionStore.load().then(stored => { this.sessions = stored })
      await this.sessionsReady
      if (this.server || this.shared) { Object.assign(this.config, tickets, sessions); return this.status() }
    }
    this.config = { enable: true, mode: "auto", host: "127.0.0.1", port: 18164, path: "/lotus/coin-shop", public_url: "", icp_number: "", ...config }
    Object.assign(this.config, tickets, sessions)
    const cfg = this.config
    if (!/^\/[a-zA-Z0-9_/-]+$/.test(cfg.path) || cfg.path === "/" || cfg.path.includes("//")) throw new Error("商城挂载路径格式错误")
    cfg.path = cfg.path.replace(/\/$/, "")
    if (cfg.public_url && !/^https?:$/.test(new URL(cfg.public_url).protocol)) throw new Error("商城外部地址需使用 HTTP 或 HTTPS")
    if (!["auto", "shared", "standalone"].includes(cfg.mode)) throw new Error("商城服务模式错误")
    if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error("商城端口配置错误")
    const handler = (req, res) => void this.handle(req, res)
    const app = bot?.express
    if (cfg.mode !== "standalone" && app?.use) {
      const stack = app._router?.stack || app.router?.stack
      if (!Array.isArray(stack)) throw new Error("无法安全挂载 TRSS 共用端口，请改用 standalone 模式")
      const length = stack.length
      app.use(cfg.path, handler)
      app.use(this.panelPath(), handler)
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
    try { if (cfg.enable !== false) await this.service.start() }
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

  panelPath() { return this.config.path.replace(/\/[^/]+$/, "") + "/panel" }

  ticketMinutes(purpose = "user") { return this.config[purpose === "panel" ? "panel_ticket_minutes" : "ticket_minutes"] }

  sessionHours(purpose = "user") { return this.config[purpose === "panel" ? "panel_session_hours" : "session_hours"] }

  updateSessions(mutate) {
    const write = this.sessionWrites.catch(() => {}).then(async () => {
      const previous = new Map(this.sessions)
      mutate(this.sessions)
      try { await this.sessionStore?.save(this.sessions) }
      catch (error) { this.sessions = previous; throw error }
    })
    this.sessionWrites = write
    return write
  }

  mountRoute(route, handler) {
    if (!/^\/[a-zA-Z0-9_/-]+$/.test(route) || route.includes("//") || route === "/" || this.routes.has(route)
      || [this.config.path, this.panelPath()].some(base => route === base || route.startsWith(base + "/") || base.startsWith(route + "/"))) throw new Error("网页挂载路径冲突")
    this.routes.set(route, handler)
    let layers = []
    if (this.shared) {
      const { app, stack } = this.shared
      const length = stack.length
      app.use(route, (req, res) => void this.handle(req, res))
      layers = stack.splice(length)
      stack.unshift(...layers)
      this.shared.layers.push(...layers)
    }
    return () => {
      if (this.routes.get(route) !== handler) return
      this.routes.delete(route)
      handler.close?.()
      for (const layer of layers) {
        const index = this.shared?.stack.indexOf(layer) ?? -1
        if (index >= 0) this.shared.stack.splice(index, 1)
      }
    }
  }

  issuePanelTicket(qq, botId = "", owner = false) {
    if (owner !== true) throw Object.assign(new Error("只有机器人主人可以获取管理面板链接"), { status: 403 })
    return this.issueTicket(qq, botId, true, "panel")
  }

  issueTicket(qq, botId = "", owner = false, purpose = "user") {
    if (!this.status().enabled) throw new Error("米游币网页尚未启动，请检查本机 coin_shop 配置")
    if (purpose === "user" && this.config.enable === false) throw new Error("米游社功能网页已关闭")
    if (!["user", "panel"].includes(purpose) || purpose === "panel" && owner !== true) throw new Error("面板登录权限无效")
    this.prune()
    for (const [key, ticket] of this.tickets) if (ticket.qq === String(qq) && ticket.purpose === purpose) this.tickets.delete(key)
    const value = secret()
    this.tickets.set(digest(value), { qq: String(qq), botId: String(botId), owner: owner === true, purpose, expires: this.now() + this.ticketMinutes(purpose) * 60000 })
    const url = purpose === "panel" ? new URL(this.panelPath() + "/", this.status().url).href : this.status().url
    return `${url}#ticket=${value}`
  }

  prune() {
    for (const records of [this.tickets, this.sessions]) for (const [key, item] of records) if (item.expires <= this.now()) records.delete(key)
  }

  async close() {
    for (const handler of this.routes.values()) handler.close?.()
    this.routes.clear()
    if (this.shared) {
      for (const layer of this.shared.layers) { const i = this.shared.stack.indexOf(layer); if (i >= 0) this.shared.stack.splice(i, 1) }
      this.shared = null
    }
    if (this.server) { await new Promise(resolve => this.server.close(resolve)); this.server = null }
    await this.sessionWrites.catch(() => {})
    this.sessions.clear()
    this.sessionsReady = null
    this.tickets.clear()
  }

  async body(req, limit = 8192) {
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body
    let bytes = 0
    const chunks = []
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > limit) throw Object.assign(new Error("请求内容过长"), { status: 413 })
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
      for (const [route, handler] of this.routes) {
        if (url.pathname === route || url.pathname.startsWith(route + "/")) return await handler(req, res)
      }
      const panel = url.pathname === this.panelPath() || url.pathname.startsWith(this.panelPath() + "/")
      if (!panel && this.config.enable === false) { this.json(res, 404, { error: "用户页面已关闭" }); return }
      const base = panel ? this.panelPath() : this.config.path
      const purpose = panel ? "panel" : "user", sessionCookie = panel ? "lotus_panel" : cookieName
      if (url.pathname === base) { res.writeHead(302, { Location: base + "/" }); res.end(); return }
      if (!url.pathname.startsWith(base + "/")) { this.json(res, 404, { error: "页面不存在" }); return }
      const route = url.pathname.slice(base.length)
      if (req.method === "GET" && ["/", "/app.js", "/style.css"].includes(route)) {
        const file = route === "/" ? "index.html" : route.slice(1)
        const data = await fs.readFile(new URL(`./${panel ? "panel" : "web"}/${file}`, import.meta.url))
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
        if (ticket.purpose !== purpose || panel && !await this.isOwner(ticket)) throw Object.assign(new Error("登录链接不适用于此页面"), { status: 403 })
        if (this.tickets.get(digest(input.ticket)) !== ticket || ticket.expires <= this.now()) throw Object.assign(new Error("登录链接已使用或已过期，请获取新链接"), { status: 401 })
        this.tickets.delete(digest(input.ticket))
        const sessionId = secret(), csrf = secret()
        const maxAge = Math.floor(this.sessionHours(purpose) * 3600)
        const browserSession = { ...ticket, csrf, expires: this.now() + maxAge * 1000 }
        await this.updateSessions(sessions => sessions.set(digest(sessionId), browserSession))
        res.setHeader("Set-Cookie", `${sessionCookie}=${sessionId}; Path=${base}/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.status().url.startsWith("https:") ? "; Secure" : ""}`)
        this.json(res, 200, { csrf, qq: ticket.qq, owner: await this.isOwner(ticket), now: this.now(), expiresAt: browserSession.expires })
        return
      }
      const value = String(req.headers.cookie || "").split(/;\s*/).find(part => part.startsWith(sessionCookie + "="))?.slice(sessionCookie.length + 1)
      const session = value ? this.sessions.get(digest(value)) : null
      if (!session) throw Object.assign(new Error(panel ? "管理会话已失效，请主人私聊发送 #荷花管理面板 获取新链接" : "请私聊机器人发送 #米游社功能，获取专属登录链接"), { status: 401 })
      if (session.purpose !== purpose || panel && !await this.isOwner(session)) throw Object.assign(new Error("只有机器人主人可以访问管理面板"), { status: 403 })
      if (mutating && req.headers["x-csrf-token"] !== session.csrf) throw Object.assign(new Error("页面凭证已失效，请刷新页面"), { status: 403 })
      if (req.method === "GET" && route === "/api/session") { this.json(res, 200, { csrf: session.csrf, qq: session.qq, owner: await this.isOwner(session), now: this.now(), expiresAt: session.expires }); return }
      if (req.method === "POST" && route === "/api/logout") {
        await this.updateSessions(sessions => sessions.delete(digest(value)))
        res.setHeader("Set-Cookie", `${sessionCookie}=; Path=${base}/; HttpOnly; SameSite=Strict; Max-Age=0${this.status().url.startsWith("https:") ? "; Secure" : ""}`)
        this.json(res, 200, { ok: true }); return
      }
      if (panel) {
        if (route === "/api/config" && req.method === "GET") { this.json(res, 200, await this.readPanel()); return }
        if (route === "/api/config" && req.method === "POST") { this.json(res, 200, await this.savePanel(await this.body(req, 65536))); return }
        this.json(res, 404, { error: "页面不存在" }); return
      }
      if (route === "/api/miyoushe/captcha" && req.method === "GET") {
        this.json(res, 200, await this.miyoushe.captchaStatus(session.qq, normalizeProfileId(url.searchParams.get("profile") || 1))); return
      }
      if (route === "/api/miyoushe" && req.method === "GET") {
        this.json(res, 200, await this.miyoushe.overview(session.qq, normalizeProfileId(url.searchParams.get("profile") || 1))); return
      }
      if (route === "/api/miyoushe/settings" && req.method === "POST") {
        const { profileId = 1, settings } = await this.body(req)
        this.json(res, 200, { settings: await this.miyoushe.settings(session.qq, profileId, settings || {}, { user_id: session.qq, isMaster: await this.isOwner(session) }) }); return
      }
      if (route === "/api/miyoushe/run" && req.method === "POST") {
        const { profileId = 1 } = await this.body(req)
        this.json(res, 202, await this.miyoushe.run(session.qq, profileId)); return
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
        const { profileId, mode, game, itemType, goodsIds, keywords, maxPrice, spendLimit, followSameName, addressId, pollMinutes, leadSeconds, intervalMs } = input
        const tracker = await this.service.tracking.create({ qq: session.qq, botId: session.botId, profileId, mode, game, itemType, goodsIds, keywords, maxPrice, spendLimit, followSameName, addressId, pollMinutes, leadSeconds, intervalMs })
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
