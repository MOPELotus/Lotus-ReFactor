export async function emitCaptchaEvent(context = {}, event = {}) {
  if (typeof context.onCaptchaEvent === "function") {
    await context.onCaptchaEvent({
      ...event,
      message: event.message || formatCaptchaMessage(event),
    })
  }
}

export function formatCaptchaMessage(event = {}) {
  const providerLabel = providerName(event.provider)
  const nextProviderLabel = providerName(event.nextProvider)
  const elapsed = formatElapsed(event.elapsedMs)
  switch (event.type) {
    case "captcha:start":
      return "[荷花插件]遇到验证码，正在尝试过码。"
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
      return `[荷花插件]全部自动方案失败，请点击链接手动过码：${event.link}`
    case "captcha:success":
      return `[荷花插件]验证码已通过，使用方案：${providerLabel}。`
    case "captcha:fail":
      return event.manualLink
        ? `[荷花插件]全部方案失败，无法通过验证码，请点击链接手动过码：${event.manualLink}`
        : "[荷花插件]全部方案失败，无法通过验证码。"
    default:
      return ""
  }
}

function providerName(provider) {
  const names = {
    test_nine: "方案一 test_nine",
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
