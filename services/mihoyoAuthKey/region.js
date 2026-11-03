import { inferServerFromUid } from "../../core/mihoyo/regions.js"

const CN_REGIONS = Object.freeze({
  gs: new Set(["cn_gf01", "cn_qd01"]),
  sr: new Set(["prod_gf_cn", "prod_qd_cn"]),
  zzz: new Set(["prod_gf_cn", "prod_qd_cn"]),
})

// These APIs use Chinese passport credentials. Unknown regions must not fall
// through to their Chinese endpoints, even if a caller supplies a valid token.
export function requireCnGachaRegion({ region, uid, game = "gs" } = {}) {
  let target = String(region || "").trim()
  if (!target) {
    const text = String(uid || "")
    const knownCnUid = game === "zzz" ? /^[1-9]\d{7,8}$/.test(text) : /^[125]\d{8}$/.test(text)
    if (knownCnUid) target = inferServerFromUid(text, game)
  }
  if (!CN_REGIONS[game]?.has(target)) {
    throw new Error("自动获取抽卡凭据目前仅支持已确认的国服分区；海外服请使用官方抽卡链接，绝区零也可尝试 CK 直刷")
  }
  return target
}
