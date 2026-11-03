import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import QRCode from "qrcode"
import YAML from "yaml"
import { resolveData, rootPath } from "../../core/path.js"
import { formatLocalIso } from "../../core/time.js"
import { TuneWeaveService } from "../tuneweave/service.js"
import { downloadRanges } from "../media/range-download.js"
import { createMediaTask, releaseMediaTask, recoverMediaTasks } from "../media/tasks.js"
import { packMediaFiles, runMediaProcess, mediaLimitFailure, safeMediaName } from "../media/files.js"

const LIVE_INFO_API = "https://api.live.bilibili.com/room/v1/Room/get_info"

const COMMON_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  Referer: "https://www.bilibili.com/",
})


export class BilibiliService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.tuneweave = options.tuneweave || new TuneWeaveService({ config: options.tuneweaveConfig, fetch: this.fetch })
    this.tuneAccount = options.tuneAccount || ""
    this.sessdata = options.sessdata || ""
    this.cookie = normalizeBiliCookie(options.cookie || options.sessdata || "")
    this.now = options.now || (() => new Date())
        this.accountFile = options.accountFile || resolveData("bilibili", "account.yaml")
    this.tasksDir = options.tasksDir || resolveData("bilibili", "tasks")
    this.spawn = options.spawn || spawn
  }

  extractTarget(message = "") {
    const raw = String(message || "")
    const fromCard = extractFromJsonCard(raw)
    if (fromCard !== undefined) return fromCard

    const clean = raw.replace(/\\\//g, "/")
    const match = clean.match(/https?:\/\/(?:www\.)?(?:bilibili\.com\/video\/[^"'\s,\]}]+|b23\.tv\/[^"'\s,\]}]+|bili2233\.cn\/[^"'\s,\]}]+|live\.bilibili\.com\/\d+)|\bBV[1-9A-Za-z]{10}\b|\bav\d+\b/i)
    return match?.[0] || ""
  }

  async resolveTarget(input = "") {
    const text = String(input || "").trim()
    if (!text) throw new Error("empty bilibili target")
    if (/^BV[1-9A-Za-z]{10}$/i.test(text)) return { type: "video", bvid: text }
    if (/^av\d+$/i.test(text)) return { type: "video", aid: text.slice(2) }
    if (/^https?:\/\/(?:b23\.tv|bili2233\.cn)\//i.test(text)) {
      const response = await this.fetch(text, {
        method: "HEAD",
        redirect: "follow",
        headers: COMMON_HEADERS,
      })
      return this.resolveTarget(response.url || text)
    }
    const live = text.match(/live\.bilibili\.com\/(\d+)/i)
    if (live) return { type: "live", roomId: live[1] }
    const bvid = text.match(/BV[1-9A-Za-z]{10}/i)?.[0]
    if (bvid) return { type: "video", bvid }
    const aid = text.match(/av(\d+)/i)?.[1]
    if (aid) return { type: "video", aid }
    throw new Error("unsupported bilibili target")
  }

  async getInfo(input) {
    const target = typeof input === "string" ? await this.resolveTarget(input) : input
    if (target.type === "live") return this.getLiveInfo(target.roomId)
    return this.getVideoInfo(target)
  }

  async tuneRequest(route, params = {}) {
    const stored = this.tuneAccount ? null : await this.loadAccount()
    this.tuneAccount ||= stored?.tuneweave_account || ""
    const query = new URLSearchParams({ ...params, ...(this.tuneAccount ? { account: this.tuneAccount } : {}) })
    return this.tuneweave.request(route + (query.size ? "?" + query : ""))
  }

  async getVideoInfo(target) {
    const ref = target.bvid ? `bilibili:bvid:${target.bvid}` : `bilibili:aid:${target.aid}`
    const detail = await this.tuneRequest(`/v1/videos/${encodeURIComponent(ref)}`, { kind: "video" })
    const data = detail.video, ext = data.extensions || {}, pages = []
    if (!data?.ref) throw new Error("TuneWeave 视频详情不完整")
    for (let offset = 0; offset < 10000; offset += 100) {
      const part = await this.tuneRequest(`/v1/videos/${encodeURIComponent(ref)}/parts`, { kind: "video", limit: "100", offset: String(offset) })
      pages.push(...part)
      if (part.length < 100) break
      if (offset === 9900) throw new Error("视频分P数量超过限制")
    }
    return { type: "video", ref: data.ref, title: stripHtml(data.title), bvid: ext.bvid || target.bvid, aid: ext.aid || target.aid,
      url: `https://www.bilibili.com/video/${ext.bvid || target.bvid || "av" + target.aid}`,
      cover: normalizeBiliImage(data.cover_url || ""), owner: data.creators?.map(c => c.name).join(" / ") || "", duration: Number(data.duration_ms || 0) / 1000,
      stat: { view: data.play_count, like: ext.like_count, coin: ext.coin_count, favorite: ext.favorite_count, danmaku: ext.danmaku_count, reply: ext.comment_count, share: ext.share_count },
      cid: ext.first_cid, pages: pages.map((p, i) => ({ index: i + 1, cid: p.id.replace(/^cid:/, ""), partId: p.id, page: p.page, part: stripHtml(p.title), duration: Number(p.duration_ms || 0) / 1000 })), desc: stripHtml(data.description || "").slice(0, 180) }
  }

  async getLiveInfo(roomId) {
    const json = await this.requestJson(`${LIVE_INFO_API}?room_id=${encodeURIComponent(roomId)}`)
    if (json.code !== 0) throw new Error(json.message || `B站直播接口错误 ${json.code}`)
    const data = json.data || {}
    return {
      type: "live",
      title: stripHtml(data.title || `直播间 ${roomId}`),
      roomId: String(roomId),
      url: `https://live.bilibili.com/${roomId}`,
      playerUrl: livePlayerUrl(roomId),
      cover: normalizeBiliImage(data.user_cover || data.keyframe || ""),
      owner: data.uname || "",
      liveStatus: data.live_status === 1 ? "直播中" : "未开播",
      online: data.online || 0,
      desc: data.area_name ? `${data.parent_area_name || ""} · ${data.area_name}` : "",
    }
  }

  async search(keyword, { page = 1, limit = 10 } = {}) {
    const items = await this.tuneRequest("/v1/search", { platform: "bilibili", type: "video", q: keyword, limit: String(limit), offset: String((page - 1) * limit) })
    return items.filter(item => item.type === "video").map(({ data }) => ({ title: stripHtml(data.title), ref: data.ref, bvid: data.extensions?.bvid || data.id.replace(/^bvid:/, ""), author: data.creators?.map(c => c.name).join(" / ") || "", play: data.play_count, duration: Number(data.duration_ms || 0) / 1000, url: `https://www.bilibili.com/video/${data.extensions?.bvid || data.id.replace(/^bvid:/, "")}` }))
  }

  async buildDownloadPlan(input, config = {}) {
    const info = await this.getInfo(input)
    if (info.type !== "video") {
      return {
        ok: false,
        reason: "live_download_unsupported",
        info,
      }
    }

    const download = normalizeDownloadConfig(config)
    const limitFailure = mediaLimitFailure(info, download)
    if (limitFailure) return limitFailure

    const estimatedSizeMb = estimateVideoSizeMb(info)
    if (download.max_estimated_size_mb > 0 && estimatedSizeMb > download.max_estimated_size_mb) {
      return {
        ok: false,
        reason: "estimated_size_limit",
        info,
        estimatedSizeMb,
        limitMb: download.max_estimated_size_mb,
      }
    }

    const pages = selectPages(info.pages, download.multi_page_policy)
    return {
      ok: true,
      info,
      pages,
      policy: download.multi_page_policy,
      downloader: "tuneweave-js",
      estimatedSizeMb,
    }
  }

  async download(input, config = {}, hooks = {}) {
    const download = normalizeDownloadConfig(config)
    const plan = await this.buildDownloadPlan(input, download)
    if (!plan.ok) return plan
    const task = await createMediaTask(this.tasksDir)
    try {
      await emitBiliEvent(hooks, { type: "download-start", message: `开始下载 ${plan.info.bvid}，分P策略：${plan.policy}。` })
      let files = await this.downloadWithTuneWeave(plan, download, task.dir, hooks)
      if (download.multi_page_policy === "zip" && files.length > 1) {
        const target = path.join(task.dir, `${safeFileName(plan.info.title || plan.info.bvid)}-${plan.info.bvid}.zip`)
        await packMediaFiles(files, target, { timeoutMs: download.timeout_ms, spawnImpl: this.spawn, cwd: task.dir })
        files = [target]
      }
      const fileNames = Object.fromEntries(files.map((file, index) => {
        const ext = path.extname(file)
        if (ext === ".zip") return [file, path.basename(file)]
        const pageNumber = Number(path.basename(file).match(/-P(\d+)-/)?.[1]) || plan.pages[index]?.page || index + 1
        const page = plan.pages.find(item => Number(item.page) === pageNumber)
        const title = files.length > 1 ? page?.part || plan.info.title : plan.info.title || plan.info.bvid
        return [file, `${files.length > 1 ? `P${pageNumber} ` : ""}${safeFileName(title)}${ext}`]
      }))
      return { ...plan, ok: true, taskDir: task.dir, taskId: task.id, files, fileNames }
    } catch (error) {
      await releaseMediaTask(this.tasksDir, task.dir).catch(cleanupError => {
        globalThis.logger?.warn?.(`[Lotus-Plugin] Bilibili task cleanup: ${cleanupError.message}`)
      })
      throw error
    }
  }

  async downloadWithTuneWeave(plan, download, workDir, hooks = {}) {
    const ffmpeg = await resolveCommandPath("ffmpeg", download.tools_path)
    if (!ffmpeg) throw new Error("未找到 FFmpeg，请先初始化工具环境")
    const files = [], signal = hooks.signal
    for (const page of plan.pages) {
      const manifest = await this.tuneRequest(`/v1/videos/${encodeURIComponent(plan.info.ref)}/playback`, { kind: "video", part: page.partId || "cid:" + page.cid })
      const stem = `video-${plan.info.bvid}-P${page.page}-${page.cid}`, output = path.join(workDir, stem + ".mp4")
      const options = { fetch: this.fetch, headers: manifest.headers || {}, timeoutMs: download.timeout_ms, maxBytes: download.max_estimated_size_mb > 0 ? download.max_estimated_size_mb * 1024 * 1024 : 0, concurrency: download.concurrency, signal }
      await emitBiliEvent(hooks, { type: "download-part", message: `正在下载 P${page.page}，JS 并发 ${download.concurrency}。` })
      if (manifest.video_tracks?.length) {
        const videos = [...manifest.video_tracks].sort((a, b) => b.id - a.id || Number(a.codec_id !== 7) - Number(b.codec_id !== 7))
        const video = videos.find(t => t.id <= download.resolution) || videos.at(-1)
        const audio = [...(manifest.audio_tracks || [])].sort((a, b) => b.bandwidth - a.bandwidth)[0]
        const videoFile = path.join(workDir, stem + ".video"), audioFile = path.join(workDir, stem + ".audio")
        const operations = [downloadRanges([video.url, ...video.backup_urls || []], videoFile, options)]
        if (audio) operations.push(downloadRanges([audio.url, ...audio.backup_urls || []], audioFile, options))
        const downloads = await Promise.allSettled(operations)
        const failure = downloads.find(r => r.status === "rejected"); if (failure) throw failure.reason
        await runMediaProcess(ffmpeg, ["-nostdin", "-y", "-i", videoFile, ...(audio ? ["-i", audioFile] : []), "-map", "0:v:0", ...(audio ? ["-map", "1:a:0"] : []), "-c", "copy", "-movflags", "+faststart", output], { cwd: workDir, spawnImpl: this.spawn, timeoutMs: download.timeout_ms, signal })
        await fs.rm(videoFile, { force: true }); await fs.rm(audioFile, { force: true })
      } else if (manifest.progressive_segments?.length) {
        const segments = [...manifest.progressive_segments].sort((a, b) => a.order - b.order), paths = []
        for (const segment of segments) {
          const file = path.join(workDir, stem + "-segment-" + segment.order)
          await downloadRanges([segment.url, ...segment.backup_urls || []], file, options); paths.push(file)
        }
        const list = path.join(workDir, stem + ".concat")
        await fs.writeFile(list, paths.map(file => "file '" + path.basename(file) + "'").join("\n"))
        await runMediaProcess(ffmpeg, ["-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output], { cwd: workDir, spawnImpl: this.spawn, timeoutMs: download.timeout_ms, signal })
        await Promise.all([...paths, list].map(file => fs.rm(file, { force: true })))
      } else throw new Error("TuneWeave 未返回可下载视频流")
      if (!(await fs.stat(output)).size) throw new Error("合流结果为空")
      files.push(output)
    }
    return files
  }

  async recoverTasks() {
    return recoverMediaTasks(this.tasksDir)
  }

  async releaseTask(result) {
    return releaseMediaTask(this.tasksDir, result?.taskDir)
  }

  async createQrLogin() {
    this.pendingAlias = "lotus-bilibili"
    const qr = await this.tuneweave.request("/v1/auth/qr", { method: "POST", body: { platform: "bilibili", account: this.pendingAlias, credential_mode: "server" } })
    if (!qr.transaction_id || !qr.url) throw new Error("B站二维码创建失败")
    return { url: qr.url, qrcodeKey: qr.transaction_id, qrDataUrl: qr.image_data_url || await QRCode.toDataURL(qr.url) }
  }

  async waitQrLogin({ qrcodeKey, timeoutMs = 180000, pollMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await this.tuneweave.request(`/v1/auth/qr/${encodeURIComponent(qrcodeKey)}`)
      if (result.state === "confirmed") {
        if (!result.profile?.authenticated) throw new Error("B站登录身份未核实")
        this.tuneAccount = this.pendingAlias || "lotus-bilibili"
        const account = { tuneweave_account: this.tuneAccount, saved_at: formatLocalIso(this.now()), source: "tuneweave" }
        await this.saveAccount(account); return { ok: true, account }
      }
      if (["expired", "failed", "verification_required"].includes(result.state)) throw new Error("B站二维码已过期或需要附加验证，请重新登录")
      await sleep(pollMs)
    }
    throw new Error("B站二维码登录超时")
  }

  async loadAccount() {
    try {
      const data = YAML.parse(await fs.readFile(this.accountFile, "utf8")) || {}
      return data.cookie || data.tuneweave_account ? data : null
    } catch (error) {
      if (error?.code === "ENOENT") return null
      throw error
    }
  }

  async saveAccount(account = {}) {
    if (!account.cookie && !account.tuneweave_account) throw new Error("B站账号登录信息为空")
    await fs.mkdir(path.dirname(this.accountFile), { recursive: true })
    await fs.writeFile(this.accountFile, YAML.stringify({
      ...(account.cookie ? { cookie: normalizeBiliCookie(account.cookie) } : {}),
      ...(account.tuneweave_account ? { tuneweave_account: account.tuneweave_account } : {}),
      saved_at: account.saved_at || formatLocalIso(this.now()),
      source: account.source || "manual",
    }), "utf8")
    return this.accountFile
  }

  async requestJson(url) {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    const headers = { ...COMMON_HEADERS }
    if (this.cookie) headers.Cookie = this.cookie
    const response = await this.fetch(url, { headers })
    const text = await response.text()
    const json = text ? JSON.parse(text) : null
    if (!response.ok) throw new Error(`B站请求失败 HTTP ${response.status}`)
    return json
  }
}

export function normalizeBiliCookie(value = "") {
  const text = String(value || "").trim()
  if (!text) return ""
  if (text.includes("=")) return text
  return `SESSDATA=${text}`
}

export function extractLoginCookie(data = {}, headers = null) {
  const fromHeader = readSetCookie(headers)
  if (fromHeader) return fromHeader

  const url = String(data.url || "")
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : url
  const params = new URLSearchParams(query)
  const keys = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"]
  const pairs = []
  for (const key of keys) {
    const value = params.get(key)
    if (value) pairs.push(`${key}=${value}`)
  }
  return pairs.join("; ")
}

export function buildBilibiliItems(info) {
  if (info.type === "live") {
    return [
      { label: "类型", value: "直播" },
      { label: "主播", value: info.owner || "未知" },
      { label: "状态", value: info.liveStatus },
      { label: "热度", value: formatNumber(info.online) },
      { label: "链接", value: info.url },
      { label: "播放器", value: info.playerUrl || livePlayerUrl(info.roomId) },
    ]
  }
  return [
    { label: "类型", value: "视频" },
    { label: "UP", value: info.owner || "未知" },
    { label: "时长", value: formatDuration(info.duration) },
    { label: "播放", value: formatNumber(info.stat?.view || 0) },
    { label: "分P", value: String(Array.isArray(info.pages) ? info.pages.length : info.pages || 1) },
    { label: "链接", value: info.url },
  ]
}

export function formatNumber(value) {
  const number = Number(value || 0)
  if (number >= 10000) return `${(number / 10000).toFixed(1)}万`
  return String(number)
}

export function formatDuration(seconds) {
  const value = Number(seconds || 0)
  const minutes = Math.floor(value / 60)
  const rest = String(value % 60).padStart(2, "0")
  return `${minutes}:${rest}`
}

export function normalizeDownloadConfig(config = {}) {
  const source = config.download || config
  return {
    enable: source.enable !== false,
    concurrency: Math.max(1, Math.min(16, Math.floor(Number(source.concurrency) || 4))),
    tools_path: String(source.tools_path || "data/tools/bin"),
    resolution: Number(source.resolution || 64),
    duration_limit_seconds: Number(source.duration_limit_seconds || 3600),
    video_size_limit_mb: Number(source.video_size_limit_mb || 100),
    max_estimated_size_mb: Number(source.max_estimated_size_mb || 0),
    multi_page_policy: ["zip", "all", "first"].includes(source.multi_page_policy) ? source.multi_page_policy : "zip",
    timeout_ms: Number(source.timeout_ms || 600000),
    cookie: config.cookie || config.sessdata || source.cookie || source.sessdata || "",
  }
}

export function buildToolProcessEnv(pathDirs = [], baseEnv = process.env) {
  const env = { ...baseEnv }
  const pathKey = Object.prototype.hasOwnProperty.call(env, "Path") ? "Path" : "PATH"
  const existingPath = env[pathKey] || ""
  const dirs = [...new Set(pathDirs
    .map(dir => String(dir || "").trim())
    .filter(Boolean)
    .map(dir => path.resolve(dir)))]
  env[pathKey] = [...dirs, existingPath].filter(Boolean).join(path.delimiter)
  return env
}

export async function resolveCommandPath(command, toolsPath = "") {
  const exe = process.platform === "win32" && !/\.exe$/i.test(command) ? `${command}.exe` : command
  if (toolsPath) {
    const candidate = path.join(resolveToolsPath(toolsPath), exe)
    if (await exists(candidate)) return candidate
  }

  const lookup = process.platform === "win32" ? "where.exe" : "which"
  const result = await runSpawn(lookup, [command], {
    timeoutMs: 5000,
    rejectOnNonZero: false,
  }).catch(() => null)
  const first = result?.stdout?.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  return first || ""
}

export function selectPages(pages = [], policy = "zip") {
  const list = Array.isArray(pages) && pages.length ? pages : [{ index: 1, page: 1 }]
  return policy === "first" ? [list[0]] : list
}

export function safeFileName(value = "bilibili") {
  return safeMediaName(value || "bilibili")
}

function extractFromJsonCard(raw) {
  const trimmed = String(raw || "").trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  const jsonText = trimmed.slice(start, end + 1)
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&")
  let card
  try {
    card = JSON.parse(jsonText)
  } catch {
    return undefined
  }
  const candidates = []
  collectUrls(card, candidates)
  return candidates.find(value => /bilibili\.com|b23\.tv|bili2233\.cn/i.test(value)) || null
}

function collectUrls(value, out) {
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (["preview", "icon"].includes(key)) continue
    if (typeof child === "string" && /^https?:\/\//i.test(child)) out.push(child.replace(/\\\//g, "/"))
    else if (child && typeof child === "object") collectUrls(child, out)
  }
}

function stripHtml(value = "") {
  return String(value || "").replace(/<[^>]*>/g, "").trim()
}

function normalizeBiliImage(value = "") {
  const text = String(value || "").trim()
  if (!text) return ""
  const withProtocol = text.startsWith("//") ? `https:${text}` : text
  return withProtocol.replace(/@[^/?#]+(?=$|[?#])/i, "")
}

async function emitBiliEvent(hooks = {}, event = {}) {
  if (typeof hooks.onEvent === "function") {
    await hooks.onEvent(event)
  }
}

function estimateVideoSizeMb(info = {}) {
  const bandwidth = Number(info.stat?.bandwidth || 0)
  if (!bandwidth || !info.duration) return 0
  return Math.round((bandwidth * info.duration) / 8 / 1024 / 1024)
}

function resolveToolsPath(value = "") {
  const text = String(value || "")
  if (!text) return ""
  if (path.isAbsolute(text)) return text
  if (text === "data/tools/bin") return resolveData("tools", "bin")
  if (text.startsWith("data/") || text.startsWith("data\\")) return resolveData(text.slice(5))
  return path.resolve(rootPath, text)
}


function runSpawn(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const spawnImpl = options.spawnImpl || spawn
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.pathDirs ? buildToolProcessEnv(options.pathDirs, options.env || process.env) : options.env,
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, Number(options.timeoutMs || 600000))

    child.stdout?.on("data", chunk => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString()
    })
    child.on("error", error => {
      clearTimeout(timer)
      if (options.rejectOnNonZero === false) resolve({ ok: false, stdout, stderr, error })
      else reject(error)
    })
    child.on("close", code => {
      clearTimeout(timer)
      const ok = code === 0 && !timedOut
      const result = { ok, code, timedOut, stdout, stderr }
      if (ok || options.rejectOnNonZero === false) resolve(result)
      else reject(new Error(stderr || stdout || `${command} exited with code ${code}`))
    })
  })
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}


function readSetCookie(headers) {
  if (!headers) return ""
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : []
  const raw = values.length ? values.join("; ") : headers.get?.("set-cookie") || ""
  if (!raw) return ""
  const skip = new Set(["path", "expires", "max-age", "domain", "httponly", "secure", "samesite"])
  const pairs = new Map()
  for (const part of raw.split(/,(?=\s*[^;,=]+=[^;,]+)/)) {
    for (const item of part.split(";")) {
      const [key, ...rest] = item.trim().split("=")
      if (!key || !rest.length || skip.has(key.toLowerCase())) continue
      pairs.set(key, rest.join("="))
    }
  }
  return [...pairs.entries()].map(([key, value]) => `${key}=${value}`).join("; ")
}

function livePlayerUrl(roomId) {
  return `https://www.bilibili.com/blackboard/live/live-activity-player.html?cid=${encodeURIComponent(String(roomId || ""))}`
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
