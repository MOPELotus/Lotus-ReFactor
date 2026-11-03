import { loadGlobalConfig } from "../config/global.js"
import { gtManualProvider } from "./providers/gtManual.js"
import { testNineProvider } from "./providers/testNine.js"
import { ttocrProvider } from "./providers/ttocr.js"
import { visionAiProvider } from "./providers/visionAi.js"
import { captchaFail, normalizeCaptchaChallenge, normalizeCaptchaSolution } from "./result.js"
import { emitCaptchaEvent } from "./events.js"

const PROVIDERS = {
  test_nine: testNineProvider,
  testnine: testNineProvider,
  ttocr: ttocrProvider,
  tttocr: ttocrProvider,
  gtmanual: gtManualProvider,
  "gt-manual": gtManualProvider,
  vision_ai: visionAiProvider,
  visionai: visionAiProvider,
  "vision-ai": visionAiProvider,
}

export class CaptchaService {
  constructor(config = {}) {
    this.config = config
  }

  async solveCaptcha(challengeInput, context = {}) {
    let challenge
    try {
      challenge = normalizeCaptchaChallenge(challengeInput)
    } catch (error) {
      return captchaFail(null, error.message, {
        fatal: true,
        retryable: false,
      })
    }

    const attempts = []
    const order = this.providerOrder(context)
    const providerAttempts = this.providerAttemptLimit(context)
    const chainAttempts = this.chainAttemptLimit(context)
    let refreshAttempts = 0
    let challengeUsed = false
    const consumedChallenges = new Set()
    const consumedV4Lots = new Set()
    const submittedV3Challenges = new Set()
    const submittedV3Proofs = new Set()
    let lastFailure = null
    const maxRefreshAttempts = this.maxChallengeRefreshAttempts(context, {
      order,
      providerAttempts,
      chainAttempts,
    })

    await emitCaptchaEvent(context, {
      type: "captcha:start",
      providers: order,
    })

    chains: for (let chainAttempt = 1; chainAttempt <= chainAttempts; chainAttempt += 1) {
      for (let providerIndex = 0; providerIndex < order.length; providerIndex += 1) {
        const providerName = order[providerIndex]
        const provider = PROVIDERS[providerName]
        const nextProvider = nextProviderName(order, providerIndex)
        if (!provider) {
          attempts.push(captchaFail(providerName, "unknown_provider", { skipped: true }))
          await emitCaptchaEvent(context, {
            type: "captcha:provider-skip",
            provider: providerName,
            reason: "unknown_provider",
            nextProvider,
          })
          continue
        }

        // A consumed challenge must be refreshed before selecting by version:
        // the business may switch Geetest generations on that fresh request.
        if (!challengeUsed && !(provider.supportedVersions || [3]).includes(challenge.captchaVersion)) {
          const skipped = captchaFail(provider.name, "unsupported_captcha_version", { skipped: true, retryable: false })
          attempts.push(skipped)
          await emitCaptchaEvent(context, { type: "captcha:provider-skip", provider: provider.name, reason: skipped.reason, captchaVersion: challenge.captchaVersion, nextProvider })
          continue
        }
        const providerConfig = this.providerConfig(providerName, provider.name)
        const attemptLimit = this.providerAttemptLimit(context, provider.name)
        for (let providerAttempt = 1; providerAttempt <= attemptLimit; providerAttempt += 1) {
          context.signal?.throwIfAborted()
          if (challengeUsed) {
            if (typeof context.refreshChallenge !== "function") {
              lastFailure = captchaFail("challenge_refresh", "challenge_refresh_unavailable", { retryable: false })
              attempts.push(lastFailure)
              break chains
            }
            if (refreshAttempts >= maxRefreshAttempts) {
              lastFailure = captchaFail("challenge_refresh", "refresh_limit_exceeded", {
                fatal: false,
                retryable: false,
              })
              attempts.push(lastFailure)
              break
            }
            const refreshed = await this.refreshChallenge(challenge, {
              provider: provider.name,
              reason: providerAttempt > 1
                ? "provider_retry"
                : chainAttempt > 1
                  ? "chain_retry"
                  : "provider_switch",
            }, attempts, context)
            if (refreshed) {
              if (refreshed.captchaVersion === 3 && consumedChallenges.has(challengeKey(refreshed))) {
                lastFailure = captchaFail("challenge_refresh", "challenge_not_refreshed", { retryable: false })
                attempts.push(lastFailure)
                break chains
              }
              challenge = refreshed
              refreshAttempts += 1
              challengeUsed = false
            } else if (typeof context.refreshChallenge === "function") {
              lastFailure = captchaFail("challenge_refresh", "refresh_failed", {
                fatal: false,
                retryable: false,
              })
              attempts.push(lastFailure)
              break
            }
          }

          if (!(provider.supportedVersions || [3]).includes(challenge.captchaVersion)) {
            const skipped = captchaFail(provider.name, "unsupported_captcha_version", { skipped: true, retryable: false })
            attempts.push(skipped)
            await emitCaptchaEvent(context, { type: "captcha:provider-skip", provider: provider.name, reason: skipped.reason, captchaVersion: challenge.captchaVersion, nextProvider })
            break
          }
          challengeUsed = true
          if (challenge.captchaVersion === 3) consumedChallenges.add(challengeKey(challenge))
          await emitCaptchaEvent(context, {
            type: "captcha:provider-start",
            provider: provider.name,
            attempt: providerAttempt,
            chainAttempt,
          })
          let result = await provider.solve(challenge, providerConfig, context)
          context.signal?.throwIfAborted()
          if (result.skipped) {
            challengeUsed = false
            consumedChallenges.delete(challengeKey(challenge))
          }
          if (result.ok) {
            try { result = normalizeCaptchaSolution(result, challenge) } catch (error) {
              result = captchaFail(provider.name, error.message, { retryable: true, challengeRefresh: true, costMs: result.costMs, raw: result.raw })
            }
          }
          if (result.ok && result.captchaVersion === 4) {
            // lotNumber identifies a single verification event, regardless of
            // changes to its proof fields. captchaId only identifies the site.
            const key = JSON.stringify([result.captchaId, result.lotNumber])
            if (consumedV4Lots.has(key)) result = captchaFail(provider.name, "solution_already_used", { retryable: true, challengeRefresh: true })
            else consumedV4Lots.add(key)
          }
          if (result.ok && challenge.captchaVersion === 3 && result.captchaVersion !== 4) {
            const actualChallenge = result.challenge || challenge.challenge
            const validate = result.validate || result.token
            if (typeof actualChallenge !== "string" || !actualChallenge || typeof validate !== "string" || !validate) {
              result = captchaFail(provider.name, "invalid_v3_result", { retryable: true, challengeRefresh: true })
            } else if (submittedV3Challenges.has(actualChallenge) || submittedV3Proofs.has(validate)) {
              result = captchaFail(provider.name, "solution_already_used", { retryable: true, challengeRefresh: true })
            } else {
              // SDKs may legitimately update challenge. Consume the actual
              // returned challenge and proof before business verification, even
              // when that verification rejects the result.
              submittedV3Challenges.add(actualChallenge)
              submittedV3Proofs.add(validate)
              consumedChallenges.add(challengeKey({ ...challenge, challenge: actualChallenge }))
            }
          }
          if (result.ok && typeof context.verifyResult === "function") {
            // A Geetest token is provisional until the calling business accepts it.
            // Exceptions abort the operation; only explicit captcha rejections retry.
            const verification = await context.verifyResult(result, challenge)
            if (verification?.ok) result = { ...result, verification }
            else result = {
              ...captchaFail(provider.name, verification?.reason || "business_captcha_rejected", {
                retryable: verification?.retryable ?? true,
                challengeRefresh: verification?.challengeRefresh ?? true,
                costMs: result.costMs,
                raw: result.raw,
              }),
              verification,
            }
          }
          attempts.push(result)

          if (result.ok) {
            await emitCaptchaEvent(context, {
              type: "captcha:success",
              provider: result.provider,
              costMs: result.costMs,
            })
            return {
              ...result,
              attempts,
            }
          }

          lastFailure = result
          await emitCaptchaEvent(context, {
            type: result.skipped ? "captcha:provider-skip" : "captcha:provider-fail",
            provider: result.provider || provider.name,
            reason: result.reason,
            code: typeof result.code === "number" && Number.isFinite(result.code) ? result.code : undefined,
            retryable: result.retryable,
            fatal: result.fatal,
            challengeRefresh: result.challengeRefresh,
            attempt: providerAttempt,
            chainAttempt,
            nextProvider: providerAttempt < attemptLimit ? provider.name : nextProvider,
          })

          if (result.fatal) {
            // Invalid API credentials or exhausted balance stop this provider,
            // while local/manual alternatives remain available.
            break
          }

          if (result.skipped) break
          if (result.retryable === false && !result.challengeRefresh) break
        }
      }
    }

    const failed = {
      ...captchaFail(lastFailure?.provider || null, lastFailure?.reason || "all_providers_failed", {
        retryable: true,
        manualLink: findManualLink(attempts),
      }),
      attempts,
    }
    await emitCaptchaEvent(context, {
      type: "captcha:fail",
      provider: failed.provider,
      reason: failed.reason,
      attempts,
    })
    return failed
  }

