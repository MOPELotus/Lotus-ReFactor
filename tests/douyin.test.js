import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { extractDouyinTarget, targetFromUrl, resolveDouyinTarget } from "../services/douyin/links.js"
import { extractRouterData, detailFromRouter } from "../services/douyin/ssr.js"
import { normalizeDouyinWork, selectVideoSources } from "../services/douyin/model.js"
import { DouyinService } from "../services/douyin/service.js"
import { DouyinVisitor } from "../services/douyin/visitor.js"
import { generateABogus, sealPlatformBytes, SIGNING_ALPHABET, WEB_UA } from "../services/douyin/signature.js"
import { buildDetailUrl } from "../services/douyin/api.js"
import { articlePages, buildMediaMessageText } from "../services/media/message.js"
import { runMediaProcess } from "../services/media/files.js"

const id = "7372484719365098803"
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(20)])
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)])
const base = () => ({ aweme_id: id, desc: "作品标题", create_time: 1710000000, author: { nickname: "作者" }, statistics: { digg_count: 0 }, video: { duration: 1000, play_addr: { url_list: ["https://cdn.test/video"] } } })
const rootFor = async t => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-douyin-test-")); t.after(() => fs.rm(root, { recursive: true, force: true })); return root }
const noConversion = async file => ({ file, warnings: [] })
const visitor = { get: async () => "test-visitor" }
const response = detail => new Response(JSON.stringify({ status_code: 0, aweme_detail: detail }))

// A real platform signature captured 2026-09-09, public factual test data:
// Evil0ctal/Douyin_TikTok_Download_API/tests/fixtures/signing/abogus_browser.json.
const captured = "QyUVhFWEmq5nFd/tmcJuHtnlDFgMNTSySTi2WjKPyOu8LheY58Pe/PGbaxLLshEybbBzho372xMAYEdcpUUhp9HpLmkkuBGSCGVc960Lhqw4G0kQLHb0euvzowMxUcGqaAV4ilU6gUrogfxAkHdm/dl9yKoK5bWBPZOWk/ucE9sg1MyAgpnePpbdOhPxUJOf"
const capturedQuery = `device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${id}&pc_client_type=1&version_code=190500&version_name=19.5.0&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&browser_online=true&engine_name=Blink&engine_version=130.0.0.0&os_name=Windows&os_version=10&cpu_core_num=8&device_memory=8&platform=PC`
function decoded(signature) {
  const ordinary = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const bytes = Buffer.from([...signature].map(char => char === "=" ? char : ordinary[SIGNING_ALPHABET.indexOf(char)]).join(""), "base64")
  const decrypted = sealPlatformBytes(bytes.subarray(4), [211])
  const version = decrypted.subarray(0, 8)
  const frame = decrypted.subarray(8)
  const payload = []
  for (let i = 0; i < frame.length; i += 4) {
    const block = frame.subarray(i, i + 4)
    if (block.length < 4) payload.push(...block)
    else for (const [j, mask] of [0x91, 0x42, 0x2c].entries()) payload.push(block[j] & (255 ^ mask) | block[3] & mask)
  }
  return { version, payload: Buffer.from(payload), header: bytes.subarray(0, 4) }
}

test("independent signer matches browser-captured request bindings and checksum rules", () => {
  const oracle = decoded(captured)
  const timeIndices = [5, 18, 22, 45, 36, 0]
  const now = timeIndices.reduce((value, index, shift) => value + oracle.payload[index] * 2 ** (8 * shift), 0)
  const generated = decoded(generateABogus(capturedQuery, { now, random: () => 0.25 }))
  assert.deepEqual(generated.payload.subarray(0, 50), oracle.payload.subarray(0, 50))
  const geometryLength = generated.payload.readUInt16LE(46)
  assert.equal(generated.payload.subarray(50, 50 + geometryLength).toString(), "1920|947|1920|1032|1920|1032|1920|1080|Win32")
  assert.equal([...generated.version, ...generated.payload.subarray(0, 50)].reduce((sum, byte) => sum ^ byte, 0), generated.payload.at(-1))
  const changed = decoded(generateABogus(capturedQuery + "&changed=1", { now, random: () => 0.25 }))
  assert.notDeepEqual(changed.payload.subarray(0, 50), generated.payload.subarray(0, 50))
  assert.throws(() => generateABogus("", { now: 123 }), /毫秒/)
})

