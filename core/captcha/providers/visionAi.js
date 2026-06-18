import { requestJson } from "../http.js"
import { captchaFail, captchaOk } from "../result.js"

export const visionAiProvider = {
  name: "vision_ai",

  isAvailable(config = {}) {
    return config.enable === true && Boolean(config.api)
  },

  async solve(challenge, config = {}, context = {}) {
    const started = Date.now()
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

      const validate = extractValidate(response)
      if (!validate) {
        return captchaFail(this.name, response?.message || "no_validate", {
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
      return captchaFail(this.name, error.message || "request_failed", {
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
