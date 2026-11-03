import { MihoyoClient } from "../mihoyo/client.js"
import { exchangeStokenCredentials } from "./credentials.js"

export class QrLoginService {
  constructor(options = {}) {
    this.client = options.client || new MihoyoClient(options)
    this.pollIntervalMs = options.pollIntervalMs || 5000
    this.maxPolls = options.maxPolls || 60
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  async create() {
    const res = await this.client.createQrLogin()
    const url = res?.data?.url
    const ticket = res?.data?.ticket || url?.split("ticket=")[1]
    if (!url || !ticket) throw new Error(res?.message || "QR login url is unavailable")
    return {
      url,
      ticket,
      raw: res,
    }
  }

  async waitConfirmed(ticket, events = {}) {
    let scannedNotified = false
    for (let index = 0; index < this.maxPolls; index += 1) {
      await this.sleep(this.pollIntervalMs)
      const res = await this.client.queryQrLoginStatus(ticket)
      if (res?.retcode && res.retcode !== 0) throw new Error(res.message || "QR login expired")

      const status = res?.data?.status || res?.data?.stat
      if (status === "Scanned" && !scannedNotified) {
        scannedNotified = true
        await events.onScanned?.(res)
      }
      if (status === "Confirmed") {
        return this.buildLoginResult(res)
      }
    }
    throw new Error("QR login timeout")
  }

  async buildLoginResult(statusResult) {
    const tokenData = pickToken(statusResult.data?.tokens, ["stoken_v2", "stoken"])
    const stoken = tokenData?.token
    const stuid = statusResult.data?.user_info?.aid
      || statusResult.data?.user_info?.uid
      || statusResult.data?.user_info?.account_id
    const mid = statusResult.data?.user_info?.mid
    if (!stoken || !stuid) {
      logInvalidConfirmedShape(statusResult.data, { hasStoken: Boolean(stoken), hasUid: Boolean(stuid), hasMid: Boolean(mid) })
      throw new Error("QR login result has no stoken")
    }

    const result = await exchangeStokenCredentials(this.client, { stuid, stoken, mid })
    return { ...result, raw: statusResult }
  }
}

function logInvalidConfirmedShape(data, presence) {
  try {
    const tokens = Array.isArray(data?.tokens) ? data.tokens : []
    const knownNames = new Set(["stoken", "stoken_v2", "ltoken", "ltoken_v2", "cookie_token", "cookie_token_v2", "game_token"])
    const shape = {
      ...presence,
      tokenCount: tokens.length,
      dataKeys: ["status", "stat", "tokens", "user_info"].filter(key => Object.hasOwn(data || {}, key)),
      userInfoKeys: ["aid", "uid", "account_id", "mid"].filter(key => Object.hasOwn(data?.user_info || {}, key)),
      tokens: tokens.slice(0, 8).map(item => ({
        keys: ["token", "name", "token_type"].filter(key => Object.hasOwn(item || {}, key)),
        name: knownNames.has(item?.name) ? item.name : item?.name === undefined ? "absent" : "other",
        type: [1, 2, 3, 4, "1", "2", "3", "4"].includes(item?.token_type) ? Number(item.token_type) : item?.token_type === undefined ? "absent" : "other",
      })),
    }
    globalThis.logger?.warn?.(`[Lotus-Plugin] QR confirmed result unsupported: ${JSON.stringify(shape)}`)
  } catch {}
}

export function pickToken(tokens = [], names = []) {
  if (!Array.isArray(tokens)) return null
  // Passport QR responses use token_type=1 for SToken and may have no name.
  // Retain named-response compatibility without guessing another token family.
  if (names.some(name => name === "stoken" || name === "stoken_v2")) {
    const matches = []
    for (const item of tokens) {
      if (!item || typeof item.token !== "string" || !item.token) continue
      const named = names.includes(item.name)
      const typed = item.token_type === 1 || item.token_type === "1"
      if (named && item.token_type !== undefined && !typed) return null
      if (typed && ["ltoken", "ltoken_v2", "cookie_token", "cookie_token_v2", "game_token"].includes(item.name)) return null
      if (named || typed) matches.push(item)
    }
    if (new Set(matches.map(item => item.token)).size !== 1) return null
    return matches[0] || null
  }
  for (const name of names) {
    const token = tokens.find(item => item?.name === name)
    if (token?.token) return token
  }
  return null
}
