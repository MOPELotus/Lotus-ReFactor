import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadGlobalConfig } from "../config/global.js"
import { resolveData } from "../path.js"

const FALLBACK_BACKGROUND = "https://api.dujin.org/bing/1920.php"
const IMAGE_URL_PATTERN = /^https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?$/i
const IMAGE_URL_GLOBAL_PATTERN = /https?:\\?\/\\?\/[^\s"'<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?/gi

export async function getRenderBackground(configOverride = null) {
  const config = configOverride || await loadGlobalConfig()
  return resolveRenderBackgroundFromConfig(config)
}

export async function createRenderBackgroundProvider(configOverride = null) {
  const config = configOverride || await loadGlobalConfig()
  return async () => resolveRenderBackgroundFromConfig(config)
}

export async function getRenderBackgrounds(count = 1, configOverride = null) {
  const provider = await createRenderBackgroundProvider(configOverride)
  const total = Math.max(1, Number(count) || 1)
  const results = []
  for (let index = 0; index < total; index += 1) {
    const bg = await provider()
    if (bg && !results.includes(bg)) results.push(bg)
  }
  return results.length ? results : [await getRenderBackground(configOverride)]
}

export async function resolveRenderBackgroundFromConfig(config) {
  const sources = normalizeBackgroundSources(config.render?.background)
  const ordered = shuffle(sources.length ? sources : [FALLBACK_BACKGROUND])
  for (const source of ordered) {
    try {
      const imageUrl = await resolveBackgroundUrl(source, config)
      if (!isHttpUrl(imageUrl)) return normalizeStaticBackground(imageUrl)
      return await cacheRemoteBackground(imageUrl, config)
    } catch {
      continue
    }
  }
  return FALLBACK_BACKGROUND
}

async function normalizeStaticBackground(source) {
  const value = String(source || "")
  if (!value || /^(?:data|file):/i.test(value)) return value
  const file = path.isAbsolute(value) ? value : path.resolve(value)
  try {
    await fs.access(file)
    return pathToFileURL(file).href
  } catch {
    return value
  }
}

async function resolveBackgroundUrl(source, config) {
  if (!looksLikeDynamicBackgroundSource(source)) return source

  const response = await fetchWithTimeout(
    source,
    Number(config.render?.background_timeout_ms || 3000),
  )
  if (!response.ok) throw new Error(`background source request failed: ${response.status}`)

  const contentType = response.headers.get("content-type") || ""
  if (contentType.startsWith("image/")) return response.url || source

  const bodyText = await response.text()
  const urls = extractImageUrls(parseMaybeJson(bodyText) || bodyText)
  const picked = pick(urls)
  if (!picked) {
    throw new Error("background source did not return an image url")
  }
  return picked
}

export function normalizeBackgroundSources(value) {
  if (Array.isArray(value)) {
    return value.flatMap(item => normalizeBackgroundSources(item))
  }
  const text = String(value || "").trim()
  if (!text) return []
  return text
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
}

function looksLikeDynamicBackgroundSource(source) {
  const text = String(source || "")
  return isHttpUrl(text) && /api|json|contents|github\.com\/repos\/.+\/contents|hoyoverse|mihoyo|miyoushe/i.test(text)
}

async function fetchWithTimeout(url, timeoutMs) {
  if (typeof fetch !== "function") throw new Error("fetch is unavailable")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function extractImageUrls(value, results = []) {
  if (!value) return results
  if (typeof value === "string") {
    for (const match of value.match(IMAGE_URL_GLOBAL_PATTERN) || []) {
      results.push(match.replaceAll("\\/", "/"))
    }
    if (IMAGE_URL_PATTERN.test(value)) results.push(value)
    return unique(results)
  }
  if (Array.isArray(value)) {
    for (const item of value) extractImageUrls(item, results)
    return unique(results)
  }
  if (typeof value !== "object") return unique(results)
  for (const key of ["download_url", "data", "url", "imgurl", "img", "image", "pic", "acgurl", "link"]) {
    const next = value[key]
    extractImageUrls(next, results)
  }
  for (const next of Object.values(value)) extractImageUrls(next, results)
  return unique(results)
}

async function cacheRemoteBackground(url, config) {
  const timeoutMs = Number(config.render?.background_timeout_ms || 3000)
  const cacheDir = resolveData("render-backgrounds")

  const response = await fetchWithTimeout(url, timeoutMs)
  if (!response.ok) throw new Error(`background image request failed: ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!isImageBuffer(buffer, response.headers.get("content-type") || "")) {
    throw new Error("background response is not an image")
  }
  const ext = detectImageExt(buffer, response.headers.get("content-type"), url)
  const cacheSource = response.url && response.url !== url
    ? response.url
    : `${url}:${crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 16)}`
  const cacheKey = crypto.createHash("sha1").update(cacheSource).digest("hex").slice(0, 16)
  const file = path.join(cacheDir, `${cacheKey}.${ext}`)

  await fs.mkdir(cacheDir, { recursive: true })
  try {
    const stat = await fs.stat(file)
    if (stat.size > 0) return pathToFileURL(file).href
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await fs.writeFile(file, buffer)
  return pathToFileURL(file).href
}

function isImageBuffer(buffer, contentType = "") {
  if (!buffer || buffer.length < 16) return false
  return /^image\//i.test(contentType)
    || buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))
    || buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP")
    || buffer.subarray(0, 3).toString("ascii") === "GIF"
}

function detectImageExt(buffer, contentType = "", url = "") {
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) return "jpg"
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png"
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp"
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "gif"

  if (contentType.includes("png")) return "png"
  if (contentType.includes("webp")) return "webp"
  if (contentType.includes("gif")) return "gif"
  if (/\.png(\?|$)/i.test(url)) return "png"
  if (/\.webp(\?|$)/i.test(url)) return "webp"
  if (/\.gif(\?|$)/i.test(url)) return "gif"
  return "jpg"
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""))
}

function shuffle(values = []) {
  const next = [...values]
  for (let index = next.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1))
    ;[next[index], next[target]] = [next[target], next[index]]
  }
  return next
}

function pick(values = []) {
  if (!values.length) return ""
  return values[Math.floor(Math.random() * values.length)]
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))]
}
