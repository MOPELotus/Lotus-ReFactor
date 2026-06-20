import crypto from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import QRCode from "qrcode"
import YAML from "yaml"
import { resolveData, rootPath } from "../../core/path.js"
import { formatLocalIso } from "../../core/time.js"

const NAV_API = "https://api.bilibili.com/x/web-interface/nav"
const QR_GENERATE_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
const QR_POLL_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
const VIDEO_INFO_API = "https://api.bilibili.com/x/web-interface/view"
const LIVE_INFO_API = "https://api.live.bilibili.com/room/v1/Room/get_info"
const SEARCH_API = "https://api.bilibili.com/x/web-interface/search/type"
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32,
  15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
]

const COMMON_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  Referer: "https://www.bilibili.com/",
})

const MEDIA_EXTENSIONS = new Set([".mp4", ".mkv", ".flv", ".mov", ".m4v"])

export class BilibiliService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.sessdata = options.sessdata || ""
    this.cookie = normalizeBiliCookie(options.cookie || options.sessdata || "")
    this.now = options.now || (() => new Date())
    this.wbiCache = null
    this.accountFile = options.accountFile || resolveData("bilibili", "account.yaml")
    this.cacheFile = options.cacheFile || resolveData("bilibili", "cache.yaml")
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

  async getVideoInfo(target) {
    const params = new URLSearchParams()
    if (target.bvid) params.set("bvid", target.bvid)
    if (target.aid) params.set("aid", target.aid)
    const json = await this.requestJson(`${VIDEO_INFO_API}?${params}`)
    if (json.code !== 0) throw new Error(json.message || `B站视频接口错误 ${json.code}`)
    const data = json.data || {}
    return {
      type: "video",
      title: stripHtml(data.title),
      bvid: data.bvid,
      aid: data.aid,
      url: `https://www.bilibili.com/video/${data.bvid}`,
      cover: normalizeBiliImage(data.pic || ""),
      owner: data.owner?.name || "",
      duration: Number(data.duration || 0),
      stat: data.stat || {},
      cid: data.cid,
      pages: Array.isArray(data.pages) && data.pages.length
        ? data.pages.map((page, index) => ({
            index: index + 1,
            cid: page.cid,
            page: page.page || index + 1,
            part: stripHtml(page.part || `P${index + 1}`),
            duration: Number(page.duration || 0),
          }))
        : [{ index: 1, cid: data.cid, page: 1, part: "P1", duration: Number(data.duration || 0) }],
      desc: stripHtml(data.desc || "").slice(0, 180),
    }
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
    const params = {
      search_type: "video",
      keyword,
      page: String(page),
    }
    const query = await this.buildMaybeSignedQuery(params)
    const json = await this.requestJson(`${SEARCH_API}?${query}`)
    if (json.code !== 0) throw new Error(json.message || `B站搜索接口错误 ${json.code}`)
    return (json.data?.result || [])
      .filter(item => item.bvid)
      .slice(0, limit)
      .map(item => ({
        title: stripHtml(item.title),
        bvid: item.bvid,
        author: stripHtml(item.author || ""),
        play: item.play || 0,
        duration: item.duration || "",
        url: `https://www.bilibili.com/video/${item.bvid}`,
      }))
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
    if (download.duration_limit_seconds > 0 && info.duration > download.duration_limit_seconds) {
      return {
        ok: false,
        reason: "duration_limit",
        info,
        limitSeconds: download.duration_limit_seconds,
      }
    }

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
    const cacheKey = downloadCacheKey(info, download)
    const cached = await this.getCachedDownload(cacheKey, download).catch(() => null)
    return {
      ok: true,
      info,
      pages,
      cacheKey,
      cached,
      policy: download.multi_page_policy,
      downloader: "bbdown",
      estimatedSizeMb,
    }
  }

  async download(input, config = {}, hooks = {}) {
    const download = normalizeDownloadConfig(config)
    const plan = await this.buildDownloadPlan(input, download)
    if (!plan.ok) return plan

    if (plan.cached?.files?.length) {
      await emitBiliEvent(hooks, {
        type: "cache-hit",
        message: "命中 B站下载缓存，准备发送已缓存文件。",
        files: plan.cached.files,
      })
      return {
        ...plan,
        ok: true,
        fromCache: true,
        files: plan.cached.files,
      }
    }

    await emitBiliEvent(hooks, {
      type: "download-start",
      message: `开始下载 ${plan.info.bvid}，方式：${plan.downloader}，分P策略：${plan.policy}。`,
    })

    const workDir = resolveData("bilibili", "tmp", `${plan.cacheKey}-${Date.now()}`)
    const outputDir = resolveData("bilibili", "downloads")
    await fs.rm(workDir, { recursive: true, force: true })
    await fs.mkdir(workDir, { recursive: true })
    await fs.mkdir(outputDir, { recursive: true })

    try {
      let files = await this.downloadWithBBDown(plan, download, workDir, hooks)

      if (download.multi_page_policy === "zip" && files.length > 1) {
        const zipPath = path.join(outputDir, `${safeFileName(plan.info.title || plan.info.bvid)}-${plan.info.bvid}.zip`)
        await compressFiles(files, zipPath, this.spawn || spawn, download.timeout_ms)
        files = [zipPath]
      } else {
        files = await moveFilesToOutput(files, outputDir)
      }

      await this.setCachedDownload(plan.cacheKey, files, download)
      return {
        ...plan,
        ok: true,
        fromCache: false,
        files,
      }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => null)
    }
  }

  async downloadWithBBDown(plan, download, workDir, hooks = {}) {
    const url = plan.info.url
    const pageArg = download.multi_page_policy === "first" && plan.pages[0]?.page
      ? plan.pages[0].page
      : null
    await emitBiliEvent(hooks, {
      type: "bbdown-start",
      message: "正在调用 BBDown。",
    })
    await this.runBBDown(url, workDir, {
      page: pageArg,
      config: download,
    })
    const files = await findMediaFiles(workDir)
    if (!files.length) throw new Error("BBDown 执行完成但没有找到视频文件")
    return files
  }

  async runBBDown(url, cwd, { page = null, config = {} } = {}) {
    const bbdownPath = await resolveCommandPath("BBDown", config.tools_path)
    if (!bbdownPath) throw new Error("未找到 BBDown，请检查环境变量或 bilibili.download.tools_path")
    const args = [url, "--work-dir", cwd]
    if (config.use_aria2) args.push("--use-aria2c")
    if (page) args.push("-p", String(page))
    if (config.resolution) args.push("--dfn-priority", String(config.resolution))

    const sessdata = await this.getSessDataForDownload(config)
    if (sessdata) args.push("-c", `SESSDATA=${sessdata}`)
    if (Array.isArray(config.extra_args) && config.extra_args.length) args.push(...config.extra_args)

    return runSpawn(bbdownPath, args, {
      cwd,
      timeoutMs: Number(config.timeout_ms || 600000),
    })
  }

  async getSessDataForDownload(config = {}) {
    const cookie = normalizeBiliCookie(config.cookie || this.cookie || this.sessdata || "")
    const sessdata = cookie.match(/(?:^|;\s*)SESSDATA=([^;]+)/)?.[1]
    if (sessdata) return sessdata

    const bbdownPath = await resolveCommandPath("BBDown", config.tools_path)
    if (!bbdownPath) return ""
    const dataPath = path.join(path.dirname(bbdownPath), "BBDown.data")
    try {
      const raw = await fs.readFile(dataPath, "utf8")
      return raw.match(/SESSDATA=([^;]+)/)?.[1] || ""
    } catch {
      return ""
    }
  }

  async runBBDownLogin(config = {}, hooks = {}) {
    const download = normalizeDownloadConfig(config)
    const bbdownPath = await resolveCommandPath("BBDown", download.tools_path)
    if (!bbdownPath) throw new Error("未找到 BBDown，请检查环境变量或 bilibili.download.tools_path")

    const workDir = resolveData("bilibili")
    const qrPath = path.join(workDir, "qrcode.png")
    const logPath = path.join(workDir, "bbdown-login.log")
    await fs.mkdir(workDir, { recursive: true })
    await fs.rm(qrPath, { force: true }).catch(() => null)
    await fs.rm(logPath, { force: true }).catch(() => null)

    await emitBiliEvent(hooks, {
      type: "bbdown-login-start",
      message: "正在启动 BBDown 登录进程。",
    })

    return new Promise((resolve, reject) => {
      const child = spawn(bbdownPath, ["login"], {
        cwd: workDir,
        windowsHide: true,
      })
      let stdout = ""
      let stderr = ""
      let sentQr = false
      const timer = setTimeout(() => {
        child.kill("SIGTERM")
      }, download.timeout_ms)
      const qrTimer = setInterval(async () => {
        if (sentQr) return
        if (await exists(qrPath)) {
          sentQr = true
          await emitBiliEvent(hooks, {
            type: "bbdown-login-qr",
            message: "BBDown 登录二维码已生成。",
            qrPath,
          })
        }
      }, 1000)

      child.stdout?.on("data", chunk => {
        stdout += chunk.toString()
      })
      child.stderr?.on("data", chunk => {
        stderr += chunk.toString()
      })
      child.on("error", error => {
        clearTimeout(timer)
        clearInterval(qrTimer)
        reject(error)
      })
      child.on("close", async code => {
        clearTimeout(timer)
        clearInterval(qrTimer)
        await fs.writeFile(logPath, stdout + stderr, "utf8").catch(() => null)
        resolve({
          ok: code === 0 || /登录成功|login success/i.test(stdout + stderr),
          code,
          stdout,
          stderr,
          logPath,
          qrPath: await exists(qrPath) ? qrPath : "",
        })
      })
    })
  }

  async getCachedDownload(key, config = {}) {
    if (!config.cache_enable) return null
    const cache = await this.readCache()
    const item = cache[key]
    if (!item) return null
    if (item.expires_at && Date.parse(item.expires_at) < Date.now()) {
      delete cache[key]
      await this.writeCache(cache)
      return null
    }
    const files = []
    for (const file of item.files || []) {
      if (await exists(file)) files.push(file)
    }
    if (!files.length) {
      delete cache[key]
      await this.writeCache(cache)
      return null
    }
    return {
      ...item,
      files,
    }
  }

  async setCachedDownload(key, files, config = {}) {
    if (!config.cache_enable) return
    const cache = await this.readCache()
    const ttl = Number(config.cache_ttl_seconds || 0)
    cache[key] = {
      files,
      saved_at: formatLocalIso(this.now()),
      expires_at: ttl > 0 ? formatLocalIso(new Date(this.now().getTime() + ttl * 1000)) : "",
    }
    await this.writeCache(cache)
  }

  async readCache() {
    try {
      return YAML.parse(await fs.readFile(this.cacheFile, "utf8")) || {}
    } catch (error) {
      if (error?.code === "ENOENT") return {}
      throw error
    }
  }

  async writeCache(cache) {
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true })
    await fs.writeFile(this.cacheFile, YAML.stringify(cache), "utf8")
  }

  async createQrLogin() {
    const json = await this.requestJson(`${QR_GENERATE_API}?t=${Date.now()}`)
    const url = json?.data?.url
    const qrcodeKey = json?.data?.qrcode_key
    if (!url || !qrcodeKey) throw new Error(json?.message || "B站二维码创建失败")
    return {
      url,
      qrcodeKey,
      qrDataUrl: await QRCode.toDataURL(url, {
        margin: 1,
        width: 320,
      }),
    }
  }

  async waitQrLogin({ qrcodeKey, timeoutMs = 180000, pollMs = 3000 } = {}) {
    if (!qrcodeKey) throw new Error("qrcode_key is required")
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const response = await this.fetch(`${QR_POLL_API}?qrcode_key=${encodeURIComponent(qrcodeKey)}&t=${Date.now()}`, {
        headers: COMMON_HEADERS,
      })
      const text = await response.text()
      const json = text ? JSON.parse(text) : null
      if (!response.ok) throw new Error(`B站登录轮询失败 HTTP ${response.status}`)
      const code = Number(json?.data?.code)
      if (code === 0) {
        const cookie = extractLoginCookie(json?.data, response.headers)
        if (!cookie) throw new Error("B站登录成功但未提取到 cookie")
        const account = {
          cookie,
          saved_at: formatLocalIso(this.now()),
          source: "qrcode",
        }
        await this.saveAccount(account)
        this.cookie = cookie
        return {
          ok: true,
          account,
        }
      }
      if (code === 86038) throw new Error("B站二维码已过期")
      await sleep(pollMs)
    }
    throw new Error("B站二维码登录超时")
  }

  async loadAccount() {
    try {
      const data = YAML.parse(await fs.readFile(this.accountFile, "utf8")) || {}
      return data.cookie ? data : null
    } catch (error) {
      if (error?.code === "ENOENT") return null
      throw error
    }
  }

  async saveAccount(account = {}) {
    if (!account.cookie) throw new Error("B站账号 cookie 为空")
    await fs.mkdir(path.dirname(this.accountFile), { recursive: true })
    await fs.writeFile(this.accountFile, YAML.stringify({
      cookie: normalizeBiliCookie(account.cookie),
      saved_at: account.saved_at || formatLocalIso(this.now()),
      source: account.source || "manual",
    }), "utf8")
    return this.accountFile
  }

  async buildMaybeSignedQuery(params) {
    try {
      const key = await this.getWbiMixinKey()
      if (key) return buildWbiQuery(params, key, Math.floor(this.now().getTime() / 1000))
    } catch (error) {
      logger?.debug?.(`[Lotus-Plugin] bilibili WBI key unavailable: ${error.message}`)
    }
    return new URLSearchParams(params).toString()
  }

  async getWbiMixinKey() {
    if (this.wbiCache && this.wbiCache.expires > Date.now()) return this.wbiCache.key
    const json = await this.requestJson(NAV_API)
    const imgUrl = json?.data?.wbi_img?.img_url || ""
    const subUrl = json?.data?.wbi_img?.sub_url || ""
    const imgKey = keyFromUrl(imgUrl)
    const subKey = keyFromUrl(subUrl)
    if (!imgKey || !subKey) return ""
    const key = getMixinKey(`${imgKey}${subKey}`)
    this.wbiCache = {
      key,
      expires: Date.now() + 10 * 60 * 1000,
    }
    return key
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

export function buildWbiQuery(params = {}, mixinKey, wts = Math.floor(Date.now() / 1000)) {
  const query = {
    ...params,
    wts,
  }
  const encoded = Object.keys(query)
    .sort()
    .map(key => {
      const value = String(query[key] ?? "").replace(/[!'()*]/g, "")
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join("&")
  const wRid = crypto.createHash("md5").update(`${encoded}${mixinKey}`).digest("hex")
  return `${encoded}&w_rid=${wRid}`
}

export function getMixinKey(rawKey = "") {
  return MIXIN_KEY_ENC_TAB
    .map(index => rawKey[index] || "")
    .join("")
    .slice(0, 32)
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
    use_aria2: source.use_aria2 === true,
    tools_path: String(source.tools_path || "data/tools/bin"),
    resolution: Number(source.resolution || 64),
    duration_limit_seconds: Number(source.duration_limit_seconds || 3600),
    video_size_limit_mb: Number(source.video_size_limit_mb || 100),
    max_estimated_size_mb: Number(source.max_estimated_size_mb || 0),
    multi_page_policy: ["zip", "all", "first"].includes(source.multi_page_policy) ? source.multi_page_policy : "zip",
    cache_enable: source.cache_enable !== false,
    cache_ttl_seconds: Number(source.cache_ttl_seconds || 0),
    timeout_ms: Number(source.timeout_ms || 600000),
    extra_args: Array.isArray(source.extra_args) ? source.extra_args.map(String) : [],
    cookie: config.cookie || config.sessdata || source.cookie || source.sessdata || "",
  }
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

export function downloadCacheKey(info, config = {}) {
  return [
    info.bvid || info.aid,
    "bbdown",
    config.resolution || 64,
    config.multi_page_policy || "zip",
  ].join("-")
}

export function safeFileName(value = "bilibili") {
  return String(value || "bilibili")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "bilibili"
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

async function compressFiles(files, zipPath, spawnImpl = spawn, timeoutMs = 600000) {
  await fs.rm(zipPath, { force: true }).catch(() => null)
  if (process.platform === "win32") {
    const escaped = files.map(file => `'${file.replace(/'/g, "''")}'`).join(",")
    const command = `Compress-Archive -LiteralPath ${escaped} -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
    await runSpawn("powershell.exe", ["-NoProfile", "-Command", command], {
      spawnImpl,
      timeoutMs,
    })
    return zipPath
  }

  await runSpawn("zip", ["-j", zipPath, ...files], {
    spawnImpl,
    timeoutMs,
  })
  return zipPath
}

function resolveToolsPath(value = "") {
  const text = String(value || "")
  if (!text) return ""
  if (path.isAbsolute(text)) return text
  if (text === "data/tools/bin") return resolveData("tools", "bin")
  if (text.startsWith("data/") || text.startsWith("data\\")) return resolveData(text.slice(5))
  return path.resolve(rootPath, text)
}

async function moveFilesToOutput(files, outputDir) {
  const result = []
  for (const file of files) {
    const target = await uniquePath(path.join(outputDir, path.basename(file)))
    await fs.rename(file, target).catch(async error => {
      if (error?.code !== "EXDEV") throw error
      await fs.copyFile(file, target)
      await fs.rm(file, { force: true })
    })
    result.push(target)
  }
  return result
}

async function uniquePath(file) {
  const parsed = path.parse(file)
  let candidate = file
  let index = 1
  while (await exists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`)
    index += 1
  }
  return candidate
}

async function findMediaFiles(root) {
  const files = []
  const queue = [root]
  while (queue.length) {
    const dir = queue.shift()
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(full)
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

function runSpawn(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const spawnImpl = options.spawnImpl || spawn
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
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

function keyFromUrl(url = "") {
  return String(url || "").split("/").pop()?.split(".")[0] || ""
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
