import { requestJson } from "../http.js"
import { captchaFail, captchaOk, captchaVersion, hasCaptchaV4Response } from "../result.js"

export const visionAiProvider = {
  name: "vision_ai",
  supportedVersions: [3],

  isAvailable(config = {}) {
    return config.enable === true && Boolean(config.api)
  },

  async solve(challenge, config = {}, context = {}) {
    const started = Date.now()
    if (captchaVersion(challenge) === 4) {
      return captchaFail(this.name, "unsupported_captcha_version", { skipped: true, retryable: false })
    }
    if (!this.isAvailable(config)) {
      return captchaFail(this.name, "provider_unconfigured", { skipped: true })
    }

    try {
      const response = await requestJson(config.api, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.key ? { authorization: `Bearer ${config.key}` } : {}),
        },
        body: JSON.stringify({
          gt: challenge.gt,
          challenge: challenge.challenge,
          type: "geetest_v3",
          context: {
            url: context.url || "",
            referer: context.referer || "https://webstatic.mihoyo.com/",
          },
        }),
        timeoutMs: config.timeout_ms || 60000,
      }, context)

      if (hasCaptchaV4Response(response)) return captchaFail(this.name, "captcha_result_version_mismatch", { retryable: true, challengeRefresh: true, costMs: Date.now() - started, raw: response })
      const validate = extractValidate(response)
      if (!validate) {
        return captchaFail(this.name, "no_validate", {
          retryable: true,
          costMs: Date.now() - started,
          raw: response,
        })
      }

      return captchaOk(this.name, {
        validate,
        token: validate,
        challenge: extractChallenge(response) || challenge.challenge,
        costMs: Date.now() - started,
        raw: response,
      })
    } catch (error) {
      return captchaFail(this.name, error?.name === "AbortError" ? "timeout" : "request_failed", {
        raw: error,
        retryable: true,
        costMs: Date.now() - started,
      })
    }
  },
}

function extractValidate(data) {
  if (!data || typeof data !== "object") return ""
  return data.validate
    || data.token
    || data.data?.validate
    || data.data?.token
    || data.result?.validate
    || ""
}

function extractChallenge(data) {
  if (!data || typeof data !== "object") return ""
  return data.challenge
    || data.data?.challenge
    || data.result?.challenge
    || ""
}
