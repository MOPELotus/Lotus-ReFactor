import {
  appendKey,
  formBody,
  mergeQueryString,
  requestJson,
  sleep,
} from "../http.js"
import { captchaFail, captchaOk } from "../result.js"
import { emitCaptchaEvent } from "../events.js"

const CHALLENGE_USED_STATUS = 4022
const FATAL_STATUS = new Set([4006, 4007, 4008, 4009, 4021, 4023])

export const ttocrProvider = {
  name: "ttocr",

  isAvailable(config = {}) {
    const key = String(config.key || "").trim()
    return config.enable !== false
      && Boolean(config.api)
      && Boolean(config.resapi)
      && Boolean(key)
      && key !== "脱敏"
  },

  async solve(challenge, config = {}, context = {}) {
    const started = Date.now()
    if (!this.isAvailable(config)) {
      return captchaFail(this.name, "provider_unconfigured", { skipped: true })
    }

    const submitFields = buildSubmitFields(challenge, config)
    const submit = await postForm(config.api, submitFields, config.timeout_ms || 30000, context)
    if (submit.status !== 1 || !submit.resultid) {
      return classifyFailure(this.name, submit, Date.now() - started)
    }

    const timeoutMs = Number(config.timeout_ms || config.max_wait_ms || 60000)
    const pollIntervalMs = Math.max(1000, Number(config.poll_interval_ms || 2000))
    const progressIntervalMs = Math.max(0, Number(config.progress_interval_ms || 10000))
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
      const result = await postForm(
        config.resapi,
        appendKey({ resultid: submit.resultid }, config.key),
        config.timeout_ms || 30000,
        context,
      )

      if (result.status === 1 && result.data) {
        const validate = result.data.validate || result.data.geetest_validate
        if (validate) {
          return captchaOk(this.name, {
            challenge: result.data.challenge || challenge.challenge,
            validate,
            seccode: result.data.seccode,
            costMs: Date.now() - started,
            raw: result,
          })
        }
      }

      if (Number(result.status) === CHALLENGE_USED_STATUS || FATAL_STATUS.has(Number(result.status))) {
        return classifyFailure(this.name, result, Date.now() - started)
      }
    }

    return captchaFail(this.name, "timeout", {
      retryable: true,
      costMs: Date.now() - started,
    })
  },
}

function buildSubmitFields(challenge, config) {
  let fields = {
    gt: challenge.gt,
    challenge: challenge.challenge,
    itemid: config.itemid || 388,
    referer: config.referer || "https://webstatic.mihoyo.com/",
  }

  fields = mergeQueryString(fields, config.query)
  fields = appendKey(fields, config.key)
  return fields
}

async function postForm(url, fields, timeoutMs, context) {
  return requestJson(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: formBody(fields).toString(),
      timeoutMs,
    },
    context,
  )
}

function classifyFailure(provider, data, costMs) {
  const status = Number(data?.status)
  const challengeRefresh = status === CHALLENGE_USED_STATUS || String(data?.msg || "").includes("已使用")
  if (challengeRefresh) {
    return captchaFail(provider, "challenge_used", {
      retryable: false,
      fatal: false,
      challengeRefresh: true,
      code: status,
      costMs,
      raw: data,
    })
  }

  const fatal = FATAL_STATUS.has(status)
  return captchaFail(provider, data?.msg || `status_${data?.status || "unknown"}`, {
    retryable: !fatal,
    fatal,
    code: status,
    costMs,
    raw: data,
  })
}
