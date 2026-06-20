import { requestJson, sleep } from "../http.js"
import { captchaFail, captchaOk } from "../result.js"
import { emitCaptchaEvent } from "../events.js"

export const gtManualProvider = {
  name: "gtmanual",

  isAvailable(config = {}) {
    return config.enable !== false && Boolean(config.verify_addr || config.verifyAddr)
  },

  async solve(challenge, config = {}, context = {}) {
    const started = Date.now()
    if (!this.isAvailable(config)) {
      return captchaFail(this.name, "provider_unconfigured", { skipped: true })
    }

    try {
      const verifyAddr = config.verify_addr || config.verifyAddr
      const created = await requestJson(
        verifyAddr,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            gt: challenge.gt,
            challenge: challenge.challenge,
          }),
          timeoutMs: config.request_timeout_ms || 15000,
        },
        context,
      )

      const link = created?.data?.link || created?.link
      const resultUrl = created?.data?.result || created?.result
      if (!link || !resultUrl) {
        return captchaFail(this.name, "manual_register_failed", {
          retryable: true,
          costMs: Date.now() - started,
          raw: created,
        })
      }

      await emitCaptchaEvent(context, {
        type: "captcha:manual-link",
        provider: this.name,
        link,
        resultUrl,
      })
      await notifyManualLink(link, context)

      const timeoutMs = Number(config.timeout_ms || 180000)
      const pollIntervalMs = Math.max(1000, Number(config.poll_interval_ms || 1500))
      const progressIntervalMs = Math.max(0, Number(config.progress_interval_ms || 15000))
      const deadline = Date.now() + timeoutMs
      let nextProgressAt = Date.now() + progressIntervalMs

      while (Date.now() < deadline) {
        await sleep(pollIntervalMs, context)
        const now = Date.now()
        if (progressIntervalMs > 0 && now >= nextProgressAt) {
          await emitCaptchaEvent(context, {
            type: "captcha:provider-wait",
            provider: this.name,
            elapsedMs: now - started,
          })
          nextProgressAt = now + progressIntervalMs
        }
        const result = await requestJson(resultUrl, {
          timeoutMs: config.request_timeout_ms || 15000,
        }, context)
        const validate = extractValidate(result)
        if (validate) {
          return captchaOk(this.name, {
            challenge: extractChallenge(result) || challenge.challenge,
            validate,
            costMs: Date.now() - started,
            raw: result,
          })
        }
      }

      return captchaFail(this.name, "manual_timeout", {
        retryable: true,
        manualLink: link,
        resultUrl,
        costMs: Date.now() - started,
      })
    } catch (error) {
      return captchaFail(this.name, error.message || "manual_request_failed", {
        retryable: true,
        costMs: Date.now() - started,
      })
    }
  },
}

async function notifyManualLink(link, context) {
  if (typeof context.notifyManualLink === "function") {
    await context.notifyManualLink(link, {
      provider: "gtmanual",
    })
  }
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
  return data?.challenge
    || data?.data?.challenge
    || data?.data?.geetest_challenge
    || data?.request?.geetest_challenge
    || ""
}
