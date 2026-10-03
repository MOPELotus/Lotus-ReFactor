import { load } from "cheerio"
import { DouyinError } from "./http.js"

/**
 * @typedef {Object} MediaSource
 * @property {string[]} urls Ordered mirrors; never rewrite signed paths.
 * @property {string|undefined} quality Platform's quality label.
 * @property {number|undefined} sizeBytes
 * @property {number|undefined} width
 * @property {number|undefined} height
 * @property {string|undefined} codec
 * @property {string|undefined} format
 *
 * @typedef {Object} MediaWork
 * @property {"video"|"gallery"|"live_photo"|"article"} type
 * @property {string} id
 * @property {string} platform
 * @property {string} title
 * @property {string} owner
 * @property {string} url
 * @property {Array<Object>} media Ordered logical items; live photos contain image + motion.
 * @property {MediaSource[]} sources All video variants, not just the selected variant.
 * @property {string[]} warnings
 */

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined
const count = value => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined
const jsonObject = value => {
  if (value && typeof value === "object") return value
  try { return JSON.parse(value || "{}") || {} } catch { return {} }
}

export function mediaUrls(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : value?.url_list || []
  const candidates = Array.isArray(list) ? list : typeof list === "string" ? [list] : []
  return [...new Set(candidates.filter(url => {
    if (typeof url !== "string") return false
    try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password } catch { return false }
  }))]
}

function plainText(value) {
  const text = String(value || "")
  if (!/<\/?[a-z][\s\S]*>/i.test(text)) return text.trim()
  const $ = load(text)
  $("script,style").remove()
  $("br").replaceWith("\n")
  return $.text().trim()
}

function qualityLabel(entry) {
  const definition = jsonObject(entry.video_extra).definition
  const known = { uhd: "4k", "4k": "4k", "2k": "2k", qhd: "2k", fhd: "1080p", hd: "720p", sd: "540p", ld: "360p" }
  if (definition) return known[definition] || String(definition)
  return String(entry.gear_name || "").match(/(?:^|[_-])(2160|1440|1080|720|540|360)p?(?:[_-]|$)/)?.[1]?.replace(/^(.*)$/, "$1p")
}

function sourceFromAddress(address, entry = {}) {
  if (!address) return null
  let urls = mediaUrls(address)
  if (!urls.length && address.uri && !/^https?:/i.test(address.uri)) {
    const params = new URLSearchParams({ video_id: address.uri })
    urls = [`https://www.douyin.com/aweme/v1/play/?${params}`]
  } else if (!urls.length) urls = mediaUrls(address.uri)
  if (!urls.length) return null
  return {
    urls, quality: qualityLabel(entry), sizeBytes: positive(address.data_size),
    width: positive(address.width), height: positive(address.height), bitrate: positive(entry.bit_rate),
    codec: entry.is_bytevc1 === 1 ? "h265" : entry.is_bytevc1 === 0 || entry.h264 ? "h264" : undefined,
    format: entry.format || undefined,
  }
}

export function videoSources(video = {}) {
  const variants = Array.isArray(video.bit_rate) ? video.bit_rate : []
  const sources = variants.map(entry => sourceFromAddress(entry.play_addr, entry)).filter(Boolean)
  for (const [key, h264] of [["play_addr_h264", true], ["play_addr", false], ["download_addr", false]]) {
    const source = sourceFromAddress(video[key], { h264 })
    if (source && !sources.some(item => item.urls.join("\n") === source.urls.join("\n"))) sources.push(source)
  }
  return sources
}

export function selectVideoSources(sources, config = {}) {
  const sizes = { "4k": 2160, "2160p": 2160, "2k": 1440, "1440p": 1440, "1080p": 1080, "720p": 720, "540p": 540, "360p": 360 }
  const preferred = config.quality || "adapt"
  const candidates = sources.filter(source => !source.format || source.format.toLowerCase() === "mp4")
  const ordered = [...candidates].sort((a, b) => (sizes[b.quality] || 0) - (sizes[a.quality] || 0)
    || Number(b.codec === "h264") - Number(a.codec === "h264") || (b.bitrate || 0) - (a.bitrate || 0))
  if (preferred !== "adapt") {
    const exact = ordered.filter(source => source.quality === preferred)
    return [...exact, ...ordered.filter(source => source.quality !== preferred)]
  }
  const limit = Number(config.video_size_limit_mb || 100) * 1024 * 1024
  const fits = ordered.filter(source => source.sizeBytes && source.sizeBytes <= limit)
  if (fits.length) return [...fits, ...ordered.filter(source => !fits.includes(source))]
  const known = ordered.filter(source => source.sizeBytes).sort((a, b) => a.sizeBytes - b.sizeBytes)
  return [...known, ...ordered.filter(source => !source.sizeBytes)]
}

