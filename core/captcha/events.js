export async function emitCaptchaEvent(context = {}, event = {}) {
  logCaptchaEvent(event)
  if (typeof context.onCaptchaEvent === "function") {
    const publicEvent = publicCaptchaEvent(event)
    await context.onCaptchaEvent({
      ...publicEvent,
      message: formatCaptchaMessage(publicEvent),
      visible: isUserVisibleCaptchaEvent(publicEvent),
    })
  }
}

// Provider results remain available to the solver's caller for diagnostics.
// Notification callbacks receive only summaries: results may contain solution
// tickets, provider credentials, and private manual polling URLs at any depth.
const PUBLIC_TYPES = new Set([
  "captcha:start", "captcha:provider-start", "captcha:provider-fail", "captcha:provider-skip",
  "captcha:provider-wait", "captcha:refresh-challenge", "captcha:manual-link", "captcha:manual-legacy", "captcha:success", "captcha:fail",
])
const PUBLIC_PROVIDERS = new Set(["test_nine", "ttocr", "gtmanual", "vision_ai", "challenge_refresh"])
const PUBLIC_REASONS = new Set([
  "unknown_provider", "provider_unconfigured", "provider_disabled", "unsupported_captcha_version",
  "challenge_used", "challenge_expired", "challenge_refreshed", "challenge_refresh_failed",
  "all_providers_failed", "invalid_v3_result", "invalid_v4_result", "invalid_result", "invalid_captcha_result", "captcha_result_version_mismatch", "no_validate",
  "manual_register_failed", "manual_timeout", "manual_request_failed", "timeout", "request_failed",
  "recognition_failed", "verification_failed", "business_verification_failed", "aborted",
  "challenge_not_refreshed", "challenge_refresh_unavailable", "refresh_limit_exceeded", "refresh_failed",
  "solution_already_used", "business_captcha_rejected", "provider_retry", "provider_switch", "chain_retry",
])

function publicCaptchaEvent(event) {
  const result = publicAttempt(event)
  result.type = PUBLIC_TYPES.has(event.type) ? event.type : "captcha:unknown"
  if (typeof event.nextProvider === "string") result.nextProvider = publicProvider(event.nextProvider)
  for (const key of ["attempt", "chainAttempt", "elapsedMs", "captchaVersion"]) {
    if (typeof event[key] === "number" && Number.isFinite(event[key])) result[key] = event[key]
  }
  if (event.type === "captcha:manual-link") result.link = publicManualLink(event.link)
  if (Array.isArray(event.attempts)) result.attempts = event.attempts.map(publicAttempt)
  return result
}

function publicAttempt(attempt = {}) {
  const result = {}
  if (!attempt || typeof attempt !== "object") return result
  if (typeof attempt.provider === "string") result.provider = publicProvider(attempt.provider)
  if (attempt.reason) result.reason = publicReason(attempt.reason)
  for (const key of ["ok", "retryable", "fatal", "skipped", "challengeRefresh"]) {
    if (typeof attempt[key] === "boolean") result[key] = attempt[key]
  }
  for (const key of ["costMs", "code"]) {
    if (typeof attempt[key] === "number" && Number.isFinite(attempt[key])) result[key] = attempt[key]
  }
  return result
}

function publicProvider(value) {
  return PUBLIC_PROVIDERS.has(value) ? value : "unknown"
}

function publicReason(value) {
  return PUBLIC_REASONS.has(value) ? value : "provider_error"
}

function publicManualLink(value) {
  try {
    const url = new URL(value)
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch {}
  return ""
}

export function isUserVisibleCaptchaEvent(event = {}) {
  return ["captcha:start", "captcha:manual-link", "captcha:manual-legacy", "captcha:success", "captcha:fail"].includes(event.type)
}

export function formatCaptchaMessage(event = {}) {
  const providerLabel = providerName(event.provider)
  const nextProviderLabel = providerName(event.nextProvider)
  const elapsed = formatElapsed(event.elapsedMs)
  switch (event.type) {
    case "captcha:start":
      return "[荷花插件]当前操作需要验证码，正在自动验证，请稍等。"
    case "captcha:provider-start":
      return `[荷花插件]正在尝试${providerLabel}。`
    case "captcha:provider-fail":
      return event.nextProvider
        ? `[荷花插件]${providerLabel}失败，正在尝试${nextProviderLabel}。`
        : `[荷花插件]${providerLabel}失败。`
    case "captcha:provider-skip":
      return event.nextProvider
        ? `[荷花插件]${providerLabel}未配置或不可用，已跳过，正在尝试${nextProviderLabel}。`
        : `[荷花插件]${providerLabel}未配置或不可用，已跳过。`
    case "captcha:provider-wait":
      if (event.provider === "gtmanual") {
        return `[荷花插件]正在等待手动过码完成${elapsed}。`
      }
      return `[荷花插件]${providerLabel}仍在处理中${elapsed}，请稍等。`
    case "captcha:refresh-challenge":
      return "[荷花插件]当前验证码参数已失效，正在重新请求验证码。"
    case "captcha:manual-link":
      return `[荷花插件]自动验证未通过，需要你手动完成验证：${event.link}`
    case "captcha:manual-legacy":
      return "[荷花插件]当前外部人工验证服务为旧版，仅支持部分极验 v3。建议机器人主人启用荷花内置人工验证服务，或更新外部 GT-Manual。"
    case "captcha:success":
      return "[荷花插件]验证码已通过，正在继续处理原请求。"
    case "captcha:fail":
      if (event.reason === "manual_timeout" || event.attempts?.some(attempt => attempt?.reason === "manual_timeout")) {
        return "[荷花插件]本次人工验证等待已结束，请重新发送原指令，并使用新链接完成验证。"
      }
      if (event.attempts?.some(attempt => attempt?.provider === "ttocr" && attempt?.code === 4039)) {
        return "[荷花插件]本次验证未完成；其中 ttocr 连接目标主机或代理失败（4039）。可稍后重试，或到对应官方页面完成验证。"
      }
      return "[荷花插件]本次验证码未通过，请稍后重新发送原指令。"
    default:
      return ""
  }
}

function logCaptchaEvent(event = {}) {
  if (!event?.type) return
  const parts = [
    event.type,
    event.provider ? `provider=${event.provider}` : "",
    event.nextProvider ? `next=${event.nextProvider}` : "",
    event.reason ? `reason=${publicReason(event.reason)}` : "",
    typeof event.code === "number" && Number.isFinite(event.code) ? `code=${event.code}` : "",
    event.retryable !== undefined ? `retryable=${event.retryable}` : "",
    event.fatal !== undefined ? `fatal=${event.fatal}` : "",
    event.costMs ? `costMs=${event.costMs}` : "",
    event.manualLink ? "manualLink=yes" : "",
  ].filter(Boolean)
  globalThis.logger?.mark?.(`[Lotus-Plugin] captcha ${parts.join(" ")}`)
}

function providerName(provider) {
  const names = {
    test_nine: "方案一 本地识别",
    ttocr: "方案二 ttocr",
    gtmanual: "方案三 GT-Manual",
    vision_ai: "视觉 AI",
    challenge_refresh: "验证码刷新",
  }
  return names[provider] || provider || "当前方案"
}

function formatElapsed(elapsedMs) {
  const seconds = Math.floor(Number(elapsedMs || 0) / 1000)
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  if (seconds < 60) return `，已等待 ${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `，已等待 ${minutes} 分 ${rest} 秒` : `，已等待 ${minutes} 分钟`
}
