import fs from "node:fs/promises"
import path from "node:path"
import { resolveData } from "../../core/path.js"
import { createMediaTask, releaseMediaTask, recoverMediaTasks } from "../media/tasks.js"
import { packMediaFiles, safeMediaName, mediaLimitFailure } from "../media/files.js"
import { downloadMedia } from "../media/download.js"
import { prepareVideo } from "../media/video.js"
import { extractDouyinTarget, resolveDouyinTarget } from "./links.js"
import { fetchWebDetail } from "./api.js"
import { fetchSsrDetail } from "./ssr.js"
import { DouyinVisitor, getDefaultVisitor } from "./visitor.js"
import { normalizeDouyinWork, selectVideoSources } from "./model.js"
import { WEB_UA } from "./signature.js"
import { DouyinError } from "./http.js"

export function normalizeDouyinDownloadConfig(config = {}) {
  const source = config.download || config
  return {
    enable: source.enable !== false, tools_path: String(source.tools_path || "data/tools/bin"),
    quality: source.quality || "adapt", duration_limit_seconds: Number(source.duration_limit_seconds ?? 3600),
    video_size_limit_mb: Number(source.video_size_limit_mb || 100), max_estimated_size_mb: Number(source.max_estimated_size_mb || 0),
    multi_page_policy: ["first", "all", "zip"].includes(source.multi_page_policy) ? source.multi_page_policy : "zip",
    timeout_ms: Number(source.timeout_ms || 600000),
  }
}

