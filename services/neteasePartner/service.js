import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { resolveData } from "../../core/path.js"

const MODULUS = "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7"
const PUBKEY = "010001"
const NONCE = "0CoJUm6Qyw8W8jud"
const IV = "0102030405060708"

export class NeteasePartnerService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.now = options.now || (() => new Date())
    this.accountsFile = options.accountsFile || resolveData("netease", "accounts.yaml")
    this.logDir = options.logDir || resolveData("logs")
    this.stateFile = options.stateFile || resolveData("netease", "state.yaml")
  }

  async createQrLogin(apiUrl) {
    const base = normalizeApiUrl(apiUrl)
    const keyRes = await this.requestJson(`${base}/login/qr/key?timestamp=${Date.now()}`)
    const key = keyRes?.data?.unikey
    if (!key) throw new Error("网易云二维码 key 获取失败")
    const qrRes = await this.requestJson(`${base}/login/qr/create?key=${encodeURIComponent(key)}&qrimg=true&timestamp=${Date.now()}`)
    const qrimg = qrRes?.data?.qrimg
    if (!qrimg) throw new Error("网易云二维码创建失败")
    return {
      key,
      qrimg,
    }
  }

  async waitQrLogin({ apiUrl, key, qq, timeoutMs = 300000, pollMs = 3000 } = {}) {
    const base = normalizeApiUrl(apiUrl)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const res = await this.requestJson(`${base}/login/qr/check?key=${encodeURIComponent(key)}&timestamp=${Date.now()}`)
      if (res?.code === 803) {
        const cookie = normalizeCookie(res.cookie || "")
        const account = await this.getAccountInfo(base, cookie).catch(() => ({ uid: "", nickname: "网易云账号" }))
        const saved = await this.saveAccount({
          uid: String(account.uid || ""),
          nickname: account.nickname || "网易云账号",
          qq: String(qq || ""),
          cookie,
        })
        return {
          ok: true,
          account: saved,
        }
      }
      if (res?.code === 800) throw new Error("网易云二维码已过期")
      await this.sleep(pollMs)
    }
    throw new Error("网易云二维码登录超时")
  }

  async getAccountInfo(apiUrl, cookie) {
    const res = await this.requestJson(`${apiUrl}/user/account?cookie=${encodeURIComponent(cookie)}&timestamp=${Date.now()}`)
    return {
      uid: res?.profile?.userId || "",
      nickname: res?.profile?.nickname || "网易云账号",
    }
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
      cookie: account.cookie || "",
      updated_at: this.now().toISOString(),
    }
    const index = accounts.findIndex(item => String(item.uid) === String(normalized.uid) && normalized.uid)
    if (index >= 0) accounts[index] = { ...accounts[index], ...normalized }
    else accounts.push(normalized)

    await fs.mkdir(path.dirname(this.accountsFile), { recursive: true })
    await fs.writeFile(this.accountsFile, YAML.stringify({ accounts }), "utf8")
    return normalized
  }

  async executeTask(config = {}, trigger = "手动测试", options = {}) {
    const accounts = await this.loadAccounts()
    const report = {
      trigger,
      time: this.now().toISOString(),
      accounts: [],
    }
    if (!accounts.length) {
      report.accounts.push({
        nickname: "未配置账号",
        total: 0,
        success: 0,
        skip: 0,
        fail: 0,
        details: ["请先使用 #合伙人登录 或写入 data/netease/accounts.yaml。"],
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
    const comments = Array.isArray(config.comments) && config.comments.length ? config.comments : ["打卡支持"]
    const delayMin = Number(config.delay_ms_min ?? 8000)
    const delayMax = Number(config.delay_ms_max ?? 11000)
    const summary = {
      uid: account.uid,
      nickname: account.nickname || `用户_${account.uid}`,
      total: 0,
      success: 0,
      skip: 0,
      fail: 0,
      details: [],
    }
    try {
      if (!account.cookie) throw new Error("未登录")
      const csrf = account.cookie.match(/__csrf=([^;]+)/)?.[1] || ""
      const headers = {
        Cookie: account.cookie,
        Referer: "https://mp.music.163.com/",
      }
      const taskRes = await this.requestJson("https://interface.music.163.com/api/music/partner/daily/task/get", { headers })
      if (taskRes.code !== 200) throw new Error(taskRes.message || "接口异常")
      const taskId = taskRes.data?.id
      const works = [...(taskRes.data?.works || [])]
      const extraRes = await this.requestJson("https://interface.music.163.com/api/music/partner/extra/wait/evaluate/work/list", { headers }).catch(() => null)
      if (extraRes?.code === 200) {
        const extra = (extraRes.data || []).filter(item => !item.completed).slice(0, Number(account.extraCount || 0))
        works.push(...extra.map(item => ({ ...item, isExtra: true })))
      }

      if (!works.length) summary.details.push("今日无评定待办")
      for (const item of works) {
        const work = item.work || item
        const songId = work.id
        const songName = work.name || String(songId)
        summary.total++
        if (item.completed) {
          summary.skip++
          summary.details.push(`${songName}: 已完成`)
          continue
        }
        await this.sleep(randomDelay(delayMin, delayMax))
        const score = weightedScore()
        const payload = {
          taskId,
          workId: songId,
          score,
          tags: `${score}-A-1`,
          customTags: "[]",
          comment: account.comment === false ? "" : comments[Math.floor(Math.random() * comments.length)],
          syncYunCircle: "true",
          syncComment: account.comment === false ? "false" : "true",
          extraScore: "{}",
          source: "mp-music-partner",
          csrf_token: csrf,
        }
        if (item.isExtra) payload.extraResource = "true"
        const cryptoData = weapi(payload)
        const post = await this.requestJson(`https://interface.music.163.com/weapi/music/partner/work/evaluate?csrf_token=${csrf}`, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(cryptoData).toString(),
        })
        if (post.code === 200) {
          summary.success++
          summary.details.push(`${songName}: ${score}分`)
        } else {
          summary.fail++
          summary.details.push(`${songName}: ${post.message || "失败"}`)
        }
      }
    } catch (error) {
      summary.fail++
      summary.details.push(`流程错误: ${error.message}`)
    }
    return summary
  }

  async latestLog() {
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
    const date = this.now()
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`
    const file = path.join(this.logDir, `nep-${stamp}.json`)
    await fs.writeFile(file, JSON.stringify(report, null, 2), "utf8")
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

  async markTaskRun(time = this.now().toISOString()) {
    const date = localDateKey(new Date(time))
    await this.saveState({
      last_run_time: time,
      last_run_date: date,
    })
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

  async requestJson(url, options = {}) {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    const response = await this.fetch(url, options)
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    if (!response.ok) throw new Error(`网易云请求失败 HTTP ${response.status}`)
    return data
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

export function weapi(obj) {
  const text = JSON.stringify(obj)
  const secretKey = crypto.randomBytes(16).map(n => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".charCodeAt(n % 62))
  const params = aesEncrypt(aesEncrypt(text, NONCE, IV), secretKey, IV)
  return {
    params,
    encSecKey: rsaEncrypt(secretKey, PUBKEY, MODULUS),
  }
}

export function buildPartnerItems(report) {
  return (report.accounts || []).map(account => ({
    label: account.nickname || account.uid || "账号",
    value: `总 ${account.total} · 成功 ${account.success} · 跳过 ${account.skip} · 失败 ${account.fail}`,
  }))
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

function aesEncrypt(data, key, iv) {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv))
  return Buffer.concat([cipher.update(data, "utf8"), cipher.final()]).toString("base64")
}

function rsaEncrypt(key, pubKey, mod) {
  const mBig = BigInt(`0x${mod}`)
  const eBig = BigInt(`0x${pubKey}`)
  const kBig = BigInt(`0x${Buffer.from(key).reverse().toString("hex")}`)
  let res = 1n
  let base = kBig
  let exp = eBig
  while (exp > 0n) {
    if (exp % 2n === 1n) res = (res * base) % mBig
    base = (base * base) % mBig
    exp /= 2n
  }
  return res.toString(16).padStart(256, "0")
}

function normalizeApiUrl(value = "http://127.0.0.1:3000") {
  return String(value || "http://127.0.0.1:3000").replace(/\/+$/, "")
}

function weightedScore() {
  const r = Math.floor(Math.random() * 100)
  if (r < 35) return 3
  if (r < 70) return 4
  if (r < 90) return 2
  return 5
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
