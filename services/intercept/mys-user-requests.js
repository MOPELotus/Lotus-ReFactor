import { listAllProfiles } from "../../core/config/profile.js"
import { refreshAccountAndSync } from "../../core/login/refresh.js"
import { parseCookieString } from "../../core/mihoyo/cookies.js"
import { bindMysApiOwner, bindMysRequestProfile, installMysRequestCompatibility } from "./mys-request-context.js"

const PATCHED = Symbol.for("lotus-plugin.mys-user-requests")
const AUTH_CODES = new Set([-100, 10001, 10101, 10102, 10103])
const canonicalCookie = cookie => JSON.stringify(Object.entries(parseCookieString(cookie)).sort(([a], [b]) => a.localeCompare(b)))

// These two canonical-account reads use a Web/Cookie protocol, not record DS.
// A gate checks Lotus ownership without adding its headers to the Web request.
export function installMysUserRequests({ MysUser, listProfiles = listAllProfiles,
  refreshProfile = refreshAccountAndSync,
} = {}) {
  const prototype = MysUser?.prototype
  if (!prototype) return { ok: true, skipped: true }
  const gates = new WeakMap()
  const readProfiles = async () => {
    try { return await listProfiles({ skipInvalid: true }) }
    catch { throw new Error("无法读取米游社账号上下文，请稍后重试") }
  }
  class CanonicalReadGate {
    constructor(owner) { this.cookie = owner.ck; this._device = owner.device || ""; this.option = {} }
    get device() { return this._device }
    async getData(_type, data) { return data.operation(data.headers || {}) }
  }
  installMysRequestCompatibility({ MysApi: CanonicalReadGate, MysUser, listProfiles: readProfiles })
  let installed = 0
  for (const name of ["getGameRole", "getUserFullInfo"]) {
    const original = prototype[name]
    if (typeof original !== "function" || original[PATCHED]) continue
    async function read(serv = "mys", ...args) {
      const cookie = this.ck
      let gate = gates.get(this)
      if (!gate) { gate = new CanonicalReadGate(this); gates.set(this, gate) }
      gate.cookie = cookie
      bindMysApiOwner(gate, this)
      const invoke = ck => {
        const selected = Object.create(this)
        Object.defineProperty(selected, "ck", { value: ck, configurable: true })
        return Reflect.apply(original, selected, [serv, ...args])
      }
      let deviceId = ""
      const result = await gate.getData(name, { operation: headers => {
        if (canonicalCookie(this.ck) !== canonicalCookie(cookie)) throw new Error("米游社账号上下文已变化，请重新发送原指令")
        deviceId = headers["x-rpc-device_id"] || ""
        return invoke(cookie)
      } })
      if (canonicalCookie(this.ck) !== canonicalCookie(cookie)) throw new Error("米游社账号上下文已变化，请重新发送原指令")
      await gate.getData(name, { operation: () => undefined })
      // Overseas cookies have their own identity and refresh protocol. Never
      // refresh the CN account merely because the same owner requested Hoyolab.
      if (serv !== "mys" || !AUTH_CODES.has(Number(result?.retcode))) return result
      if (canonicalCookie(this.ck) !== canonicalCookie(cookie)) throw new Error("米游社账号上下文已变化，请重新发送原指令")
      const profiles = await readProfiles()
      const matches = profiles.filter(profile => profile.account?.cookie
        && canonicalCookie(profile.account.cookie) === canonicalCookie(cookie)
        && String(profile.account.ltuid || profile.account.stuid || "") === String(this.ltuid)
        && (!deviceId || profile.device?.id === deviceId))
      if (matches.length !== 1) return result
      const profile = matches[0]
      const updated = await refreshProfile(String(profile.user.qq), Number(profile.profile?.id || 1), { expectedProfile: profile })
      if (!updated?.account?.cookie) throw new Error("米游社登录刷新未返回有效凭据")
      const retry = new CanonicalReadGate({ ck: updated.account.cookie, device: updated.device?.id })
      bindMysRequestProfile(retry, updated)
      const retried = await retry.getData(name, { operation: () => invoke(updated.account.cookie) })
      await retry.getData(name, { operation: () => undefined })
      return retried
    }
    Object.defineProperty(read, PATCHED, { value: true })
    prototype[name] = read
    installed++
  }
  return { ok: true, skipped: !installed }
}
