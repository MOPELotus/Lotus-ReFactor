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
    ltoken: data.ltoken_v2 || data.ltoken || "",
    mid: data.mid || data.account_mid_v2 || data.ltmid_v2 || "",
  }
}

export function parseAccountCookie(cookie = "") {
  const data = parseCookieString(cookie)
  return {
    ltuid: data.ltuid_v2 || data.ltuid || data.account_id_v2 || data.account_id || "",
    ltoken: data.ltoken_v2 || data.ltoken || "",
    cookie_token: data.cookie_token_v2 || data.cookie_token || "",
    account_id: data.account_id_v2 || data.account_id || data.ltuid_v2 || data.ltuid || "",
    mid: data.mid || data.ltmid_v2 || data.account_mid_v2 || "",
  }
}

export function buildStokenCookie({ stuid, stoken, ltoken, mid } = {}) {
  return serializeCookie({
    stoken,
    stuid,
    ...(String(ltoken || "").startsWith("v2_")
      ? { ltoken_v2: ltoken, ltuid_v2: stuid, ltmid_v2: mid }
      : { ltoken }),
    mid,
  })
}

// Version belongs to each returned token, not to the stoken used to exchange it.
export function buildAccountCookie({ ltuid, ltoken, cookieToken, mid } = {}) {
  const fields = {}
  if (String(ltoken || "").startsWith("v2_")) {
    if (!mid) throw new Error("v2 ltoken requires mid")
    Object.assign(fields, { ltoken_v2: ltoken, ltuid_v2: ltuid, ltmid_v2: mid })
  } else {
    Object.assign(fields, { ltoken, ltuid })
  }
  if (String(cookieToken || "").startsWith("v2_")) {
    if (!mid) throw new Error("v2 cookie_token requires mid")
    Object.assign(fields, { cookie_token_v2: cookieToken, account_id_v2: ltuid, account_mid_v2: mid })
  } else {
    Object.assign(fields, { cookie_token: cookieToken, account_id: ltuid })
  }
  return serializeCookie(fields)
}

const UID_FIELDS = ["stuid", "uid", "ltuid", "ltuid_v2", "account_id", "account_id_v2"]

export function cookieUidValues(cookie = "") {
  const fields = parseCookieString(cookie)
  return UID_FIELDS.map(key => fields[key]).filter(Boolean).map(value => String(value).trim())
}

// Only malformed token families need a one-time exchange. Ordering or unrelated
// cookies do not trigger a refresh, and valid mixed v1/v2 families are supported.
export function needsAccountCookieRefresh(account = {}) {
  const fields = parseCookieString(account.cookie)
  if (!account.cookie || !(account.stoken || account.stoken_cookie)) return false
  const stokenFields = parseCookieString(account.stoken_cookie)
  const uids = [account.stuid, account.ltuid, ...cookieUidValues(account.cookie), ...cookieUidValues(account.stoken_cookie)]
    .filter(value => value !== undefined && value !== null && String(value).trim() !== "")
    .map(value => String(value).trim())
  if (new Set(uids).size > 1) return true
  if (stokenFields.ltoken?.startsWith("v2_")) return true
  if (stokenFields.ltoken_v2 && (!stokenFields.ltuid_v2 || !stokenFields.ltmid_v2)) return true
  const parsed = parseAccountCookie(account.cookie)
  if (account.ltoken && account.ltoken !== parsed.ltoken) return true
  for (const [tokenName, uidName, midName] of [
    ["ltoken", "ltuid", "ltmid_v2"],
    ["cookie_token", "account_id", "account_mid_v2"],
  ]) {
    const legacy = fields[tokenName]
    const modern = fields[`${tokenName}_v2`]
    if (legacy?.startsWith("v2_")) return true
    if (modern && (!fields[`${uidName}_v2`] || !fields[midName])) return true
    if (!legacy && !modern) return true
    const uid = modern ? fields[`${uidName}_v2`] : fields[uidName]
    if (!uid || (account.stuid && String(uid) !== String(account.stuid))) return true
  }
  return false
}

export function maskSecret(value = "") {
  const text = String(value || "")
  if (!text) return ""
  if (text.length <= 8) return "***"
  return `${text.slice(0, 4)}***${text.slice(-4)}`
}
