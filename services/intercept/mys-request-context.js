import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { listAllProfiles, getProfileSnapshotGuard, getProfileLifetime } from "../../core/config/profile.js"
import { parseCookieString } from "../../core/mihoyo/cookies.js"
import { MIHOYO_PROTOCOL, mihoyoUserAgent } from "../../core/mihoyo/constants.js"
import { buildDeviceFpPayload } from "../../core/devices/service.js"

const KEY = Symbol.for("lotus-plugin.mys-request-context")
const PATCHED = Symbol.for("lotus-plugin.mys-request-context.getData")
const state = globalThis[KEY] ||= { bindings: new WeakMap(), profiles: new Map(), revisions: new Map(), revision: 0, loadedAt: 0, loading: null }
const UID_KEYS = ["ltuid", "ltuid_v2", "account_id", "account_id_v2", "stuid", "stuid_v2", "login_uid"]
const MID_KEYS = ["mid", "ltmid_v2", "stmid_v2", "account_mid_v2"]
state.scope ||= new AsyncLocalStorage()
state.requests ||= new AsyncLocalStorage()
state.owners ||= new Map()
state.resolved ||= new WeakMap()
state.proven ||= new WeakMap()
state.unbound ||= new WeakMap()
state.retired ||= new Map()
const URL_PATCHED = Symbol.for("lotus-plugin.mys-request-context.getUrl")
const fail = () => new Error("米游社请求的账号或设备上下文冲突，已停止请求")
const text = value => typeof value === "string" ? value.trim() : ""

function cookieContext(cookie) {
  if (typeof cookie !== "string" || !cookie.trim()) return null
  const parts = parseCookieString(cookie)
  const ids = [...new Set(UID_KEYS.map(key => parts[key]).filter(Boolean).map(String))]
  const mids = [...new Set(MID_KEYS.map(key => parts[key]).filter(Boolean).map(String))]
  if (ids.length !== 1 || mids.length > 1) return null
  const serialized = JSON.stringify(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b)))
  return { id: ids[0], mid: mids[0] || "", key: createHash("sha256").update(serialized).digest("hex") }
}

function profileKey(profile) { return `${String(profile?.user?.qq || "")}:${Number(profile?.profile?.id || 1)}` }
function retire(record) {
  if (!record) return
  const now = Date.now()
  for (const [key, expires] of state.retired) if (expires <= now) state.retired.delete(key)
  for (const key of record.keys) state.retired.set(key, now + 30 * 60 * 1000)
  while (state.retired.size > 2048) state.retired.delete(state.retired.keys().next().value)
}

function assertCredentialCurrent(api, cookie) {
  const records = [...state.profiles.values()].filter(record => record.keys.includes(cookie.key))
  if (records.length) { state.proven.set(api, cookie.key); return }
  // Only an exact previously owned credential is revoked. A different external
  // credential for the same account remains outside Lotus's ownership.
  if (state.proven.get(api) === cookie.key || (state.retired.get(cookie.key) || 0) > Date.now()) throw fail()
}
function profileRecord(profile, requireDevice = false) {
  const cookie = cookieContext(profile?.account?.cookie)
  if (!cookie || !profile?.user?.qq || (requireDevice && !text(profile.device?.id))) return null
  const ids = [profile.account.ltuid, profile.account.stuid].filter(Boolean).map(String)
  if (ids.some(id => id !== cookie.id) || (profile.account.mid && cookie.mid && String(profile.account.mid) !== cookie.mid)) return null
  const keys = [cookie.key]
  if (profile.account.stoken && profile.account.stuid) {
    const stoken = cookieContext(`stuid=${profile.account.stuid};stoken=${profile.account.stoken};${profile.account.mid ? `mid=${profile.account.mid};` : ""}`)
    if (stoken && stoken.id === cookie.id && (!cookie.mid || !stoken.mid || cookie.mid === stoken.mid)) keys.push(stoken.key)
  }
  return { ...cookie, keys, profileKey: profileKey(profile), device: structuredClone(profile.device || {}), guard: getProfileSnapshotGuard(profile) }
}

