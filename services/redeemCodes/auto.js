import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { resolveData } from "../../core/path.js"
import { listAllProfiles, loadProfile } from "../../core/config/profile.js"
import { createProfileRequestGuard } from "../../core/login/requestGuard.js"
import { parseAccountCookie, parseCookieString, cookieUidValues, serializeCookie } from "../../core/mihoyo/cookies.js"
import { notifyProfile } from "../../core/transport/notify.js"
import { MiyousheClient } from "../miyoushe/client.js"
import { AUTO_REDEEM_GAMES } from "./games.js"

const busyKey = Symbol.for("lotus-plugin.automatic-preview-redemption")
const cookieKeys = new Set(["account_id", "cookie_token", "ltuid", "ltoken", "account_id_v2", "cookie_token_v2", "account_mid_v2", "ltuid_v2", "ltoken_v2", "ltmid_v2", "mid"])
const validCode = code => typeof code === "string" && /^[\p{L}\p{N}_-]{1,64}$/u.test(code)

function previewExpired(result, now) {
  return result.expiry != null && !(Number.isFinite(result.expiry.ms) && result.expiry.ms > now)
}

export function completePreview(result, game, now) {
  return result?.status === "available" && /^\d+\.\d+$/.test(result.version)
    && Boolean(result.actId) && !previewExpired(result, now)
    && Array.isArray(result.codes) && result.codes.length >= game.count
    && result.codes.every(({ code }) => validCode(code))
    && new Set(result.codes.map(({ code }) => code.toLowerCase())).size === result.codes.length
}

function accountCredentials(profile) {
  const raw = profile.account?.cookie || ""
  const account = parseAccountCookie(raw)
  if (!/^\d+$/.test(account.account_id) || !account.cookie_token || cookieUidValues(raw).some(id => id !== account.account_id)
    || [profile.account?.stuid, profile.account?.ltuid].some(id => id && String(id) !== account.account_id)) return null
  const fields = Object.fromEntries(Object.entries(parseCookieString(raw)).filter(([key]) => cookieKeys.has(key)))
  if (Object.values(fields).some(value => /[;\r\n]/u.test(value))) return null
  return { id: account.account_id, cookie: serializeCookie(fields) }
}

export function selectRedeemRole(roles, game, selected) {
  const candidates = (roles || []).filter(role => game.regions.includes(role.region) && /^\d+$/.test(String(role.game_uid)))
  if (selected) return candidates.find(role => String(role.game_uid) === String(selected))
  return candidates.length === 1 ? candidates[0] : undefined
}

function redeemResult(result) {
  const known = { "-2001": "兑换码已过期", "-2003": "兑换码无效", "-2016": "操作冷却中", "-1071": "登录已失效", "-1033": "登录验证失败", "-1035": "需要安全验证" }
  if (/已(?:被)?(?:使用|兑换|领取)|重复兑换|already.{0,16}(?:redeem|use)/i.test(String(result?.data?.msg || result?.message || ""))) return { text: "已使用" }
  if (result?.retcode === 0) return { text: "使用成功" }
  if (!Number.isInteger(result?.retcode)) return { text: "结果未确认，请到游戏内检查", stop: true }
  const code = result.retcode
  return { text: known[code] || `使用失败（${code}）`, stop: [-2016, -1071, -1033, -1035].includes(code) || !known[code] }
}

export class AutoPreviewRedeem {
  constructor({ lookup, fetch = globalThis.fetch, client = new MiyousheClient({ fetch }), profiles = listAllProfiles, readProfile = loadProfile,
    notify = notifyProfile, now = Date.now, journal = resolveData("redeemCodes", "auto.json") }) {
    Object.assign(this, { lookup, fetch, client, profiles, readProfile, notify, now, journal })
    this.nextLookup = new Map()
  }

  async run() {
    if (globalThis[busyKey]) return
    globalThis[busyKey] = true
    try { return await this.scan() } finally { delete globalThis[busyKey] }
  }

