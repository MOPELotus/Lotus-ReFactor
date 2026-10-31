import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CoinShopClient, normalizeGood, beijingTime } from "../services/coinShop/client.js"
import { CoinShopStore } from "../services/coinShop/store.js"
import { CoinShopService } from "../services/coinShop/service.js"

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-coin-shop-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let now = Date.parse("2026-10-31T12:00:00+08:00")
  const profile = { account: { stuid: "acct1", cookie: "private-cookie", current_uid: { sr: "10001" } }, device: { id: "private-device", fp: "private-fp" } }
  const good = { id: "202610123", name: "星琼×60", price: 1800, type: 2, gameBiz: "hkrpg_cn", status: "scheduled", opensAt: now + 1000, limit: 1, exchanged: 0, limitCycle: "forever" }
  const posts = [], notices = []
  const client = {
    detail: async () => ({ ...good }), points: async () => 10000,
    roles: async () => [{ uid: "10001", region: "prod_gf_cn", gameBiz: "hkrpg_cn" }],
    addresses: async () => [{ id: "1", label: "张** ****1234" }],
    exchange: async (plan, p) => { posts.push({ plan, profile: p, at: now }); return { retcode: 0, message: "OK" } },
  }
  const store = new CoinShopStore(path.join(root, "plans.json"))
  const service = new CoinShopService({ client, store, now: () => now, loadProfile: async () => profile,
    wait: async (ms, signal) => { signal?.throwIfAborted(); now += ms }, notify: async (...args) => { notices.push(args) },
  })
  t.after(() => service.stop())
  return { root, service, client, store, profile, good, posts, notices, now: () => now,
    advance: ms => { now += ms }, reserve: options => service.reserve({ qq: "123", goodsId: good.id, ...options }) }
}

test("stock zero with a future refill is scheduled even if status is online; Beijing display is timezone independent", () => {
  const raw = { goods_id: "1", goods_name: "菲林", price: 1800, status: "online", total: 0, now_time: 1793440000, next_time: 1793876400, sale_start_time: "1793271600", next_num: 3000 }
  const good = normalizeGood(raw)
  assert.equal(good.status, "scheduled")
  assert.equal(good.opensAt, 1793876400000)
  assert.equal(good.nextStock, 3000)
  assert.equal(beijingTime(Date.parse("2026-10-31T12:00:00+08:00")), "2026-10-31 12:00:00")
  assert.equal(normalizeGood({ ...raw, total: 3 }).status, "available")
  assert.equal(normalizeGood({ ...raw, end: 1793000000 }).status, "ended")
  assert.equal(normalizeGood({ ...raw, total: undefined, next_time: 0 }).status, "unknown")
})

test("first sale time takes precedence over a later refill", () => {
  const good = normalizeGood({ goods_id: "1", status: "not_in_sell", total: 0, now_time: 100, sale_start_time: 200, next_time: 300 })
  assert.equal(good.opensAt, 200000)
})

