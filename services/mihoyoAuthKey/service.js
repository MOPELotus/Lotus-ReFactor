import { GAME_BIZ, MIHOYO } from "../../core/mihoyo/constants.js"
import { getDs } from "../../core/mihoyo/ds.js"
import { inferServerFromUid } from "../../core/mihoyo/regions.js"
import { requireCnGachaRegion } from "./region.js"
import { loadLoggedInProfile, getProfileLifetime, getProfileSnapshotGuard } from "../../core/config/profile.js"
import { getAccountGeneration } from "../../core/login/account.js"
import { assertLoginProfileUnchanged, refreshAccountAndSync } from "../../core/login/refresh.js"
import { readStokenCredentials } from "../../core/login/credentials.js"
import { cookieUidValues, parseCookieString } from "../../core/mihoyo/cookies.js"

const AUTH_RETCODES = new Set([-100, 10001, 10101, 10102, 10103])
const numericRetcode = value => (typeof value === "number" || (typeof value === "string" && /^-?\d+$/.test(value))) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined

export class AuthKeyService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.loadProfile = options.loadProfile || loadLoggedInProfile
    this.refreshProfile = options.refreshProfile || refreshAccountAndSync
  }

  async getAuthKeyForProfile({ qq, profileId = 1, profile, accountId, onRefreshedProfile, beforeRequest, ...request } = {}) {
    let expected, snapshot
    try {
      const source = profile || await this.loadProfile(String(qq), profileId)
      snapshot = getProfileSnapshotGuard(source)
      expected = structuredClone(source)
    }
    catch { throw new Error("无法读取登录状态，请稍后重试") }
    if (snapshot && (snapshot.qq !== String(qq) || snapshot.profileId !== Number(profileId))) throw new Error("登录账号上下文已变化，请重新发送原指令")
    const expectedGeneration = getAccountGeneration(qq, profileId), expectedLifetime = getProfileLifetime(qq, profileId)
    const current = async () => {
      let latest
      try { latest = await this.loadProfile(String(qq), profileId) }
      catch { throw new Error("登录状态已变化，请重新发送原指令") }
      assertLoginProfileUnchanged(expected, latest, { qq: String(qq), profileId, expectedGeneration: snapshot?.generation, expectedLifetime: snapshot?.lifetime })
      assertLoginProfileUnchanged(expected, latest, { qq: String(qq), profileId, expectedGeneration, expectedLifetime })
      assertStokenIdentity(latest, accountId)
      return latest
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const selected = await current()
      await beforeRequest?.()
      let result
      try { result = await this.getAuthKey({ ...request, profile: selected }) }
      catch (error) {
        await current()
        await beforeRequest?.()
        if (attempt || !AUTH_RETCODES.has(error?.retcode) || error?.status) throw error
        let refreshed
        try { refreshed = await this.refreshProfile(String(qq), profileId, { expectedProfile: selected }) }
        catch (failure) {
          const stopped = new Error(failure?.code === "LOTUS_ACCOUNT_CHANGED" ? "登录账号或设备已变化，请重新发送原指令" : "登录凭据刷新失败，请重新登录后再试")
          if (failure?.code === "LOTUS_ACCOUNT_CHANGED") stopped.code = failure.code
          throw stopped
        }
        await current()
        await onRefreshedProfile?.(refreshed)
        continue
      }
      await current()
      await beforeRequest?.()
      return result
    }
  }

  async getAuthKey({ profile, game = "gs", uid, region, authAppId = "webview_gacha" } = {}) {
    if (!profile?.account?.stoken_cookie) throw new Error("profile has no stoken")
    if (!uid) throw new Error("uid is required")
    const targetRegion = requireCnGachaRegion({ region, uid, game })
    const body = JSON.stringify({
      auth_appid: authAppId,
      game_biz: GAME_BIZ[game] || game,
      game_uid: Number(uid),
      region: targetRegion,
    })

    const res = await this.requestJson(`${MIHOYO.webApi}/binding/api/genAuthKey`, {
      method: "POST",
      headers: {
        "x-rpc-app_version": MIHOYO.appVersion,
        "User-Agent": "okhttp/4.8.0",
        "x-rpc-client_type": "5",
        Referer: "https://app.mihoyo.com",
        Origin: "https://webstatic.mihoyo.com",
        Cookie: profile.account.stoken_cookie,
        DS: getDs(MIHOYO.saltWeb),
        "x-rpc-sys_version": String(profile.device?.android_version || "12"),
        "x-rpc-channel": "mihoyo",
        "x-rpc-device_id": profile.device?.id || "00000000000000000000000000000000",
        ...(profile.device?.id && profile.device?.fp ? { "x-rpc-device_fp": profile.device.fp } : {}),
        "x-rpc-device_name": profile.device?.name || "Lotus Device",
        "x-rpc-device_model": profile.device?.model || "Lotus",
        Host: "api-takumi.mihoyo.com",
        "Content-Type": "application/json",
      },
      body,
    })

    const authkey = res?.data?.authkey
    if (numericRetcode(res?.retcode) !== 0 || typeof authkey !== "string" || !authkey.trim()) {
      const error = new Error("authkey 获取失败，请检查登录状态")
      const code = numericRetcode(res?.retcode)
      if (code !== undefined) error.retcode = code
      throw error
    }
    return {
      authkey,
      region: targetRegion,
      game,
      uid: String(uid),
      authAppId,
    }
  }

  async requestJson(url, options = {}) {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    let response, data
    try {
      response = await this.fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) })
      const text = await response.text()
      data = text ? JSON.parse(text) : null
    } catch { throw new Error("authkey 请求失败，请稍后重试") }
    if (!response.ok) {
      const error = new Error(`authkey request failed: HTTP ${response.status}`)
      error.status = response.status
      const code = numericRetcode(data?.retcode)
      if (code !== undefined) error.retcode = code
      throw error
    }
    return data
  }
}