export class DouyinService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.now = options.now || Date.now
    this.sign = options.sign
    this.timeoutMs = options.timeoutMs || 15000
    this.visitor = options.visitor || (options.fetch || options.now ? new DouyinVisitor({ fetch: this.fetch, now: this.now, timeoutMs: this.timeoutMs }) : getDefaultVisitor())
    this.tasksDir = options.tasksDir || resolveData("douyin", "tasks")
    this.prepareVideo = options.prepareVideo || prepareVideo
    this.pack = options.pack || packMediaFiles
  }

  extractTarget(message) { return extractDouyinTarget(message) }
  resolveTarget(input) { return resolveDouyinTarget(input, { fetch: this.fetch, timeoutMs: this.timeoutMs }) }

  async getInfo(input, { deadline = Infinity } = {}) {
    const requestBudget = () => {
      const remaining = Math.min(this.timeoutMs, deadline - Date.now())
      if (remaining <= 0) throw new DouyinError("timeout", "作品下载超时")
      return remaining
    }
    const target = typeof input === "string" ? await resolveDouyinTarget(input, { fetch: this.fetch, timeoutMs: requestBudget() }) : input
    if (!/^\d+$/.test(target?.id || "")) throw new DouyinError("invalid_link", "抖音作品 ID 无效")
    let previous = ""
    let primaryError
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const getVisitor = this.visitor.getSession || this.visitor.get
        previous = await getVisitor.call(this.visitor, { refresh: attempt > 0, previous, timeoutMs: requestBudget() })
        const detail = await fetchWebDetail(target.id, previous, { fetch: this.fetch, timeoutMs: requestBudget(), sign: this.sign, now: this.now() })
        return normalizeDouyinWork(detail, { source: "web", expectedId: target.id })
      } catch (error) {
        if (error.code === "unavailable" || Date.now() >= deadline) throw error
        primaryError = error
      }
    }
    try {
      const detail = await fetchSsrDetail(target.id, { fetch: this.fetch, timeoutMs: requestBudget() })
      return normalizeDouyinWork(detail, { source: "ssr", expectedId: target.id })
    } catch (error) {
      if (error.code === "unavailable") throw error
      throw new DouyinError("parse_failed", "抖音主接口与分享页面均未取得可用作品，请检查链接或稍后重试", { cause: new AggregateError([primaryError, error]) })
    }
  }

  async download(input, config = {}, hooks = {}) {
    const download = normalizeDouyinDownloadConfig(config)
    const info = typeof input === "object" && input.platform === "douyin" ? input : await this.getInfo(input)
    const limitFailure = mediaLimitFailure(info, download)
    if (limitFailure) return limitFailure
    const task = await createMediaTask(this.tasksDir)
    const deadline = Date.now() + download.timeout_ms
    const files = []
    const artifacts = []
    const warnings = [...info.warnings]
    const failedItems = []
    let consumed = 0
    let refreshed
    const remainingTime = () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error("作品下载超时")
      return remaining
    }
    const downloadItem = async (candidates, base, kind) => {
      let lastError
      for (const candidate of candidates) {
        for (const url of candidate.urls) {
          try {
            const cap = download.max_estimated_size_mb * 1024 * 1024
            if (cap > 0 && consumed >= cap) throw new Error("作品媒体总大小超过下载限制")
            const result = await downloadMedia(url, base, { fetch: this.fetch, kind, headers: { "User-Agent": WEB_UA, Referer: "https://www.douyin.com/" }, timeoutMs: remainingTime(), maxBytes: cap > 0 ? cap - consumed : 0 })
            consumed += result.sizeBytes
            if (kind === "video") {
              const prepared = await this.prepareVideo(result.file, { ...download, timeout_ms: remainingTime(), codec: candidate.codec })
              warnings.push(...prepared.warnings)
              result.file = prepared.file
            }
            return result
          } catch (error) {
            lastError = error
            // Conversion can fail after the final file exists. This attempt is not a reusable artifact.
            for (const ext of [".mp4", ".mkv", ".flv", ".jpg", ".png", ".webp", ".gif", ".avif", ".heic", "-compatible.mp4"]) {
              await fs.rm(`${base}${ext}`, { force: true }).catch(() => {})
            }
          }
        }
      }
      throw lastError || new Error("媒体地址缺失")
    }
    try {
      await hooks.onEvent?.({ type: "download-start", message: `开始下载抖音作品 ${info.id}` })
      if (info.article) {
        const file = path.join(task.dir, "000-正文.txt")
        const text = [info.title, `作者：${info.owner}`, info.url, "", ...info.article.blocks.map(block => block.type === "text" ? block.text : `[图片] ${block.urls[0]}`)].join("\n\n")
        await fs.writeFile(file, text, "utf8")
        files.push(file); artifacts.push({ file, kind: "text", index: 0 })
      }
      const items = download.multi_page_policy === "first" ? info.media.slice(0, 1) : info.media
      for (const item of items) {
        const prefix = path.join(task.dir, String(item.index).padStart(3, "0"))
        const processPart = async (kind, candidates, suffix) => {
          try {
            let result
            try { result = await downloadItem(candidates, `${prefix}-${suffix}`, kind) } catch (firstError) {
              if (!refreshed) { remainingTime(); refreshed = this.getInfo(info.url, { deadline }) }
              const fresh = await refreshed
              const replacement = fresh.media.find(entry => entry.index === item.index)
              if (!replacement) throw firstError
              result = await downloadItem(kind === "image" ? [{ urls: replacement.urls }] : selectVideoSources(replacement.sources, download), `${prefix}-${suffix}`, kind)
            }
            files.push(result.file); artifacts.push({ ...result, index: item.index })
          } catch (error) {
            failedItems.push({ index: item.index, kind, message: error.message })
          }
        }
        if (item.type === "image" || item.type === "live_photo") await processPart("image", [{ urls: item.urls }], "image")
        if (["video", "live_photo"].includes(item.type)) await processPart("video", selectVideoSources(item.sources, download), "video")
      }
      if (!files.length) throw new Error(failedItems[0]?.message || "没有取得可发送的作品内容")
      if (failedItems.length) warnings.push(`部分媒体未取得：${failedItems.map(item => `第${item.index}项${item.kind === "video" ? "视频" : "图片"}`).join("、")}`)
      let output = files
      if (download.multi_page_policy === "zip" && files.length > 1) {
        if (failedItems.length) await fs.writeFile(path.join(task.dir, "下载缺项.txt"), failedItems.map(item => `第${item.index}项 ${item.kind}：${item.message}`).join("\n"), "utf8")
        const packFiles = failedItems.length ? [...files, path.join(task.dir, "下载缺项.txt")] : files
        const target = path.join(task.dir, `${safeMediaName(info.title)}-${info.id}.zip`)
        await this.pack(packFiles, target, { cwd: task.dir, timeoutMs: remainingTime() })
        output = [target]
      }
      return { ok: true, info, taskDir: task.dir, taskId: task.id, files: output, artifacts, warnings, partial: failedItems.length > 0, failedItems }
    } catch (error) {
      await this.releaseTask({ taskDir: task.dir }).catch(cleanupError => globalThis.logger?.warn?.(`[Lotus-Plugin] Douyin task cleanup: ${cleanupError.message}`))
      throw error
    }
  }

  recoverTasks() { return recoverMediaTasks(this.tasksDir) }
  releaseTask(result) { return releaseMediaTask(this.tasksDir, result?.taskDir) }
}
