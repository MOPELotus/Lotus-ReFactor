import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CoinShopWeb } from "../services/coinShop/web.js"
import { CoinShopService } from "../services/coinShop/service.js"
import { CoinShopStore } from "../services/coinShop/store.js"

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-coin-web-"))
  const good = { id: "123456", name: "菲林×60", price: 1800, type: 2, gameBiz: "nap_cn", status: "scheduled", opensAt: Date.now() + 3600000, stock: 0, nextStock: 3000 }
  const reads = [], posts = []
  const profile = qq => ({ profile: { id: 1, name: "主账号" }, account: { stuid: `acct-${qq}`, cookie: "SECRET-COOKIE", current_uid: { zzz: "10001" } }, device: { id: "SECRET-DEVICE", fp: "SECRET-FP" } })
  const loadProfile = async (qq, id) => { assert.ok(["123", "456"].includes(qq)); if(id !== 1) throw new Error("该 profile 未登录"); return profile(qq) }
  const client = {
    list: async options => { reads.push(options); return { goods: [good], games: [{ key: "nap", name: "绝区零" }], total: 1, page: 1 } },
    detail: async () => good, points: async () => 11519,
    roles: async () => [{ uid: "10001", region: "prod_gf_cn", gameBiz: "nap_cn", nickname: "角色" }],
    exchange: async plan => { posts.push(plan); return { retcode: 0 } },
  }
  const service = new CoinShopService({ client, store: new CoinShopStore(path.join(root, "plans.json")), loadProfile, notify: async () => {} })
  const web = new CoinShopWeb({ service, loadProfile, listProfiles: async qq => { assert.ok(["123", "456"].includes(qq)); return [1] } })
  await web.start({ mode: "standalone", port: 0 })
  t.after(async () => { service.stop(); await web.close(); await fs.rm(root, { recursive: true, force: true }) })
  const base = web.status().url, origin = new URL(base).origin
  const login = async qq => {
    const ticket = new URL(web.issueTicket(qq, "bot")).hash.slice(8)
    const response = await fetch(base + "api/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) })
    assert.equal(response.status, 200)
    const data = await response.json(), cookie = response.headers.get("set-cookie").split(";")[0]
    const request = (route, options = {}) => fetch(base + "api/" + route, { ...options, headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": data.csrf, "Content-Type": "application/json", ...options.headers } })
    return { ticket, cookie, csrf: data.csrf, request }
  }
  return { root, service, client, web, good, reads, posts, base, origin, login }
}

test("page and assets load without credentials, but all account data needs a valid session", async t => {
  const f = await fixture(t)
  const page = await fetch(f.base)
  assert.equal(page.status, 200)
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/)
  assert.match(await page.text(), /商品商城/)
  assert.equal((await fetch(f.base + "app.js")).status, 200)
  assert.equal((await fetch(f.base + "api/catalog")).status, 401)
  assert.equal(f.reads.length, 0)
  assert.equal(f.posts.length, 0)
})

test("one-time login links cannot be replayed, cookies are HttpOnly, and profiles expose no credentials", async t => {
  const f = await fixture(t), user = await f.login("123")
  const replay = await fetch(f.base + "api/session", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket: user.ticket }) })
  assert.equal(replay.status, 401)
  const profiles = await user.request("profiles"), data = await profiles.text()
  assert.ok(!data.includes("SECRET"))
  assert.deepEqual(JSON.parse(data).profiles.map(p => p.id), [1])
  const ticket = new URL(f.web.issueTicket("456")).hash.slice(8)
  const login = await fetch(f.base + "api/session", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) })
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/)
})

test("catalog and details expose real stock, future opening and only owned destinations without submitting", async t => {
  const f = await fixture(t), user = await f.login("123")
  const catalog = await (await user.request("catalog?profile=1&game=nap&page=1")).json()
  assert.equal(catalog.balance, 11519)
  assert.equal(catalog.goods[0].stock, 0)
  assert.equal(catalog.goods[0].nextStock, 3000)
  assert.equal(f.reads[0].game, "nap")
  const detail = await (await user.request("goods/123456?profile=1")).json()
  assert.equal(detail.targets.selected, "10001")
  assert.deepEqual(detail.targets.items.map(r => r.uid), ["10001"])
  assert.equal(f.posts.length, 0)
})

