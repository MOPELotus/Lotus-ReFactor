import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { resolveData } from "../../core/path.js"
import { formatLocalIso } from "../../core/time.js"
import QRCode from "qrcode"
import { TuneWeaveService } from "../tuneweave/service.js"

let taskRunning = null

export class NeteasePartnerService {
  constructor(options = {}) {
    this.tuneweave = options.tuneweave || new TuneWeaveService({ config: options.config, fetch: options.fetch })
    this.scorer = options.scorer || weightedScore
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.now = options.now || (() => new Date())
    this.accountsFile = options.accountsFile || resolveData("netease", "accounts.yaml")
    this.logDir = options.logDir || resolveData("logs")
    this.stateFile = options.stateFile || resolveData("netease", "state.yaml")
  }

  async createQrLogin(qq) {
    await this.tuneweave.requireReady()
    const alias = `lotus-nep-${String(qq).replace(/[^a-zA-Z0-9_-]/g, "_")}`
    const qr = await this.tuneweave.request("/v1/auth/qr", {
      method: "POST", body: { platform: "netease", account: alias, credential_mode: "server" },
    })
    if (!qr.transaction_id || !qr.url) throw new Error("TuneWeave 未返回完整登录二维码。")
    return { key: qr.transaction_id, alias, qrimg: qr.image_data_url || await QRCode.toDataURL(qr.url) }
  }

  async waitQrLogin({ key, alias, qq, timeoutMs = 300000, pollMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await this.tuneweave.request(`/v1/auth/qr/${encodeURIComponent(key)}`)
      if (result.state === "confirmed") {
        if (!result.profile?.authenticated || !result.profile.user_id) throw new Error("TuneWeave 登录未核验账号身份。")
        const account = await this.saveAccount({ uid: result.profile.user_id, nickname: result.profile.nickname, qq, tuneweave_account: alias })
        return { ok: true, account }
      }
      if (["expired", "failed", "verification_required"].includes(result.state)) throw new Error("二维码已过期或需要额外验证，请重新登录。")
      await this.sleep(pollMs)
    }
    throw new Error("网易云二维码登录超时")
  }

  async migrateAccount(account) {
    if (account.tuneweave_account) return account
    if (!account.cookie) throw new Error("请先使用 #合伙人登录。")
    const profile = await this.tuneweave.request("/v1/account?platform=netease&account=default")
    if (!profile?.authenticated || !profile.user_id || (account.uid && String(profile.user_id) !== String(account.uid))) throw new Error("旧账号与 TuneWeave 默认账号不一致，请使用 #合伙人登录。")
    return this.saveAccount({ ...account, uid: profile.user_id, nickname: profile.nickname || account.nickname, tuneweave_account: "default" })
  }

  async partnerApi(account, uri, data = {}, crypto = "weapi") {
    return this.tuneweave.request("/v1/extensions/netease/api", { method: "POST", body: { account: account.tuneweave_account, uri, data, crypto } })
  }

  async loadAccounts() {
    try {
      const raw = await fs.readFile(this.accountsFile, "utf8")
      const data = YAML.parse(raw) || {}
      return Array.isArray(data.accounts) ? data.accounts : []
    } catch (error) {
      if (error?.code === "ENOENT") return []
      throw error
    }
  }

  async saveAccount(account) {
    const accounts = await this.loadAccounts()
    const normalized = {
      uid: String(account.uid || ""),
      nickname: account.nickname || "网易云账号",
      qq: String(account.qq || ""),
      extraCount: Number(account.extraCount ?? 9999),
      comment: account.comment !== false,
      tuneweave_account: account.tuneweave_account || "",
      updated_at: formatLocalIso(this.now()),
    }
    const index = accounts.findIndex(item => (String(item.uid) === String(normalized.uid) && normalized.uid) || (normalized.tuneweave_account && item.tuneweave_account === normalized.tuneweave_account))
    if (index >= 0) accounts[index] = { ...accounts[index], ...normalized }
    else accounts.push(normalized)
    for (const item of accounts) { if (item.tuneweave_account) delete item.cookie }

    await fs.mkdir(path.dirname(this.accountsFile), { recursive: true })
    await fs.writeFile(this.accountsFile, YAML.stringify({ accounts }), { encoding: "utf8", mode: 0o600 })
    await fs.chmod(this.accountsFile, 0o600)
    return normalized
  }

