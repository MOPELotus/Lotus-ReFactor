import { MihoyoClient } from "../mihoyo/client.js"
import {
  buildAccountCookie,
  buildStokenCookie,
} from "../mihoyo/cookies.js"

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
    if (!stoken || !stuid) throw new Error("QR login result has no stoken")

    const ltokenRes = await this.client.getLtokenByStoken({ stuid, stoken, mid })
    const ltoken = pickToken(statusResult.data?.tokens, ["ltoken", "ltoken_v2"])?.token
      || ltokenRes?.data?.ltoken
      || ltokenRes?.data?.token?.token

    const ck = await this.client.getCookieTokenByStoken({ stuid, stoken, mid })
    const cookieToken = ck?.data?.cookie_token
    if (!ltoken || !cookieToken) {
      throw new Error(ck?.message || ltokenRes?.message || "failed to exchange stoken")
    }

    return {
      cookie: buildAccountCookie({
        ltuid: stuid,
        ltoken,
        cookieToken,
      }),
      stoken: buildStokenCookie({
        stuid,
        stoken,
        ltoken,
        mid,
      }),
      raw: statusResult,
    }
  }
}

export function pickToken(tokens = [], names = []) {
  if (!Array.isArray(tokens)) return null
  for (const name of names) {
    const token = tokens.find(item => item?.name === name)
    if (token?.token) return token
  }
  return tokens.find(item => item?.token) || null
}
