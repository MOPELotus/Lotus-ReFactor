import { requestJson, sleep } from "../http.js"
import { captchaFail, captchaOk, captchaVersion, hasCaptchaV4Response, normalizeCaptchaV4Solution } from "../result.js"
import { emitCaptchaEvent } from "../events.js"
import { detectGtCapabilities } from "../../../services/gtManual/capabilities.js"

const TERMINAL_REASONS = new Set(["manual_closed", "manual_sdk_error", "manual_invalid_result", "manual_submission_failed", "manual_expired"])

export const gtManualProvider = {
  name: "gtmanual",
  supportedVersions: [3, 4],

  isAvailable(config = {}) {
    return config.enable !== false && (config.internal_enable === true || Boolean(config.verify_addr || config.verifyAddr))
  },

  async solve(challenge, config = {}, context = {}) {
    const started = Date.now()
    const version = captchaVersion(challenge) === 4 ? 4 : 3
    let deadline = started + finiteNumber(config.timeout_ms || 180000, 180000)
    const fail = (reason, options = {}) => captchaFail(this.name, reason, {
      retryable: true, challengeRefresh: true, costMs: Date.now() - started, ...options,
    })
    const expired = () => {
      context.signal?.throwIfAborted()
      return Date.now() >= deadline
    }
    if (!this.isAvailable(config)) return fail("provider_unconfigured", { skipped: true })
    if (expired()) return fail("manual_timeout")

    try {
      let address = config.verify_addr || config.verifyAddr
      if (config.internal_enable === true) {
        const { ensureInternalGt } = await import("../../../services/gtManual/runtime.js")
        const connection = await ensureInternalGt()
        address = connection.address
        context = { ...context, fetch: connection.fetch }
      } else if (config.internal_enable === false) {
        const { stopInternalGt } = await import("../../../services/gtManual/runtime.js")
        stopInternalGt()
        const capability = await detectGtCapabilities(address, context)
        if (capability.kind === "legacy") {
          await emitCaptchaEvent(context, { type: "captcha:manual-legacy", provider: this.name })
          if (version === 4) return fail("unsupported_captcha_version", { skipped: true })
        }
      }
      if (expired()) return fail("manual_timeout")
      const payload = version === 4 ? {
        captchaVersion: 4,
        captchaId: challenge.captchaId || challenge.captcha_id,
        ...(typeof (challenge.riskType ?? challenge.risk_type) === "string" ? { riskType: challenge.riskType ?? challenge.risk_type } : {}),
        ...(typeof challenge.userInfo === "string" ? { userInfo: challenge.userInfo } : {}),
      } : { gt: challenge.gt, challenge: challenge.challenge }
      const requestTimeout = Math.max(1, finiteNumber(config.request_timeout_ms || 15000, 15000))
      const created = await requestJson(address, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        timeoutMs: Math.min(requestTimeout, deadline - Date.now()),
      }, context)
      if (expired()) return fail("manual_timeout")
      const registration = created?.data || created
      const link = registration?.link
      const resultUrl = registration?.result
      if ((created?.status !== undefined && created.status !== 0) || !httpUrl(link) || !httpUrl(resultUrl)) return fail("manual_register_failed")
      const limits = registrationDeadline(registration, started, version)
      if (limits === null) return fail("manual_register_failed")
      deadline = Math.min(deadline, limits)
      if (expired()) return fail("manual_timeout")

      await emitCaptchaEvent(context, { type: "captcha:manual-link", provider: this.name, link, resultUrl })
      if (expired()) return fail("manual_timeout")
      await notifyManualLink(link, context)
      if (expired()) return fail("manual_timeout")

      const pollIntervalMs = Math.max(1000, finiteNumber(config.poll_interval_ms || 1500, 1500))
      const progressIntervalMs = Math.max(0, finiteNumber(config.progress_interval_ms ?? 15000, 15000))
      let nextProgressAt = Date.now() + progressIntervalMs
      while (!expired()) {
        await sleep(Math.min(pollIntervalMs, deadline - Date.now()), context)
        if (expired()) break
        if (progressIntervalMs > 0 && Date.now() >= nextProgressAt) {
          await emitCaptchaEvent(context, { type: "captcha:provider-wait", provider: this.name, elapsedMs: Date.now() - started })
          if (expired()) break
          nextProgressAt = Date.now() + progressIntervalMs
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        let result
        try {
          result = await requestJson(resultUrl, { timeoutMs: Math.min(requestTimeout, remainingMs) }, context)
        } catch (error) {
          if (expired()) break
          if ([409, 410].includes(error.status)) return fail("manual_result_unavailable")
          throw error
        }
        // Neither delayed callbacks nor an HTTP transport ignoring abort may
        // extend a human task's lifetime or submit an expired proof.
        if (expired()) break
        if (result?.status !== undefined && result.status !== 0) return fail("manual_request_failed")
        const data = result?.data || result
        if (data?.ok === false) {
          if (data.captchaVersion !== version) return fail("captcha_result_version_mismatch")
          return fail(TERMINAL_REASONS.has(data.reason) ? data.reason : "manual_invalid_result")
        }
        if (version === 4) {
          if (!data || typeof data !== "object" || !Object.keys(data).length) continue
          if (data.captchaVersion !== 4 || typeof data.captchaId !== "string" || ["validate", "token", "challenge", "seccode", "geetest_validate"].some(key => key in data)) return fail("captcha_result_version_mismatch")
          let proof
          try { proof = normalizeCaptchaV4Solution(data, payload.captchaId) } catch { return fail("invalid_v4_result") }
          return captchaOk(this.name, { captchaVersion: 4, ...proof, costMs: Date.now() - started })
        }
        if (hasCaptchaV4Response(result)) return fail("captcha_result_version_mismatch")
        const validate = extractValidate(result)
        if (validate) return captchaOk(this.name, { challenge: extractChallenge(result) || challenge.challenge, validate, costMs: Date.now() - started })
      }
      return fail("manual_timeout")
    } catch (error) {
      return fail(error?.name === "AbortError" ? "timeout" : "manual_request_failed")
    }
  },
}

function registrationDeadline(data, started, version) {
  const limits = []
  for (const key of ["expires_in_ms", "expires_at"]) {
    if (data[key] === undefined) continue
    if (!Number.isSafeInteger(data[key]) || data[key] <= 0) return null
    // Include registration transport time conservatively: receiving a relative
    // lifetime late must not give a task extra time beyond its advertised TTL.
    limits.push(key === "expires_in_ms" ? started + data[key] : data[key])
  }
  // Old servers remain valid v3 adapters. V4 requires the new bounded task
  // contract, so an old registration page cannot silently masquerade as v4.
  if (version === 4 && !limits.length) return null
  return limits.length ? Math.min(...limits) : Infinity
}

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function httpUrl(value) {
  if (typeof value !== "string") return false
  try { return ["http:", "https:"].includes(new URL(value).protocol) } catch { return false }
}

async function notifyManualLink(link, context) {
  if (typeof context.notifyManualLink === "function") await context.notifyManualLink(link, { provider: "gtmanual" })
}

function extractValidate(data) {
  if (!data || typeof data !== "object") return ""
  if (typeof data.validate === "string") return data.validate
  if (typeof data?.data?.validate === "string") return data.data.validate
  if (typeof data?.data?.geetest_validate === "string") return data.data.geetest_validate
  if (typeof data?.request?.geetest_validate === "string") return data.request.geetest_validate
  return ""
}

function extractChallenge(data) {
  return data?.challenge || data?.data?.challenge || data?.data?.geetest_challenge || data?.request?.geetest_challenge || ""
}
