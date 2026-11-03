import { buildAccountCookie, buildStokenCookie, parseStokenCookie, parseAccountCookie, parseCookieString, cookieUidValues } from "../mihoyo/cookies.js"

export function readStokenCredentials(account = {}) {
  const parsed = parseStokenCookie(account.stoken_cookie)
  const cookie = parseAccountCookie(account.cookie)
  const stokenFields = parseCookieString(account.stoken_cookie)
  const authoritative = [account.stuid, stokenFields.stuid, stokenFields.uid]
    .filter(value => value !== undefined && value !== null && String(value).trim() !== "")
    .map(value => String(value).trim())
  const candidates = authoritative.length ? authoritative : [account.ltuid, ...cookieUidValues(account.stoken_cookie), ...cookieUidValues(account.cookie)]
    .filter(value => value !== undefined && value !== null && String(value).trim() !== "")
    .map(value => String(value).trim())
  if (new Set(candidates).size > 1) throw new Error("conflicting stoken account ids; original credentials retained")
  return {
    stuid: candidates[0] || "",
    stoken: account.stoken || parsed.stoken || "",
    mid: account.mid || parsed.mid || cookie.mid || "",
  }
}

export async function exchangeStokenCredentials(client, credentials) {
  const { stuid, stoken, mid } = credentials
  if (!stuid || !stoken) throw exchangeError("ltoken", "missing_credentials", "account has no stoken")
  const lt = await requestToken("ltoken", () => client.getLtokenByStoken({ stuid, stoken, mid }))
  if (lt?.retcode !== 0) throw exchangeError("ltoken", "business", "ltoken refresh failed; original credentials retained", { retcode: lt?.retcode })
  const ltoken = lt.data?.ltoken || lt.data?.token?.token
  if (!ltoken) throw exchangeError("ltoken", "missing_token", "ltoken refresh returned no token")
  assertReturnedUid(lt.data, stuid, false, mid, "ltoken")

  const ck = await requestToken("cookie_token", () => client.getCookieTokenByStoken({ stuid, stoken, mid }))
  if (ck?.retcode !== 0) throw exchangeError("cookie_token", "business", "cookie_token refresh failed; original credentials retained", { retcode: ck?.retcode })
  const cookieToken = ck.data?.cookie_token
  if (!cookieToken) throw exchangeError("cookie_token", "missing_token", "cookie_token refresh returned no token")
  assertReturnedUid(ck.data, stuid, true, mid, "cookie_token")
  try {
    return {
      cookie: buildAccountCookie({ ltuid: stuid, ltoken, cookieToken, mid }),
      stoken: buildStokenCookie({ stuid, stoken, ltoken, mid }),
    }
  } catch {
    throw exchangeError("cookie_token", "credential_format", "token exchange returned invalid credential format; original credentials retained")
  }
}

const FAILURE_REASONS = new Set(["missing_credentials", "request", "http", "business", "missing_token", "uid_mismatch", "mid_mismatch", "credential_format"])

function numericCode(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^-?\d{1,10}$/.test(value))) return undefined
  const number = Number(value)
  return Number.isInteger(number) && number >= -2147483648 && number <= 2147483647 ? number : undefined
}

function exchangeError(stage, reason, message, details = {}) {
  const error = new Error(message)
  error.code = "LOTUS_CREDENTIAL_EXCHANGE_FAILED"
  error.stage = stage
  error.reason = reason
  const retcode = numericCode(details.retcode)
  const status = numericCode(details.status)
  if (retcode !== undefined) error.retcode = retcode
  if (status >= 100 && status <= 599) error.status = status
  return error
}

async function requestToken(stage, operation) {
  try {
    return await operation()
  } catch (error) {
    // Do not retain the upstream message, cause, response body, URL or data.
    const status = numericCode(error?.status)
    throw exchangeError(stage, status >= 100 && status <= 599 ? "http" : "request", `${stage} refresh request failed; original credentials retained`, { status })
  }
}

export function credentialExchangeDiagnostics(error) {
  if (error?.code !== "LOTUS_CREDENTIAL_EXCHANGE_FAILED" || !["ltoken", "cookie_token"].includes(error.stage)) return {}
  const result = { stage: error.stage }
  if (FAILURE_REASONS.has(error.reason)) result.reason = error.reason
  const retcode = numericCode(error.retcode)
  const status = numericCode(error.status)
  if (retcode !== undefined) result.retcode = retcode
  if (status >= 100 && status <= 599) result.status = status
  return result
}

function assertReturnedUid(data, expected, required = false, expectedMid = "", stage) {
  const ids = [data?.uid, data?.aid, data?.account_id, data?.user_info?.aid, data?.user_info?.uid]
    .filter(value => value !== undefined && value !== null && String(value) !== "")
  if ((required && !ids.length) || ids.some(uid => String(uid) !== String(expected))) {
    throw exchangeError(stage, "uid_mismatch", "token exchange account id mismatch; original credentials retained")
  }
  const mids = [data?.mid, data?.user_info?.mid, data?.account_mid_v2].filter(Boolean)
  if (mids.some(mid => !expectedMid || String(mid) !== String(expectedMid))) {
    throw exchangeError(stage, "mid_mismatch", "token exchange account mid mismatch; original credentials retained")
  }
}
