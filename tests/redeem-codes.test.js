import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseRedeemCommand, REDEEM_GAMES } from "../services/redeemCodes/games.js"
import { activityIds, MiyoliveProvider, parseExpiry, versionOf } from "../services/redeemCodes/official.js"
import { RedeemCodeService, formatRedeemResult } from "../services/redeemCodes/service.js"
import { LOTUS_CONFIG_DISABLED_PLUGIN_NAMES } from "../core/intercept/priority.js"

const now = () => Date.parse("2026-10-31T12:00:00+08:00")
const game = REDEEM_GAMES.find(g => g.id === "sr")
const post = (version = "4.7", expiry = "2026年10月31日23:59:59") => ({
  uid: game.uid, post_id: "123", subject: `${version}版本前瞻特别节目`, created_at: now() / 1000,
  structured_content: JSON.stringify([{ insert: `本次特别节目中的兑换码将于${expiry}失效，请及时兑换。` }]),
})
const activity = (version = "4.7", actId = "act-current") => ({ actId,
  live: { title: `${version}版本前瞻`, start: "2026-10-30 19:30:00", remain: 0, code_ver: "codes-current" },
  template: "{}", streamer: { aid: game.uid },
})
function fixture(overrides = {}) {
  let current = { activity: activity(), newestVersion: "4.7", posts: [post()], activities: ["act-current"] }
  let entries = [{ code: "中文兑换码", title: "<p>星琼×100</p>", to_get_time: now() / 1000 - 60 }]
  let codeCalls = 0, discoveryCalls = 0
  const provider = {
    discover: async () => { discoveryCalls++; return current },
    codes: async () => { codeCalls++; return entries },
  }
  const service = new RedeemCodeService({ now, historyFile: false, providers: { miyolive: provider }, ...overrides })
  return { service, provider, setCurrent: value => { current = value }, setEntries: value => { entries = value }, calls: () => ({ codeCalls, discoveryCalls }) }
}

test("existing aliases and prefixes select the proper game; unrelated and redeem-use commands do not match", () => {
  for (const [msg, id] of [["#兑换码", "gs"], ["兑换码", "gs"], ["*前瞻兑换码", "sr"], ["#崩铁直播兑换码", "sr"], ["#星穹铁道兑换码", "sr"], ["%兑换码", "zzz"], ["/ZZZcode", "zzz"], ["#崩三兑换码", "bh3"], ["崩坏3兑换码", "bh3"]]) assert.equal(parseRedeemCommand(msg)?.id, id, msg)
  for (const msg of ["#兑换码使用ABC", "#星铁体力", "#某游戏兑换码", "#foo code", "#前瞻兑换码备注"]) assert.equal(parseRedeemCommand(msg), null)
  assert.ok(LOTUS_CONFIG_DISABLED_PLUGIN_NAMES.includes("兑换码"))
  assert.ok(LOTUS_CONFIG_DISABLED_PLUGIN_NAMES.includes("[ZZZ-Plugin]Code"))
})

test("expiry uses an explicit official date, Beijing time and the activity year; release timestamps and launch dates are not expiry", () => {
  const reference = Date.parse("2026-10-23T19:30:00+08:00")
  assert.deepEqual(parseExpiry("兑换码将于10月26日12:00过期，请及时兑换~", reference), { ms: Date.parse("2026-10-26T12:00:00+08:00"), text: "2026-10-26 12:00:00" })
  assert.equal(parseExpiry("7.2版本10月28日上线。兑换码存在有效期，请及时兑换", reference), null)
  assert.equal(parseExpiry("兑换码有效期至2026年2月30日23:59", reference), null)
  assert.equal(parseExpiry("兑换码有效期为10月30日19:30至10月31日23:59:59", reference).text, "2026-10-31 23:59:59")
  assert.equal(parseExpiry("兑换码有效期至1月1日12:00", Date.parse("2026-12-30T00:00:00+08:00")).text, "2027-01-01 12:00:00")
  assert.equal(parseExpiry(JSON.stringify([{ insert: "兑换码将于" }, { insert: "10月26日12:00", attributes: { bold: true } }, { insert: "过期" }]), reference).text, "2026-10-26 12:00:00")
})

