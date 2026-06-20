import { loadGlobalConfig } from "../config/global.js"
import { gtManualProvider } from "./providers/gtManual.js"
import { testNineProvider } from "./providers/testNine.js"
import { ttocrProvider } from "./providers/ttocr.js"
import { visionAiProvider } from "./providers/visionAi.js"
import { captchaFail, normalizeCaptchaChallenge } from "./result.js"
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
    const order = this.providerOrder()
    let refreshAttempts = 0
    const maxRefreshAttempts = this.maxChallengeRefreshAttempts(context)

    await emitCaptchaEvent(context, {
      type: "captcha:start",
      providers: order,
    })

    while (true) {
      let refreshedThisRound = false

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

        const providerConfig = this.providerConfig(providerName, provider.name)
        await emitCaptchaEvent(context, {
          type: "captcha:provider-start",
          provider: provider.name,
        })
        const result = await provider.solve(challenge, providerConfig, context)
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

        await emitCaptchaEvent(context, {
          type: result.skipped ? "captcha:provider-skip" : "captcha:provider-fail",
          provider: result.provider || provider.name,
          reason: result.reason,
          retryable: result.retryable,
          fatal: result.fatal,
          challengeRefresh: result.challengeRefresh,
          nextProvider,
        })

        if (result.challengeRefresh && refreshAttempts < maxRefreshAttempts) {
          const refreshed = await this.refreshChallenge(challenge, result, attempts, context)
          if (refreshed) {
            challenge = refreshed
            refreshAttempts += 1
            refreshedThisRound = true
            break
          }
        }

        if (result.fatal || result.retryable === false) {
          await emitCaptchaEvent(context, {
            type: "captcha:fail",
            provider: result.provider,
            reason: result.reason,
            manualLink: findManualLink(attempts),
            attempts,
          })
          return {
            ...result,
            attempts,
          }
        }
      }

      if (refreshedThisRound) continue

      const failed = {
        ...captchaFail(null, "all_providers_failed", {
          retryable: true,
          manualLink: findManualLink(attempts),
        }),
        attempts,
      }
      await emitCaptchaEvent(context, {
        type: "captcha:fail",
        reason: failed.reason,
        manualLink: findManualLink(attempts),
        attempts,
      })
      return failed
    }
  }

  providerOrder() {
    const configured = this.config.providers || ["test_nine", "ttocr", "gtmanual"]
    return configured.map(name => normalizeProviderName(name)).filter(Boolean)
  }

  providerConfig(providerName, canonicalName = providerName) {
    return {
      ...(this.config[canonicalName] || {}),
      ...(this.config[providerName] || {}),
    }
  }

  maxChallengeRefreshAttempts(context = {}) {
    if (typeof context.maxChallengeRefreshAttempts === "number") {
      return Math.max(0, context.maxChallengeRefreshAttempts)
    }
    if (this.config.refresh?.enable_on_challenge_used === false) return 0
    return Math.max(0, Number(this.config.refresh?.max_attempts ?? 1))
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