test("cross-site and missing-CSRF requests cannot create plans", async t => {
  const f = await fixture(t), user = await f.login("123")
  const body = JSON.stringify({ goodsId: f.good.id, profileId: 1, immediate: false })
  assert.equal((await user.request("plans", { method: "POST", body, headers: { Origin: "https://attacker.example" } })).status, 403)
  assert.equal((await user.request("plans", { method: "POST", body, headers: { "X-CSRF-Token": "" } })).status, 403)
  assert.equal((await f.service.store.list()).length, 0)
})

test("session identity overrides forged owner fields; owners cannot read or cancel each other's reservations", async t => {
  const f = await fixture(t), a = await f.login("123"), b = await f.login("456")
  const created = await (await a.request("plans", { method: "POST", body: JSON.stringify({ qq: "456", botId: "forged", accountId: "forged", goodsId: f.good.id, profileId: 1, immediate: false }) })).json()
  assert.ok(created.plan.id)
  assert.equal(created.plan.qq, undefined)
  assert.equal(created.plan.accountId, undefined)
  const stored = (await f.service.store.list())[0]
  assert.equal(stored.qq, "123")
  assert.equal(stored.botId, "bot")
  assert.equal((await (await b.request("plans")).json()).plans.length, 0)
  assert.equal((await b.request(`plans/${stored.id}/cancel`, { method: "POST", body: "{}" })).status, 400)
  assert.equal((await a.request(`plans/${stored.id}/cancel`, { method: "POST", body: "{}" })).status, 200)
  assert.equal((await f.service.store.list())[0].status, "cancelled")
  assert.equal(f.posts.length, 0)
})

test("logout revokes the server session immediately", async t => {
  const f = await fixture(t), user = await f.login("123")
  assert.equal((await user.request("logout", { method: "POST", body: "{}" })).status, 200)
  assert.equal((await user.request("plans")).status, 401)
})

test("TRSS mounts only its own prefix before generic logging and uses the existing server port", async () => {
  const genericLogger = { path: "/", handle: () => {} }
  const app = { router: { stack: [genericLogger] }, use(prefix, handle) { this.router.stack.push({ path: prefix, handle }) } }
  const web = new CoinShopWeb({ service: { start: async () => {} } })
  await web.start({ mode: "shared" }, { express: app, server: { address: () => ({ port: 2536 }) }, url: "http://localhost:2536" })
  assert.equal(web.status().mode, "shared")
  assert.equal(web.status().port, 2536)
  assert.equal(app.router.stack[0].path, "/lotus/coin-shop")
  assert.equal(app.router.stack[1], genericLogger)
  assert.equal(web.server, null)
  await web.close()
  assert.deepEqual(app.router.stack, [genericLogger])
})

test("tracking endpoints bind the session owner and profile target, enforce CSRF and hide account identifiers", async t => {
  const f = await fixture(t), a = await f.login("123"), b = await f.login("456")
  const input = { qq: "456", accountId: "forged", role: { uid: "forged" }, profileId: 1, mode: "category", game: "nap", itemType: 2, keywords: ["菲林"] }
  const blocked = await a.request("trackers", { method: "POST", headers: { "X-CSRF-Token": "wrong" }, body: JSON.stringify(input) })
  assert.equal(blocked.status, 403)
  const response = await a.request("trackers", { method: "POST", body: JSON.stringify(input) })
  assert.equal(response.status, 200)
  const { tracker } = await response.json()
  assert.equal(tracker.role.uid, "10001")
  assert.equal(tracker.qq, undefined)
  assert.equal(tracker.accountId, undefined)
  assert.deepEqual((await (await b.request("trackers")).json()).trackers, [])
  assert.equal((await b.request(`trackers/${tracker.id}/pause`, { method: "POST", body: "{}" })).status, 400)
  assert.equal((await a.request(`trackers/${tracker.id}/pause`, { method: "POST", body: "{}" })).status, 200)
  assert.equal((await (await a.request("trackers")).json()).trackers[0].enabled, false)
  assert.equal(f.posts.length, 0)
})