test("activity extraction handles nested JSON escapes without swallowing the following parameter or unrelated activity", () => {
  assert.deepEqual(activityIds({ structured_content: '[{"link":"https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=ea123\\u0026mhy_presentation_style=fullscreen"}]' }), ["ea123"])
  assert.deepEqual(activityIds({ app_path: "https://webstatic.mihoyo.com/bbs/event/signin/bh3/?act_id=signin" }), [])
  assert.equal(versionOf("【资讯】V9.2更新内容前瞻丨碎盾机制上线"), "9.2")
  assert.equal(versionOf("米游社崩坏3-9.1特别节目"), "9.1")
})

test("Chinese codes survive unchanged; duplicate, future and empty codes are omitted", async () => {
  const f = fixture()
  f.setEntries([{ code: "永远不会抛弃你", title: "<p>星琼×100</p>" }, { code: "永远不会抛弃你" }, { code: "FUTURE", to_get_time: now() / 1000 + 60 }, { code: "" }])
  const result = await f.service.query("sr")
  assert.equal(result.status, "available")
  assert.deepEqual(result.codes, [{ code: "永远不会抛弃你", reward: "星琼×100" }])
  assert.equal(result.expiry.text, "2026-10-31 23:59:59")
  assert.match(formatRedeemResult(result), /永远不会抛弃你/)
})

test("new preview immediately suppresses the previous page, then new activity/code_ver replaces it on the next query", async () => {
  const f = fixture()
  assert.equal((await f.service.query("sr")).status, "available")
  f.setCurrent({ activity: activity(), newestVersion: "4.8", posts: [post("4.8")], activities: ["act-current"] })
  const pending = await f.service.query("sr")
  assert.equal(pending.status, "unreleased")
  assert.equal(pending.version, "4.8")
  assert.deepEqual(pending.codes, [])
  assert.equal(f.calls().codeCalls, 1)
  const next = activity("4.8", "act-next"); next.live.code_ver = "codes-next"
  f.setCurrent({ activity: next, newestVersion: "4.8", posts: [], activities: ["act-next"] })
  f.setEntries([{ code: "新版本码" }])
  const result = await f.service.query("sr")
  assert.equal(result.actId, "act-next")
  assert.equal(result.codeVersion, "codes-next")
  assert.equal(result.codes[0].code, "新版本码")
  assert.equal(result.expiry, null)
  assert.match(formatRedeemResult(result), /官方未明确公布失效时间/)
})

test("expired or not-yet-started activities do not request codes; a removed expired page uses the official matching post", async () => {
  const f = fixture()
  f.setCurrent({ activity: activity(), newestVersion: "4.7", posts: [post("4.7", "2026年10月30日23:59:59")], activities: [] })
  assert.equal((await f.service.query("sr")).status, "expired")
  assert.equal(f.calls().codeCalls, 0)
  const upcoming = activity(); upcoming.live.start = "2026-11-01 19:30:00"
  f.setCurrent({ activity: upcoming, newestVersion: "4.7", posts: [], activities: [] })
  assert.equal((await f.service.query("sr")).status, "unreleased")
  f.setCurrent({ activity: null, newestVersion: "4.7", posts: [post("4.7", "2026年10月30日23:59:59")], activities: [] })
  const removed = await f.service.query("sr")
  assert.equal(removed.status, "expired")
  assert.equal(removed.expiry.text, "2026-10-30 23:59:59")
})

test("failures never return cached codes; simultaneous queries share work but subsequent queries discover again", async () => {
  const f = fixture()
  const [a, b] = await Promise.all([f.service.query("sr"), f.service.query("sr")])
  assert.equal(a, b)
  assert.equal(f.calls().discoveryCalls, 1)
  f.provider.discover = async () => { throw new Error("network down") }
  const error = await f.service.query("sr")
  assert.equal(error.status, "error")
  assert.deepEqual(error.codes, [])
})

test("activity history survives restart, without persisting codes or credentials", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-redeem-test-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, "activities.json")
  const f = fixture({ historyFile: file })
  await Promise.all([f.service.query("sr"), f.service.query("gs")])
  const saved = JSON.parse(await fs.readFile(file, "utf8"))
  assert.deepEqual(saved.sr, ["act-current"])
  const fresh = fixture({ historyFile: file })
  fresh.provider.discover = async (g, ids) => { assert.deepEqual(ids, ["act-current"]); return { activity: null, newestVersion: "", posts: [] } }
  await fresh.service.query("sr")
  assert.ok(!(await fs.readFile(file, "utf8")).includes("中文兑换码"))
})

