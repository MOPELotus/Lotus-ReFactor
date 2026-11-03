import {
  appendKey,
  formBody,
  mergeQueryString,
  requestJson,
  sleep,
} from "../http.js"
import { captchaFail, captchaOk, captchaVersion, hasCaptchaV4Response } from "../result.js"
import { emitCaptchaEvent } from "../events.js"

const CHALLENGE_USED_STATUS = 4022
const FAILED_CHALLENGE_STATUS = new Set([4024, 4026, 4028, 4039])
const FATAL_STATUS = new Set([4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010, 4011, 4012, 4013, 4018, 4021, 4023, 4038, 4100, 4101, 4103, 4106, 4030])
// The official polling examples wait on every non-success response. Only
// explicit credential/configuration errors, a missing task ID, and an
// explicitly rejected challenge or reported host/proxy failure stop early here.
// In particular 4015/4016 (not found yet) and 4040
// (unspecified error) do not establish that the task has finished.
const TERMINAL_STATUS = new Set([...FATAL_STATUS, 4014, CHALLENGE_USED_STATUS, ...FAILED_CHALLENGE_STATUS])

// Share only result-task polling and IP backoff across module reloads. Different
// result IDs may proceed independently, as permitted by the official API.
const sharedKey = Symbol.for("lotus-plugin.ttocr-request-limits")
const limits = globalThis[sharedKey] ||= { polls: new Map(), cooldownUntil: 0, cooldownCode: null }
const COOLDOWN_MS = 30 * 60 * 1000

function duration(value, fallback, minimum = 1) {
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum
    ? Math.min(number, 2147483647)
    : fallback
}

function cooldownFailure(provider, costMs = 0, skipped = true) {
  if (Date.now() >= limits.cooldownUntil) return null
  return captchaFail(provider, `status_${limits.cooldownCode}`, {
    code: limits.cooldownCode, fatal: true, retryable: false, skipped, costMs,
  })
}

function recordIpBlock(data) {
  const code = Number(data?.status)
  if (code === 4030 || (code === 4006 && /IP\s*已被拉黑|IP.*blacklist|blacklist.*IP/i.test(String(data?.msg || "")))) {
    limits.cooldownUntil = Date.now() + COOLDOWN_MS
    limits.cooldownCode = code
  }
}

async function pollTask(url, fields, timeoutMs, intervalMs, deadline, context) {
  const key = JSON.stringify([new URL(url).origin, String(fields.resultid)])
  const previous = limits.polls.get(key) || Promise.resolve()
  let release
  const current = new Promise(resolve => { release = resolve })
  limits.polls.set(key, current)
  try {
    await previous
    context.signal?.throwIfAborted()
    if (Date.now() >= deadline) throw new Error("TTOCR result timeout")
    // Wait after acquiring the task lock: concurrent consumers cannot query the
    // same result ID together, even when their outer loops started together.
    await sleep(intervalMs, context)
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw new Error("TTOCR result timeout")
    const result = await postForm(url, fields, Math.min(timeoutMs, remainingMs), context)
    // Reject late proofs but retain explicit terminal diagnostics such as 4039.
    if (Date.now() >= deadline && !TERMINAL_STATUS.has(Number(result?.status))) throw new Error("TTOCR result timeout")
    return result
  } finally {
    release()
    if (limits.polls.get(key) === current) limits.polls.delete(key)
  }
}

