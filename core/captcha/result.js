export function captchaOk(provider, data = {}) {
  return {
    ok: true,
    provider,
    token: data.token || data.validate || "",
    challenge: data.challenge || "",
    validate: data.validate || data.token || "",
    seccode: data.seccode || (data.validate ? `${data.validate}|jordan` : ""),
    costMs: data.costMs || 0,
    raw: data.raw,
  }
}

export function captchaFail(provider, reason, options = {}) {
  return {
    ok: false,
    provider,
    reason,
    retryable: options.retryable ?? true,
    fatal: options.fatal ?? false,
    skipped: options.skipped ?? false,
    code: options.code,
    challengeRefresh: options.challengeRefresh ?? false,
    costMs: options.costMs || 0,
    raw: options.raw,
  }
}

export function normalizeCaptchaChallenge(challenge = {}) {
  const gt = challenge.gt || challenge.geetest_gt || challenge.captchaId || challenge.captcha_id
  const challengeValue = challenge.challenge || challenge.geetest_challenge || ""

  if (!gt) throw new Error("captcha gt is required")
  return {
    ...challenge,
    gt,
    challenge: challengeValue,
  }
}
