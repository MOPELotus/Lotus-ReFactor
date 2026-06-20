export function parseCookieString(cookie = "") {
  const result = {}
  for (const item of String(cookie || "").split(";")) {
    const index = item.indexOf("=")
    if (index <= 0) continue
    const key = item.slice(0, index).trim()
    const value = item.slice(index + 1).trim()
    if (key) result[key] = value
  }
  return result
}

export function serializeCookie(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(";") + ";"
}

export function parseStokenCookie(stoken = "") {
  const data = parseCookieString(stoken)
  return {
    stuid: data.stuid || data.uid || "",
    stoken: data.stoken || "",
    ltoken: data.ltoken || data.ltoken_v2 || "",
    mid: data.mid || data.account_mid_v2 || data.ltmid_v2 || "",
  }
}

export function parseAccountCookie(cookie = "") {
  const data = parseCookieString(cookie)
  return {
    ltuid: data.ltuid || data.ltuid_v2 || data.account_id || data.account_id_v2 || "",
    ltoken: data.ltoken || data.ltoken_v2 || "",
    cookie_token: data.cookie_token || data.cookie_token_v2 || "",
    account_id: data.account_id || data.account_id_v2 || data.ltuid || data.ltuid_v2 || "",
  }
}

export function buildStokenCookie({ stuid, stoken, ltoken, mid } = {}) {
  return serializeCookie({
    stoken,
    stuid,
    ltoken,
    mid,
  })
}

export function buildAccountCookie({ ltuid, ltoken, cookieToken } = {}) {
  return serializeCookie({
    ltoken,
    ltuid,
    cookie_token: cookieToken,
    account_id: ltuid,
  })
}

export function maskSecret(value = "") {
  const text = String(value || "")
  if (!text) return ""
  if (text.length <= 8) return "***"
  return `${text.slice(0, 4)}***${text.slice(-4)}`
}