test("signer binds exactly the outgoing encoded query and UA, with one signature escaping pass", () => {
  let signed
  const url = buildDetailUrl(id, { now: 1789010742000, sign: (query, options) => { signed = { query, options }; return "a+b/=" } })
  assert.equal(url.split("?")[1].split("&a_bogus=")[0], signed.query)
  assert.equal(new URL(url).searchParams.get("a_bogus"), "a+b/=")
  assert.equal(signed.options.userAgent, WEB_UA)
})

test("share text/cards identify exact hosts and preserve large IDs", () => {
  const message = buildMediaMessageText({ message: [{ type: "json", data: { url: `https://www.douyin.com/video/${id}` } }] })
  assert.equal(targetFromUrl(extractDouyinTarget(message)).id, id)
  assert.equal(extractDouyinTarget("https://www.douyin.com.evil.test/video/123"), "")
  assert.equal(extractDouyinTarget("复制 https://v.douyin.com/abc/，打开抖音"), "https://v.douyin.com/abc/")
  assert.equal(targetFromUrl(`https://www.douyin.com/?modal_id=${id}`).id, id)
  assert.equal(targetFromUrl(`https://www.douyin.com/article/${id}`).type, "article")
})

test("short-link redirects reject unrelated domains and loops", async () => {
  const target = await resolveDouyinTarget("https://v.douyin.com/test/", { fetch: async () => new Response("", { status: 302, headers: { location: `https://www.douyin.com/note/${id}` } }) })
  assert.equal(target.id, id)
  await assert.rejects(resolveDouyinTarget("https://v.douyin.com/test/", { fetch: async () => new Response("", { status: 302, headers: { location: "https://evil.test/video/1" } }) }), /域名/)
  await assert.rejects(resolveDouyinTarget("https://v.douyin.com/test/", { fetch: async () => new Response("", { status: 302, headers: { location: "/test/" } }) }), /未跳转/)
})

test("SSR scanner handles quoted braces, escaped quotes and variable loader keys without eval", () => {
  const router = { loaderData: { arbitrary: { videoInfoRes: { item_list: [{ ...base(), desc: '标题 { } " \\' }] } } } }
  const extracted = extractRouterData(`<script>window._ROUTER_DATA = ${JSON.stringify(router)};throw new Error("must not execute")</script>`)
  assert.equal(detailFromRouter(extracted, id).aweme_id, id)
  assert.throws(() => extractRouterData("window._ROUTER_DATA = {broken};"), /未找到/)
  assert.throws(() => detailFromRouter(extracted, "123"), /没有可用/)
})

test("video, mixed gallery, Live Photo and article normalize without video bitrate assumptions", () => {
  const video = normalizeDouyinWork(base())
  assert.equal(video.duration, 1)
  assert.equal(video.stat.like, 0)
  assert.equal(video.stat.reply, undefined)
  const gallery = normalizeDouyinWork({ ...base(), video: null, is_slides: true, images: [{ clip_type: 2, url_list: ["https://cdn.test/image"] }, { clip_type: 4, video: { play_addr_h264: { url_list: ["https://cdn.test/clip"] } } }] })
  assert.equal(gallery.type, "gallery")
  assert.equal(gallery.isCollection, true)
  assert.deepEqual(gallery.media.map(item => item.type), ["image", "video"])
  const live = normalizeDouyinWork({ ...base(), images: [{ clip_type: 5, url_list: ["https://cdn.test/image"] }] })
  assert.equal(live.type, "live_photo")
  assert.ok(live.warnings.some(value => value.includes("动态资源缺失")))
  const article = normalizeDouyinWork({ ...base(), video: null, aweme_type: 163, article_info: { article_title: "正文", article_content: JSON.stringify({ markdown: "前文\n![图](https://cdn.test/small)\n后文" }), fe_data: JSON.stringify({ image_list: [{ markdown_url: "https://cdn.test/small", high_image_url: "https://cdn.test/full" }] }) } })
  assert.equal(article.type, "article")
  assert.deepEqual(article.article.blocks.map(item => item.type), ["text", "image", "text"])
  assert.equal(article.media[0].urls[0], "https://cdn.test/full")
  assert.equal(article.sources.length, 0)
})

