// Official game-record clients pass their original Axios config.url and the
// original response's x-trace-id to both captcha creation and verification.
// Axios URLs are relative to these exact official bases; unrelated hosts and
// paths must retain their full pathname rather than losing a matching segment.
const OFFICIAL_BASES = [
  ["https://api-takumi-record.mihoyo.com", "/event/game_record_zzz/api"],
  ["https://api-takumi-record.mihoyo.com", "/game_record/app"],
  ["https://api-takumi-record.mihoyo.com", "/game_record"],
]

export function captchaRequestContext({ url, headers, requestMetadata = {} } = {}) {
  const originalUrl = requestMetadata.url || requestMetadata.path || url
  const path = originalCaptchaPath(originalUrl)
  const traceId = String(requestMetadata.traceId || readTraceId(requestMetadata.headers) || readTraceId(headers) || "").trim()
  return { ...(path ? { path } : {}), ...(traceId ? { traceId } : {}) }
}

export function captchaContextHeaders({ path, traceId } = {}) {
  return {
    ...(path ? { "x-rpc-challenge_path": path } : {}),
    ...(traceId ? { "x-rpc-challenge_trace": traceId } : {}),
  }
}

function originalCaptchaPath(value) {
  if (!value) return ""
  const text = String(value)
  if (!/^[a-z][a-z\d+.-]*:/i.test(text) && !text.startsWith("//")) {
    return text.split(/[?#]/, 1)[0]
  }
  let target
  try { target = new URL(text) } catch { return "" }
  for (const [origin, base] of OFFICIAL_BASES) {
    if (target.origin === origin && target.pathname.startsWith(`${base}/`)) {
      return target.pathname.slice(base.length)
    }
  }
  return target.pathname
}

function readTraceId(headers) {
  if (typeof headers?.get === "function") return headers.get("x-trace-id")
  return Object.entries(headers || {}).find(([name]) => name.toLowerCase() === "x-trace-id")?.[1]
}