// Registry holds credential hashes and device information, never raw cookies.
// Writers call this only after their durable profile save has succeeded.
export function updateMysProfileRegistry(profile) {
  const key = profileKey(profile)
  try {
    const record = profileRecord(profile, true)
    const previous = state.profiles.get(key)
    if (previous && (!record || previous.keys.some(key => !record.keys.includes(key)))) retire(previous)
    state.revisions.set(key, ++state.revision)
    if (record) state.profiles.set(key, record)
    else state.profiles.delete(key)
  } catch { retire(state.profiles.get(key)); state.profiles.delete(key); state.revisions.set(key, ++state.revision) }
}

export function invalidateMysProfileRegistry(qq, profileId) {
  const keys = profileId === undefined
    ? [...new Set([...state.profiles.keys(), ...state.revisions.keys()])].filter(key => key.startsWith(`${String(qq)}:`))
    : [`${String(qq)}:${Number(profileId)}`]
  for (const key of keys) { retire(state.profiles.get(key)); state.profiles.delete(key); state.revisions.set(key, ++state.revision) }
}

globalThis[Symbol.for("lotus-plugin.mys-profile-registry-hook")] = {
  update: updateMysProfileRegistry,
  invalidate: invalidateMysProfileRegistry,
}

async function refreshRegistry(listProfiles) {
  if (state.loadedAt && Date.now() - state.loadedAt < 30000) return
  if (state.loading) return state.loading
  const revision = state.revision
  state.loading = (async () => {
    const profiles = await listProfiles({ skipInvalid: true })
    const snapshot = new Map()
    for (const profile of profiles) {
      try { const record = profileRecord(profile, true); if (record) snapshot.set(record.profileKey, record) } catch { /* Invalid profile cannot supply a device. */ }
    }
    // A concurrent logout/bind/refresh must win over this asynchronous snapshot.
    for (const [key, changed] of state.revisions) if (changed > revision) {
      if (state.profiles.has(key)) snapshot.set(key, state.profiles.get(key))
      else snapshot.delete(key)
    }
    state.profiles = snapshot
    state.loadedAt = Date.now()
  })().finally(() => { state.loading = null })
  return state.loading
}

export function bindMysApiOwner(api, owner) {
  if (!api || typeof api !== "object") return api
  const cookie = cookieContext(api.cookie), owned = cookieContext(owner?.ck)
  if (cookie && owned && cookie.key === owned.key && String(owner?.ltuid || "") === cookie.id) {
    // A trusted explicit profile is stronger than an upstream canonical owner.
    state.owners.set(cookie.id, owner)
    if ([...state.profiles.values()].some(record => record.keys.includes(cookie.key))) state.proven.set(api, cookie.key)
    if (state.bindings.get(api)?.kind !== "profile") state.bindings.set(api, { kind: "owner", owner })
  }
  return api
}

export function bindMysRequestProfile(api, profile) {
  if (!api || typeof api !== "object") return api
  const record = profileRecord(profile), cookie = cookieContext(api.cookie)
  if (!record || !cookie || !record.keys.includes(cookie.key)) throw fail()
  assertProfileRecordCurrent(record)
  state.bindings.set(api, { kind: "profile", record, revision: state.revisions.get(record.profileKey) || 0 })
  return api
}

export function withMysRequestProfile(profile, operation) {
  const record = profileRecord(profile)
  if (!record) throw fail()
  assertProfileRecordCurrent(record)
  return state.scope.run({ kind: "profile", record, revision: state.revisions.get(record.profileKey) || 0 }, operation)
}

export async function prepareMysRequestRegistry({ MysUser, listProfiles = listAllProfiles } = {}) {
  await refreshRegistry(listProfiles)
  const ids = [...new Set([...state.profiles.values()].map(record => record.id))]
  for (const id of ids) {
    const owner = await MysUser?.create?.(id)
    if (owner && cookieContext(owner.ck)?.id === id && String(owner.ltuid || "") === id) state.owners.set(id, owner)
  }
  return { ok: true }
}

function headersObject(headers) {
  if (!headers) return {}
  if (typeof headers.entries === "function") return Object.fromEntries(headers.entries())
  if (typeof headers === "object" && !Array.isArray(headers)) return { ...headers }
  return null
}
function header(headers, name) {
  const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === name).map(([, value]) => String(value))
  if (new Set(values).size > 1) throw fail()
  return values[0]
}
function setHeader(headers, name, value) {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
  if (value) headers[name] = value
}

