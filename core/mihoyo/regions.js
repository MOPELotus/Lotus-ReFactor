const UNKNOWN_SERVER_VALUES = new Set(["", "unknown", "undefined", "null", "none", "-"])

export function normalizeServer(value = "") {
  return String(value || "").trim()
}

export function isUnknownServer(server = "") {
  return UNKNOWN_SERVER_VALUES.has(normalizeServer(server).toLowerCase())
}

export function isCnServer(server = "") {
  const text = normalizeServer(server).toLowerCase()
  if (isUnknownServer(text)) return true

  if (/(?:^|_)global(?:_|$)/.test(text)) return false
  if (/^(os_|prod_official_)/.test(text)) return false
  if (/^prod_gf_(?:us|eu|jp|sg)$/.test(text)) return false
  if (/(?:^|_)(?:usa|euro|asia|cht|us|eu|jp|sg)(?:_|$)/.test(text)) return false

  if (/^(?:hk4e|hkrpg|nap)_cn$/.test(text)) return true
  if (/(?:^|_)cn(?:_|$)/.test(text)) return true
  if (/^prod_(?:gf|qd)_cn$/.test(text)) return true
  return true
}

export function inferServerFromUid(uid, game = "gs") {
  const text = String(uid || "")
  const prefix = text.slice(0, -8)

  if (game === "zzz") {
    if (text.length < 10) return "prod_gf_cn"
    if (prefix === "10") return "prod_gf_us"
    if (prefix === "15") return "prod_gf_eu"
    if (prefix === "13") return "prod_gf_jp"
    if (prefix === "17") return "prod_gf_sg"
    return "prod_gf_cn"
  }

  if (game === "sr") {
    if (prefix === "5") return "prod_qd_cn"
    if (prefix === "6") return "prod_official_usa"
    if (prefix === "7") return "prod_official_euro"
    if (prefix === "8" || prefix === "18") return "prod_official_asia"
    if (prefix === "9") return "prod_official_cht"
    return "prod_gf_cn"
  }

  if (prefix === "5") return "cn_qd01"
  if (prefix === "6") return "os_usa"
  if (prefix === "7") return "os_euro"
  if (prefix === "8" || prefix === "18") return "os_asia"
  if (prefix === "9") return "os_cht"
  return "cn_gf01"
}

export function resolveServer({ server, uid, game = "gs", fallback = "" } = {}) {
  const explicit = normalizeServer(server)
  if (!isUnknownServer(explicit)) return explicit
  if (uid) return inferServerFromUid(uid, game)
  const fallbackServer = normalizeServer(fallback)
  return isUnknownServer(fallbackServer) ? "" : fallbackServer
}

export function sameServerSide(left = "", right = "") {
  if (isUnknownServer(left) || isUnknownServer(right)) return false
  return isCnServer(left) === isCnServer(right)
}
