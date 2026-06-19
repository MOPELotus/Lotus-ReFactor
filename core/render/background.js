import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadGlobalConfig } from "../config/global.js"
import { resolveData } from "../path.js"

const FALLBACK_BACKGROUND = "https://api.dujin.org/bing/1920.php"

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
  const source = config.render?.background || FALLBACK_BACKGROUND
  const imageUrl = await resolveBackgroundUrl(source, config)

  if (!isHttpUrl(imageUrl)) return normalizeStaticBackground(imageUrl)
  try {
    return await cacheRemoteBackground(imageUrl, config)
  } catch {
    return imageUrl
  }
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
  if (!looksLikeJsonImageApi(source)) return source

  try {
    const response = await fetchWithTimeout(
      source,
      Number(config.render?.background_timeout_ms || 3000),
    )
    const contentType = response.headers.get("content-type") || ""
    if (contentType.includes("application/json") || source.includes("xxapi.cn")) {
      const body = await response.json()
      return extractImageUrl(body) || source
    }
  } catch {
    return FALLBACK_BACKGROUND
  }

  return source
}

function looksLikeJsonImageApi(source) {
  return isHttpUrl(source) && /xxapi\.cn|json|api/i.test(source)
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

function extractImageUrl(value) {
  if (!value || typeof value !== "object") return ""
  for (const key of ["data", "url", "img", "image", "pic"]) {
    const next = value[key]
    if (typeof next === "string" && /^https?:\/\//i.test(next)) return next
    const nested = extractImageUrl(next)
    if (nested) return nested
  }
  return ""
}

async function cacheRemoteBackground(url, config) {
  const timeoutMs = Number(config.render?.background_timeout_ms || 3000)
  const cacheDir = resolveData("render-backgrounds")

  const response = await fetchWithTimeout(url, timeoutMs)
  if (!response.ok) throw new Error(`background image request failed: ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const ext = detectImageExt(buffer, response.headers.get("content-type"), url)
  const cacheSource = response.url && response.url !== url
    ? response.url
    : `${url}:${crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 16)}`
  const cacheKey = crypto.createHash("sha1").update(cacheSource).digest("hex").slice(0, 16)
  const file = path.join(cacheDir, `${cacheKey}.${ext}`)

  await fs.mkdir(cacheDir, { recursive: true })
  try {
    await fs.access(file)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    await fs.writeFile(file, buffer)
  }
  return pathToFileURL(file).href
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