  async executeTask(config = {}, trigger = "手动测试", options = {}) {
    if (taskRunning) return taskRunning
    taskRunning = this.executeTaskInternal(config, trigger, options)
    try { return await taskRunning } finally { taskRunning = null }
  }

  async executeTaskInternal(config = {}, trigger = "手动测试", options = {}) {
    const accounts = await this.loadAccounts()
    const report = {
      trigger,
      time: formatLocalIso(this.now()),
      accounts: [],
    }
    if (!accounts.length) {
      report.accounts.push({
        nickname: "未配置账号",
        total: 0,
        success: 0,
        skip: 0,
        fail: 0,
        details: ["请先使用 #初始化TuneWeave 和 #合伙人登录。"],
      })
      await this.writeLog(report)
      if (options.recordRun) await this.markTaskRun(report.time)
      return report
    }

    for (const account of accounts) {
      report.accounts.push(await this.executeAccount(account, config))
    }
    await this.writeLog(report)
    if (options.recordRun) await this.markTaskRun(report.time)
    return report
  }

  async executeAccount(account, config = {}) {
    const comments = [...new Set((Array.isArray(config.comments) && config.comments.length ? config.comments : ["打卡支持"]).map(text => String(text).trim()).filter(Boolean))]
    const availableComments = [...comments]
    const delayMin = Number(config.delay_ms_min ?? 8000)
    const delayMax = Number(config.delay_ms_max ?? 11000)
    const completed = new Map()
    const pending = new Map()
    const summary = { uid: account.uid, nickname: account.nickname || `用户_${account.uid}`, total: 20, success: 0, skip: 0, fail: 20, attempts: 0, details: [], evaluations: [], results: [] }

    for (let attempt = 1; attempt <= 2 && completed.size < 20; attempt++) {
      summary.attempts = attempt
      if (attempt === 2) {
        summary.details.push("完成数不足 20，重试一轮；已完成作品不重复提交。")
        await this.sleep(randomDelay(delayMin, delayMax))
      }
      try {
        await this.tuneweave.requireReady?.()
        account = await this.migrateAccount(account)
        const identity = await this.tuneweave.request(`/v1/account?platform=netease&account=${encodeURIComponent(account.tuneweave_account)}`)
        if (!identity.authenticated || String(identity.user_id) !== String(account.uid)) throw new Error("TuneWeave 账号与合伙人记录不一致，请重新登录。")
        const taskRes = await this.partnerApi(account, "/api/music/partner/daily/task/get")
        if (taskRes.code !== 200) throw new Error("每日任务读取失败。")
        const works = [...(taskRes.data?.works || [])]
        const extraRes = await this.partnerApi(account, "/api/music/partner/extra/wait/evaluate/work/list").catch(error => {
          summary.details.push(`第 ${attempt} 轮额外任务读取失败：${error.message}`)
          return null
        })
        if (extraRes?.code === 200 && Array.isArray(extraRes.data)) {
          works.push(...extraRes.data.slice(0, Math.min(15, Number(account.extraCount ?? 15))).map(item => ({ ...item, isExtra: true })))
        }
        if (!works.length) summary.details.push(`第 ${attempt} 轮未返回待评作品。`)
        for (const item of works) {
          if (completed.size >= 20) break
          const work = item.work || item
          const id = String(work.id || "")
          if (!id || completed.has(id)) continue
          const name = work.name || id
          const dimensions = resolveExtraScoreDimensions(item, work)
          if (item.completed) {
            const record = { workId: id, name, status: "already_completed", score: item.score ?? null, dimensions, extraScore: Object.fromEntries(dimensions.map(key => [key, item.extraScore?.[key] ?? null])), comment: item.comment || "", attempt }
            completed.set(id, record)
            summary.evaluations.push(record)
            summary.skip++
            summary.details.push(`${name}: 已完成，不重复提交。`)
            continue
          }
          let payload = pending.get(id)
          if (!payload) {
            const score = this.scorer()
            const extraScore = buildExtraScore(dimensions, this.scorer)
            if (!availableComments.length) availableComments.push(...comments)
            const comment = account.comment === false ? "" : availableComments.splice(Math.floor(Math.random() * availableComments.length), 1)[0] || ""
            payload = { taskId: taskRes.data?.id, workId: work.id, score, tags: `${score}-A-1`, customTags: "[]", comment, syncYunCircle: "true", syncComment: comment ? "true" : "false", extraScore: JSON.stringify(extraScore), source: "mp-music-partner" }
            if (item.isExtra) payload.extraResource = "true"
            pending.set(id, payload)
          }
          const record = { workId: id, name, score: payload.score, extraScore: JSON.parse(payload.extraScore), dimensions, comment: payload.comment, commentPosted: Boolean(payload.comment), attempt }
          await this.sleep(randomDelay(delayMin, delayMax))
          try {
            const post = await this.partnerApi(account, "/api/music/partner/work/evaluate", payload)
            if (post.code !== 200) throw new Error(`评分提交未成功（${post.code || "未知状态"}）。`)
            record.status = "success"
            completed.set(id, record)
            summary.evaluations.push(record)
            summary.details.push(`${name}: 主分 ${record.score} · ${formatSubScores(record.extraScore) || "该作品未提供子项"}\n乐评：${record.comment || "未发布"}`)
          } catch (error) {
            record.status = "failed"
            record.error = error.message
            summary.evaluations.push(record)
            summary.details.push(`第 ${attempt} 轮 ${name}: ${error.message}`)
            if (error.message.includes("（405）")) break
          }
        }
      } catch (error) {
        summary.details.push(`第 ${attempt} 轮流程错误: ${error.message}`)
      }
    }
    summary.success = completed.size
    summary.fail = 20 - completed.size
    summary.results = [...completed.values()]
    return summary
  }

