import { requestText, DouyinError } from "./http.js"
import { MOBILE_UA } from "./links.js"

/** Balanced JSON scan: braces inside escaped strings do not terminate the object. */
export function extractRouterData(html) {
  const assignment = /window\s*\.\s*_ROUTER_DATA\s*=\s*/g
  let match
  while ((match = assignment.exec(html))) {
    const start = match.index + match[0].length
    if (html[start] !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < html.length; index++) {
      const char = html[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === "{") depth++
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(html.slice(start, index + 1)) } catch { break }
      }
    }
  }
  throw new DouyinError("ssr_structure", "分享页面未找到有效的 _ROUTER_DATA")
}

export function detailFromRouter(router, id) {
  for (const value of Object.values(router?.loaderData || {})) {
    const result = value?.videoInfoRes
    const detail = result?.item_list?.find(item => String(item?.aweme_id || "") === id)
    if (detail) return detail
    const message = String(result?.status_msg || "")
    if (/已删除|不存在|私密|无权|不可见/.test(message)) throw new DouyinError("unavailable", message)
  }
  throw new DouyinError("ssr_empty", "分享页面没有可用的作品详情")
}

export async function fetchSsrDetail(id, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const { response, text } = await requestText(fetchImpl, `https://www.iesdouyin.com/share/video/${id}/`, {
    redirect: "follow", headers: { "User-Agent": MOBILE_UA, Referer: "https://www.douyin.com/" },
  }, { timeoutMs })
  if (!response.ok) throw new DouyinError("ssr_http", `分享页面 HTTP ${response.status}`)
  return detailFromRouter(extractRouterData(text), id)
}