test("source selection preserves originals, platform quality, mirrored URLs and H264 preference", () => {
  const detail = base()
  detail.video.bit_rate = [
    { format: "mp4", is_bytevc1: 1, video_extra: '{"definition":"fhd"}', play_addr: { width: 1920, height: 800, data_size: 100, url_list: ["https://cdn.test/hevc"] } },
    { format: "mp4", is_bytevc1: 0, video_extra: '{"definition":"fhd"}', play_addr: { data_size: 200, url_list: ["https://cdn.test/h264", "https://mirror.test/h264"] } },
  ]
  const model = normalizeDouyinWork(detail)
  const selected = selectVideoSources(model.sources)
  assert.equal(selected[0].codec, "h264")
  assert.equal(selected[0].quality, "1080p")
  assert.equal(selected[0].urls.length, 2)
  assert.equal(detail.video.bit_rate.length, 2)
  assert.equal(model.sources.length, 3)
})

test("visitor refresh is concurrent-safe and registration does not expose cookies", async () => {
  let requests = 0
  const identity = new DouyinVisitor({ fetch: async () => { requests++; await new Promise(resolve => setTimeout(resolve, 5)); return new Response("{}", { headers: { "set-cookie": `ttwid=identity-${requests}; Max-Age=3600; HttpOnly` } }) } })
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => identity.get())), Array(5).fill("identity-1"))
  assert.equal(requests, 1)
  assert.equal(await identity.get({ refresh: true, previous: "identity-1" }), "identity-2")
  assert.equal(await identity.get({ refresh: true, previous: "identity-1" }), "identity-2")
  assert.equal(requests, 2)
})

test("two independent requests each call Web API; main failure uses SSR and same model", async () => {
  let calls = 0
  const service = new DouyinService({ visitor, fetch: async () => { calls++; return response(base()) } })
  await Promise.all([service.getInfo({ id }), service.getInfo({ id })])
  assert.equal(calls, 2)
  const router = JSON.stringify({ loaderData: { any: { videoInfoRes: { item_list: [base()] } } } })
  let web = 0
  const fallback = new DouyinService({ visitor, fetch: async url => {
    if (url.includes("iesdouyin")) return new Response(`window._ROUTER_DATA=${router};`)
    web++; return new Response("<html>blocked</html>")
  } })
  const info = await fallback.getInfo({ id })
  assert.equal(web, 2)
  assert.equal(info.source, "ssr")
  assert.equal(info.title, "作品标题")
  assert.ok(info.warnings.length)
})

test("explicit unavailable work does not retry or fall back", async () => {
  let calls = 0
  const service = new DouyinService({ visitor, fetch: async () => { calls++; return new Response(JSON.stringify({ status_code: 1, status_msg: "作品已删除" })) } })
  await assert.rejects(service.getInfo({ id }), /已删除/)
  assert.equal(calls, 1)
})

test("CDN error page triggers mirror retry; repeated work downloads remain independent", async t => {
  const root = await rootFor(t)
  let transfers = 0
  const service = new DouyinService({ tasksDir: root, visitor, prepareVideo: noConversion, fetch: async url => {
    if (url.includes("detail")) { const detail = base(); detail.video.play_addr.url_list = ["https://cdn.test/bad", "https://cdn.test/good"]; return response(detail) }
    transfers++; return new Response(url.endsWith("bad") ? "<html>invalid</html>" : mp4)
  } })
  const results = await Promise.all([service.download({ id }, { multi_page_policy: "all" }), service.download({ id }, { multi_page_policy: "all" })])
  assert.equal(transfers, 4)
  assert.notEqual(results[0].files[0], results[1].files[0])
  await service.releaseTask(results[0])
  assert.deepEqual(await fs.readFile(results[1].files[0]), mp4)
  await service.releaseTask(results[1])
})

test("expired media addresses refresh once within the task and discard failed parts", async t => {
  const root = await rootFor(t)
  let resolutions = 0
  const service = new DouyinService({ tasksDir: root, visitor, prepareVideo: noConversion, fetch: async url => {
    if (url.includes("detail")) { resolutions++; const detail = base(); detail.video.play_addr.url_list = [resolutions === 1 ? "https://cdn.test/expired" : "https://cdn.test/new"]; return response(detail) }
    return url.endsWith("expired") ? new Response("", { status: 403 }) : new Response(mp4)
  } })
  const result = await service.download({ id }, { multi_page_policy: "all" })
  assert.equal(resolutions, 2)
  assert.equal(result.partial, false)
  assert.deepEqual(await fs.readFile(result.files[0]), mp4)
  await service.releaseTask(result)
})