  async save(journal) {
    await fs.mkdir(path.dirname(this.journal), { recursive: true, mode: 0o700 })
    const temp = `${this.journal}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify(journal), { mode: 0o600, flag: "wx" })
      await fs.rename(temp, this.journal)
    } finally { await fs.rm(temp, { force: true }) }
  }

  async scan() {
    const profiles = (await this.profiles({ skipInvalid: true })).filter(p => p.auto_redeem?.enable && p.account?.cookie && p.auto_redeem.games.length)
    if (!profiles.length) return
    const journal = JSON.parse(await fs.readFile(this.journal, "utf8").catch(error => {
      if (error.code === "ENOENT") return "{}"
      throw error
    }))
    if (!journal || Array.isArray(journal) || typeof journal !== "object") throw new Error("自动兑换记录格式无效")
    for (const [id, game] of Object.entries(AUTO_REDEEM_GAMES)) {
      const subscribers = profiles.filter(p => p.auto_redeem.games.includes(id))
      if (!subscribers.length || (this.nextLookup.get(id) || 0) > this.now()) continue
      const result = await this.lookup.query(id)
      const now = this.now()
      if (result.startAt > now) this.nextLookup.set(id, Math.min(result.startAt, now + 60 * 60_000))
      else if (["expired", "unavailable"].includes(result.status)) this.nextLookup.set(id, now + 30 * 60_000)
      if (!completePreview(result, game, this.now())) continue
      for (const snapshot of subscribers) {
        if (previewExpired(result, this.now())) break
        try { await this.redeemProfile(journal, snapshot, id, game, result) }
        catch (error) { globalThis.logger?.warn?.(`[Lotus-Plugin] 前瞻自动兑换未完成：${error?.code || error?.name || "unknown"}`) }
      }
    }
  }

  async redeemProfile(journal, snapshot, id, game, result) {
    const qq = String(snapshot.user.qq), profileId = Number(snapshot.profile.id)
    const profile = await this.readProfile(qq, profileId)
    if (!profile.auto_redeem?.enable || !profile.auto_redeem.games.includes(id)) return
    const credentials = accountCredentials(profile)
    if (!credentials) return
    const selected = String(profile.account.current_uid?.[id] || "")
    const batchKey = value => createHash("sha256").update(JSON.stringify([credentials.id, id, result.version, value])).digest("hex")
    // Remember the implicit role as well, to avoid a roles API call on every poll.
    if (!selected && journal[batchKey("implicit")]) return
    if (selected && journal[batchKey(selected)]) return
    const validate = createProfileRequestGuard(profile, { qq, profileId, loadProfile: this.readProfile })
    const roles = this.client.assert(await this.client.request("https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie", profile, {
      params: { game_biz: game.biz }, web: true, captcha: false, beforeRequest: validate,
    })).list
    const role = selectRedeemRole(roles, game, selected)
    if (!role) return
    const uid = String(role.game_uid), key = batchKey(uid)
    if (journal[key] || previewExpired(result, this.now())) return
    const record = journal[key] = { time: this.now(), status: "started" }
    if (!selected) journal[batchKey("implicit")] = record
    // A request may actually succeed before a timeout or restart. Reserve this
    // batch before the first request and never replay an uncertain submission.
    await this.save(journal)
    const lines = []
    let stopped = false
    for (const { code } of result.codes) {
      if (stopped || previewExpired(result, this.now())) { lines.push(`${code}：未提交`); continue }
      try {
        const current = await this.readProfile(qq, profileId)
        if (!current.auto_redeem?.enable || !current.auto_redeem.games.includes(id) || String(current.account.current_uid?.[id] || "") !== selected) throw new Error("settings changed")
        await validate({ profile })
      } catch {
        lines.push(`${code}：账号或设置已变化，未提交`)
        stopped = true
        continue
      }
      if (previewExpired(result, this.now())) { lines.push(`${code}：兑换码已过期，未提交`); stopped = true; continue }
      try {
        const url = new URL(`https://${game.host}/common/apicdkey/api/webExchangeCdkey`)
        url.search = new URLSearchParams({ cdkey: code, game_biz: game.biz, region: role.region, uid, lang: "zh-cn", t: String(this.now()) })
        const response = await this.fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
          headers: { Cookie: credentials.cookie, Referer: "https://webstatic.mihoyo.com/", Accept: "application/json" } })
        if (!response.ok) await response.body?.cancel().catch(() => {})
        const row = response.ok ? redeemResult(await response.json()) : { text: `使用失败（HTTP ${response.status}）`, stop: true }
        lines.push(`${code}：${row.text}`)
        stopped = Boolean(row.stop)
      } catch {
        lines.push(`${code}：结果未确认，请到游戏内检查`)
        stopped = true
      }
    }
    record.status = "finished"
    await this.save(journal)
    await this.notify(profile, `${result.gameName} ${result.version} 前瞻 · Profile ${profileId} (UID: ${uid})\n${lines.join("\n")}`)
  }
}