test("GET recovers from connection reset, scopes credentials to official reads, and normalizes balance", async () => {
  let reads = 0
  const client = new CoinShopClient({ getJson: async (url, options) => {
    reads++
    assert.equal(new URL(url).hostname, "api-takumi.mihoyo.com")
    assert.equal(options.headers.Cookie, "secret")
    if (reads === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" })
    return { retcode: 0, data: { points: "11519" } }
  } })
  assert.equal(await client.points({ account: { cookie: "secret" } }), 11519)
  assert.equal(reads, 2)
})

test("exchange POST is exactly once, for one unit and the selected role, even if the response is lost", async () => {
  let posts = 0
  const client = new CoinShopClient({ postJson: async (body, headers) => {
    posts++
    assert.deepEqual(body, { app_id: 1, point_sn: "myb", goods_id: "1", exchange_num: 1, uid: "10001", region: "cn", game_biz: "hkrpg_cn" })
    assert.equal(headers["x-rpc-device_fp"], "fp")
    throw new Error("response lost")
  } })
  await assert.rejects(client.exchange({ goodsId: "1", role: { uid: "10001", region: "cn", gameBiz: "hkrpg_cn" } }, { device: { id: "id", fp: "fp" }, account: { cookie: "secret" } }), /response lost/)
  assert.equal(posts, 1)
})

test("creating a reservation never spends coins; duplicate plans for the same account are blocked across profile slots", async t => {
  const f = await fixture(t)
  const plan = await f.reserve()
  assert.equal(plan.status, "scheduled")
  assert.equal(f.posts.length, 0)
  await assert.rejects(f.reserve({ profileId: 2 }), /已有/)
  const saved = await fs.readFile(f.store.file, "utf8")
  assert.ok(!saved.includes("private-cookie"))
  assert.ok(!saved.includes("private-device"))
  assert.ok(!saved.includes("private-fp"))
  assert.equal((await fs.stat(f.store.file)).mode & 0o777, 0o600)
})

test("insufficient coins, missing device, unowned role and foreign address are rejected before reservation", async t => {
  const f = await fixture(t)
  await assert.rejects(f.reserve({ uid: "another-account" }), /角色/)
  f.client.points = async () => 10
  await assert.rejects(f.reserve(), /米游币不足/)
  f.client.points = async () => 10000
  f.profile.device.fp = ""
  await assert.rejects(f.reserve(), /设备/)
  f.profile.device.fp = "fp"
  f.good.type = 1
  await assert.rejects(f.reserve(), /收货地址 ID/)
  await assert.rejects(f.reserve({ addressId: "foreign" }), /不属于/)
  assert.equal((await f.store.list()).length, 0)
})

test("only the plan owner may cancel or inspect plans, and cancellation prevents dispatch", async t => {
  const f = await fixture(t)
  const plan = await f.reserve()
  assert.deepEqual(await f.service.listPlans("other"), [])
  await assert.rejects(f.service.cancel("other", plan.id), /未找到/)
  await f.service.cancel("123", plan.id)
  await f.service.run(plan)
  assert.equal(f.posts.length, 0)
  assert.equal((await f.store.list())[0].status, "cancelled")
})

test("scheduler waits until the planned time, submits once, records success and notifies the owner", async t => {
  const f = await fixture(t)
  const plan = await f.reserve()
  await f.service.run(plan)
  assert.equal(f.posts.length, 1)
  assert.equal(f.posts[0].at, plan.opensAt)
  assert.equal((await f.store.list())[0].status, "succeeded")
  assert.equal(f.notices.length, 1)
  await f.service.run(plan)
  assert.equal(f.posts.length, 1)
})

test("an explicit not-started or busy response is retried within the window until the first success", async t => {
  const f = await fixture(t)
  let attempts = 0
  f.client.exchange = async () => (++attempts < 3 ? { retcode: -1, message: "未到兑换时间" } : { retcode: 0 })
  await f.service.run(await f.reserve())
  assert.equal(attempts, 3)
  assert.equal((await f.store.list())[0].status, "succeeded")
})

test("a lost exchange response becomes unknown and is never replayed automatically", async t => {
  const f = await fixture(t)
  let attempts = 0
  f.client.exchange = async () => { attempts++; throw new Error("response lost") }
  const plan = await f.reserve()
  await f.service.run(plan)
  assert.equal(attempts, 1)
  assert.equal((await f.store.list())[0].status, "unknown")
  await f.service.scan()
  await assert.rejects(f.reserve(), /待确认/)
  assert.equal(attempts, 1)
})

test("restart restores waiting plans but marks interrupted submissions unknown without replay", async t => {
  const f = await fixture(t)
  const plan = await f.reserve()
  await f.store.update(plan.id, { status: "submitting" })
  const restored = new CoinShopService({ store: new CoinShopStore(f.store.file), client: f.client })
  await restored.initialize()
  assert.equal((await restored.store.list())[0].status, "unknown")
  assert.equal(f.posts.length, 0)
})

test("changed price, changed account and missed windows stop before spending", async t => {
  for (const scenario of ["price", "account", "missed"]) {
    const f = await fixture(t)
    const plan = await f.reserve()
    if (scenario === "price") f.good.price++
    if (scenario === "account") f.profile.account.stuid = "other-account"
    if (scenario === "missed") f.advance(32000)
    await f.service.run(plan)
    assert.equal(f.posts.length, 0)
    assert.equal((await f.store.list())[0].status, scenario === "missed" ? "missed" : "failed")
  }
})

test("verification and terminal failures stop rather than retrying or bypassing the challenge", async t => {
  for (const response of [{ retcode: 1028, message: "请求失败" }, { retcode: -1, message: "米游币不足" }]) {
    const f = await fixture(t)
    let calls = 0
    f.client.exchange = async () => { calls++; return response }
    await f.service.run(await f.reserve())
    assert.equal(calls, 1)
    assert.equal((await f.store.list())[0].status, "failed")
  }
})

test("rescheduled opening is persisted, while an immediate order never silently becomes a future reservation", async t => {
  const f = await fixture(t)
  const plan = await f.reserve()
  f.good.opensAt += 60000
  await f.service.run(plan)
  assert.equal(f.posts.length, 0)
  assert.equal((await f.store.list())[0].opensAt, f.good.opensAt)
  await f.service.cancel("123", plan.id)
  f.good.status = "available"
  const immediate = await f.reserve({ immediate: true })
  f.good.status = "scheduled"
  await f.service.run(immediate)
  assert.equal(f.posts.length, 0)
  assert.equal((await f.store.list()).find(p => p.id === immediate.id).status, "failed")
})

test("cancellation during preflight is not overwritten and never reaches exchange", async t => {
  const f = await fixture(t)
  const plan = await f.reserve()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.client.points = async () => { entered.resolve(); await release.promise; return 10000 }
  const running = f.service.run(plan)
  await entered.promise
  await f.service.cancel("123", plan.id)
  release.resolve()
  await running
  assert.equal(f.posts.length, 0)
  assert.equal((await f.store.list())[0].status, "cancelled")
})

test("failure to save a confirmed success cannot turn it into a failed order eligible for automatic replay", async t => {
  const f = await fixture(t)
  const plan = await f.reserve()
  const update = f.store.update.bind(f.store)
  f.store.update = async (id, fields, ...rest) => {
    if (fields.status === "succeeded") throw new Error("disk temporarily unavailable")
    return update(id, fields, ...rest)
  }
  await f.service.run(plan)
  assert.equal(f.posts.length, 1)
  assert.equal((await f.store.list())[0].status, "unknown")
  await assert.rejects(f.reserve(), /待确认/)
})

test("only the owner can resolve an uncertain outcome, and doing so never submits a new order", async t => {
  const f = await fixture(t)
  const plan = await f.reserve()
  await f.store.update(plan.id, { status: "unknown" })
  await assert.rejects(f.service.resolveUnknown("other", plan.id, false), /未找到/)
  await f.service.resolveUnknown("123", plan.id, false)
  assert.equal((await f.store.list())[0].status, "failed")
  assert.equal(f.posts.length, 0)
  assert.ok(await f.reserve())
})

test("bot entry only issues a per-user web login link in private chat", async () => {
  globalThis.plugin = class { constructor(config) { Object.assign(this, config) } }
  const { LotusCoinShop } = await import("../apps/coinShop.js")
  const replies = [], issued = []
  const web = { start: async () => {}, issueTicket: (qq, botId) => { issued.push([qq, botId]); return "http://localhost:18164/lotus/coin-shop/#ticket=test" } }
  const app = new LotusCoinShop({ web, getConfig: async () => ({ coin_shop: {} }) })
  app.reply = async message => { replies.push(message) }
  app.e = { msg: "#米游币兑换", user_id: "123", self_id: "bot", isGroup: true, group_id: "456" }
  assert.equal(await app.coinShop(), true)
  assert.equal(issued.length, 0)
  assert.match(replies[0], /请私聊/)
  app.e = { msg: "#米游币兑换", user_id: "123", self_id: "bot" }
  await app.coinShop()
  assert.deepEqual(issued, [["123", "bot"]])
  assert.match(replies[1], /#ticket=test/)
})

test("new goods enrich the first opening from detail rather than displaying the list's later refill", async () => {
  const raw = { goods_id: "123", goods_name: "新商品", price: 100, type: 1, total: 10, status: "not_in_sell", now_time: 100, next_time: 300 }
  const client = new CoinShopClient({ getJson: async url => ({ retcode: 0, data: url.includes("/list?") ? { list: [raw], total: 1 } : { ...raw, sale_start_time: 200 } }) })
  assert.equal((await client.list()).goods[0].opensAt, 200000)
  client.getJson = async url => { if (url.includes("/detail?")) throw new Error("detail unavailable"); return { retcode: 0, data: { list: [raw], total: 1 } } }
  const uncertain = (await client.list()).goods[0]
  assert.equal(uncertain.status, "unknown")
  assert.equal(uncertain.opensAt, 0)
})

test("tracking polls continuously, follows a new goods ID, starts before opening and deduplicates each successful cycle", async t => {
  const f = await fixture(t)
  f.good.game = "hkrpg"
  f.good.opensAt = f.now() + 4000
  f.client.listAll = async () => [{ ...f.good }]
  const rule = await f.service.tracking.create({ qq: "123", mode: "goods", game: "hkrpg", itemType: 2, goodsIds: [f.good.id] })
  await f.service.tracking.poll()
  let [plan] = await f.store.list()
  assert.equal(plan.trackingId, rule.id)
  let attempts = 0
  f.client.exchange = async (p, profile) => { f.posts.push({ plan: p, at: f.now() }); return ++attempts < 3 ? { retcode: -1, message: "尚未开放" } : { retcode: 0 } }
  await f.service.run(plan)
  assert.equal(f.posts[0].at, plan.opensAt - 4000)
  assert.equal(f.posts[1].at - f.posts[0].at, 500)
  assert.equal((await f.store.list())[0].status, "succeeded")
  assert.equal((await f.service.tracking.list("123"))[0].enabled, true)
  f.advance(1800001)
  await f.service.tracking.poll()
  assert.equal((await f.store.list()).length, 1)
  f.good.id = "9999"
  f.good.status = "available"
  await f.service.tracking.poll()
  assert.equal((await f.store.list()).length, 1, "poll interval is respected")
  f.advance(1800001)
  await f.service.tracking.poll()
  assert.equal((await f.store.list()).length, 2)
  assert.deepEqual(await f.service.tracking.list("other"), [])
})

test("category tracking respects game-bound UID, budgets, pause, ownership and restart persistence", async t => {
  const f = await fixture(t)
  f.good.game = "hkrpg"
  f.good.status = "available"
  f.profile.account.current_uid.gs = "wrong-game-uid"
  f.client.listAll = async () => [{ ...f.good }]
  const rule = await f.service.tracking.create({ qq: "123", mode: "category", game: "hkrpg", itemType: 2, keywords: ["星琼"], spendLimit: 1800 })
  assert.equal(rule.role.uid, "10001")
  await assert.rejects(f.service.tracking.setEnabled("other", rule.id, false), /未找到/)
  const reloaded = new CoinShopStore(f.store.file)
  assert.equal((await reloaded.listTrackers())[0].role.uid, "10001")
  await f.service.tracking.poll()
  await f.service.run((await f.store.list())[0])
  f.advance(1800001); f.good.id = "9999"
  await f.service.tracking.poll()
  assert.equal((await f.store.list()).length, 1, "successful spending consumes the rule budget")
  await f.service.tracking.setEnabled("123", rule.id, false)
  assert.equal((await f.service.tracking.list("123"))[0].status, "paused")
  await f.service.tracking.setEnabled("123", rule.id, true)
  f.profile.account.current_uid.sr = "20002"
  f.advance(1800001); await f.service.tracking.poll()
  assert.equal((await f.service.tracking.list("123"))[0].enabled, false)
})

test("unknown tracking submissions and verification pause the rule and never replay", async t => {
  for (const verification of [false, true]) {
    const f = await fixture(t)
    f.good.game = "hkrpg"; f.good.status = "available"
    f.client.listAll = async () => [{ ...f.good }]
    const rule = await f.service.tracking.create({ qq: "123", mode: "category", game: "hkrpg", itemType: 2 })
    await f.service.tracking.poll()
    f.client.exchange = async () => { if (verification) return { retcode: 1034, message: "需要验证" }; throw new Error("lost response") }
    await f.service.run((await f.store.list())[0])
    assert.equal((await f.service.tracking.list("123"))[0].enabled, false)
    assert.equal((await f.store.list())[0].status, verification ? "failed" : "unknown")
    if (!verification) await assert.rejects(f.service.tracking.setEnabled("123", rule.id, true), /待确认/)
    f.advance(1800001); await f.service.tracking.poll()
    assert.equal((await f.store.list()).length, 1)
  }
})

test("pausing during asynchronous tracker preparation cannot create an active submission", async t => {
  const f = await fixture(t)
  f.good.game = "hkrpg"; f.good.status = "available"
  f.client.listAll = async () => [{ ...f.good }]
  const rule = await f.service.tracking.create({ qq: "123", mode: "category", game: "hkrpg", itemType: 2 })
  f.client.points = async () => { await f.service.tracking.setEnabled("123", rule.id, false); return 10000 }
  await f.service.tracking.poll()
  assert.equal((await f.store.list()).length, 0)
  assert.equal(f.posts.length, 0)
})

test("v1 plan stores migrate without losing existing records when tracking rules are added", async t => {
  const f = await fixture(t)
  const file = path.join(f.root, "legacy.json")
  await fs.writeFile(file, JSON.stringify({ version: 1, plans: [{ id: "old", status: "succeeded" }] }))
  const store = new CoinShopStore(file)
  await Promise.all([store.changeTrackers(rules => rules.push({ id: "rule" })), store.update("old", { message: "kept" })])
  const saved = JSON.parse(await fs.readFile(file, "utf8"))
  assert.equal(saved.version, 2)
  assert.equal(saved.plans[0].message, "kept")
  assert.equal(saved.trackers[0].id, "rule")
})

test("restart pauses tracking rules with interrupted submissions before polling other goods", async t => {
  const f = await fixture(t)
  await f.store.changeTrackers(rules => rules.push({ id: "tracking", qq: "123", enabled: true }))
  await f.store.change(plans => plans.push({ id: "interrupted", trackingId: "tracking", status: "submitting" }))
  await f.service.initialize()
  assert.equal((await f.store.list())[0].status, "unknown")
  assert.equal((await f.store.listTrackers())[0].enabled, false)
})

test("minute polling sleeps between scans but wakes for a known opening even with a three-hour interval", async t => {
  const f = await fixture(t)
  f.good.game = "hkrpg"; f.good.opensAt = f.now() + 3600000
  let reads = 0
  f.client.listAll = async () => { reads++; return [{ ...f.good }] }
  const rule = await f.service.tracking.create({ qq: "123", mode: "category", game: "hkrpg", itemType: 2, pollMinutes: 180 })
  assert.equal(rule.pollMs, 10800000)
  await f.service.tracking.poll()
  assert.equal(reads, 1)
  assert.equal(f.service.tracking.snapshots.get(rule.id).nextPollAt, f.good.opensAt - 15000)
  f.advance(30 * 60000); await f.service.tracking.poll()
  assert.equal(reads, 1, "no requests during the ordinary polling interval")
  f.advance(30 * 60000 - 15000); await f.service.tracking.poll()
  assert.equal(reads, 2)
  const [plan] = await f.store.list()
  assert.equal(plan.opensAt, f.good.opensAt)
  assert.equal(f.posts.length, 0)
  await f.service.run(plan)
  assert.equal(f.posts[0].at, f.good.opensAt - 5000)
})

test("HTTP 429 reads are not retried, and a frequency limit pauses all tracking rules on the account", async t => {
  let reads = 0
  const client = new CoinShopClient({ getJson: async () => { reads++; throw new Error("官方接口 HTTP 429") } })
  await assert.rejects(client.points({}), /HTTP 429/)
  assert.equal(reads, 1)
  const f = await fixture(t)
  const create = () => f.service.tracking.create({ qq: "123", mode: "category", game: "hkrpg", itemType: 2 })
  const a = await create(), b = await create()
  f.client.listAll = async () => { throw new Error("操作频繁，请稍后再试") }
  await f.service.tracking.poll()
  assert.equal((await f.service.tracking.list("123")).filter(rule => rule.enabled).length, 0)
  assert.deepEqual((await f.store.listTrackers()).map(rule => rule.id), [a.id, b.id])
  assert.equal(f.posts.length, 0)
})

test("default polling is thirty minutes and old second-based preview rules migrate to that interval", async t => {
  const f = await fixture(t)
  const rule = await f.service.tracking.create({ qq: "123", mode: "category", game: "hkrpg", itemType: 2 })
  assert.equal(rule.pollMs, 1800000)
  await assert.rejects(f.service.tracking.create({ qq: "123", mode: "category", game: "hkrpg", itemType: 2, pollMinutes: 0 }), /超出/)
  await f.store.changeTrackers(rules => { rules[0].pollMs = 300000; delete rules[0].pollUnit })
  const restarted = new CoinShopService({ store: f.store, client: f.client, loadProfile: async () => f.profile })
  await restarted.initialize()
  assert.equal((await f.store.listTrackers())[0].pollMs, 1800000)
  const short = await restarted.tracking.create({ qq: "123", mode: "category", game: "hkrpg", itemType: 2, pollMinutes: 5 })
  restarted.initializing = null
  await restarted.initialize()
  assert.equal((await f.store.listTrackers()).find(rule => rule.id === short.id).pollMs, 300000, "explicit minute settings are preserved")
})

test("physical exchange matches official numeric address fields and encodes non-ASCII device names", async () => {
  let submitted
  const client = new CoinShopClient({ postJson: async (body, headers) => { submitted = { body, headers }; return { retcode: 0 } } })
  await client.exchange({ type: 1, goodsId: "1", addressId: "1234" }, { account: {}, device: { name: "荷花的手机" } })
  assert.equal(submitted.body.address_id, 1234)
  assert.equal(submitted.body.exchange_num, 1)
  assert.equal(submitted.headers["x-rpc-device_name"], encodeURIComponent("荷花的手机"))
  await assert.rejects(client.exchange({ type: 1, goodsId: "1", addressId: "invalid" }, {}), /地址 ID/)
})

test("a quota-exhausted item still wakes at the next official opening with long ordinary polling", async t => {
  const f = await fixture(t)
  f.good.game = "hkrpg"; f.good.exchanged = 1; f.good.opensAt = f.now() + 3600000
  f.client.listAll = async () => [{ ...f.good }]
  const rule = await f.service.tracking.create({ qq: "123", mode: "category", game: "hkrpg", itemType: 2, pollMinutes: 180 })
  await f.service.tracking.poll()
  assert.equal(f.service.tracking.snapshots.get(rule.id).nextPollAt, f.good.opensAt - 15000)
  f.advance(3600000 - 15000); await f.service.tracking.poll()
  assert.equal((await f.store.list()).length, 0)
  assert.equal(f.service.tracking.snapshots.get(rule.id).nextPollAt, f.good.opensAt + 1000)
  f.advance(16000); f.good.status = "available"; f.good.exchanged = 0
  await f.service.tracking.poll()
  assert.equal((await f.store.list()).length, 1)
})
