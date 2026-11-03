import { createHash } from "node:crypto"
import { listAllProfiles, loadLoggedInProfile, getProfileLifetime } from "../../core/config/profile.js"
import { parseCookieString } from "../../core/mihoyo/cookies.js"
import { AuthKeyService } from "../mihoyoAuthKey/service.js"
import { assertLoginProfileUnchanged } from "../../core/login/refresh.js"
import { getAccountGeneration } from "../../core/login/account.js"
import { bindMysApiOwner, installMysRequestCompatibility } from "./mys-request-context.js"

const PATCHED = Symbol.for("lotus-plugin.zzz-authkey-requests.getGachaLink")
const cookieHash = value => createHash("sha256").update(JSON.stringify(Object.entries(parseCookieString(value)).sort(([a], [b]) => a.localeCompare(b)))).digest("hex")
const changed = () => new Error("抽卡凭据账号上下文已变化，请重新发送原指令")
const hasRole = (profile, uid) => (profile.account?.game_roles?.zzz || []).some(role => String(role.uid || role.game_uid || role) === String(uid))

export function installZzzAuthKeyRequests({ GachaLog, getZZZGachaLink,
  authKeyService = new AuthKeyService(), listProfiles = listAllProfiles, getProfile = loadLoggedInProfile,
} = {}) {
  const prototype = GachaLog?.prototype, original = prototype?.getGachaLink
  if (typeof original !== "function" || typeof getZZZGachaLink !== "function") return { ok: true, skipped: true }
  if (original[PATCHED]) return { ok: true, already: true }
  const gates = new WeakMap()
  class CanonicalAuthKeyGate {
    constructor(owner) { this.cookie = owner.ck; this._device = owner.device || ""; this.option = {} }
    get device() { return this._device }
    async getData(_type, input) { return input.operation() }
  }
  const readProfiles = async () => { try { return await listProfiles({ skipInvalid: true }) } catch { throw changed() } }
  installMysRequestCompatibility({ MysApi: CanonicalAuthKeyGate, listProfiles: readProfiles })
  async function getGachaLink() {
    const uid = await this.getUID()
    if (/^(1[0-9])[0-9]{8}/i.test(uid)) return this.reply("国际服不支持此功能")
    if (!uid) return false
    if (!this.e.isPrivate || this.e.isGroup) return this.reply("请私聊获取抽卡链接", false, { at: true })
    const uidData = this.User?.getUidData?.(uid, "zzz", this.e)
    if (!uidData || uidData.type !== "ck" || !uidData.ltuid) throw new Error("当前绝区零 UID 未绑定 cookie，请切换 UID 后尝试")
    const event = this.e, user = this.User, qq = String(event.user_id)
    const assertEvent = () => {
      const current = this.User?.getUidData?.(uid, "zzz", this.e)
      if (this.e !== event || this.User !== user || String(this.e.user_id) !== qq
        || current?.type !== "ck" || String(current.ltuid) !== String(uidData.ltuid)
        || (typeof user.getUid === "function" && String(user.getUid("zzz")) !== String(uid))) throw changed()
    }
    const owner = this.User?.mysUsers?.[uidData.ltuid]
    const context = this.e.lotusProfileContext
    let profile
    if (context) {
      if (String(context.qq) !== String(this.e.user_id) || !Number.isInteger(context.profileId) || context.profileId < 1) throw changed()
      try { profile = await getProfile(String(context.qq), context.profileId) } catch { throw changed() }
      if (String(profile?.user?.qq) !== String(context.qq) || Number(profile?.profile?.id || 1) !== context.profileId
        || !owner?.ck || String(owner.ltuid) !== String(uidData.ltuid)
        || cookieHash(owner.ck) !== cookieHash(profile.account?.cookie) || !hasRole(profile, uid)) throw changed()
    } else if (owner?.ck && String(owner.ltuid) === String(uidData.ltuid)) {
      const profiles = (await readProfiles()).filter(candidate => String(candidate.user?.qq) === String(this.e.user_id)
        && candidate.account?.cookie && cookieHash(candidate.account.cookie) === cookieHash(owner.ck) && hasRole(candidate, uid))
      if (profiles.length === 1) profile = profiles[0]
      else if (profiles.length > 1) {
        const selected = profiles.filter(candidate => candidate.device?.id && candidate.device.id === owner.device)
        if (selected.length !== 1) throw changed()
        profile = selected[0]
      }
    }
    if (profile) {
      assertEvent()
      const selectedProfile = structuredClone(profile)
      const selectedQq = String(profile.user.qq), selectedId = Number(profile.profile?.id || 1)
      const expectedGeneration = getAccountGeneration(selectedQq, selectedId), expectedLifetime = getProfileLifetime(selectedQq, selectedId)
      const key = await authKeyService.getAuthKeyForProfile({ qq: String(profile.user.qq), profileId: Number(profile.profile?.id || 1),
        profile, accountId: String(uidData.ltuid), game: "zzz", uid, region: "prod_gf_cn" })
      const link = await getZZZGachaLink(key.authkey)
      // Link building is normally synchronous, but retain a guard if upstream
      // later introduces an await before the private response.
      let latest
      try { latest = await getProfile(String(profile.user.qq), Number(profile.profile?.id || 1)) } catch { throw changed() }
      assertLoginProfileUnchanged(profile, latest, { qq: String(profile.user.qq), profileId: Number(profile.profile?.id || 1) })
      assertLoginProfileUnchanged(selectedProfile, latest, { qq: selectedQq, profileId: selectedId, expectedGeneration, expectedLifetime })
      assertEvent()
      await this.reply(link)
      return
    }
    // Independent external accounts retain their own stoken source. Guard only
    // a canonical cookie we can actually prove, never attach a Lotus profile by aid.
    let gate
    if (owner?.ck && String(owner.ltuid) === String(uidData.ltuid)) {
      gate = gates.get(owner)
      if (!gate) { gate = new CanonicalAuthKeyGate(owner); gates.set(owner, gate) }
      gate.cookie = owner.ck
      bindMysApiOwner(gate, owner)
    }
    const check = operation => {
      assertEvent()
      return gate ? gate.getData("zzzAuthKey", { operation }) : operation()
    }
    const selected = Object.create(this)
    selected.getUID = async () => uid
    selected.User = this.User
    selected.reply = (...args) => check(() => Reflect.apply(this.reply, this, args))
    const result = await check(() => Reflect.apply(original, selected, []))
    await check(() => undefined)
    return result
  }
  Object.defineProperty(getGachaLink, PATCHED, { value: true })
  prototype.getGachaLink = getGachaLink
  return { ok: true }
}
