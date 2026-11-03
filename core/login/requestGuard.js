import { loadProfile, getProfileLifetime, getProfileSnapshotGuard } from "../config/profile.js"
import { accountChangedError, getAccountGeneration } from "./account.js"
import { assertLoginProfileUnchanged } from "./refresh.js"

const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const credentials = profile => stable(Object.fromEntries([
  "cookie", "stoken", "stoken_cookie", "ltuid", "stuid", "mid", "ltoken", "cookie_token",
].map(key => [key, String(profile?.account?.[key] || "")])))

// Build this before creating request-specific CN/HoYoLAB copies of a profile.
// Unmarked custom fixtures remain opt-in; a clone cannot recover historical
// login generations that were lost before it reached this boundary.
export function createProfileRequestGuard(profile, options = {}) {
  const marker = getProfileSnapshotGuard(profile)
  if (!marker && !options.loadProfile && options.expectedGeneration === undefined && options.expectedLifetime === undefined) return undefined
  const qq = String(options.qq || profile?.user?.qq || "")
  const profileId = Number(options.profileId || profile?.profile?.id || 1)
  const generation = options.expectedGeneration ?? marker?.generation
  const lifetime = options.expectedLifetime ?? marker?.lifetime
  const expected = structuredClone(profile)
  const read = options.loadProfile || loadProfile
  const changed = () => { throw accountChangedError("登录账号或设备已变化，本次操作已停止，请重新发送原指令。") }
  if (marker && (marker.qq !== qq || marker.profileId !== profileId)) changed()
  return async ({ overseas = false, profile: selected, tokenOnly = false } = {}) => {
    if ((generation !== undefined && generation !== getAccountGeneration(qq, profileId))
      || (lifetime !== undefined && lifetime !== getProfileLifetime(qq, profileId))) changed()
    let current
    try { current = await read(qq, profileId) } catch { changed() }
    if (expected.account?.stuid || expected.account?.ltuid) {
      assertLoginProfileUnchanged(expected, current, { qq, profileId, expectedGeneration: generation, expectedLifetime: lifetime })
    }
    if ((generation !== undefined && generation !== getAccountGeneration(qq, profileId))
      || (lifetime !== undefined && lifetime !== getProfileLifetime(qq, profileId))
      || credentials(expected) !== credentials(current)
      || String(current?.user?.qq || "") !== qq
      || Number(current?.profile?.id || 1) !== profileId
      || stable(expected.device || {}) !== stable(current?.device || {})
      || stable(expected.cloud_games || {}) !== stable(current?.cloud_games || {})
      || String(expected.games?.os?.cookie || "") !== String(current?.games?.os?.cookie || "")) changed()
    const cookie = overseas ? expected.games?.os?.cookie : expected.account?.cookie
    if (!tokenOnly && selected && String(selected.account?.cookie || "") !== String(cookie || "")) changed()
  }
}