function assertStokenIdentity(profile, accountId) {
  const account = profile?.account || {}
  const credentials = readStokenCredentials(account)
  const fields = parseCookieString(account.stoken_cookie)
  const cookieFields = parseCookieString(account.cookie)
  const ids = [...cookieUidValues(account.cookie), ...cookieUidValues(account.stoken_cookie), account.ltuid, account.stuid, accountId].filter(Boolean).map(String)
  const mids = [account.mid, ...[fields, cookieFields].flatMap(item => [item.mid, item.stmid_v2, item.ltmid_v2, item.account_mid_v2])].filter(Boolean).map(String)
  if (!credentials.stuid || !fields.stoken || fields.stoken !== credentials.stoken
    || ids.some(id => id !== credentials.stuid) || new Set(mids).size > 1) {
    throw new Error("抽卡凭据账号信息不一致，请重新登录后再试")
  }
}

export function buildGachaLogUrl({ authkey, game = "gs", region } = {}) {
  region = requireCnGachaRegion({ region, game })
  if (game === "sr") {
    const params = new URLSearchParams({
      authkey_ver: "1",
      sign_type: "2",
      auth_appid: "webview_gacha",
      authkey,
      game_biz: "hkrpg_cn",
      gacha_type: "11",
      page: "1",
      size: "5",
      end_id: "0",
      region,
      lang: "zh-cn",
    })
    return `https://public-operation-hkrpg.mihoyo.com/common/gacha_record/api/getGachaLog?${params}`
  }

  const params = new URLSearchParams({
    authkey_ver: "1",
    sign_type: "2",
    auth_appid: "webview_gacha",
    init_type: "301",
    gacha_id: "fecafa7b6560db5f3182222395d88aaa6aaac1bc",
    timestamp: String(Math.floor(Date.now() / 1000)),
    lang: "zh-cn",
    device_type: "mobile",
    plat_type: "ios",
    region,
    authkey,
    game_biz: "hk4e_cn",
    gacha_type: "301",
    page: "1",
    size: "5",
    end_id: "0",
  })
  return `https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog?${params}`
}

export function getServer(uid, game = "gs") {
  return inferServerFromUid(uid, game)
}
