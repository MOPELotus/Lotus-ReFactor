// Add games here when their official community and livestream source are available.
// A provider can be replaced independently if a future game uses another API.
export const REDEEM_GAMES = Object.freeze([
  { id: "gs", name: "原神", aliases: ["原神"], prefix: ["#"], community: "ys", gids: 2, uid: "75276539", provider: "miyolive" },
  { id: "sr", name: "星穹铁道", aliases: ["星铁", "崩铁", "星穹铁道", "崩坏星穹铁道", "崩坏：星穹铁道"], prefix: ["*"], community: "sr", gids: 6, uid: "288909600", provider: "miyolive" },
  { id: "zzz", name: "绝区零", aliases: ["绝区零", "绝区", "zzz"], prefix: ["%", "％"], community: "zzz", gids: 8, uid: "152039148", provider: "miyolive" },
  { id: "bh3", name: "崩坏三", aliases: ["崩三", "崩坏三", "崩坏3"], prefix: [], community: "bh3", gids: 1, uid: "73565430", provider: "miyolive" },
])

export const AUTO_REDEEM_GAMES = Object.freeze({
  gs: { count: 3, biz: "hk4e_cn", host: "hk4e-api.mihoyo.com", regions: ["cn_gf01", "cn_qd01"] },
  sr: { count: 3, biz: "hkrpg_cn", host: "public-operation-hkrpg.mihoyo.com", regions: ["prod_gf_cn", "prod_qd_cn"] },
  zzz: { count: 1, biz: "nap_cn", host: "public-operation-nap.mihoyo.com", regions: ["prod_gf_cn", "prod_qd_cn"] },
})

export function parseRedeemCommand(message, games = REDEEM_GAMES) {
  let text = String(message || "").trim()
  if (!/(?:兑换码|code)$/i.test(text)) return null
  const prefix = /^[#*%％/]/.test(text) ? text[0] : ""
  if (prefix) text = text.slice(1)
  text = text.replace(/(?:直播|前瞻)?(?:兑换码|code)$/i, "")
  if (text) return games.find(game => game.aliases.some(alias => alias.toLowerCase() === text.toLowerCase())) || null
  return games.find(game => game.prefix.includes(prefix)) || games.find(game => game.id === "gs")
}
