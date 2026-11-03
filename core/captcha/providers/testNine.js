import { requestJson, withQuery } from "../http.js"
import { captchaFail, captchaOk, captchaVersion, hasCaptchaV4Response } from "../result.js"

export const testNineProvider = {
  name: "test_nine",
  supportedVersions: [3],

  isAvailable(config = {}) {
    return config.enable !== false && Boolean(config.endpoint || config.api)
  },

  async solve(challenge, config = {}, context = {}) {
    const started = Date.now()
    if (captchaVersion(challenge) === 4) {
      return captchaFail(this.name, "unsupported_captcha_version", { skipped: true, retryable: false })
    }
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
      if (hasCaptchaV4Response(data)) return captchaFail(this.name, "captcha_result_version_mismatch", { retryable: true, challengeRefresh: true, costMs: Date.now() - started, raw: data })
      const validate = extractValidate(data).split("|")[0]
      if (validate) {
        return captchaOk(this.name, {
          challenge: extractChallenge(data) || challenge.challenge,
          validate,
          costMs: Date.now() - started,
          raw: data,
        })
      }

      const reason = classifyTestNineFailure(data)
      return captchaFail(this.name, reason, {
        retryable: true,
        challengeRefresh: true,
        costMs: Date.now() - started,
        raw: data,
      })
    } catch (error) {
      const reason = classifyTestNineFailure(error)
      return captchaFail(this.name, reason, {
        retryable: true,
        challengeRefresh: isChallengeConsumptiveFailure(reason),
        costMs: Date.now() - started,
      })
    }
  },
}

function extractChallenge(data) {
  const value = data?.data?.data?.challenge || data?.data?.challenge || data?.challenge
  return typeof value === "string" && /^[\w-]{1,256}$/.test(value) ? value : ""
}

function extractValidate(data) {
  if (!data || typeof data !== "object") return ""
  if ([data, data.data, data.data?.data].some(value => value?.result && value.result !== "success")) return ""
  if (typeof data.validate === "string") return data.validate
  if (typeof data?.data?.validate === "string") return data.data.validate
  if (typeof data?.data?.data?.validate === "string") return data.data.data.validate
  return ""
}

function classifyTestNineFailure(value) {
  const text = stringifyFailure(value)
  if (/duration\s*short|too\s*short|short\s*duration|人机|过快/i.test(text)) return "duration_short"
  if (/challenge.*(?:used|invalid)|validate.*used|已被使用|重复使用/i.test(text)) return "challenge_used"
  if (/timeout|timed?\s*out|超时/i.test(text)) return "timeout"
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|request_failed|连接失败/i.test(text)) return "request_failed"
  return "no_validate"
}

function stringifyFailure(value) {
  if (!value) return ""
  if (typeof value === "string") return value
  if (value instanceof Error) {
    return [
      value.message,
      value.stack,
      value.data ? stringifyFailure(value.data) : "",
      value.cause?.message,
    ].filter(Boolean).join("\n")
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isChallengeConsumptiveFailure(reason) {
  return ["duration_short", "challenge_used", "no_validate"].includes(reason)
}
