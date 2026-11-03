import { getDs, getDs2 } from "../../core/mihoyo/ds.js"
import { parseCookieString, serializeCookie } from "../../core/mihoyo/cookies.js"
import { solveCaptcha } from "../../core/captcha/service.js"
import { MIHOYO_PROTOCOL, mihoyoUserAgent } from "../../core/mihoyo/constants.js"
import { captchaVersion } from "../../core/captcha/result.js"
import { captchaRequestContext } from "../../core/captcha/requestContext.js"
import { captchaRoute, gameCaptchaContext, requireCaptchaChallenge, requireInlineCaptchaChallenge, captchaVerification, requestCaptchaChallenge, verifyCaptchaChallenge, requiresMiyousheCaptcha } from "./captcha.js"

export const BBS = Object.freeze({
  ...MIHOYO_PROTOCOL.bbsCn, origin: "https://bbs-api.miyoushe.com",
})
const locks = new Map()

export async function withMiyousheAccount(profile, work) {
  const key = String(profile.account?.stuid || profile.account?.ltuid || profile.user?.qq)
  const previous = locks.get(key) || Promise.resolve()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const tail = previous.catch(() => {}).then(() => gate)
  locks.set(key, tail)
  await previous.catch(() => {})
  try { return await work() } finally { release(); if (locks.get(key) === tail) locks.delete(key) }
}

export function miyousheHeaders(profile, { web = false, stoken = false, body = "", query = "", x6 = false, overseas = false } = {}) {
  const account = profile.account || {}, device = profile.device || {}
  if (overseas) return {
    Accept: "application/json, text/plain, */*", "Content-Type": "application/json; charset=UTF-8",
    Cookie: account.cookie || "", "x-rpc-app_version": MIHOYO_PROTOCOL.hoyolab.version,
    "x-rpc-client_type": MIHOYO_PROTOCOL.hoyolab.clientType, "x-rpc-device_id": String(device.id || ""),
    "User-Agent": mihoyoUserAgent(device, true), Origin: "https://act.hoyolab.com", Referer: "https://act.hoyolab.com/",
    DS: getDs(MIHOYO_PROTOCOL.hoyolab.salt),
  }
  let cookie = account.cookie || ""
  if (stoken) {
    const parts = parseCookieString(cookie)
    const stuid = account.stuid || parts.stuid || parts.ltuid
    cookie = serializeCookie({ ...parts, ...(account.stoken ? { stoken: account.stoken } : {}), ...(stuid ? { stuid } : {}), ...(account.mid ? { mid: account.mid } : {}) })
  }
  return {
    Accept: "application/json, text/plain, */*", "Content-Type": "application/json; charset=UTF-8",
    Cookie: cookie, "x-rpc-app_version": BBS.version, "x-rpc-client_type": web ? "5" : "2",
    "x-rpc-device_id": String(device.id || ""), ...(device.fp ? { "x-rpc-device_fp": String(device.fp) } : {}),
    "x-rpc-device_name": String(device.name || ""), "x-rpc-device_model": String(device.model || ""),
    "x-rpc-channel": "miyousheluodi", "x-rpc-verify_key": MIHOYO_PROTOCOL.passport.appId,
    "User-Agent": web ? mihoyoUserAgent(device) : "okhttp/4.9.3",
    Origin: "https://webstatic.mihoyo.com", Referer: "https://webstatic.mihoyo.com/",
    DS: x6 ? getDs2(query, body, BBS.x6Salt) : getDs(web ? BBS.webSalt : BBS.salt),
  }
}

// A refresh can discover the business has already succeeded, without spending
// another recognition attempt or repeating the accepted operation.
class InlineBusinessCompleted extends Error {
  constructor(result) {
    super("inline business completed during challenge refresh")
    this.result = result
  }
}

export class MiyousheClient {
  constructor(options = {}) { this.fetch = options.fetch || globalThis.fetch; this.solveCaptcha = options.solveCaptcha || solveCaptcha }

