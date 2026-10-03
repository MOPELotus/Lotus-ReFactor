import { requestText, DouyinError } from "./http.js"

export const MOBILE_UA = "Mozilla/5.0 (Linux; Android 10; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
const HOSTS = new Set(["douyin.com", "www.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com"])

export function validateDouyinUrl(input) {
  let url
  try { url = new URL(input) } catch { throw new DouyinError("invalid_link", "抖音链接格式无效") }
  if (!HOSTS.has(url.hostname.toLowerCase()) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new DouyinError("invalid_link", "不支持的抖音链接域名")
  }
  url.protocol = "https:"
  return url
}

export function extractDouyinTarget(message = "") {
  const raw = String(message).replace(/\\\//g, "/").replace(/&amp;/g, "&")
  const urls = raw.match(/https?:\/\/(?:[a-z0-9-]+\.)?(?:douyin|iesdouyin)\.com(?![a-z0-9.-])(?:\/[^\s<>"'\\，。！？、；：（）]*)?/gi) || []
  for (const input of urls) {
    const candidate = input.replace(/[，。！？、；：）)\]}]+$/g, "")
    try { return validateDouyinUrl(candidate).href } catch {}
  }
  return ""
}

export function targetFromUrl(input) {
  const url = validateDouyinUrl(input)
  const match = url.pathname.match(/\/(?:share\/)?(video|note|article)\/(\d+)(?:\/|$)/)
  const id = match?.[2] || ["modal_id", "aweme_id", "item_id", "vid"].map(key => url.searchParams.get(key)).find(value => /^\d+$/.test(value || ""))
  return id ? { id, type: match?.[1] || "video", url: url.href } : null
}

export async function resolveDouyinTarget(input, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const extracted = extractDouyinTarget(input)
  if (!extracted) throw new DouyinError("invalid_link", "未找到有效的抖音作品链接")
  let url = validateDouyinUrl(extracted)
  for (let hop = 0; hop <= 5; hop++) {
    const target = targetFromUrl(url.href)
    if (target) return target
    const { response } = await requestText(fetchImpl, url.href, { redirect: "manual", headers: { "User-Agent": MOBILE_UA } }, { timeoutMs })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) break
      url = validateDouyinUrl(new URL(location, url).href)
    } else break
  }
  throw new DouyinError("invalid_link", "短链接未跳转到可识别的抖音作品")
}
