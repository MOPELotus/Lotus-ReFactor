import { solveCaptcha } from "../../core/captcha/service.js"
import { normalizeCaptchaV4Solution } from "../../core/captcha/result.js"
import { captchaVerificationResult } from "../../core/captcha/mysHandler.js"
import { requestOfficialJson } from "../redeemCodes/http.js"

const ORIGIN = "https://bbs-api.miyoushe.com"
const SHOP_ORIGIN = "https://webstatic.miyoushe.com"

// The shop's v4 flow is separate from record/tool v3 verification. Its /misc
// requests use the browser cookie, without copying native exchange headers.
export class CoinShopCaptcha {
  constructor(options = {}) {
    this.requestJson = options.requestJson || requestOfficialJson
    this.solveCaptcha = options.solveCaptcha || solveCaptcha
  }

  async solve(profile, retcode, { signal, onCaptchaEvent, background = false, assertCurrent } = {}) {
    if (![1028, 1034].includes(Number(retcode))) throw new Error("该商城响应不支持验证码验证")
    const headers = {
      Accept: "application/json, text/plain, */*",
      Cookie: profile?.account?.cookie || "",
      Origin: SHOP_ORIGIN,
      Referer: `${SHOP_ORIGIN}/`,
    }
    const guard = async () => {
      signal?.throwIfAborted()
      await assertCurrent?.()
      signal?.throwIfAborted()
    }
    let currentChallenge
    const create = async () => {
      await guard()
      const url = new URL("/misc/wapi/createVerification", ORIGIN)
      url.search = new URLSearchParams({ point_sn: "myb", is_high: String(Number(retcode) === 1034), captcha_version: "v4" }).toString()
      const result = await this.requestJson(url.href, { method: "GET", headers, signal })
      await guard()
      if (result?.retcode !== 0) {
        const error = new Error(`创建商城验证码失败（${Number.isFinite(result?.retcode) ? result.retcode : "无状态码"}）`)
        error.retcode = result?.retcode
        throw error
      }
      if (typeof result.data?.captcha_id !== "string" || !result.data.captcha_id.trim()) throw new Error("商城未返回受支持的 v4 captcha_id")
      currentChallenge = {
        captchaVersion: 4,
        captchaId: result.data.captcha_id,
        referer: `${SHOP_ORIGIN}/app/community-shop/index.html`,
        ...(typeof result.data.risk_type === "string" ? { riskType: result.data.risk_type } : {}),
      }
      return currentChallenge
    }
    const verifyResult = async (solution, challenge) => {
      await guard()
      const normalized = normalizeCaptchaV4Solution(solution, challenge.captchaId)
      const url = new URL("/misc/wapi/verifyVerfication", ORIGIN)
      // Official spelling and parameter placement: v4 answer in the query,
      // only point_sn in JSON. /misc does not receive the shop app_id.
      url.search = new URLSearchParams({
        captcha_version: "v4", lot_number: normalized.lotNumber,
        captcha_output: normalized.captchaOutput, pass_token: normalized.passToken,
        gen_time: normalized.genTime,
      }).toString()
      const result = await this.requestJson(url.href, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json;charset=utf-8" },
        body: JSON.stringify({ point_sn: "myb" }), signal,
      })
      await guard()
      return captchaVerificationResult(result)
    }
    const challenge = await create()
    const solved = await this.solveCaptcha(challenge, {
      signal, onCaptchaEvent, refreshChallenge: create, verifyResult,
      providerOrder: background ? ["ttocr"] : ["ttocr", "gtmanual"],
      ...(background ? { providerAttempts: 1, chainAttempts: 1 } : {}),
    })
    await guard()
    if (!solved.ok) {
      const attempts = (solved.attempts || [solved]).filter(attempt => attempt.provider === "ttocr")
      const unavailable = attempts.length === 0 || attempts.every(attempt => attempt.skipped || attempt.fatal || (attempt.retryable === false && !attempt.challengeRefresh))
      return { ...solved, unavailable }
    }
    if (!solved.verification?.rpcChallenge) throw new Error("商城验证码尚未完成业务校验")
    return { ...solved, captchaVersion: 4, ...normalizeCaptchaV4Solution(solved, currentChallenge.captchaId) }
  }
}
