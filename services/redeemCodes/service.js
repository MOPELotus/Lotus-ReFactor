import fs from "node:fs/promises"
import path from "node:path"
import { resolveData } from "../../core/path.js"
import { REDEEM_GAMES } from "./games.js"
import { MiyoliveProvider, compareVersions, versionOf, plainText, parseExpiry, parseOfficialDate } from "./official.js"

export class RedeemCodeService {
  constructor(options = {}) {
    this.now = options.now || Date.now
    this.games = options.games || REDEEM_GAMES
    this.providers = options.providers || { miyolive: new MiyoliveProvider(options) }
    this.historyFile = options.historyFile === false ? null : options.historyFile || resolveData("redeemCodes", "activities.json")
    this.history = null
    this.loading = null
    this.inflight = new Map()
    this.persisting = Promise.resolve()
  }

  async query(gameId) {
    const game = this.games.find(item => item.id === gameId)
    if (!game) throw new Error("尚未接入该游戏的官方兑换码来源")
    if (this.inflight.has(gameId)) return this.inflight.get(gameId)
    const task = this.collect(game).finally(() => this.inflight.delete(gameId))
    this.inflight.set(gameId, task)
    return task
  }

  async collect(game) {
    const base = { game: game.id, gameName: game.name, checkedAt: this.now(), codes: [] }
    try {
      await this.loadHistory()
      const provider = this.providers[game.provider]
      if (!provider) throw new Error("该游戏的官方来源尚未接入")
      const found = await provider.discover(game, this.history[game.id] || [])
      await this.saveHistory(game.id, found.activities || [])
      const { activity, newestVersion, posts } = found
      const version = activity ? versionOf(activity.live.title) : ""
      // Discovering the next preview must invalidate the previous preview immediately,
      // even if its old page and code endpoint are still alive.
      if (activity && newestVersion && (!version || compareVersions(newestVersion, version) > 0)) {
        return { ...base, version: newestVersion, status: "unreleased", title: `${game.name} ${newestVersion} 版本前瞻`, reason: "尚未获取到新版本的官方兑换码，请等待后续公布。" }
      }
      if (!activity) {
        // Expired pages can disappear from navigation and the livestream API.
        // A matching official recap can still give a precise expiry without codes.
        for (const post of posts.filter(p => newestVersion && versionOf(p.subject) === newestVersion).sort((a, b) => b.created_at - a.created_at)) {
          const expiry = parseExpiry(post.structured_content || post.content, Number(post.created_at) * 1000 || this.now())
          if (expiry && expiry.ms <= this.now()) {
            return { ...base, version: newestVersion, title: `${game.name} ${newestVersion} 版本前瞻`, status: "expired", expiry,
              source: `https://www.miyoushe.com/${game.community}/article/${post.post_id}` }
          }
        }
        return { ...base, version: newestVersion, status: "unavailable", reason: "暂未找到当前版本的官方前瞻兑换码页面" }
      }
      let template = activity.template || {}
      if (typeof template === "string") {
        try { template = JSON.parse(template) } catch { template = {} }
      }
      const startMs = parseOfficialDate(activity.live.start)
      const reference = startMs || this.now()
      const pageUrl = `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${activity.actId}`
      let expiry = parseExpiry(template.codeTipText || "", reference)
      let expirySource = expiry ? pageUrl : ""
      if (!expiry && version) {
        for (const post of posts.filter(p => versionOf(p.subject) === version).sort((a, b) => b.created_at - a.created_at)) {
          expiry = parseExpiry(post.structured_content || post.content, reference)
          if (expiry) { expirySource = `https://www.miyoushe.com/${game.community}/article/${post.post_id}`; break }
        }
      }
      const result = { ...base, title: activity.live.title, version, actId: activity.actId, codeVersion: activity.live.code_ver, source: pageUrl, expiry, expirySource }
      if (startMs > this.now() || Number(activity.live.remain) > 0) return { ...result, status: "unreleased", reason: "前瞻尚未开始，兑换码尚未发放" }
      if (expiry && expiry.ms <= this.now()) return { ...result, status: "expired" }
      const entries = await provider.codes(activity)
      const seen = new Set()
      result.codes = entries.filter(item => {
        const code = String(item.code || "").trim()
        if (!code || seen.has(code) || Number(item.to_get_time || 0) * 1000 > this.now()) return false
        seen.add(code)
        return true
      }).map(item => ({ code: String(item.code).trim(), reward: plainText(item.title) }))
      return { ...result, status: result.codes.length ? "available" : "unreleased", reason: result.codes.length ? "" : "官方尚未公布兑换码" }
    } catch (error) {
      globalThis.logger?.warn?.(`[Lotus-Plugin] ${game.name}兑换码查询失败：${error.stack || error.message}`)
      return { ...base, status: "error", reason: error.message }
    }
  }

  async loadHistory() {
    if (this.history) return
    if (!this.loading) this.loading = this.readHistory()
    await this.loading
  }

  async readHistory() {
    if (!this.historyFile) { this.history = {}; return }
    try {
      const parsed = JSON.parse(await fs.readFile(this.historyFile, "utf8"))
      this.history = Object.fromEntries(this.games.map(game => [game.id,
        Array.isArray(parsed?.[game.id]) ? parsed[game.id].filter(id => typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id)).slice(0, 12) : [],
      ]))
    } catch (error) {
      if (error.code !== "ENOENT") globalThis.logger?.warn?.(`[Lotus-Plugin] 兑换码活动记录读取失败：${error.message}`)
      this.history = {}
    }
  }

  async saveHistory(gameId, activities) {
    this.history[gameId] = [...new Set([...activities, ...(this.history[gameId] || [])])].slice(0, 12)
    if (!this.historyFile) return
    this.persisting = this.persisting.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.historyFile), { recursive: true })
      const temporary = `${this.historyFile}.${process.pid}.tmp`
      await fs.writeFile(temporary, JSON.stringify(this.history), "utf8")
      await fs.rename(temporary, this.historyFile)
    })
    // History is a discovery aid; disk errors must not hide valid official results.
    await this.persisting.catch(error => globalThis.logger?.warn?.(`[Lotus-Plugin] 兑换码活动记录保存失败：${error.message}`))
  }
}

export function formatRedeemResult(result) {
  const title = result.title || `${result.gameName}前瞻兑换码`
  if (result.status === "error") return `${title}\n官方来源查询失败，请稍后重试。\n${result.reason}`
  if (result.status === "unavailable") return `${title}\n${result.reason}，请稍后再查。`
  const lines = [title]
  if (result.status === "expired") lines.push("本次前瞻兑换码已过期，请等待下一版本前瞻。")
  else if (result.status === "unreleased") lines.push(result.reason || "兑换码尚未发放。")
  else for (const item of result.codes) lines.push("", item.code, ...(item.reward ? [item.reward] : []))
  if (result.expiry) lines.push("", `有效期至：${result.expiry.text}（北京时间）`)
  else if (result.status === "available") lines.push("", "官方未明确公布失效时间，请及时兑换。")
  if (result.source) lines.push(`官方页面：${result.source}`)
  if (result.expirySource && result.expirySource !== result.source) lines.push(`有效期来源：${result.expirySource}`)
  return lines.join("\n")
}