  async request(url, profile, { method = "GET", params, body, headers = {}, headersFactory, web = false, stoken = false, x6 = false, overseas = false, onCaptchaEvent, captcha = true, signal, game, requestMetadata, beforeRequest } = {}) {
    const target = new URL(url)
    if (params) for (const [key, value] of Object.entries(params)) if (value !== undefined) target.searchParams.set(key, String(value))
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const assertCurrent = async () => {
      signal?.throwIfAborted()
      await beforeRequest?.({ profile, overseas, tokenOnly: headers.Cookie === "" && Boolean(headers["x-rpc-combo_token"]) })
      signal?.throwIfAborted()
    }
    let responseRequestContext
    const send = async extra => {
      await assertCurrent()
      const freshHeaders = typeof headersFactory === "function" ? await headersFactory() : undefined
      await assertCurrent()
      const response = await this.fetch(target, { method, headers: { ...miyousheHeaders(profile, { web, stoken, x6, overseas, body: payload || "", query: target.search.slice(1) }), ...headers, ...freshHeaders, ...extra }, body: payload, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) })
      if (!response.ok) throw new Error(`米游社接口 HTTP ${response.status}`)
      responseRequestContext = captchaRequestContext({ url: requestMetadata?.url || requestMetadata?.path || target, headers: response.headers })
      let result
      try { result = await response.json() } catch { throw new Error("米游社接口返回无效 JSON") }
      if (!Number.isFinite(result?.retcode)) throw new Error("米游社响应缺少状态码")
      await assertCurrent()
      return result
    }
    let result = await send({})
    if (captcha && requiresMiyousheCaptcha(result)) {
      const route = captchaRoute(target, result, { game, headers, params, body })
      const inline = route.kind === "inline"
      if (inline) {
        let accepted
        const seen = new Set()
        const submitted = new Set()
        const submittedProofs = new Set()
        const requireFresh = response => {
          const challenge = requireInlineCaptchaChallenge(response)
          const key = `${challenge.gt}:${challenge.challenge}`
          if (seen.has(key)) throw new Error("业务重复返回已使用的验证码，已停止重试")
          seen.add(key)
          return challenge
        }
        const challenge = requireFresh(result)
        const refreshChallenge = async () => {
          const refreshed = await send({})
          if (!requiresMiyousheCaptcha(refreshed)) {
            this.assert(refreshed)
            throw new InlineBusinessCompleted(refreshed)
          }
          return requireFresh(refreshed)
        }
        const verifyResult = async (solution, current) => {
          await assertCurrent()
          if (captchaVersion(solution) === 4) throw new Error("该业务不支持回填 Geetest v4 结果")
          const token = solution.validate || solution.token
          const challengeId = solution.challenge || current.challenge
          if (typeof token !== "string" || !token || typeof challengeId !== "string" || !challengeId) {
            throw new Error("业务验证码结果缺少 v3 validate/challenge")
          }
          if (submitted.has(challengeId) || submittedProofs.has(token)) throw new Error("验证码已提交，禁止重复使用")
          submitted.add(challengeId)
          submittedProofs.add(token)
          const verified = await send({ "x-rpc-challenge": challengeId, "x-rpc-validate": token, "x-rpc-seccode": `${token}|jordan` })
          if (requiresMiyousheCaptcha(verified)) {
            return { ok: false, reason: "签到业务未接受验证码", retryable: true, challengeRefresh: true }
          }
          this.assert(verified)
          accepted = verified
          return { ok: true, raw: verified }
        }
        try {
          await assertCurrent()
          const solved = await this.solveCaptcha(challenge, { onCaptchaEvent, signal, refreshChallenge, verifyResult })
          await assertCurrent()
          if (!solved.ok) throw new Error(`验证码未通过：${solved.reason || "识别失败"}`)
          if (!accepted) throw new Error("验证码尚未完成签到业务校验")
          return accepted
        } catch (error) {
          if (error instanceof InlineBusinessCompleted) return error.result
          throw error
        }
      }
      const apiFetch = async (url, options) => {
        await assertCurrent()
        const response = await this.fetch(url, {
          ...options,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
        })
        await assertCurrent()
        return response
      }
      const context = route.kind !== "bbs" ? gameCaptchaContext(route, profile, miyousheHeaders, responseRequestContext) : null
      const create = async () => {
        await assertCurrent()
        const created = route.kind === "bbs"
          ? await this.request(`${route.origin}/misc/api/createVerification`, profile, { params: { is_high: true }, stoken: !route.overseas, overseas: route.overseas, captcha: false, signal, beforeRequest })
          : await requestCaptchaChallenge(context, apiFetch)
        await assertCurrent()
        return requireCaptchaChallenge(created)
      }
      const verifyResult = async (solved, challenge) => {
        await assertCurrent()
        if (captchaVersion(solved) === 4) throw new Error("该业务不支持回填 Geetest v4 结果")
        const token = solved.validate || solved.token
        const challengeId = solved.challenge || challenge.challenge
        const verified = route.kind === "bbs"
          ? await this.request(`${route.origin}/misc/api/verifyVerification`, profile, {
              method: "POST", body: { geetest_challenge: challengeId, geetest_validate: token, geetest_seccode: `${token}|jordan` },
              stoken: !route.overseas, overseas: route.overseas, captcha: false, signal, beforeRequest,
            })
          : await verifyCaptchaChallenge(context, { challenge: challengeId, validate: token }, apiFetch)
        await assertCurrent()
        return captchaVerification(verified)
      }
      const challenge = await create()
      await assertCurrent()
      const solved = await this.solveCaptcha(challenge, { onCaptchaEvent, signal, refreshChallenge: create, verifyResult })
      await assertCurrent()
      if (!solved.ok) throw new Error(`验证码未通过：${solved.reason || "识别失败"}`)
      const rpcChallenge = solved.verification?.rpcChallenge
      if (!rpcChallenge) throw new Error("验证码尚未完成业务校验")
      result = await send({ "x-rpc-challenge": rpcChallenge })
      if (requiresMiyousheCaptcha(result)) throw new Error("验证码提交后业务接口仍要求验证")
    }
    return result
  }

  assert(result) {
    if (result.retcode !== 0) { const error = new Error(`米游社接口失败（${result.retcode}）：${String(result.message || "未知错误").slice(0, 120)}`); error.retcode = result.retcode; throw error }
    return result.data
  }

  async missions(profile, { onCaptchaEvent, signal, beforeRequest } = {}) {
    return this.assert(await this.request(`${BBS.origin}/apihub/wapi/getUserMissionsState`, profile, { params: { point_sn: "myb" }, web: true, onCaptchaEvent, signal, beforeRequest }))
  }
}
