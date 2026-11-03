import { createHash } from "node:crypto"
import { listAllProfiles, loadProfile } from "../../core/config/profile.js"
import { parseCookieString } from "../../core/mihoyo/cookies.js"
import { bindMysRequestProfile } from "./mys-request-context.js"

const PATCHED = Symbol.for("lotus-plugin.zzz-direct-requests.getAPI")
const failure = () => new Error("绝区零请求的账号或设备已变化，请重新发送原指令")
const hashCookie = cookie => createHash("sha256").update(JSON.stringify(Object.entries(parseCookieString(cookie)).sort(([a], [b]) => a.localeCompare(b)))).digest("hex")
const issuedFp = value => value?.retcode === 0 && String(value.data?.code) === "200"
  && typeof value.data.device_fp === "string" && /^[0-9a-f]{13}$/i.test(value.data.device_fp)

// Only ZZZPlugin's direct getAPI bootstrap is replaced. Its URL builder retains
// the CN/OS body, headers and DS for each exact upstream endpoint.
export function installZzzDirectRequests({ ZZZPlugin, MysZZZApi, getCk,
  listProfiles = listAllProfiles, getProfile = loadProfile, now = Date.now,
} = {}) {
  const prototype = ZZZPlugin?.prototype
  if (!prototype?.getAPI || !MysZZZApi || typeof getCk !== "function") return { ok: true, skipped: true }
  if (prototype.getAPI[PATCHED]) return { ok: true, already: true }
  const attempts = new Map()
  const readProfiles = async () => { try { return await listProfiles({ skipInvalid: true }) } catch { throw failure() } }
  const readProfile = async (qq, id) => { try { return await getProfile(qq, id) } catch { throw failure() } }
  const trim = () => {
    for (const [key, value] of attempts) if (!value.pending && value.expires <= now()) attempts.delete(key)
    while (attempts.size > 1024) {
      const key = [...attempts].find(([, value]) => !value.pending)?.[0]
      if (!key) break
      attempts.delete(key)
    }
  }
  async function selectedProfile(api, e) {
    const cookieKey = hashCookie(api.cookie)
    const context = e?.lotusProfileContext
    if (context) {
      if (String(context.qq) !== String(e.user_id) || !Number.isInteger(context.profileId) || context.profileId < 1) throw failure()
      const profile = await readProfile(String(context.qq), context.profileId)
      if (String(profile?.user?.qq) !== String(context.qq) || Number(profile?.profile?.id || 1) !== context.profileId
        || !profile?.account?.cookie || hashCookie(profile.account.cookie) !== cookieKey) throw failure()
      return profile
    }
    const matches = (await readProfiles()).filter(profile => profile.account?.cookie && hashCookie(profile.account.cookie) === cookieKey)
    if (!matches.length) return null
    if (matches.length === 1) return matches[0]
    const devices = matches.filter(profile => profile.device?.id === api._device)
    if (devices.length === 1) return devices[0]
    throw failure()
  }
  async function assertCurrent(profile) {
    if (!profile) return
    const latest = await readProfile(String(profile.user.qq), Number(profile.profile?.id || 1))
    if (!latest?.account?.cookie || hashCookie(latest.account.cookie) !== hashCookie(profile.account.cookie)
      || JSON.stringify(latest.device || {}) !== JSON.stringify(profile.device || {})) throw failure()
  }
  async function bootstrap(api, profile) {
    await assertCurrent(profile)
    const data = {}
    const fpResponse = await api.getData("getFp", { ...data, Getfp: true }, false)
    if (!issuedFp(fpResponse)) throw new Error("获取设备指纹失败：官方接口未成功签发有效指纹")
    await assertCurrent(profile)
    api._device_fp = fpResponse
    const fp = fpResponse.data.device_fp
    // Native getAPI only registers newly issued CN devices. Keep that sequence,
    // using the same selected ID and signed FP, without per-account Redis writes.
    if (api.server === "prod_gf_cn") {
      for (const type of ["deviceLogin", "saveDevice"]) {
        await assertCurrent(profile)
        const result = await api.getData(type, { deviceFp: fp }, false)
        let checked
        try { checked = typeof api.checkCode === "function" ? await api.checkCode(result, type, { deviceFp: fp }) : result }
        catch { throw new Error("绝区零设备登录或保存失败") }
        if (Number(checked?.retcode) !== 0) throw new Error("绝区零设备登录或保存失败")
      }
    }
    await assertCurrent(profile)
    return fpResponse
  }
  async function getAPI() {
    this.e.game = "zzz"
    const uid = await this.getUID()
    let cookies
    try { cookies = await getCk(this.e) } catch { throw failure() }
    if (!cookies || !Object.values(cookies).some(item => item?.ck)) throw new Error("尚未绑定 cookie，请先登录")
    const api = new MysZZZApi(uid, cookies, { handler: this.e?.runtime?.handler || {}, e: this.e })
    if (typeof api.cookie !== "string" || !api.cookie) throw failure()
    const profile = await selectedProfile(api, this.e)
    if (profile) bindMysRequestProfile(api, profile)
    await assertCurrent(profile)
    // getUrl applies the proven selected profile ID before the cache key is made.
    if (!api.getUrl("getFp", {})) throw new Error("获取设备指纹请求数据失败")
    if (profile?.device?.id && profile.device.fp) return { api, uid, deviceFp: profile.device.fp }
    if (!api._device) throw failure()
    const key = `${hashCookie(api.cookie)}:${api._device}`
    trim()
    let attempt = attempts.get(key)
    if (attempt?.error && attempt.expires > now()) throw new Error("设备指纹签发暂不可用，请稍后重试")
    if (!attempt || attempt.expires <= now()) {
      attempt = { pending: true, expires: now() + 30 * 60 * 1000 }
      attempts.set(key, attempt)
      attempt.promise = bootstrap(api, profile).then(response => { attempt.response = response; attempt.expires = now() + 30 * 60 * 1000; return response }, error => { attempt.error = true; attempt.expires = now() + 60000; throw error }).finally(() => { attempt.pending = false; trim() })
    }
    const response = attempt.response || await attempt.promise
    await assertCurrent(profile)
    api._device_fp = response
    return { api, uid, deviceFp: response.data.device_fp }
  }
  Object.defineProperty(getAPI, PATCHED, { value: true })
  prototype.getAPI = getAPI
  return { ok: true }
}
