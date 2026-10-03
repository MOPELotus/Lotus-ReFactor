import { WEB_UA, generateABogus } from "./signature.js"
import { requestText, DouyinError } from "./http.js"
import { signVisitorUrl } from "./guest-signature.js"

export function buildDetailUrl(id, { sign = generateABogus, now = Date.now() } = {}) {
  const params = new URLSearchParams({
    device_platform: "webapp", aid: "6383", channel: "channel_pc_web", aweme_id: id,
    pc_client_type: "1", version_code: "190500", version_name: "19.5.0", cookie_enabled: "true",
    screen_width: "1920", screen_height: "1080", browser_language: "zh-CN", browser_platform: "Win32",
    browser_name: "Chrome", browser_version: "146.0.0.0", browser_online: "true", engine_name: "Blink",
    engine_version: "146.0.0.0", os_name: "Windows", os_version: "10", cpu_core_num: "8", device_memory: "8", platform: "PC",
    timestamp: String(Math.floor(now / 1000)),
  })
  const query = params.toString()
  return `https://www.douyin.com/aweme/v1/web/aweme/detail/?${query}&a_bogus=${encodeURIComponent(sign(query, { userAgent: WEB_UA, now }))}`
}

export async function fetchWebDetail(id, visitor, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, sign, now = Date.now() } = {}) {
  const session = typeof visitor === "string" ? { ttwid: visitor } : visitor
  const detailUrl = buildDetailUrl(id, { sign, now })
  const request = session?.uifid ? signVisitorUrl(detailUrl, session.uifid, { now }) : { url: detailUrl, headers: {} }
  const { response, text } = await requestText(fetchImpl, request.url, {
    redirect: "error", headers: { "User-Agent": WEB_UA, Referer: "https://www.douyin.com/", "Accept-Language": "zh-CN,zh;q=0.9", Cookie: `ttwid=${session?.ttwid || ""};`, ...request.headers },
  }, { timeoutMs })
  if (!response.ok) {
    if (/ArgusSecurityPlugin|Uifid Not Found/i.test(text)) throw new DouyinError("risk_control", "抖音风控要求额外游客校验")
    throw new DouyinError("api_http", `抖音作品接口 HTTP ${response.status}`)
  }
  let data
  try { data = JSON.parse(text) } catch { throw new DouyinError("api_empty", "抖音作品接口返回空数据或非 JSON") }
  const message = String(data.status_msg || data.message || "")
  if (data.status_code !== 0) {
    if (/已删除|不存在|私密|无权|不可见/.test(message)) throw new DouyinError("unavailable", message)
    throw new DouyinError("api_rejected", "抖音作品接口拒绝请求或遭遇风控")
  }
  if (!data.aweme_detail || String(data.aweme_detail.aweme_id || "") !== id) throw new DouyinError("api_empty", "接口未返回匹配的作品详情")
  return data.aweme_detail
}
