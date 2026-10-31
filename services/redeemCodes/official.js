// Public official APIs only. No account cookie or redemption API is needed.
import { requestOfficialJson } from "./http.js"
import { setTimeout as delay } from "node:timers/promises"

const BBS = "https://bbs-api.mihoyo.com"
const LIVE = "https://api-takumi.mihoyo.com/event/miyolive"

export function versionOf(text) {
  return String(text || "").match(/(?:[vV]\s*)?(\d+\.\d+)\s*(?:版本|更新|前瞻|特别节目)/)?.[1] || ""
}

export function compareVersions(a, b) {
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number)
  return (aa[0] - bb[0]) || (aa[1] - bb[1])
}

export function plainText(value) {
  const raw = String(value || "")
  try {
    const flatten = x => typeof x === "string" ? x : Array.isArray(x) ? x.map(flatten).join("")
      : x && typeof x === "object" ? Object.values(x).map(flatten).join("") : ""
    return stripHtml(flatten(JSON.parse(raw)))
  } catch { return stripHtml(raw) }
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&times;/g, "×")
}

// to_get_time is the release time; never use it to guess an expiry.
export function parseExpiry(text, referenceMs) {
  const datePattern = /(?:(\d{4})\s*[年\-/]\s*)?(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*(?:[:：分]\s*(\d{1,2})\s*秒?)?/g
  // Scope to sentences mentioning codes and expiry, to exclude launch and broadcast dates.
  for (const sentence of plainText(text).split(/[\n。！？]/)) {
    if (!/兑换码/.test(sentence) || !/失效|过期|截止|有效期|有效至|有效时间/.test(sentence)) continue
    // If an official validity range is given, its last date is the deadline.
    for (const match of [...sentence.matchAll(datePattern)].reverse()) {
      const reference = new Date(referenceMs + 8 * 3600000)
      let year = Number(match[1] || reference.getUTCFullYear())
      const month = Number(match[2]), day = Number(match[3]), hour = Number(match[4])
      const minute = Number(match[5] || 0), second = Number(match[6] || 0)
      if (!match[1] && reference.getUTCMonth() === 11 && month === 1) year++
      if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) continue
      const ms = Date.UTC(year, month - 1, day, hour - 8, minute, second)
      const check = new Date(ms + 8 * 3600000)
      if (check.getUTCDate() !== day) continue
      return { ms, text: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}` }
    }
  }
  return null
}

export function activityIds(value) {
  // Structured posts contain JSON-escaped links. Restrict to official livestream pages.
  const raw = JSON.stringify(value).replace(/\\+u0026/gi, "&").replace(/\\+u003d/gi, "=").replace(/\\+/g, "").replace(/&amp;/g, "&")
  return [...raw.matchAll(/(?:webstatic\.mihoyo\.com\/bbs\/event\/live\/index\.html|act\.mihoyo\.com\/[^"\s]*live[^"\s]*)\?[^"\s]*?act_id=([a-zA-Z0-9_-]+)/g)].map(m => m[1])
}

function normalizePost(item) {
  const post = item?.post?.post || item?.post || item
  return post?.post_id ? post : null
}

export class MiyoliveProvider {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.now = options.now || Date.now
    this.directRequest = options.directRequest === false ? null : options.directRequest || (options.fetch ? null : requestOfficialJson)
  }

  async request(url, actId = "") {
    const deadline = Date.now() + 20000
    const headers = { "x-rpc-client_type": "2", "x-rpc-act_id": actId, Referer: "https://www.miyoushe.com/" }
    let body
    try {
      const response = await this.fetch(url, { headers, signal: AbortSignal.timeout(10000) })
      if (!response.ok) {
        const error = new Error(`官方接口 HTTP ${response.status}`)
        error.retryable = response.status >= 500 || response.status === 429
        throw error
      }
      body = await response.json()
    } catch (error) {
      const endpoint = `${new URL(url).hostname}${new URL(url).pathname}`
      const detail = error.cause?.code || error.code || error.message
      if (!this.directRequest || error.retryable === false) throw new Error(`${endpoint}：${detail}`, { cause: error })
      globalThis.logger?.debug?.(`[Lotus-Plugin] 兑换码 ${endpoint} 请求失败（${detail}），改用直连重试`)
      let lastError
      for (const waitMs of [0, 150, 350]) {
        if (waitMs) await delay(waitMs)
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        try {
          body = await this.directRequest(url, { headers, timeoutMs: Math.min(10000, remainingMs) })
          lastError = null
          break
        } catch (retryError) { lastError = retryError }
      }
      if (!body) throw new Error(`${endpoint}：请求及直连重试均失败（${detail}；${lastError?.code || lastError?.message || "超时"}）`, { cause: lastError || error })
    }
    if (body.retcode !== 0 || !body.data) throw new Error(`官方接口：${body.message || body.retcode}`)
    return body.data
  }

  async discover(game, remembered = []) {
    const [homeResult, postsResult] = await Promise.allSettled([
      this.request(`https://bbs-api.miyoushe.com/apihub/api/home/new?gids=${game.gids}&parts=1%2C3%2C4`),
      this.request(`${BBS}/post/wapi/userPost?uid=${game.uid}&size=50&offset=0`),
    ])
    const errors = [homeResult, postsResult].filter(r => r.status === "rejected").map(r => r.reason.message)
    const ids = new Set()
    const navigationIds = new Set()
    if (homeResult.status === "fulfilled") {
      for (const nav of homeResult.value.navigator || []) {
        if (/前瞻|特别节目|直播|兑换码/.test(nav.name || "")) activityIds(nav).forEach(id => { ids.add(id); navigationIds.add(id) })
      }
    }
    const posts = []
    const addPosts = list => {
      for (const item of list || []) {
        const post = normalizePost(item)
        if (!post || String(post.uid) !== game.uid || !/前瞻|特别节目|直播|兑换码/.test(post.subject || "")) continue
        if (!posts.some(p => p.post_id === post.post_id)) posts.push(post)
        activityIds(post).forEach(id => ids.add(id))
      }
    }
    if (postsResult.status === "fulfilled") {
      let page = postsResult.value
      addPosts(page.list)
      // Official accounts can publish many posts between livestreams.
      for (let i = 0; i < 2 && !page.is_last && page.next_offset && !posts.some(p => versionOf(p.subject)); i++) {
        try {
          page = await this.request(`${BBS}/post/wapi/userPost?uid=${game.uid}&size=50&offset=${encodeURIComponent(page.next_offset)}`)
          addPosts(page.list)
        } catch (error) { errors.push(error.message); break }
      }
    }
    // Search only the official author's results. This also recovers older preview links
    // after the homepage entry disappears, without trusting community reposts.
    if (!ids.size && posts.length) {
      const version = posts.map(p => versionOf(p.subject)).filter(Boolean).sort(compareVersions).at(-1)
      if (version) {
        try {
          const search = await this.request(`${BBS}/post/wapi/searchPosts?gids=${game.gids}&keyword=${encodeURIComponent(version + " 前瞻 特别节目")}&size=20&page=1&sort_type=1`)
          addPosts(search.posts || search.list)
        } catch (error) { errors.push(error.message) }
      }
    }
    // A post's full structured content sometimes contains links omitted in the list.
    const newestVersion = posts.map(p => versionOf(p.subject)).filter(Boolean).sort(compareVersions).at(-1) || ""
    const relevant = posts.filter(p => newestVersion && versionOf(p.subject) === newestVersion).slice(0, 5)
    const details = await Promise.allSettled(relevant.map(p => this.request(`${BBS}/post/wapi/getPostFull?post_id=${p.post_id}&gids=${game.gids}&read=0`)))
    for (const result of details) {
      if (result.status !== "fulfilled") continue
      const post = normalizePost(result.value.post)
      if (post && String(post.uid) === game.uid) {
        const i = posts.findIndex(p => p.post_id === post.post_id)
        if (i >= 0) posts[i] = post
        activityIds(post).forEach(id => ids.add(id))
      }
    }
    // On discovery failures, do not present an old remembered activity as current.
    if (homeResult.status === "rejected" || postsResult.status === "rejected") {
      throw new Error(`活动发现不完整：${errors.join("；")}`)
    }
    const candidates = [...new Set([...ids, ...remembered])].slice(0, 12)
    const indexes = await Promise.allSettled(candidates.map(async actId => {
      const data = await this.request(`${LIVE}/index`, actId)
      if (String(data.streamer?.aid) !== game.uid) return null
      return { ...data, actId }
    }))
    if (candidates.some((id, i) => navigationIds.has(id) && indexes[i].status === "rejected")) {
      throw new Error("官方活动详情暂不可用，请稍后重试")
    }
    const activities = indexes.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : [])
      .sort((a, b) => parseOfficialDate(b.live.start) - parseOfficialDate(a.live.start))
    const activity = activities[0]
    if (!activity) {
      if (candidates.length && indexes.some(r => r.status === "rejected")) throw new Error("官方活动详情暂不可用，请稍后重试")
      return { activity: null, posts, newestVersion, activities: [] }
    }
    return { activity, posts, newestVersion, activities: activities.map(a => a.actId) }
  }

  async codes(activity) {
    if (!activity.live.code_ver) return []
    const data = await this.request(`${LIVE}/refreshCode?version=${encodeURIComponent(activity.live.code_ver)}&time=${Math.floor(this.now() / 1000)}`, activity.actId)
    if (!Array.isArray(data.code_list)) throw new Error("官方兑换码列表格式异常")
    return data.code_list
  }
}

export function parseOfficialDate(value) {
  return Date.parse(String(value || "").replace(" ", "T") + "+08:00") || 0
}