function profileBinding(api, cookie) {
  const explicit = state.bindings.get(api)?.kind === "profile" ? state.bindings.get(api) : null
  const scoped = state.scope.getStore()
  if (explicit && scoped?.kind === "profile") {
    const a = explicit.record, b = scoped.record
    if (a.profileKey !== b.profileKey || a.id !== b.id || (a.mid && b.mid && a.mid !== b.mid)
      || deviceSignature(a.device) !== deviceSignature(b.device)) throw fail()
  }
  const binding = explicit || scoped
  if (binding?.kind !== "profile") return null
  if (!binding.record.keys.includes(cookie.key)) throw fail()
  assertProfileRecordCurrent(binding.record)
  const revision = state.revisions.get(binding.record.profileKey) || 0
  if (revision !== binding.revision) {
    const latest = state.profiles.get(binding.record.profileKey)
    if (!latest || latest.key !== binding.record.key || deviceSignature(latest.device) !== deviceSignature(binding.record.device)) throw fail()
  }
  return binding.record
}

function ownerMatches(owner, cookie, records) {
  const owned = cookieContext(owner?.ck)
  if (!owned || owned.id !== cookie.id || String(owner?.ltuid || "") !== cookie.id) return false
  return owned.key === cookie.key || records.some(record => record.key === owned.key && record.keys.includes(cookie.key))
}