  async latestLog() {
    try {
      return JSON.parse(await fs.readFile(path.join(this.logDir, "nep-latest.json"), "utf8"))
    } catch (error) { if (error.code !== "ENOENT") throw error }
    const files = await fs.readdir(this.logDir).catch(error => {
      if (error?.code === "ENOENT") return []
      throw error
    })
    const picked = files.filter(file => file.startsWith("nep-") && file.endsWith(".json")).sort().at(-1)
    if (!picked) return null
    return JSON.parse(await fs.readFile(path.join(this.logDir, picked), "utf8"))
  }

  async writeLog(report) {
    await fs.mkdir(this.logDir, { recursive: true })
    const file = path.join(this.logDir, "nep-latest.json")
    await fs.writeFile(file, JSON.stringify(report, null, 2), "utf8")
    // Keep the latest daily report only; never touch other feature logs.
    const oldFiles = (await fs.readdir(this.logDir)).filter(name => /^nep-\d{12}\.json$/.test(name))
    await Promise.all(oldFiles.map(name => fs.rm(path.join(this.logDir, name), { force: true })))
    return file
  }

  async loadState() {
    try {
      return YAML.parse(await fs.readFile(this.stateFile, "utf8")) || {}
    } catch (error) {
      if (error?.code === "ENOENT") return {}
      throw error
    }
  }

  async saveState(state = {}) {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true })
    await fs.writeFile(this.stateFile, YAML.stringify(state), "utf8")
    return this.stateFile
  }

  async markTaskRun(time = formatLocalIso(this.now())) {
    const date = localDateKey(new Date(time))
    await this.saveState({
      last_run_time: time,
      last_run_date: date,
    })
  }

  async hasRunToday() {
    const state = await this.loadState()
    return state.last_run_date === localDateKey(this.now())
  }

  async shouldCatchUp(config = {}) {
    if (config.enable === false || config.auto_catch_up !== true) return false
    const scheduled = parseDailyCronTime(config.schedule)
    if (!scheduled) return false

    const now = this.now()
    const state = await this.loadState()
    const today = localDateKey(now)
    if (state.last_run_date === today) return false

    const scheduledToday = new Date(now)
    scheduledToday.setHours(scheduled.hour, scheduled.minute, scheduled.second, 0)
    return now > scheduledToday
  }


}