test("Live Photo first-item policy retains both static and motion; a failed motion is explicitly partial", async t => {
  const root = await rootFor(t)
  const detail = { ...base(), images: [{ clip_type: 5, url_list: ["https://cdn.test/image"], video: { play_addr_h264: { url_list: ["https://cdn.test/clip"] } } }, { url_list: ["https://cdn.test/second"] }] }
  let broken = false
  const service = new DouyinService({ tasksDir: root, visitor, prepareVideo: noConversion, fetch: async url => {
    if (url.includes("detail")) return response(detail)
    return new Response(url.endsWith("clip") ? broken ? "bad" : mp4 : png)
  } })
  const good = await service.download({ id }, { multi_page_policy: "first" })
  assert.equal(good.files.length, 2)
  assert.deepEqual(good.artifacts.map(item => item.kind), ["image", "video"])
  broken = true
  const partial = await service.download({ id }, { multi_page_policy: "first" })
  assert.equal(partial.files.length, 1)
  assert.equal(partial.partial, true)
  assert.equal(partial.failedItems[0].kind, "video")
  await fs.access(good.files[1])
  await service.releaseTask(partial)
  await service.releaseTask(good)
})

test("article pagination preserves all Unicode text and images in order", () => {
  const text = "正文😀".repeat(900)
  const pages = articlePages({ blocks: [{ type: "text", text }, { type: "image", urls: ["https://cdn.test/image"] }, { type: "text", text: "末尾" }] })
  assert.equal(pages.flat().filter(item => item.type === "text").map(item => item.text).join(""), text + "末尾")
  assert.equal(pages.at(-2)[0].type, "image")
  assert.ok(pages.filter(page => page[0].type === "text").every(page => Array.from(page.map(item => item.text).join("")).length <= 600))
})

test("article downloads contain TXT and ordered images in a valid ZIP", async t => {
  const root = await rootFor(t)
  const detail = { ...base(), video: null, aweme_type: 163, article_info: { article_title: "文章", article_content: '{"markdown":"正文\\n![图](https://cdn.test/image)"}' } }
  const service = new DouyinService({ tasksDir: root, visitor, fetch: async url => url.includes("detail") ? response(detail) : new Response(png) })
  const result = await service.download({ id })
  assert.equal(result.files.length, 1)
  assert.equal(path.extname(result.files[0]), ".zip")
  const listing = await runMediaProcess("unzip", ["-Z1", result.files[0]])
  assert.match(listing.output, /000-正文.txt/)
  assert.match(listing.output, /001-image.png/)
  await service.releaseTask(result)
})

test("failed downloads and duration limits leave no task directories", async t => {
  const root = await rootFor(t)
  const service = new DouyinService({ tasksDir: root, visitor, fetch: async url => url.includes("detail") ? response(base()) : new Response("invalid") })
  await assert.rejects(service.download({ id }))
  assert.deepEqual(await fs.readdir(root), [])
  const info = normalizeDouyinWork(base())
  info.duration = 99999
  const limited = await service.download(info)
  assert.equal(limited.reason, "duration_limit")
  assert.deepEqual(await fs.readdir(root), [])
})

test("risk-control responses are classified without logging response cookies", async () => {
  const service = new DouyinService({ visitor, fetch: async url => url.includes("iesdouyin") ? new Response("missing") : new Response("Blocked by ArgusSecurityPlugin Uifid Not Found", { status: 403 }) })
  await assert.rejects(service.getInfo({ id }), error => error.code === "parse_failed" && error.cause.errors[0].code === "risk_control")
})

test("article malformed content keeps readable text and warns rather than requiring video fields", () => {
  const info = normalizeDouyinWork({ ...base(), video: null, aweme_type: 163, article_info: { article_title: "标题", article_content: "可读正文" } })
  assert.equal(info.article.blocks[0].text, "可读正文")
  assert.ok(info.warnings.length)
})

test("an exhausted task budget stops before additional platform requests", async () => {
  let calls = 0
  const service = new DouyinService({ visitor, fetch: async () => { calls++; return response(base()) } })
  await assert.rejects(service.getInfo({ id }, { deadline: Date.now() - 1 }), /超时/)
  assert.equal(calls, 0)
})
