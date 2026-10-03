import test from "node:test"
import assert from "node:assert/strict"
import { generateNonceSignature, signVisitorUrl } from "../services/douyin/guest-signature.js"
import { DouyinVisitor } from "../services/douyin/visitor.js"
import { fetchWebDetail } from "../services/douyin/api.js"
import { requestText } from "../services/douyin/http.js"

const now = 1700000000000
// Captured from the platform's nonce page with controlled time and synthetic nonce.
// No live visitor identities, account cookies or downloaded SDK source are fixtures.
const nonceVectors = [
  ["0123456789abcdef01234", now, "_02B4Z6wo00f01HR4CBQAAIDDlhtjLHBI6Bx0SCyAAHhV47"],
  ["ffffffffffffffffffff0", now, "_02B4Z6wo00f01HR4CBQAAIDDlhtjLHBKimx0SCyAAHhV01"],
  ["0123456789abcdef01234", now + 1000, "_02B4Z6wo00f01eyfGFwAAIDCDvxzZzeJmjXsrzzAAB5280"],
  ["ffffffffffffffffffff0", now + 1000, "_02B4Z6wo00f01eyfGFwAAIDCDvxzZzeIcWHsrzzAAB5286"],
  ["0123456789abcdef01234", 1791034000000, "_02B4Z6wo00f01X-LgJwAAIDCnejrpsq9rdl.u6QAADUn76"],
]

test("native nonce signer matches platform oracle across nonce and time changes", () => {
  for (const [nonce, now, signature] of nonceVectors) assert.equal(generateNonceSignature(nonce, { now }), signature)
  assert.throws(() => generateNonceSignature("invalid", { now }), /参数无效/)
  assert.notEqual(generateNonceSignature(nonceVectors[0][0], { now, url: "https://www.douyin.com/video/1" }), nonceVectors[0][2])
})

test("visitor signing covers canonical bytes and replaces obsolete duplicate signature fields", () => {
  const input = new URL("https://www.douyin.com/aweme/v1/web/aweme/detail/?text=%E4%B8%AD%E6%96%87+!&a_bogus=a%2Bb%2F%3D&uifid=old&uifid=duplicate&timestamp=1&x-secsdk-web-signature=old")
  const before = input.href
  const signed = signVisitorUrl(input, "synthetic-visitor", { now })
  const parsed = new URL(signed.url)
  assert.equal(input.href, before)
  assert.deepEqual(parsed.searchParams.getAll("uifid"), ["synthetic-visitor"])
  assert.deepEqual(parsed.searchParams.getAll("timestamp"), ["1700000000"])
  assert.equal(parsed.searchParams.get("a_bogus"), "a+b/=")
  assert.match(signed.url, /text=%E4%B8%AD%E6%96%87\+%21/)
  assert.equal(parsed.searchParams.get("x-secsdk-web-signature"), signed.headers["x-secsdk-web-signature"])
  assert.equal(signed.headers["x-secsdk-web-expire"], "1700000000")
  const changed = new URL(input); changed.searchParams.set("text", "changed")
  assert.notEqual(signVisitorUrl(changed, "synthetic-visitor", { now }).headers["x-secsdk-web-signature"], signed.headers["x-secsdk-web-signature"])
  assert.throws(() => signVisitorUrl(input, "secret; injected=value", { now }), /参数无效/)
})

test("anonymous session bootstrap coalesces concurrent visitors and accepts rotated ttwid", async () => {
  let registrations = 0
  let challenges = 0
  const identity = new DouyinVisitor({ now: () => now, fetch: async (url, options) => {
    if (url.includes("ttwid.bytedance")) { registrations++; return new Response("{}", { headers: { "set-cookie": `ttwid=union-${registrations}; Max-Age=3600` } }) }
    challenges++
    await new Promise(resolve => setTimeout(resolve, 5))
    if (!options.headers.Cookie.includes("__ac_signature=")) return new Response("", { headers: { "set-cookie": "__ac_nonce=0123456789abcdef01234; Max-Age=1800" } })
    assert.match(options.headers.Cookie, /__ac_signature=_02B4Z6wo00f01HR4CBQAAIDDlhtjLHBI6Bx0SCyAAHhV47/)
    const headers = new Headers(); headers.append("set-cookie", `ttwid=web-${registrations}; Max-Age=3600`); headers.append("set-cookie", `UIFID_TEMP=visitor-${registrations}; Max-Age=3600`)
    return new Response("", { headers })
  } })
  const sessions = await Promise.all(Array.from({ length: 6 }, () => identity.getSession()))
  assert.equal(registrations, 1); assert.equal(challenges, 2)
  assert.deepEqual(sessions[0], { ttwid: "web-1", uifid: "visitor-1" })
  assert.ok(sessions.every(session => session === sessions[0]))
  const refreshed = await identity.getSession({ refresh: true, previous: sessions[0] })
  assert.deepEqual(refreshed, { ttwid: "web-2", uifid: "visitor-2" })
  assert.equal(await identity.getSession({ refresh: true, previous: sessions[0] }), refreshed)
  assert.equal(registrations, 2); assert.equal(challenges, 4)
})

test("anonymous session requires platform-issued UIFID and excludes account cookies", async () => {
  const identity = new DouyinVisitor({ fetch: async (url, options) => {
    if (url.includes("ttwid.bytedance")) return new Response("{}", { headers: { "set-cookie": "ttwid=union; Max-Age=3600" } })
    assert.doesNotMatch(options.headers.Cookie, /sessionid|sid_guard/)
    return new Response("", { headers: { "set-cookie": "sessionid=ignored; HttpOnly" } })
  } })
  await assert.rejects(identity.getSession(), error => error.code === "visitor" && /nonce/.test(error.message))
})

test("visitor bootstrap discards an unread oversized HTML body once headers are obtained", async () => {
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const { response, text } = await requestText(async () => new Response(body, { headers: { "content-length": "999999999", "set-cookie": "UIFID_TEMP=synthetic" } }), "https://www.douyin.com/", {}, { headersOnly: true, maxBytes: 10 })
  assert.equal(cancelled, true); assert.equal(text, ""); assert.equal(response.headers.get("set-cookie"), "UIFID_TEMP=synthetic")
})

test("main API carries both signatures and the same anonymous identity without account credentials", async () => {
  const id = "7689728105266663406"
  let outgoing
  const detail = await fetchWebDetail(id, { ttwid: "visitor-cookie", uifid: "synthetic-visitor" }, { now: 1791034000000, sign: () => "a+b/=", fetch: async (url, options) => {
    outgoing = { url: new URL(url), headers: options.headers }
    return new Response(JSON.stringify({ status_code: 0, aweme_detail: { aweme_id: id } }))
  } })
  assert.equal(detail.aweme_id, id)
  assert.equal(outgoing.url.searchParams.get("a_bogus"), "a+b/=")
  assert.equal(outgoing.url.searchParams.get("uifid"), outgoing.headers.uifid)
  assert.equal(outgoing.url.searchParams.get("x-secsdk-web-signature"), outgoing.headers["x-secsdk-web-signature"])
  assert.equal(outgoing.headers.Cookie, "ttwid=visitor-cookie;")
})
