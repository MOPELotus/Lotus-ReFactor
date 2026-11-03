import { listProfileIds, loadProfile, getProfileLifetime, getProfileSnapshotGuard } from "../config/profile.js"
import { deviceHeaders } from "../devices/service.js"
import { AccountService, accountChangedError, getAccountGeneration } from "../login/account.js"
import { refreshAccountAndSync, assertLoginProfileUnchanged } from "../login/refresh.js"
import { parseCookieString } from "../mihoyo/cookies.js"
import { getDs2 } from "../mihoyo/ds.js"
import { MIHOYO, MIHOYO_PROTOCOL, mihoyoUserAgent } from "../mihoyo/constants.js"
import {
  inferServerFromUid,
  isCnServer,
  isUnknownServer,
  resolveServer,
  sameServerSide,
} from "../mihoyo/regions.js"
import { solveCaptcha } from "./service.js"
import { captchaVersion } from "./result.js"
import { captchaRequestContext, captchaContextHeaders } from "./requestContext.js"
import { bindMysRequestProfile } from "../../services/intercept/mys-request-context.js"

const CAPTCHA_RETCODES = new Set([1034, 10035])
const TOOL_APP_KEYS = Object.freeze({ sr: "hkrpg_game_record", zzz: "game_record_zzz" })
const COOKIE_REFRESH_RETCODES = new Set([-100, 10001, 10101, 10102, 10103])

export async function solveMysRequestCaptcha({
  e,
  args,
  reject,
  fetchImpl = globalThis.fetch,
  solveCaptchaImpl = solveCaptcha,
  onCaptchaEvent,
  accountService,
} = {}) {
  const { mysApi, res, type, data = {} } = args || {}
  const retcode = Number(res?.retcode)
  if (retcode === 10041) return reject?.()
  if (isCookieRefreshableResponse(res)) {
    return await refreshCookieAndRetry({
      e,
      args,
      reject,
      accountService,
    })
  }
  if (!CAPTCHA_RETCODES.has(retcode)) return reject?.()
  if (!mysApi) return reject?.()
  const requestContext = await mysRequestContext(args)
  if (!knownRecordRequest(requestContext, normalizeCaptchaGame(e?.game || mysApi.game || "gs"))) return reject?.() ?? res
  requireV3BusinessData(res?.data)
  const context = await createMysCaptchaContext(e, mysApi, retcode, requestContext, args?.profileContext)
  const assertCurrent = captchaRequestGuard(context)
  const createChallenge = async () => {
    await assertCurrent()
    const created = await requestCaptchaChallenge(context, fetchImpl)
    await assertCurrent()
    requireV3BusinessData(created?.data)
    if (created?.retcode !== 0 || !created?.data?.gt || !created?.data?.challenge) {
      throw new Error(created?.message || "create captcha challenge failed")
    }
    return created
  }

  const created = await createChallenge()
  const solved = await solveCaptchaImpl(created.data, {
    onCaptchaEvent,
    refreshChallenge: async () => (await createChallenge()).data,
    verifyResult: async (solution, challenge) => {
      requireV3BusinessData(solution)
      requireV3BusinessData(challenge)
      await assertCurrent()
      const verified = await verifyCaptchaChallenge(context, {
        challenge: solution.challenge || challenge.challenge,
        validate: solution.validate || solution.token,
      }, fetchImpl)
      await assertCurrent()
      return captchaVerificationResult(verified)
    },
  })

  if (!solved.ok) {
    return {
      retcode,
      message: solved.reason || "验证码失败",
      data: null,
    }
  }

  const rpcChallenge = solved.verification?.rpcChallenge
  if (!rpcChallenge) throw new Error("验证码尚未完成业务校验")

  if (args?.OnlyGtest) return solved.verification.raw

  await assertCurrent()
  const retryData = {
    ...data,
    headers: {
      ...(data?.headers || {}),
      "x-rpc-challenge": rpcChallenge,
    },
  }
  return mysApi.getData(type, retryData)
}