function articleBlocks(info, warnings) {
  const content = jsonObject(info.article_content)
  const fe = jsonObject(info.fe_data)
  const images = Array.isArray(fe.image_list) ? fe.image_list : []
  const replacements = new Map(images.map(image => [image.markdown_url, image.ai_high_image_url || image.high_image_url || image.origin_image_url || image.markdown_url]))
  const blocks = []
  const markdown = typeof content.markdown === "string" ? content.markdown : ""
  if (markdown) {
    const expression = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:[^)]*)\)/g
    let offset = 0
    for (const match of markdown.matchAll(expression)) {
      const text = plainText(markdown.slice(offset, match.index))
      if (text) blocks.push({ type: "text", text })
      const urls = mediaUrls(replacements.get(match[2]) || match[2])
      if (urls.length) blocks.push({ type: "image", urls, caption: match[1] })
      offset = match.index + match[0].length
    }
    const text = plainText(markdown.slice(offset))
    if (text) blocks.push({ type: "text", text })
  } else {
    const nodes = content.blocks || content.body || content.content
    const visit = (node, depth = 0) => {
      if (depth > 12 || !node) return
      if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return }
      if (typeof node === "string") { const text = plainText(node); if (text) blocks.push({ type: "text", text }); return }
      if (typeof node !== "object") return
      const urls = mediaUrls(node.url_list || node.image?.url_list || node.url || node.src)
      if (urls.length && /image|img|picture/.test(String(node.type || node.tag || ""))) blocks.push({ type: "image", urls })
      else if (typeof node.text === "string") visit(node.text, depth + 1)
      else visit(node.children || node.content || node.body, depth + 1)
    }
    visit(nodes)
    if (!blocks.length) {
      warnings.push("文章正文结构未知，已保留可读内容")
      if (typeof info.article_content === "string" && !Object.keys(content).length) visit(info.article_content)
      for (const image of images) {
        const urls = mediaUrls(image.high_image_url || image.origin_image_url || image.markdown_url)
        if (urls.length) blocks.push({ type: "image", urls })
      }
    }
  }
  return { blocks, cover: mediaUrls(content.head_poster_list)[0], markdown }
}

/** @returns {MediaWork} */
export function normalizeDouyinWork(detail, { source = "web", expectedId } = {}) {
  const id = String(detail?.aweme_id || "")
  if (!/^\d+$/.test(id) || expectedId && id !== expectedId) throw new DouyinError("invalid_detail", "作品详情 ID 不匹配")
  const warnings = source === "ssr" ? ["使用分享页面降级解析，部分统计或清晰度信息可能缺失"] : []
  const images = Array.isArray(detail.images) ? detail.images : []
  const isArticle = detail.aweme_type === 163 || Boolean(detail.article_info)
  const media = images.map((image, index) => {
    const urls = mediaUrls(image)
    const motion = videoSources(image.video || {})
    const type = image.clip_type === 4 && motion.length ? "video" : motion.length || image.clip_type === 5 ? "live_photo" : "image"
    if (!urls.length && !motion.length) warnings.push(`第 ${index + 1} 项缺少媒体地址`)
    if ((type === "live_photo" || image.clip_type === 4) && !motion.length) warnings.push(`第 ${index + 1} 项动态资源缺失，保留静态图`)
    return { index: index + 1, type, urls, sources: motion, width: positive(image.width), height: positive(image.height) }
  })
  const article = isArticle ? articleBlocks(detail.article_info || {}, warnings) : undefined
  const sources = isArticle || images.length ? [] : videoSources(detail.video || {})
  const type = isArticle ? "article" : images.length ? (media.some(item => item.type === "live_photo") ? "live_photo" : "gallery") : "video"
  if (type === "video") media.push({ index: 1, type: "video", sources, urls: [] })
  if (isArticle) {
    media.splice(0, media.length, ...article.blocks.filter(block => block.type === "image").map((block, index) => ({ ...block, index: index + 1, sources: [] })))
    if (!article.blocks.length && detail.desc) article.blocks.push({ type: "text", text: plainText(detail.desc) })
  }
  if ((type === "video" && !sources.length) || (type !== "video" && !isArticle && !media.some(item => item.urls.length || item.sources.length))) {
    throw new DouyinError("no_media", "作品详情缺少可用媒体资源")
  }
  const author = detail.author || {}
  const statistics = detail.statistics || {}
  const createdAt = positive(detail.create_time)
  const title = plainText(detail.article_info?.article_title || detail.preview_title || detail.item_title || detail.desc || `抖音作品 ${id}`)
  return {
    platform: "douyin", id, type, title, desc: plainText(detail.desc), owner: author.nickname || "",
    author: { id: String(author.uid || ""), secUid: author.sec_uid || "", name: author.nickname || "", avatar: mediaUrls(author.avatar_thumb)[0] },
    cover: article?.cover || mediaUrls(detail.video?.origin_cover)[0] || mediaUrls(detail.video?.cover)[0] || media[0]?.urls?.[0] || "",
    url: `https://www.douyin.com/${isArticle ? "article" : images.length ? "note" : "video"}/${id}`,
    createdAt, duration: (positive(detail.video?.duration || detail.duration) || 0) / 1000,
    stat: { like: count(statistics.digg_count), reply: count(statistics.comment_count), favorite: count(statistics.collect_count), share: count(statistics.share_count), view: count(statistics.play_count) },
    music: detail.music ? { id: String(detail.music.id || ""), title: detail.music.title || "", author: detail.music.author || "", urls: mediaUrls(detail.music.play_url), cover: mediaUrls(detail.music.cover_large)[0] } : undefined,
    collection: detail.mix_info ? { id: String(detail.mix_info.mix_id || ""), title: detail.mix_info.mix_name || "" } : undefined,
    isCollection: detail.is_slides === true, media, sources, article, source, warnings,
  }
}
