// Explicit hardware rendering verification, separate from portable unit tests.
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { Canvas } from "skia-canvas"
import { renderTemplate } from "../core/render/service.js"
import { normalizeDouyinWork } from "../services/douyin/model.js"
import { articlePages } from "../services/media/message.js"
import { runMediaProcess } from "../services/media/files.js"
import { prepareVideo } from "../services/media/video.js"

const dir = path.resolve("temp/media-verification")
await fs.mkdir(dir, { recursive: true })
const video = path.join(dir, "sample.mp4")
await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", video])
assert.equal((await prepareVideo(video)).file, video)
const incompatible = path.join(dir, "sample.mkv")
await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", video, "-c", "copy", incompatible])
assert.equal(path.extname((await prepareVideo(incompatible)).file), ".mp4")
const canvas = new Canvas(640, 360)
assert.match(canvas.engine.device, /NVIDIA/)
const ctx = canvas.getContext("2d")
ctx.fillStyle = "#eaf6fc"; ctx.fillRect(0, 0, 640, 360)
ctx.fillStyle = "#1484b5"; ctx.font = "bold 36px sans-serif"; ctx.fillText("Lotus · 媒体验证", 100, 160)
ctx.font = "24px sans-serif"; ctx.fillText("独立任务 / 图集 / 动态图片", 100, 220)
const cover = path.join(dir, "cover.png")
await fs.writeFile(cover, await canvas.toBuffer("png"))
const background = new Canvas(640, 360)
const backgroundContext = background.getContext("2d")
backgroundContext.fillStyle = "#c5e1ec"; backgroundContext.fillRect(0, 0, 640, 360)
const backgroundPath = path.join(dir, "background.png")
await fs.writeFile(backgroundPath, await background.toBuffer("png"))
const bg = `file://${backgroundPath}`
const engineReports = []
const options = file => ({ path: path.join(dir, file), imgType: "png", renderScale: 1, onRender: engine => {
  assert.equal(engine.gpu, true)
  assert.match(engine.device, /NVIDIA/)
  assert.doesNotMatch(`${engine.device} ${engine.driver}`, /llvmpipe|lavapipe|SwiftShader/i)
  engineReports.push({ file, ...engine })
} })
const info = normalizeDouyinWork({ aweme_id: "7372484719365098803", desc: "普通视频解析 · 同一作品在多个群独立下载与发送", create_time: 1710000000, author: { nickname: "验证作者" }, statistics: { digg_count: 12345, comment_count: 567, collect_count: 89, share_count: 123 }, music: { title: "测试音乐", author: "音乐作者" }, video: { duration: 12345, cover: { url_list: [bg] }, bit_rate: [{ format: "mp4", is_bytevc1: 0, video_extra: '{"definition":"fhd"}', play_addr: { width: 1920, height: 1080, url_list: ["https://cdn.example/video.mp4"] } }] } })
info.cover = `file://${cover}`
await renderTemplate("douyin-info", { ...info, bg }, options("douyin-video.png"))
await renderTemplate("douyin-info", { ...info, type: "live_photo", warnings: ["第 2 项动态资源缺失，保留静态图"], media: [{}, {}], bg }, options("douyin-live-photo.png"))
const pages = articlePages({ blocks: [{ type: "text", text: "这是文章正文。段落与图片按原有顺序展示，长文章分页发送，每次解析与下载都独立进行。\n".repeat(8) }, { type: "image", urls: [bg] }, { type: "text", text: "最后一段正文。" }] })
for (const [index, blocks] of pages.entries()) await renderTemplate("douyin-article", { title: "抖音文章验证", owner: "验证作者", page: index + 1, blocks, bg }, options(`douyin-article-${index + 1}.png`))
await renderTemplate("bilibili-info", { type: "video", id: "BV17x411w7KC", title: "B 站信息卡回归", owner: "验证作者", cover: bg, duration: 12, stat: { like: 123, favorite: 456 }, bg }, options("bilibili-video.png"))
await fs.writeFile(path.join(dir, "renderer.json"), JSON.stringify(engineReports, null, 2))
globalThis.plugin = class { constructor(options) { Object.assign(this, options) } }
const { LotusDouyin } = await import("../apps/douyin.js")
const { DouyinService } = await import("../services/douyin/service.js")
const { createDefaultGlobalConfig } = await import("../core/config/defaults.js")
const service = new DouyinService({ tasksDir: path.join(dir, "tasks"), fetch: async () => new Response(await fs.readFile(video)) })
service.getInfo = async () => ({ ...info, bg })
const app = new LotusDouyin()
let sent = false
app.e = { user_id: 1, group_id: 1, isGroup: true, reply: async payload => {
  if (Buffer.isBuffer(payload)) await fs.writeFile(path.join(dir, "douyin-app.jpg"), payload)
  return true
}, group: { sendFile: async file => { assert.ok((await fs.stat(file)).size); sent = true; return true } } }
await app.handleWork(service, info.url, createDefaultGlobalConfig(), true)
assert.equal(sent, true)
assert.deepEqual(await fs.readdir(service.tasksDir), [])
console.log(JSON.stringify({ appPipeline: "render -> download -> probe -> send adapter -> cleanup passed", screenshots: engineReports.length, engine: engineReports[0], videoProbe: "H264 + AAC passed", remux: "MKV to MP4 passed" }))