  providerOrder(context = {}) {
    // Business callers may restrict this attempt to unattended providers.
    // Provider configuration (including enable/key) remains authoritative.
    const configured = context.providerOrder ?? this.config.providers ?? ["test_nine", "ttocr", "gtmanual"]
    if (!Array.isArray(configured)) throw new Error("captcha providerOrder must be an array")
    return configured.map(name => normalizeProviderName(name)).filter(Boolean)
  }

  providerConfig(providerName, canonicalName = providerName) {
    return {
      ...(this.config[canonicalName] || {}),
      ...(this.config[providerName] || {}),
    }
  }

  maxChallengeRefreshAttempts(context = {}, retryPlan = {}) {
    if (typeof context.maxChallengeRefreshAttempts === "number") {
      return Math.max(0, context.maxChallengeRefreshAttempts)
    }
    if (this.config.refresh?.enable_on_challenge_used === false) return 0
    const derived = Math.max(
      0,
      Number(retryPlan.order?.length || this.providerOrder().length || 1)
        * Number(retryPlan.providerAttempts || this.providerAttemptLimit(context) || 1)
        * Number(retryPlan.chainAttempts || this.chainAttemptLimit(context) || 1),
    )
    return Math.max(0, Number(this.config.refresh?.max_attempts ?? derived), derived)
  }