export function captchaVerificationResult(result) {
  if (!Number.isFinite(result?.retcode)) throw new Error("验证码业务校验响应缺少状态码")
  if (result.retcode !== 0) {
    if (Number(result.retcode) === 10041) throw accountRiskError()
    if (isCookieRefreshableResponse(result)) {
      const error = new Error(`验证码业务身份验证失败（${result.retcode}）：${String(result.message || result.msg || "未提供原因").slice(0, 120)}`)
      error.retcode = result.retcode
      throw error
    }
    return { ok: false, reason: `业务验证码校验未接受（${result.retcode}）：${String(result.message || result.msg || "未提供原因").slice(0, 120)}`, retryable: true, challengeRefresh: true }
  }
  if (!result.data?.challenge) throw new Error("验证码业务校验缺少 challenge")
  return { ok: true, rpcChallenge: result.data.challenge, raw: result }
}

export function isCookieRefreshableResponse(res = {}) {
  const retcode = Number(res?.retcode)
  if (retcode === 10041 || CAPTCHA_RETCODES.has(retcode)) return false
  if (COOKIE_REFRESH_RETCODES.has(retcode)) return true

  const message = String(res?.message || res?.msg || res?.data?.message || "")
  if (!message) return false
  if (/验证码|captcha|geetest|challenge|风控|频繁|visit too frequently/i.test(message)) return false
  return /(cookie|ck|login|登录|登陆|未登录|失效|过期|expired|invalid|please login)/i.test(message)
}

async function mysRequestContext({ mysApi, type, data = {}, res = {}, requestMetadata } = {}) {
  const metadata = requestMetadata || res.requestMetadata || {}
  let url = res.config?.url
  let rebuiltHeaders, rebuiltUrl
  if (typeof mysApi?.getUrl === "function") {
    try {
      const request = await mysApi.getUrl(type, { ...data, headers: { ...(data.headers || {}) } })
      url ||= request?.url
      rebuiltUrl = request?.url
      rebuiltHeaders = request?.headers
    } catch {
      // Some upstream API types cannot rebuild a URL. Missing metadata stays
      // absent; do not issue another account request or invent a trace ID.
    }
  }
  return {
    ...captchaRequestContext({ url, headers: res.headers, requestMetadata: metadata }),
    requestHeaders: metadata.requestHeaders || res.config?.headers || { ...rebuiltHeaders, ...data.headers },
    requestUrl: rebuiltUrl || url || metadata.url || metadata.path,
  }
}

