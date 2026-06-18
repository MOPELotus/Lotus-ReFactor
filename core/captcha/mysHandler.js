import { listProfileIds, loadProfile } from "../config/profile.js"
import { deviceHeaders } from "../devices/service.js"
import { parseCookieString } from "../mihoyo/cookies.js"
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
  const server = mysApi.server || ""
  const isCn = /cn_|_cn/.test(server)
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
  const headers = buildMysHeaders(context.mysApi, request.query, request.body)
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

function buildMysHeaders(mysApi, query = "", body = "") {
  if (typeof mysApi?.getHeaders === "function") {
    if (mysApi.getHeaders.length >= 3) return mysApi.getHeaders("", query, body)
    return mysApi.getHeaders(query, body)
  }
  return {
    "User-Agent": "Mozilla/5.0 miHoYoBBS/2.73.1",
    Referer: "https://act.mihoyo.com/",
  }
}

function apiHost(context) {
  return context.isCn ? "https://api-takumi.mihoyo.com/" : "https://sg-public-api.hoyolab.com/"
}

function recordHost(context) {
  return context.isCn ? "https://api-takumi-record.mihoyo.com/" : "https://bbs-api-os.hoyolab.com/"
}

async function findProfileDevice(e, mysApi) {
  const qq = e?.user_id
  if (!qq) return null
  const cookie = typeof mysApi.cookie === "string" ? parseCookieString(mysApi.cookie) : mysApi.cookie || {}
  const ltuid = String(cookie.ltuid || cookie.account_id || "")
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