function deviceSignature(device = {}) {
  return JSON.stringify({
    id: text(device.id), fp: text(device.fp), name: device.name || "", model: device.model || "",
    android_version: device.android_version || "", raw: device.raw || {},
  }, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
}

function assertProfileRecordCurrent(record) {
  if (record.guard) {
    const guard = record.guard
    const generation = globalThis[Symbol.for("lotus.loginAccount.state")]?.accountGenerations?.get(record.profileKey) || 0
    if (`${guard.qq}:${guard.profileId}` !== record.profileKey || guard.generation !== generation
      || guard.lifetime !== getProfileLifetime(guard.qq, guard.profileId)) throw fail()
  }
  const latest = state.profiles.get(record.profileKey)
  if (latest) {
    if (latest.key !== record.key || latest.keys.length !== record.keys.length
      || latest.keys.some(key => !record.keys.includes(key))
      || deviceSignature(latest.device) !== deviceSignature(record.device)) throw fail()
  } else if (state.revisions.has(record.profileKey)
    && (record.device.id || (state.retired.get(record.key) || 0) > Date.now())) throw fail()
}

function uniqueDevice(records) {
  const signatures = new Set(records.map(record => deviceSignature(record.device)))
  if (signatures.size !== 1) throw fail()
  return records[0].device
}

function chooseDevice(api, cookie, owner, bound) {
  if (bound) return bound.device?.id ? bound.device : unboundDevice(api, cookie, bound)
  assertCredentialCurrent(api, cookie)
  const records = [...state.profiles.values()].filter(record => record.keys.includes(cookie.key))
  if (!ownerMatches(owner, cookie, records)) return records.length ? uniqueDevice(records) : null
  const explicit = text(api.option?.device)
  const selectedId = explicit && records.some(record => record.device.id === explicit) ? explicit : text(owner.device)
  const matching = records.filter(record => record.device.id === selectedId)
  if (matching.length) return uniqueDevice(matching)
  // Canonical cache synchronization may lag a durable bind/generation save.
  // Exact credentials can recover a unique latest tuple, never an arbitrary
  // profile or a stale canonical ID when multiple current devices exist.
  if (records.length) return uniqueDevice(records)
  return selectedId ? { id: selectedId, fp: "" } : null
}

function unboundDevice(api, cookie, bound) {
  const previous = state.unbound.get(api)
  if (previous?.key === cookie.key && previous.profileKey === bound.profileKey) return previous.device
  const knownIds = [...state.profiles.values()].map(record => record.device.id)
  if (knownIds.includes(text(api._device)) || (text(api.option?.device) && text(api.option.device) === text(api._device))) {
    delete api._device
    // Reuse the upstream API's own default generator, never another profile's
    // canonical owner and never a fabricated fingerprint.
    void api.device
  }
  const id = text(api._device) || text(api.device)
  if (!id || knownIds.includes(id)) throw fail()
  delete api._device_fp
  const device = { id, fp: "", unbound: true }
  state.unbound.set(api, { key: cookie.key, profileKey: bound.profileKey, device })
  return device
}

async function resolveDevice(api, cookie, { MysUser, listProfiles }) {
  const bound = profileBinding(api, cookie)
  if (bound) return chooseDevice(api, cookie, null, bound)
  await refreshRegistry(listProfiles)
  assertCredentialCurrent(api, cookie)
  let owner = state.bindings.get(api)?.owner || state.owners.get(cookie.id)
  const records = [...state.profiles.values()].filter(record => record.keys.includes(cookie.key))
  if (!ownerMatches(owner, cookie, records)) owner = await MysUser?.create?.(cookie.id)
  if (ownerMatches(owner, cookie, records)) state.owners.set(cookie.id, owner)
  return chooseDevice(api, cookie, owner, bound)
}

function syncDevice(api, cookie) {
  const bound = profileBinding(api, cookie)
  if (bound) return chooseDevice(api, cookie, null, bound)
  assertCredentialCurrent(api, cookie)
  const resolved = state.resolved.get(api)
  if (resolved?.key === cookie.key && resolved.revision === state.revision) return resolved.device
  const device = chooseDevice(api, cookie, state.bindings.get(api)?.owner || state.owners.get(cookie.id), bound)
  if (!device && [...state.profiles.values()].some(record => record.keys.includes(cookie.key))) throw fail()
  return device
}

function applyDevice(api, input, device) {
  if (!device?.id) return input
  const headers = headersObject(input.headers)
  if (headers === null) return input
  const previousId = text(api._device)
  const previousHeaderId = header(headers, "x-rpc-device_id")
  if (previousId !== device.id) delete api._device_fp
  api._device = device.id
  const data = { ...input, headers }
  if (device.unbound) {
    setHeader(headers, "x-rpc-device_fp", "")
    delete data.deviceFp
    for (const key of Object.keys(zzzMetadata({}))) delete data[key]
  }
  setHeader(headers, "x-rpc-device_id", device.id)
  if (device.fp) {
    setHeader(headers, "x-rpc-device_fp", device.fp)
    api._device_fp = { retcode: 0, message: "OK", data: { device_fp: device.fp } }
  } else if ((previousHeaderId && previousHeaderId !== device.id) || previousId !== device.id) setHeader(headers, "x-rpc-device_fp", "")
  if ("deviceId" in data) data.deviceId = device.id
  if ("deviceFp" in data) {
    if (device.fp) data.deviceFp = device.fp
    else if (data.deviceId !== input.deviceId || previousId !== device.id) delete data.deviceFp
  }
  if (api.apiTool?.constructor?.name === "ZZZApiTool" || api.game === "zzz") {
    for (const [key, value] of Object.entries(zzzMetadata(device))) {
      if (value) data[key] = value
      else if (key in data && previousId !== device.id) delete data[key]
    }
  }
  return data
}

function zzzMetadata(device) {
  const raw = device.raw || {}
  return {
    modelName: raw.deviceModel || device.model, osVersion: raw.androidVersion || raw.osVersion || device.android_version,
    deviceInfo: raw.deviceFingerprint || raw.deviceInfo, productName: raw.deviceProduct || raw.productName,
    deviceType: raw.deviceName || device.name, oaid: raw.oaid, board: raw.deviceBoard || raw.board,
  }
}

const RECORD_CN_HOSTS = new Set(["api-takumi.mihoyo.com", "api-takumi-record.mihoyo.com", "bbs-api.mihoyo.com", "bbs-api.miyoushe.com", "api-takumi.miyoushe.com", "api-takumi-record.miyoushe.com"])
const RECORD_OS_HOSTS = new Set(["sg-public-api.hoyolab.com", "bbs-api-os.hoyolab.com", "sg-act-public-api.hoyolab.com", "sg-act-nap-api.hoyolab.com", "sg-public-api.hoyoverse.com", "sg-act-public-api.hoyoverse.com"])

// These record/tool APIs use the app metadata already centralized for Lotus's
// own record calls. Passport, badge, misc, cloud and public endpoints retain
// their native protocol; DS/client_type/query/body never change here.
function recordMetadata(result, device, clientType) {
  let url
  try { url = new URL(result?.url) } catch { return result }
  const overseas = RECORD_OS_HOSTS.has(url.hostname)
  if (!overseas && !RECORD_CN_HOSTS.has(url.hostname)) return result
  if (!/^\/(?:game_record(?:_zzz)?|event\/(?:game_record(?:_zzz)?|toolcomsrv))\//.test(url.pathname)) return result
  const headers = headersObject(result.headers)
  if (!headers) return result
  const version = overseas ? MIHOYO_PROTOCOL.hoyolab.version : MIHOYO_PROTOCOL.bbsCn.version
  setHeader(headers, "x-rpc-app_version", version)
  const agent = header(headers, "user-agent")
  const raw = device?.raw || {}
  const model = text(raw.deviceModel) || text(device?.model)
  const androidValue = raw.androidVersion || raw.osVersion || device?.android_version
  const android = typeof androidValue === "number" && Number.isFinite(androidValue) ? String(androidValue) : text(androidValue)
  if (device?.id) {
    for (const [name, value] of [["x-rpc-sys_version", android], ["x-rpc-device_model", model], ["x-rpc-device_name", text(raw.deviceName) || text(device.name) || model]]) {
      if (value && header(headers, name) !== undefined) setHeader(headers, name, value)
    }
  }
  // genshin's CT5 default substitutes device_id for the hardware model and
  // hardcodes Android 12. Replace only that known template, with fully proved
  // metadata; custom caller and ZZZ WebView UAs retain their own structure.
  const nativeDefault = (header(headers, "x-rpc-client_type") || clientType) === "5"
    && device?.id && model && android && agent
    && agent.includes(`(Linux; Android 12; ${device.id})`)
    && agent.includes("Chrome/99.0.4844.73 ")
    && /miHoYoBBS(?:Oversea)?\/[0-9A-Za-z.+-]+/.test(agent)
  if (nativeDefault) {
    setHeader(headers, "User-Agent", mihoyoUserAgent({ ...device, model, android_version: android }, overseas))
  } else if (agent && /miHoYoBBS(?:Oversea)?\/[0-9A-Za-z.+-]+/.test(agent)) {
    setHeader(headers, "User-Agent", agent.replace(/miHoYoBBS(?:Oversea)?\/[0-9A-Za-z.+-]+/g, `${overseas ? "miHoYoBBSOversea" : "miHoYoBBS"}/${version}`))
  }
  return { ...result, headers }
}

function deviceRegistrationRequest(result, api, device, input) {
  if (!device?.id || api.apiTool?.constructor?.name !== "ZZZApiTool") return null
  let url
  try { url = new URL(result?.url) } catch { return null }
  if (url.protocol !== "https:" || !["bbs-api.miyoushe.com", "bbs-api.mihoyo.com"].includes(url.hostname)
    || !/^\/apihub\/api\/(?:deviceLogin|saveDevice)$/.test(url.pathname)) return null
  const raw = device.raw || {}, model = text(raw.deviceModel) || text(device.model)
  const android = String(raw.androidVersion || raw.osVersion || device.android_version || "")
  // Android 12 may be API 31 or 32: only its explicit SDK can disambiguate.
  const sdk = String(raw.sdkVersion || ({ "11": "30", "13": "33", "14": "34" })[android] || "")
  if (!model && !/^\d+$/.test(sdk)) return null
  let body
  try { body = JSON.parse(result.body) } catch { throw fail() }
  if (!body || body.device_id !== device.id || typeof api.getDs !== "function") throw fail()
  body.app_version = MIHOYO_PROTOCOL.bbsCn.version
  if (/^\d+$/.test(sdk)) body.os_version = sdk
  if (model) body.device_name = `${text(raw.deviceFingerprint).split("/")[0] || text(raw.deviceBrand)}${model}`
  const serialized = JSON.stringify(body), headers = headersObject(result.headers)
  if (!headers) throw fail()
  const ds = api.getDs(url.search.slice(1), serialized)
  const normalizeHeaders = headers => {
    setHeader(headers, "DS", ds)
    setHeader(headers, "x-rpc-app_version", MIHOYO_PROTOCOL.bbsCn.version)
    for (const [name, value] of [["x-rpc-sys_version", android], ["x-rpc-device_model", model], ["x-rpc-device_name", text(raw.deviceName) || text(device.name) || model]]) {
      if (value && header(headers, name) !== undefined) setHeader(headers, name, value)
    }
    const agent = header(headers, "user-agent")
    if (agent && /miHoYoBBS(?:Oversea)?\/[0-9A-Za-z.+-]+/.test(agent)) {
      setHeader(headers, "User-Agent", agent.replace(/miHoYoBBS(?:Oversea)?\/[0-9A-Za-z.+-]+/g, `miHoYoBBS/${MIHOYO_PROTOCOL.bbsCn.version}`))
    }
  }
  normalizeHeaders(headers)
  const active = state.requests.getStore()
  if (active?.api === api && active.data === input) normalizeHeaders(input.headers)
  return { ...result, body: serialized, headers }
}

function deviceFpRequest(result, api, device, input) {
  let url
  try { url = new URL(result?.url) } catch { return null }
  const overseas = url.hostname === "sg-public-data-api.hoyoverse.com"
  if (url.protocol !== "https:" || (url.hostname !== "public-data-api.mihoyo.com" && !overseas)
    || url.pathname !== "/device-fp/api/getFp") return null
  let body
  try { body = JSON.parse(result.body) } catch { throw fail() }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail()
  const raw = device?.raw || {}
  const android = device?.id && raw.deviceName && raw.deviceModel && raw.oaid
    && raw.deviceFingerprint && raw.deviceProduct && raw.deviceBoard
    && raw.bbsDeviceId && /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(device.id)
  if (android) {
    body = buildDeviceFpPayload(raw, { deviceId: device.id, deviceGuid: raw.bbsDeviceId })
    if (overseas) {
      body.app_name = "bbs_oversea"
      body.hoyolab_device_id = body.bbs_device_id
      delete body.bbs_device_id
      const ext = JSON.parse(body.ext_fields)
      ext.packageName = "com.mihoyo.hoyolab"
      body.ext_fields = JSON.stringify(ext)
    }
  } else {
    // Keep an unmanaged native client's own platform and hardware template,
    // while eliminating its fixed or uppercased, unrelated device identity.
    const id = device?.id || text(api.device)
    if (id) {
      body.device_id = id
      let ext
      try { ext = JSON.parse(body.ext_fields) } catch { throw fail() }
      if (ext && Object.hasOwn(ext, "IDFV")) {
        ext.IDFV = id
        body.ext_fields = JSON.stringify(ext)
      }
    }
  }
  const headers = { "User-Agent": "okhttp/4.9.3", "Content-Type": "application/json" }
  const active = state.requests.getStore()
  if (active?.api === api && active.data === input) {
    // Native getData adds Cookie after getUrl, then applies data.headers.
    // Override only this owned request clone; never mutate the API's Cookie.
    input.headers = { ...headers, Cookie: "" }
    active.fpRequested = true
  }
  return { ...result, body: JSON.stringify(body), headers }
}

async function runNativeRequest(api, original, type, data, rest) {
  const request = { api, data, fpRequested: false }
  const result = await state.requests.run(request, () => Reflect.apply(original, api, [type, data, ...rest]))
  if (type !== "getFp" || !request.fpRequested) return result
  if (result?.retcode === 0 && String(result.data?.code) === "200"
    && typeof result.data?.device_fp === "string" && /^[0-9a-f]{13}$/i.test(result.data.device_fp)) return result
  // Failed getFp responses can echo the seed. Native callers expect data to
  // exist before continuing a business request, but must never reuse that echo.
  const dataWithoutFp = result?.data && typeof result.data === "object" && !Array.isArray(result.data) ? { ...result.data } : {}
  delete dataWithoutFp.device_fp
  return result && typeof result === "object" ? { ...result, data: dataWithoutFp }
    : { retcode: -1, message: "设备指纹未签发", data: {} }
}

export function installMysRequestCompatibility({ MysApi, MysZZZApi, MysUser, listProfiles = listAllProfiles } = {}) {
  const prototype = MysApi?.prototype
  if (typeof prototype?.getData !== "function") return { ok: true, skipped: true }
  // Own prototype markers survive an unrelated diagnostics wrapper installed
  // above this method, and do not accidentally mark subclass overrides.
  if (!Object.hasOwn(prototype, PATCHED)) {
    const original = prototype.getData
    async function getData(type, input = {}, ...rest) {
      const cookie = cookieContext(this.cookie)
      if (!cookie) {
        if (state.bindings.get(this)?.kind === "profile" || state.scope.getStore()) throw fail()
        if (!input || typeof input !== "object" || Array.isArray(input)) return Reflect.apply(original, this, [type, input, ...rest])
        const headers = headersObject(input.headers)
        if (headers === null) return Reflect.apply(original, this, [type, input, ...rest])
        const data = { ...input, headers }
        return runNativeRequest(this, original, type, data, rest)
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) return Reflect.apply(original, this, [type, input, ...rest])
      const headers = headersObject(input.headers)
      if (headers === null) return Reflect.apply(original, this, [type, input, ...rest])
      const override = header(headers, "cookie")
      if (override !== undefined && cookieContext(override)?.key !== cookie.key) throw fail()
      if (override !== undefined) setHeader(headers, "Cookie", this.cookie)
      const device = await resolveDevice(this, cookie, { MysUser, listProfiles })
      // getUrl called within this verified asynchronous path may retain the
      // upstream's own default device when no stored device can be proved.
      state.resolved.set(this, { key: cookie.key, device, revision: state.revision })
      const data = applyDevice(this, { ...input, headers }, device)
      return runNativeRequest(this, original, type, data, rest)
    }
    prototype.getData = getData
    Object.defineProperty(prototype, PATCHED, { value: true })
  }
  for (const target of [prototype, MysZZZApi?.prototype].filter(Boolean)) {
    if (typeof target.getUrl !== "function" || Object.hasOwn(target, URL_PATCHED)) continue
    if (target !== prototype && !Object.hasOwn(target, "getUrl")) continue
    const original = target.getUrl
    target.getUrl = function getUrl(type, input = {}, ...rest) {
      const cookie = cookieContext(this.cookie)
      if (!cookie) {
        if (state.bindings.get(this)?.kind === "profile" || state.scope.getStore()) throw fail()
        const result = Reflect.apply(original, this, [type, input, ...rest])
        return deviceFpRequest(result, this, null, input) || recordMetadata(result)
      }
      const inputHeaders = headersObject(input?.headers)
      if (inputHeaders) {
        const override = header(inputHeaders, "cookie")
        if (override !== undefined && cookieContext(override)?.key !== cookie.key) throw fail()
      }
      const device = syncDevice(this, cookie)
      const data = applyDevice(this, input, device)
      const raw = Reflect.apply(original, this, [type, data, ...rest])
      const fpRequest = deviceFpRequest(raw, this, device, input)
      if (fpRequest) return fpRequest
      const result = recordMetadata(deviceRegistrationRequest(raw, this, device, input) || raw, device)
      const active = state.requests.getStore()
      if (active?.api === this && active.data === input && input.headers) {
        // Upstream merges data.headers after getUrl. Normalize the owned clone
        // too, so a stale caller version cannot undo the URL-specific metadata.
        const normalized = recordMetadata({ url: result?.url, headers: input.headers }, device, result?.headers ? header(result.headers, "x-rpc-client_type") : undefined)
        if (normalized.headers) input.headers = normalized.headers
      }
      if (!result || !device?.id) return result
      const headers = headersObject(result.headers)
      if (headers === null) throw fail()
      setHeader(headers, "Cookie", this.cookie)
      setHeader(headers, "x-rpc-device_id", device.id)
      if (device.fp) setHeader(headers, "x-rpc-device_fp", device.fp)
      return { ...result, headers }
    }
    Object.defineProperty(target, URL_PATCHED, { value: true })
  }
  return { ok: true }
}