// The record frontends' tool app keys do not apply to sign-in, Passport, BBS
// misc or arbitrary event endpoints. The actual reconstructed URL wins over
// optional reporting metadata; an unknown original route spends no challenge.
function knownRecordRequest(context, game) {
  const value = context.requestUrl || context.path
  if (typeof value !== "string" || !value) return false
  let path
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    let url
    try { url = new URL(value) } catch { return false }
    if (!/^(?:api-takumi(?:-record)?\.mihoyo\.com|act-nap-api\.mihoyo\.com|bbs-api(?:-os)?\.(?:mihoyo\.com|miyoushe\.com|hoyolab\.com)|sg-public-api\.hoyolab\.com|sg-act-nap-api\.hoyolab\.com)$/.test(url.hostname)) return false
    path = url.pathname
  } else path = value.split(/[?#]/, 1)[0]
  const pathGame = /(?:genshin|hk4e)/.test(path) ? "gs" : /(?:hkrpg|starrail)/.test(path) ? "sr" : /(?:zzz|nap)/.test(path) ? "zzz" : ""
  if (pathGame && pathGame !== game) return false
  return /^\/(?:game_record\/|event\/game_record_zzz\/api\/|(?:genshin|hkrpg)\/(?:api|wapi)\/|zzz\/)/.test(path)
}

function captchaRequestGuard(context) {
  const api = context.mysApi, expectedCookie = cookieKey(api.cookie)
  const expectedId = typeof api.device === "string" ? api.device : ""
  const expectedFp = api._device_fp?.data?.device_fp || ""
  const expected = context.profile
  const qq = String(expected?.user?.qq || ""), profileId = Number(expected?.profile?.id || 1)
  const snapshot = expected && getProfileSnapshotGuard(expected)
  const expectedGeneration = snapshot?.generation ?? getAccountGeneration(qq, profileId)
  const expectedLifetime = snapshot?.lifetime ?? getProfileLifetime(qq, profileId)
  return async () => {
    if (cookieKey(api.cookie) !== expectedCookie
      || (typeof api.device === "string" ? api.device : "") !== expectedId
      || (api._device_fp?.data?.device_fp || "") !== expectedFp) throw accountChangedError()
    if (!expected || !qq) return
    let current
    try { current = await loadProfile(qq, profileId) } catch (error) {
      if (error?.code === "ENOENT") throw accountChangedError()
      throw error
    }
    assertLoginProfileUnchanged(expected, current, { qq, profileId, expectedGeneration, expectedLifetime })
    // A captcha belongs to the failed request's exact Cookie. Background token
    // renewal must not silently continue an old proof with a different session.
    if (cookieKey(current?.account?.cookie) !== cookieKey(expected.account?.cookie)) throw accountChangedError()
  }
}

export async function createMysCaptchaContext(e, mysApi, retcode, requestContext, profileContext) {
  const game = normalizeCaptchaGame(e?.game || mysApi.game || "gs")
  const appKey = game === "zzz" ? "game_record_zzz" : game === "sr" ? "hkrpg_game_record" : ""
  const challengeGame = game === "zzz" ? "8" : game === "sr" ? "6" : "2"
  const server = resolveMysApiServer(e, mysApi, game)
  const isCn = isCnServer(server)
  const match = await findProfileForMysApi(e, mysApi, { profileContext, headers: requestContext?.requestHeaders })
  const originalDevice = requestDeviceHeaders(requestContext?.requestHeaders)
  if (originalDevice["User-Agent"]) originalDevice["User-Agent"] = recordUserAgentVersion(originalDevice["User-Agent"], isCn)
  const fallbackFp = mysApi._device_fp?.data?.device_fp
  const cachedDeviceId = typeof mysApi.device === "string" ? mysApi.device : ""
  const originalId = originalDevice["x-rpc-device_id"]
  const originalFp = originalDevice["x-rpc-device_fp"]
  if (cachedDeviceId && fallbackFp && (!originalId || originalId === cachedDeviceId) && (!originalFp || originalFp === fallbackFp)) {
    originalDevice["x-rpc-device_id"] ||= cachedDeviceId
    originalDevice["x-rpc-device_fp"] ||= fallbackFp
  }
  const device = match?.profile?.device
  const profileDevice = deviceHeaders(device)
  // A request can outlive a device change. Keep its actual device tuple; never
  // attach a different profile's FP to the original request's device ID.
  if (originalDevice["x-rpc-device_id"] && originalDevice["x-rpc-device_id"] !== profileDevice["x-rpc-device_id"]) delete profileDevice["x-rpc-device_fp"]
  if (originalDevice["x-rpc-device_fp"] && originalDevice["x-rpc-device_fp"] !== profileDevice["x-rpc-device_fp"] && !originalDevice["x-rpc-device_id"]) delete profileDevice["x-rpc-device_id"]
  const extraHeaders = {
    ...captchaContextHeaders(requestContext),
    "x-rpc-challenge_game": challengeGame,
    ...profileDevice,
    ...originalDevice,
  }

  return {
    retcode,
    game,
    appKey,
    server,
    isCn,
    cookie: mysApi.cookie || "",
    mysApi,
    profile: match?.profile,
    extraHeaders,
  }
}

export async function requestCaptchaChallenge(context, fetchImpl = globalThis.fetch) {
  requireKnownToolContext(context)
  const query = context.retcode === 10035
    ? `is_high=true&app_key=${encodeURIComponent(context.appKey)}`
    : "is_high=true"
  const url = context.retcode === 10035
    ? `${apiHost(context)}event/toolcomsrv/risk/createGeetest?${query}`
    : `${recordHost(context)}game_record/app/card/wapi/createVerification?${query}`
  const result = await requestMysJson(context, fetchImpl, {
    url,
    query,
    body: "",
    headers: context.extraHeaders,
  })
  requireV3BusinessData(result?.data)
  return result
}

export async function verifyCaptchaChallenge(context, solved, fetchImpl = globalThis.fetch) {
  requireKnownToolContext(context)
  requireV3BusinessData(solved)
  if (typeof solved?.challenge !== "string" || !solved.challenge || typeof solved?.validate !== "string" || !solved.validate) {
    throw new Error("业务验证码结果缺少 v3 validate/challenge")
  }
  const bodyData = context.retcode === 10035
    ? {
        geetest_challenge: solved.challenge,
        geetest_validate: solved.validate,
        geetest_seccode: `${solved.validate}|jordan`,
        app_key: context.appKey,
      }
    : {
        geetest_challenge: solved.challenge,
        geetest_validate: solved.validate,
        geetest_seccode: `${solved.validate}|jordan`,
      }
  const body = JSON.stringify(bodyData)
  const url = context.retcode === 10035
    ? `${apiHost(context)}event/toolcomsrv/risk/verifyGeetest`
    : `${recordHost(context)}game_record/app/card/wapi/verifyVerification`

  return requestMysJson(context, fetchImpl, {
    url,
    query: "",
    body,
    method: "POST",
    headers: context.extraHeaders,
  })
}

function normalizeCaptchaGame(value) {
  const game = String(value || "").toLowerCase()
  if (["gs", "genshin", "hk4e", "hk4e_cn"].includes(game)) return "gs"
  if (["sr", "honkai_sr", "hkrpg", "hkrpg_cn"].includes(game)) return "sr"
  if (["zzz", "nap", "nap_cn"].includes(game)) return "zzz"
  return game
}

function requireKnownToolContext(context) {
  if (Number(context.retcode) === 10041) throw accountRiskError()
  if (Number(context.retcode) !== 10035) return
  const expected = TOOL_APP_KEYS[normalizeCaptchaGame(context.game)]
  if (!expected || context.appKey !== expected) {
    throw new Error("该游戏的 toolcomsrv 验证 app_key 尚未核实，已停止识别")
  }
}

function accountRiskError() {
  const error = new Error("当前账号存在风险（10041），请在官方客户端处理后重试")
  error.retcode = 10041
  return error
}

function requireV3BusinessData(data) {
  if (captchaVersion(data) === 4) throw new Error("该业务的 Geetest v4 校验协议尚未核实，已停止识别")
}

async function requestMysJson(context, fetchImpl, request) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable")
  const headers = buildMysHeaders(context, request.query, request.body)
  const response = await fetchImpl(request.url, {
    method: request.method || (request.body ? "POST" : "GET"),
    headers: mergeRequestHeaders(headers, request.headers, { Cookie: context.cookie }),
    body: request.body || undefined,
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch {
    if (response.ok) throw new Error("验证码接口返回无效 JSON")
  }
  if (!response.ok) {
    const error = new Error(`captcha request failed: HTTP ${response.status}`)
    error.data = data
    throw error
  }
  return data
}

function buildMysHeaders(context, query = "", body = "") {
  const mysApi = context.mysApi
  if (shouldTrustMysHeaders(context) && typeof mysApi?.getHeaders === "function") {
    const headers = mysApi.getHeaders.length >= 3 ? mysApi.getHeaders("", query, body) : mysApi.getHeaders(query, body)
    const protocol = context.isCn ? MIHOYO_PROTOCOL.bbsCn : MIHOYO_PROTOCOL.hoyolab
    const previousUa = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === "user-agent")?.[1]
    const device = context.profile?.device
    const userAgent = device?.model || device?.android_version
      ? mihoyoUserAgent(device, !context.isCn)
      : typeof previousUa === "string" ? recordUserAgentVersion(previousUa, context.isCn) : undefined
    // These helpers only dispatch the verified record/tool captcha APIs.
    // Their existing DS2 signature and client type remain protocol-specific.
    return mergeRequestHeaders(headers, { "x-rpc-app_version": protocol.version, ...(userAgent ? { "User-Agent": userAgent } : {}) })
  }
  return buildLotusMysHeaders(context, query, body)
}

function apiHost(context) {
  return context.isCn ? "https://api-takumi.mihoyo.com/" : "https://sg-public-api.hoyolab.com/"
}

function recordHost(context) {
  return context.isCn ? "https://api-takumi-record.mihoyo.com/" : "https://bbs-api-os.hoyolab.com/"
}

function resolveMysApiServer(e, mysApi, game) {
  const explicit = mysApi?.server || e?.server || e?.region || e?.mysServer || ""
  return resolveServer({
    server: explicit,
    uid: mysApi?.uid || e?.uid,
    game,
    fallback: inferServerFromUid(mysApi?.uid || e?.uid || "", game),
  })
}

function shouldTrustMysHeaders(context) {
  const server = context.mysApi?.server || ""
  if (isUnknownServer(server)) return false
  return sameServerSide(context.server, server)
}

function buildLotusMysHeaders(context, query = "", body = "") {
  const cn = context.isCn
  return {
    "x-rpc-app_version": cn ? MIHOYO_PROTOCOL.bbsCn.version : MIHOYO_PROTOCOL.hoyolab.version,
    "x-rpc-client_type": cn ? "5" : "2",
    "User-Agent": mihoyoUserAgent(context.profile?.device, !cn),
    Referer: cn ? "https://webstatic.mihoyo.com/" : "https://act.hoyolab.com/",
    DS: getDs2(query, body, cn
      ? MIHOYO_PROTOCOL.bbsCn.x4Salt
      : MIHOYO_PROTOCOL.hoyolab.salt),
  }
}

async function refreshCookieAndRetry({
  e,
  args,
  reject,
  accountService,
} = {}) {
  const { mysApi, type, data = {} } = args || {}
  if (!mysApi || !type || typeof mysApi.getData !== "function") return reject?.()

  const originalCookie = cookieKey(mysApi.cookie)
  const requestContext = await mysRequestContext(args)
  const match = await findProfileForMysApi(e, mysApi, { profileContext: args?.profileContext, headers: requestContext.requestHeaders })
  if (!match || cookieKey(match.profile.account?.cookie) !== originalCookie) return reject?.()
  const originalDevice = requestDeviceHeaders(requestContext.requestHeaders)
  const replayHeaders = typeof data.headers?.entries === "function" ? Object.fromEntries(data.headers.entries()) : { ...data.headers }
  const cookieHeaders = Object.keys(replayHeaders).filter(key => key.toLowerCase() === "cookie")
  // Only advance a caller override that belonged to this exact request login.
  // A foreign or conflicting Cookie must not be replaced by profile credentials.
  if (cookieHeaders.some(key => typeof replayHeaders[key] !== "string" || cookieKey(replayHeaders[key]) !== originalCookie)) return reject?.()

  try {
    const service = accountService || new AccountService()
    const profile = await refreshAccountAndSync(match.qq, match.profileId, { accountService: service, expectedProfile: match.profile })
    const cookie = profile?.account?.cookie
    if (!cookie || cookieKey(mysApi.cookie) !== originalCookie || !profileMatchesCookie(profile, mysApi.cookie)) return reject?.()
    if ((profile.user?.qq && String(profile.user.qq) !== match.qq) || (profile.profile?.id && Number(profile.profile.id) !== Number(match.profileId))) return reject?.()
    if (["id", "fp"].some(key => String(profile.device?.[key] || "") !== String(match.profile.device?.[key] || ""))) return reject?.()
    const previousCookie = mysApi.cookie
    mysApi.cookie = cookie
    try { bindMysRequestProfile(mysApi, profile) } catch (error) { mysApi.cookie = previousCookie; throw error }
    if (mysApi.apiTool) mysApi.apiTool.cookie = cookie
    if (cookieHeaders.length) {
      for (const key of cookieHeaders) delete replayHeaders[key]
      replayHeaders.Cookie = cookie
    }
    globalThis.logger?.mark?.(`[Lotus-Plugin] CK expired, refreshed profile ${match.profileId} and retry ${type}`)
    return await mysApi.getData(type, { ...data, headers: mergeRequestHeaders(replayHeaders, originalDevice) })
  } catch {
    globalThis.logger?.warn?.("[Lotus-Plugin] refresh expired CK failed; original request retained")
    return reject?.()
  }
}

async function findProfileForMysApi(e, mysApi, { profileContext, headers } = {}) {
  const owner = String(e?.user_id || "")
  const hint = profileContext || e?.lotusProfileContext
  if (hint) {
    const id = Number(hint.profileId)
    if (!owner || String(hint.qq || "") !== owner || !Number.isInteger(id) || id < 1 || id > 255) throw new Error("请求的 profile 归属不匹配，已停止操作")
    const profile = await loadProfile(owner, id)
    if (!profileMatchesCookie(profile, mysApi.cookie)) throw new Error("请求的 CK 与 profile 账号身份不匹配，已停止操作")
    return { qq: owner, profileId: id, profile }
  }
  if (!owner || !cookieIdentity(mysApi.cookie).uid) return null
  const matches = []
  for (const profileId of await listProfileIds(owner)) {
    const profile = await loadProfile(owner, profileId).catch(() => null)
    // A matching UID is insufficient: another profile can have a different
    // login generation or device. Unscoped requests need their own complete CK.
    if (profile && profileMatchesCookie(profile, mysApi.cookie) && cookieKey(profile.account?.cookie) === cookieKey(mysApi.cookie)) matches.push({ qq: owner, profileId, profile })
  }
  if (matches.length === 1) return matches[0]
  const original = requestDeviceHeaders(headers)
  const fields = [["x-rpc-device_id", "id"], ["x-rpc-device_fp", "fp"]].filter(([header]) => original[header])
  const byDevice = fields.length ? matches.filter(({ profile }) => fields.every(([header, field]) => String(profile.device?.[field] || "") === original[header])) : []
  return byDevice.length === 1 ? byDevice[0] : null
}

function cookieFields(cookie) {
  return cookie && typeof cookie === "object" ? cookie : parseCookieString(cookie)
}

function cookieKey(cookie) {
  return JSON.stringify(Object.entries(cookieFields(cookie)).filter(([, value]) => value !== undefined && value !== null && String(value) !== "").map(([key, value]) => [key, String(value)]).sort(([a], [b]) => a.localeCompare(b)))
}

function cookieIdentity(cookie) {
  const fields = cookieFields(cookie)
  const unique = keys => [...new Set(keys.map(key => fields[key]).filter(value => value !== undefined && value !== null && String(value).trim()).map(value => String(value).trim()))]
  const uids = unique(["stuid", "uid", "ltuid", "ltuid_v2", "account_id", "account_id_v2"])
  const mids = unique(["mid", "stmid_v2", "ltmid_v2", "account_mid_v2"])
  return { uid: uids.length === 1 ? uids[0] : "", mid: mids[0] || "", valid: uids.length === 1 && mids.length <= 1 }
}

function profileMatchesCookie(profile, cookie) {
  const original = cookieIdentity(cookie), account = profile?.account || {}, current = cookieIdentity(account.cookie)
  const ids = [account.stuid, account.ltuid, current.uid].filter(value => value !== undefined && value !== null && String(value).trim()).map(String)
  const mids = [account.mid, current.mid].filter(Boolean).map(String)
  return original.valid && current.valid && ids.length > 0 && ids.every(id => id === original.uid)
    && (!original.mid || mids.every(mid => mid === original.mid)) && new Set(mids).size <= 1
}

function requestDeviceHeaders(headers) {
  const allowed = new Set(["x-rpc-device_id", "x-rpc-device_fp", "x-rpc-device_name", "x-rpc-device_model", "x-rpc-sys_version", "user-agent"])
  const entries = typeof headers?.entries === "function" ? [...headers.entries()] : Object.entries(headers || {})
  return Object.fromEntries(entries.filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === "string" && value.trim()).map(([key, value]) => [key.toLowerCase() === "user-agent" ? "User-Agent" : key.toLowerCase(), value]))
}

function mergeRequestHeaders(...layers) {
  const result = {}
  for (const layer of layers) for (const [key, value] of Object.entries(layer || {})) {
    for (const previous of Object.keys(result)) if (previous.toLowerCase() === key.toLowerCase()) delete result[previous]
    result[key] = value
  }
  return result
}

function recordUserAgentVersion(value, isCn) {
  const protocol = isCn ? MIHOYO_PROTOCOL.bbsCn : MIHOYO_PROTOCOL.hoyolab
  return value.replace(/miHoYoBBS(?:Oversea)?\/[\d.]+/g, `${isCn ? "miHoYoBBS" : "miHoYoBBSOversea"}/${protocol.version}`)
}