export const ttocrProvider = {
  name: "ttocr",
  supportedVersions: [3, 4],

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

    const cooling = cooldownFailure(this.name)
    if (cooling) return cooling
    try {
      const requestTimeoutMs = duration(config.timeout_ms, 30000)
      const version = captchaVersion(challenge) === 4 ? 4 : 3
      const submitFields = buildSubmitFields(challenge, config, version)
      const submit = await postForm(config.api, submitFields, requestTimeoutMs, context)
      if (Number(submit.status) !== 1 || !submit.resultid) {
        return classifyFailure(this.name, submit, Date.now() - started)
      }

      const timeoutMs = duration(config.timeout_ms || config.max_wait_ms, 60000)
      const pollIntervalMs = Math.max(2000, duration(config.poll_interval_ms, 2000))
      const progressIntervalMs = duration(config.progress_interval_ms ?? 10000, 10000, 0)
      const deadline = Date.now() + timeoutMs
      let nextProgressAt = Date.now() + progressIntervalMs

      while (Date.now() < deadline) {
        const now = Date.now()
        if (progressIntervalMs > 0 && now >= nextProgressAt) {
          await emitCaptchaEvent(context, {
            type: "captcha:provider-wait",
            provider: this.name,
            elapsedMs: now - started,
          })
          nextProgressAt = now + progressIntervalMs
        }
        const result = await pollTask(
          config.resapi,
          { ...appendKey({}, config.key), resultid: submit.resultid },
          requestTimeoutMs,
          pollIntervalMs,
          deadline,
          context,
        )

        if (Number(result.status) === 1) {
          if (version === 4) {
            const fields = v4Result(result.data, challenge)
            if (!fields) return captchaFail(this.name, "invalid_v4_result", { retryable: true, costMs: Date.now() - started, raw: result })
            return captchaOk(this.name, { ...fields, costMs: Date.now() - started, raw: result })
          }
          if (hasCaptchaV4Response(result)) return captchaFail(this.name, "captcha_result_version_mismatch", { retryable: true, challengeRefresh: true, costMs: Date.now() - started, raw: result })
          const validate = result.data?.validate || result.data?.geetest_validate
          if (validate) {
            return captchaOk(this.name, {
              challenge: result.data.challenge || challenge.challenge,
              validate,
              seccode: result.data.seccode,
              costMs: Date.now() - started,
              raw: result,
            })
          }
          return captchaFail(this.name, "invalid_v3_result", { retryable: true, costMs: Date.now() - started, raw: result })
        }

        if (TERMINAL_STATUS.has(Number(result.status))) {
          return classifyFailure(this.name, result, Date.now() - started)
        }
      }

      return captchaFail(this.name, "timeout", {
        retryable: true,
        costMs: Date.now() - started,
      })
    } catch (error) {
      const cooling = cooldownFailure(this.name, Date.now() - started, false)
      if (cooling) return cooling
      // Transport failures must reach the next provider. Do not expose errors
      // that may contain endpoint URLs, query credentials, or request bodies.
      const timedOut = error?.name === "AbortError" || /timeout|timed?\s*out|abort/i.test(String(error?.message || ""))
      return captchaFail(this.name, timedOut ? "timeout" : "request_failed", {
        raw: error,
        retryable: true,
        challengeRefresh: true,
        costMs: Date.now() - started,
      })
    }
  },
}

function buildSubmitFields(challenge, config, version) {
  let fields = {
    gt: challenge.gt,
    challenge: challenge.challenge,
    itemid: config.itemid || 388,
    referer: config.referer || "https://webstatic.mihoyo.com/",
  }

  fields = mergeQueryString(fields, config.query)
  fields = appendKey(fields, config.key)
  if (typeof challenge.referer === "string" && challenge.referer.trim()) {
    fields.referer = challenge.referer
  }
  if (version === 4) {
    // TTOCR's v4 wire API calls the captcha ID `gt`; internally it remains v4.
    // Legacy configurations carry itemid=388 in query, which must not leak here.
    fields.gt = challenge.captchaId || challenge.captcha_id
    fields.itemid = config.itemid_v4 || 488
    // Preserve the current signed website risk parameter in full. A legacy
    // query value may belong to a consumed challenge and must not override it.
    const riskType = challenge.riskType || challenge.risk_type
    if (riskType) fields.ts_risktype = riskType
    delete fields.challenge
  } else {
    // Query/key options must never replace the business's fresh v3 challenge.
    fields.gt = challenge.gt
    fields.challenge = challenge.challenge
  }
  return fields
}

function v4Result(data, challenge) {
  if (!data || typeof data !== "object") return null
  const captchaId = String(challenge.captchaId || challenge.captcha_id || "")
  const returnedId = data.captchaId || data.captcha_id
  if (!captchaId || (returnedId && returnedId !== captchaId)) return null
  const lotNumber = data.lotNumber || data.lot_number
  const captchaOutput = data.captchaOutput || data.captcha_output
  const passToken = data.passToken || data.pass_token
  const genTime = String(data.genTime ?? data.gen_time ?? "")
  if (![lotNumber, captchaOutput, passToken].every(value => typeof value === "string" && value.length > 0) || !/^\d+$/.test(genTime)) return null
  return { captchaVersion: 4, captchaId, lotNumber, captchaOutput, passToken, genTime }
}

async function postForm(url, fields, timeoutMs, context) {
  if (Date.now() < limits.cooldownUntil) throw new Error("TTOCR IP cooldown")
  const data = await requestJson(
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
  ).catch(error => {
    recordIpBlock(error?.data)
    throw error
  })
  recordIpBlock(data)
  return data
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
  return captchaFail(provider, Number.isFinite(status) ? `status_${status}` : "provider_error", {
    retryable: !fatal,
    challengeRefresh: FAILED_CHALLENGE_STATUS.has(status),
    fatal,
    code: status,
    costMs,
    raw: data,
  })
}
