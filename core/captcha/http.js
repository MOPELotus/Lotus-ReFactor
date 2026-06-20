export async function requestJson(url, options = {}, context = {}) {
  const fetchImpl = context.fetch || globalThis.fetch
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable")

  const timeoutMs = Number(options.timeoutMs || 30000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    })
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      const error = new Error(`invalid json response from ${url}: ${text.slice(0, 300)}`)
      error.rawText = text
      throw error
    }

    if (!response.ok) {
      const error = new Error(`http ${response.status} ${response.statusText}`)
      error.status = response.status
      error.data = data
      throw error
    }

    return data
  } finally {
    clearTimeout(timer)
  }
}

export function withQuery(endpoint, query = {}) {
  const url = new URL(endpoint)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

export function formBody(fields = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value))
    }
  }
  return params
}

export function mergeQueryString(fields = {}, queryString = "") {
  const result = { ...fields }
  const query = String(queryString || "").replace(/^\?/, "")
  if (!query) return result

  for (const [key, value] of new URLSearchParams(query)) {
    if (key && value !== "") result[key] = value
  }
  return result
}

export function appendKey(fields, key) {
  const raw = String(key || "").trim()
  if (!raw) return fields
  if (raw.includes("=")) return mergeQueryString(fields, raw)
  return {
    ...fields,
    appkey: raw,
  }
}

export function sleep(ms, context = {}) {
  if (typeof context.sleep === "function") return context.sleep(ms)
  return new Promise(resolve => setTimeout(resolve, ms))
}
