import { GAME_BIZ } from "./constants.js"

const GAME_BY_BIZ = Object.freeze(
  Object.fromEntries(Object.entries(GAME_BIZ).map(([game, biz]) => [biz, game])),
)

export function normalizeGameRolesFromApi(list = []) {
  const result = {
    gs: [],
    sr: [],
    zzz: [],
  }

  if (!Array.isArray(list)) return result

  for (const item of list) {
    const game = GAME_BY_BIZ[item?.game_biz]
    const uid = item?.game_uid || item?.uid
    if (!game || !uid) continue

    result[game].push({
      uid: String(uid),
      game_uid: String(uid),
      game_biz: item.game_biz,
      region: item.region || "",
      region_name: item.region_name || item.region || "",
      nickname: item.nickname || "",
      level: item.level ?? "",
      is_chosen: Boolean(item.is_chosen),
    })
  }

  for (const game of Object.keys(result)) {
    result[game] = dedupeRoles(result[game])
  }

  return result
}

export function pickCurrentUid(gameRoles = {}, current = {}) {
  const result = {
    gs: current?.gs || "",
    sr: current?.sr || "",
    zzz: current?.zzz || "",
  }

  for (const game of Object.keys(result)) {
    const roles = Array.isArray(gameRoles?.[game]) ? gameRoles[game] : []
    const known = new Set(roles.map(role => String(role?.uid || role?.game_uid || role)).filter(Boolean))
    if (result[game] && known.has(String(result[game]))) continue

    const chosen = roles.find(role => role?.is_chosen) || roles[0]
    result[game] = chosen ? String(chosen.uid || chosen.game_uid || chosen) : ""
  }

  return result
}

function dedupeRoles(roles) {
  const seen = new Set()
  const result = []
  for (const role of roles) {
    const uid = String(role.uid || role.game_uid || "")
    if (!uid || seen.has(uid)) continue
    seen.add(uid)
    result.push(role)
  }
  return result
}