  async refreshChallenge(challenge, result, attempts, context) {
    if (typeof context.refreshChallenge !== "function") return null

    await emitCaptchaEvent(context, {
      type: "captcha:refresh-challenge",
      provider: result.provider,
      reason: result.reason,
    })
    const next = await context.refreshChallenge({
      challenge,
      failedResult: result,
      attempts: [...attempts],
    })
    if (!next) return null

    try {
      const refreshed = normalizeCaptchaChallenge(next)
      attempts.push({
        ok: true,
        provider: "challenge_refresh",
        reason: "challenge_refreshed",
        gt: mask(refreshed.gt),
        challenge: mask(refreshed.challenge),
      })
      return refreshed
    } catch (error) {
      attempts.push(captchaFail("challenge_refresh", error.message, {
        fatal: true,
        retryable: false,
      }))
      return null
    }
  }

  providerAttemptLimit(context = {}, providerName = "") {
    if (providerName === "gtmanual") return 1
    if (typeof context.providerAttempts === "number") {
      return Math.max(1, Math.floor(context.providerAttempts))
    }
    const configured = this.config.retry?.provider_attempts
    if (Number.isFinite(configured)) return Math.max(1, Math.floor(configured))
    const retries = this.config.retry?.provider_retries
    if (Number.isFinite(retries)) return Math.max(1, Math.floor(retries) + 1)
    return 3
  }

  chainAttemptLimit(context = {}) {
    if (typeof context.chainAttempts === "number") {
      return Math.max(1, Math.floor(context.chainAttempts))
    }
    const configured = this.config.retry?.chain_attempts
    if (Number.isFinite(configured)) return Math.max(1, Math.floor(configured))
    const retries = this.config.retry?.chain_retries
    if (Number.isFinite(retries)) return Math.max(1, Math.floor(retries) + 1)
    return 2
  }
}

export async function createCaptchaService(config) {
  const globalConfig = config || (await loadGlobalConfig()).captcha || {}
  return new CaptchaService(globalConfig)
}

export async function solveCaptcha(challenge, context = {}) {
  const service = await createCaptchaService(context.config?.captcha)
  return service.solveCaptcha(challenge, context)
}

function normalizeProviderName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, "_")
}

function challengeKey(challenge) {
  return JSON.stringify([challenge.gt, challenge.challenge])
}

function nextProviderName(order, currentIndex) {
  for (let index = currentIndex + 1; index < order.length; index += 1) {
    const name = order[index]
    const provider = PROVIDERS[name]
    if (provider?.name) return provider.name
    if (name) return name
  }
  return ""
}

function mask(value = "") {
  const text = String(value || "")
  if (text.length <= 8) return text ? "***" : ""
  return `${text.slice(0, 4)}***${text.slice(-4)}`
}

function findManualLink(attempts = []) {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]
    if (attempt?.manualLink) return attempt.manualLink
    if (attempt?.link) return attempt.link
    const rawLink = attempt?.raw?.data?.link || attempt?.raw?.link
    if (rawLink) return rawLink
  }
  return ""
}