test("official discovery accepts only the official author, checks current act_id, and refreshes with the current code_ver", async () => {
  const calls = []
  const provider = new MiyoliveProvider({ now, fetch: async (url, options) => {
    calls.push({ url, options })
    let data
    if (url.includes("/home/new")) data = { navigator: [{ name: "直播兑换码", app_path: "https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=act-new&x=1" }] }
    else if (url.includes("/userPost")) data = { list: [{ post: { post: post("4.8") } }], is_last: true }
    else if (url.includes("getPostFull")) data = { post: { post: post("4.8") } }
    else if (url.endsWith("/index")) data = { ...activity("4.8"), streamer: { aid: options.headers["x-rpc-act_id"] === "fake" ? "imposter" : game.uid } }
    else if (url.includes("refreshCode")) data = { code_list: [{ code: "CODE" }] }
    else throw new Error(url)
    return { ok: true, json: async () => ({ retcode: 0, data }) }
  } })
  const found = await provider.discover(game, ["fake"])
  assert.equal(found.activity.actId, "act-new")
  assert.equal(found.newestVersion, "4.8")
  assert.deepEqual(found.activities, ["act-new"])
  await provider.codes(found.activity)
  assert.ok(calls.at(-1).url.includes("version=codes-current"))
  assert.equal(calls.at(-1).options.headers["x-rpc-act_id"], "act-new")
  assert.equal(calls[0].options.headers["x-rpc-client_type"], "2")
})

test("an unavailable newly discovered page prevents fallback to a remembered previous page", async () => {
  const provider = new MiyoliveProvider({ now, fetch: async (url, options) => {
    let data
    if (url.includes("/home/new")) data = { navigator: [{ name: "前瞻", app_path: "https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=new" }] }
    else if (url.includes("/userPost")) data = { list: [], is_last: true }
    else if (options.headers["x-rpc-act_id"] === "new") throw new Error("unreachable")
    else data = activity()
    return { ok: true, json: async () => ({ retcode: 0, data }) }
  } })
  await assert.rejects(provider.discover(game, ["old"]), /详情暂不可用/)
})

test("message handler replies through Lotus and yields unrelated commands", async () => {
  globalThis.plugin = class { constructor(config) { Object.assign(this, config) } }
  const { LotusRedeemCodes } = await import("../apps/redeemCodes.js")
  const received = []
  const app = new LotusRedeemCodes({ service: { query: async id => { assert.equal(id, "sr"); return { gameName: "星铁", status: "unreleased", reason: "尚未发放" } } } })
  app.e = { msg: "*兑换码" }; app.reply = async text => { received.push(text) }
  assert.equal(await app.redeemCodes(), true)
  assert.match(received[0], /尚未发放/)
  app.e.msg = "#某游戏兑换码"
  assert.equal(await app.redeemCodes(), false)
})

test("a TLS connection reset retries the same official request directly, retaining the current activity header", async () => {
  let directCalls = 0
  const provider = new MiyoliveProvider({
    fetch: async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("TLS socket disconnected"), { code: "ECONNRESET" }) }) },
    directRequest: async (url, options) => {
      directCalls++
      assert.equal(url, "https://api-takumi.mihoyo.com/event/miyolive/index")
      assert.equal(options.headers["x-rpc-act_id"], "act-new")
      assert.equal(options.headers["x-rpc-client_type"], "2")
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 10000)
      return { retcode: 0, data: { live: { code_ver: "new-code-version" } } }
    },
  })
  assert.equal((await provider.request("https://api-takumi.mihoyo.com/event/miyolive/index", "act-new")).live.code_ver, "new-code-version")
  assert.equal(directCalls, 1)
})

test("failed proxy and direct requests report the failing endpoint and remain errors rather than stale successes", async () => {
  const provider = new MiyoliveProvider({
    fetch: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }) },
    directRequest: async () => { throw Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" }) },
  })
  await assert.rejects(provider.request("https://bbs-api.mihoyo.com/post/wapi/userPost"), /bbs-api\.mihoyo\.com\/post\/wapi\/userPost.*ECONNRESET.*ETIMEDOUT/)
})

