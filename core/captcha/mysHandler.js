import { listProfileIds, loadProfile } from "../config/profile.js"
import { deviceHeaders } from "../devices/service.js"
import { parseCookieString } from "../mihoyo/cookies.js"
import { getDs2 } from "../mihoyo/ds.js"
import { MIHOYO } from "../mihoyo/constants.js"
import {
  inferServerFromUid,
  isCnServer,
  isUnknownServer,
  resolveServer,
  sameServerSide,
} from "../mihoyo/regions.js"
import { solveCaptcha } from "./service.js"

const CAPTCHA_RETCODES = new Set([1034, 10035, 10041])

export async function solveMysRequestCaptcha({
  e,
  args,
  reject,
  fetchImpl = globalThis.fetch,
  solveCaptchaImpl = solveCaptcha,
  onCaptchaEvent,
} = {}) {
  const { mysApi, res, type, data = {} } = args || {}
  const retcode = Number(res?.retcode)
  if (!CAPTCHA_RETCODES.has(retcode)) return reject?.()
  if (!mysApi) return reject?.()

  const context = await createMysCaptchaContext(e, mysApi, retcode)
  const createChallenge = async () => {
    const created = await requestCaptchaChallenge(context, fetchImpl)
    if (created?.retcode !== 0 || !created?.data?.gt) {
      throw new Error(created?.message || "create captcha challenge failed")
    }
    return created
  }

  const created = await createChallenge()
  const solved = await solveCaptchaImpl(created.data, {
    onCaptchaEvent,
    refreshChallenge: async () => (await createChallenge()).data,
  })

  if (!solved.ok) {
    return {
      retcode,
      message: solved.reason || "验证码失败",
      data: null,
    }
  }

  const verified = await verifyCaptchaChallenge(context, {
    challenge: solved.challenge || created.data.challenge,
    validate: solved.validate || solved.token,
  }, fetchImpl)
  const rpcChallenge = verified?.data?.challenge
  if (!rpcChallenge) {
    return {
      retcode,
      message: verified?.message || "验证码校验失败",
      data: null,
    }
  }

  if (args?.OnlyGtest) return verified

  const retryData = {
    ...data,
    headers: {
      ...(data?.headers || {}),
      "x-rpc-challenge": rpcChallenge,
    },
  }
  return mysApi.getData(type, retryData)
}

export async function createMysCaptchaContext(e, mysApi, retcode) {
  const game = e?.game || mysApi.game || "gs"
  const appKey = game === "zzz" ? "game_record_zzz" : game === "sr" ? "hkrpg_game_record" : ""
  const challengeGame = game === "zzz" ? "8" : game === "sr" ? "6" : "2"
  const server = resolveMysApiServer(e, mysApi, game)
  const isCn = isCnServer(server)
  const device = await findProfileDevice(e, mysApi)
  const extraHeaders = {
    "x-rpc-challenge_game": challengeGame,
    ...deviceHeaders(device),
  }

  const fallbackFp = mysApi._device_fp?.data?.device_fp
  if (!extraHeaders["x-rpc-device_fp"] && fallbackFp) {
    extraHeaders["x-rpc-device_fp"] = fallbackFp
  }

  return {
    retcode,
    game,
    appKey,
    server,
    isCn,
    cookie: mysApi.cookie || "",
    mysApi,
    extraHeaders,
  }
}

export async function requestCaptchaChallenge(context, fetchImpl = globalThis.fetch) {
  const query = context.retcode === 10035
    ? `is_high=true&app_key=${encodeURIComponent(context.appKey)}`
    : "is_high=true"
  const url = context.retcode === 10035
    ? `${apiHost(context)}event/toolcomsrv/risk/createGeetest?${query}`
    : `${recordHost(context)}game_record/app/card/wapi/createVerification?${query}`
  return requestMysJson(context, fetchImpl, {
    url,
    query,
    body: "",
    headers: context.extraHeaders,
  })
}

export async function verifyCaptchaChallenge(context, solved, fetchImpl = globalThis.fetch) {
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

async function requestMysJson(context, fetchImpl, request) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable")
  const headers = buildMysHeaders(context, request.query, request.body)
  const response = await fetchImpl(request.url, {
    method: request.method || (request.body ? "POST" : "GET"),
    headers: {
      ...headers,
      ...(request.headers || {}),
      Cookie: context.cookie,
    },
    body: request.body || undefined,
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
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
    if (mysApi.getHeaders.length >= 3) return mysApi.getHeaders("", query, body)
    return mysApi.getHeaders(query, body)
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
    "x-rpc-app_version": MIHOYO.appVersion,
    "x-rpc-client_type": cn ? "5" : "2",
    "User-Agent": cn
      ? `Mozilla/5.0 (Linux; Android 12; Lotus) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.73 Mobile Safari/537.36 miHoYoBBS/${MIHOYO.appVersion}`
      : `Mozilla/5.0 (Linux; Android 11; Lotus) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.179 Mobile Safari/537.36 miHoYoBBSOversea/${MIHOYO.appVersion}`,
    Referer: cn ? "https://webstatic.mihoyo.com/" : "https://act.hoyolab.com/",
    DS: getDs2(query, body, cn
      ? "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs"
      : "okr4obncj8bw5a65hbnn5oo6ixjc3l9w"),
  }
}

async function findProfileDevice(e, mysApi) {
  const qq = e?.user_id
  if (!qq) return null
  const cookie = typeof mysApi.cookie === "string" ? parseCookieString(mysApi.cookie) : mysApi.cookie || {}
  const ltuid = String(cookie.ltuid || cookie.ltuid_v2 || cookie.account_id || cookie.account_id_v2 || "")
  if (!ltuid) return null

  const profileIds = await listProfileIds(String(qq))
  for (const profileId of profileIds) {
    const profile = await loadProfile(String(qq), profileId).catch(() => null)
    if (!profile) continue
    const account = profile.account || {}
    if ([account.ltuid, account.stuid].map(String).includes(ltuid)) {
      return profile.device || null
    }
  }
  return null
}
