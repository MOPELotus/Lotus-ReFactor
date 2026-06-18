import { requestJson, withQuery } from "../http.js"
import { captchaFail, captchaOk } from "../result.js"

export const testNineProvider = {
  name: "test_nine",

  isAvailable(config = {}) {
    return config.enable !== false && Boolean(config.endpoint || config.api)
  },

  async solve(challenge, config = {}, context = {}) {
    const started = Date.now()
    if (!this.isAvailable(config)) {
      return captchaFail(this.name, "provider_disabled", { skipped: true })
    }

    try {
      const endpoint = config.endpoint || config.api || "http://127.0.0.1:9645/pass_uni"
      const data = await requestJson(
        withQuery(endpoint, {
          gt: challenge.gt,
          challenge: challenge.challenge,
        }),
        {
          timeoutMs: config.timeout_ms || 20000,
        },
        context,
      )
      const validate = extractValidate(data)
      if (validate) {
        return captchaOk(this.name, {
          challenge: challenge.challenge,
          validate,
          costMs: Date.now() - started,
          raw: data,
        })
      }

      return captchaFail(this.name, "no_validate", {
        retryable: true,
        costMs: Date.now() - started,
        raw: data,
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
  if (typeof data.validate === "string") return data.validate
  if (typeof data?.data?.validate === "string") return data.data.validate
  if (typeof data?.data?.data?.validate === "string") return data.data.data.validate
  return ""
}