test("official API application errors and HTTP client errors are not retried", async () => {
  let calls = 0
  const directRequest = async () => { calls++; throw new Error("unexpected direct request") }
  const api = new MiyoliveProvider({ fetch: async () => ({ ok: true, json: async () => ({ retcode: -500012, message: "活动已结束" }) }), directRequest })
  await assert.rejects(api.request("https://api-takumi.mihoyo.com/event/miyolive/index"), /活动已结束/)
  const http = new MiyoliveProvider({ fetch: async () => ({ ok: false, status: 403 }), directRequest })
  await assert.rejects(http.request("https://bbs-api.mihoyo.com/post/wapi/userPost"), /HTTP 403/)
  assert.equal(calls, 0)
})

test("direct transport rejects non-official or credential-bearing destinations before connecting", async () => {
  const { requestOfficialJson } = await import("../services/redeemCodes/http.js")
  for (const url of ["https://example.com/", "http://bbs-api.mihoyo.com/", "https://user:secret@bbs-api.mihoyo.com/", "https://bbs-api.mihoyo.com:8443/"]) {
    await assert.rejects(requestOfficialJson(url), /不支持的官方接口地址/)
  }
})

test("available codes preserve all content in order, splitting each part into a forward node and keeping codes individually copyable", async () => {
  globalThis.plugin = class { constructor(config) { Object.assign(this, config) } }
  const { LotusRedeemCodes } = await import("../apps/redeemCodes.js")
  const result = await fixture().service.query("sr")
  result.codes = [{ code: "永远不会抛弃你", reward: "星琼×100" }, { code: "ABC123", reward: "信用点×50000" }]
  const app = new LotusRedeemCodes({ service: { query: async () => result } })
  const replies = []
  app.reply = async message => { replies.push(message) }
  app.e = { msg: "*兑换码", self_id: "123", group: { makeForwardMsg: async nodes => ({ type: "forward", nodes }) } }
  assert.equal(await app.redeemCodes(), true)
  assert.equal(replies.length, 1)
  assert.equal(replies[0].type, "forward")
  const texts = replies[0].nodes.map(node => node.message)
  assert.deepEqual(texts, formatRedeemResult(result).split("\n").filter(Boolean))
  assert.deepEqual(texts.slice(1, 5), ["永远不会抛弃你", "星琼×100", "ABC123", "信用点×50000"])
  assert.match(texts[5], /2026-10-31 23:59:59/)
  // If the adapter cannot build a forward, code messages still remain separate.
  replies.length = 0
  app.e.group = {}
  await app.redeemCodes()
  assert.deepEqual(replies, texts)
})

test("planet launch command works offline as a separate command with an individually copyable code", async () => {
  globalThis.plugin = class { constructor(config) { Object.assign(this, config) } }
  const { LotusRedeemCodes } = await import("../apps/redeemCodes.js")
  const app = new LotusRedeemCodes({
    now: () => Date.parse("2026-11-02T00:00:00+08:00"),
    service: { query: () => { throw new Error("launch code must not query livestream APIs") } },
  })
  const rule = app.rule.find(item => new RegExp(item.reg).test("#星布谷地公测兑换码"))
  assert.equal(rule.fnc, "planetLaunchCodes")
  const replies = []
  app.reply = async message => replies.push(message)
  app.e = { msg: "#星布谷地公测兑换码", self_id: "123", group: { makeForwardMsg: async nodes => ({ type: "forward", nodes }) } }
  assert.equal(await app[rule.fnc](), true)
  const texts = replies[0].nodes.map(node => node.message)
  assert.equal(texts[1], "XBGD1204")
  assert.equal(texts[2], "奇物海哨×10")
  assert.ok(texts.some(text => /公测开服后可兑换/.test(text)))
  assert.ok(texts.some(text => /2027-01-03 10:00:00 前/.test(text)))
  assert.equal(parseRedeemCommand("#星布谷地公测兑换码"), null)
})

test("planet launch code is suppressed exactly at the official expiry", async () => {
  const { planetLaunchMessages } = await import("../services/redeemCodes/planetLaunch.js")
  const deadline = Date.parse("2027-01-03T10:00:00+08:00")
  assert.ok(planetLaunchMessages(deadline - 1).messages.includes("XBGD1204"))
  for (const now of [deadline, deadline + 1, Date.parse("2027-02-01T00:00:00+08:00")]) {
    const result = planetLaunchMessages(now)
    assert.equal(result.expired, true)
    assert.equal(result.messages.includes("XBGD1204"), false)
    assert.ok(result.messages.some(text => /已过期/.test(text)))
  }
})