export function parseDailyCronTime(schedule = "") {
  const parts = String(schedule || "").trim().split(/\s+/)
  if (parts.length < 3) return null
  const [second, minute, hour] = parts.map(Number)
  if (![second, minute, hour].every(Number.isInteger)) return null
  if (second < 0 || second > 59 || minute < 0 || minute > 59 || hour < 0 || hour > 23) return null
  return {
    second,
    minute,
    hour,
  }
}

export function buildPartnerItems(report) {
  return (report.accounts || []).map(account => ({
    label: account.nickname || account.uid || "账号",
    value: `成功 ${account.success} · 失败 ${account.fail}`,
  }))
}

export function buildPartnerLogMessages(report) {
  const messages = [`合伙人日志 · ${report.time || ""} · ${report.trigger || ""}`]
  for (const account of report.accounts || []) {
    messages.push(`${account.nickname || account.uid || "账号"}：成功 ${account.success} · 失败 ${account.fail} · 执行 ${account.attempts || 1} 轮`)
    for (const entry of account.evaluations || []) {
      messages.push(`歌曲：${entry.name}\n主分：${entry.score ?? "未返回"}\n子项：${formatSubScores(entry.extraScore) || "该作品未提供子项"}\n乐评：${entry.comment || (entry.status === "already_completed" ? "已完成记录未返回乐评" : "未发布")}\n第 ${entry.attempt} 轮 · ${entry.status === "success" ? "成功" : entry.status === "already_completed" ? "此前已完成" : `失败：${entry.error}`}`)
    }
    messages.push(...(account.details || []).filter(text => /错误|失败|重试|未返回/.test(text)))
  }
  return messages
}

export function buildExtraScore(dimensions = [], scorer = weightedScore) {
  const extraScore = {}
  for (const dimension of normalizeDimensions(dimensions)) {
    const id = dimensionId(dimension)
    if (!id) continue
    extraScore[id] = scorer()
  }
  return extraScore
}

export function resolveExtraScoreDimensions(item = {}, work = {}) {
  const current = collectDimensionIds([work, item], ["supportExtraEvaTypes"])
  if (current.length) return current
  return collectDimensionIds([work, item], ["dimensions"])
}

export function normalizeCookie(rawCookie = "") {
  const skip = new Set(["path", "expires", "max-age", "domain", "httponly", "secure", "samesite"])
  const pairs = new Map()
  for (const part of String(rawCookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (!key || !rest.length || skip.has(key.toLowerCase())) continue
    pairs.set(key, rest.join("="))
  }
  return [...pairs.entries()].map(([key, value]) => `${key}=${value}`).join("; ")
}

function weightedScore() {
  const r = Math.floor(Math.random() * 100)
  if (r < 35) return 3
  if (r < 70) return 4
  if (r < 90) return 2
  return 5
}

function normalizeDimensions(dimensions = []) {
  if (Array.isArray(dimensions)) return dimensions
  if (dimensions && typeof dimensions === "object") return Object.values(dimensions)
  return []
}

function dimensionId(dimension) {
  if (dimension === null || dimension === undefined) return ""
  if (typeof dimension === "string" || typeof dimension === "number") return String(dimension)
  if (typeof dimension !== "object") return ""
  return String(dimension.id ?? dimension.dimensionId ?? dimension.key ?? dimension.name ?? "")
}

function collectDimensionIds(sources, fields) {
  const ids = new Set()
  for (const source of sources) {
    if (!source || typeof source !== "object") continue
    for (const field of fields) {
      for (const dimension of normalizeDimensions(source[field])) {
        const id = dimensionId(dimension)
        if (id) ids.add(id)
      }
    }
  }
  return [...ids]
}

function formatSubScores(extraScore = {}) {
  return Object.entries(extraScore)
    .map(([key, value]) => `${key}:${value}`)
    .join(" / ")
}

function randomDelay(min, max) {
  if (max <= 0) return 0
  if (max <= min) return Math.max(0, min)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pad(value) {
  return String(value).padStart(2, "0")
}

function localDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
