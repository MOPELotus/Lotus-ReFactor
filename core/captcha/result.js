export function captchaOk(provider, data = {}) {
  if (captchaVersion(data) === 4) {
    return { ok: true, provider, captchaVersion: 4, ...normalizeCaptchaV4Solution(data), costMs: data.costMs || 0, raw: data.raw }
  }
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
    manualLink: options.manualLink || options.link || "",
    resultUrl: options.resultUrl || "",
    costMs: options.costMs || 0,
    raw: options.raw,
  }
}

export function normalizeCaptchaChallenge(challenge = {}) {
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) throw new Error("无效的验证码参数")
  if (captchaVersion(challenge) === 4) {
    const captchaId = challenge.captchaId || challenge.captcha_id
    if (typeof captchaId !== "string" || !captchaId.trim()) throw new Error("captcha_id is required for Geetest v4")
    return { ...challenge, captchaVersion: 4, captchaId, captcha_id: captchaId }
  }
  const gt = challenge.gt || challenge.geetest_gt
  const challengeValue = challenge.challenge || challenge.geetest_challenge || ""

  if (!gt) throw new Error("captcha gt is required")
  if (!challengeValue) throw new Error("captcha challenge is required")
  return {
    ...challenge,
    captchaVersion: 3,
    gt,
    challenge: challengeValue,
  }
}

export function captchaVersion(challenge = {}) {
  const explicit = String(challenge?.captchaVersion || challenge?.captcha_version || challenge?.version || "").toLowerCase()
  if (["4", "v4", "geetest_v4"].includes(explicit)
    || ["lot_number", "captcha_output", "pass_token", "gen_time", "lotNumber", "captchaOutput", "passToken", "genTime"]
      .some(key => Object.prototype.hasOwnProperty.call(challenge || {}, key))) return 4
  // Some v3 monitoring payloads also call the site key captcha_id. A real
  // gt + challenge pair is stronger evidence than that ambiguous alias.
  if ((challenge?.gt || challenge?.geetest_gt) && (challenge?.challenge || challenge?.geetest_challenge)) return 3
  if (challenge?.captcha_id || challenge?.captchaId) return 4
  if (challenge?.gt || challenge?.geetest_gt) return 3
  return null
}

// Provider adapters inspect these envelopes before extracting legacy v3 fields,
// so an explicit v4 response cannot lose its version during decoding.
export function hasCaptchaV4Response(data, depth = 0) {
  if (!data || typeof data !== "object" || Array.isArray(data) || depth > 3) return false
  if (captchaVersion(data) === 4) return true
  return ["data", "result", "request"].some(key => hasCaptchaV4Response(data[key], depth + 1))
}

export function normalizeCaptchaSolution(data, challenge) {
  if (!data || typeof data !== "object" || Array.isArray(data) || data.ok !== true) throw new Error("invalid_captcha_result")
  const expectedVersion = captchaVersion(challenge)
  const returnedVersion = captchaVersion(data) || (data.validate || data.token ? 3 : null)
  const declaredVersion = String(data.captchaVersion || data.captcha_version || data.version || "").toLowerCase()
  if (returnedVersion !== expectedVersion || (["3", "v3", "geetest_v3"].includes(declaredVersion) && returnedVersion !== 3)) throw new Error("captcha_result_version_mismatch")
  if (expectedVersion === 4) {
    const { validate, token, seccode, ...result } = data
    let proof
    try { proof = normalizeCaptchaV4Solution(data, challenge.captchaId || challenge.captcha_id) } catch { throw new Error("invalid_v4_result") }
    return { ...result, captchaVersion: 4, ...proof }
  }
  const actualChallenge = data.challenge || challenge.challenge
  const validate = data.validate || data.token
  if (![actualChallenge, validate].every(value => typeof value === "string" && value.trim())) throw new Error("invalid_v3_result")
  if (data.seccode !== undefined && data.seccode !== "" && (typeof data.seccode !== "string" || !data.seccode.trim())) throw new Error("invalid_v3_result")
  return { ...data, captchaVersion: 3, challenge: actualChallenge, validate, token: validate, seccode: data.seccode || `${validate}|jordan` }
}

export function normalizeCaptchaV4Solution(data = {}, expectedCaptchaId = "") {
  const result = {
    captchaId: data.captchaId || data.captcha_id || expectedCaptchaId,
    lotNumber: data.lotNumber || data.lot_number,
    captchaOutput: data.captchaOutput || data.captcha_output,
    passToken: data.passToken || data.pass_token,
    genTime: data.genTime ?? data.gen_time,
  }
  if (typeof result.genTime === "number" && Number.isFinite(result.genTime)) result.genTime = String(result.genTime)
  if (Object.values(result).some(value => typeof value !== "string" || !value.trim())) throw new Error("incomplete Geetest v4 solution")
  if (!/^\d+$/.test(result.genTime)) throw new Error("invalid Geetest v4 gen_time")
  if (expectedCaptchaId && result.captchaId !== expectedCaptchaId) throw new Error("Geetest v4 captcha_id mismatch")
  return result
}
