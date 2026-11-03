import { listAllProfiles, loadProfile, saveProfile, withProfileWrite, getProfileLifetime } from "../config/profile.js"
import { DeviceService } from "./service.js"
import { getAccountGeneration } from "../login/account.js"
import { withPendingLoginSync, syncCurrentLoginProfile } from "../login/refresh.js"

const state = globalThis[Symbol.for("lotus-plugin.generated-device-fp")] ||= { inflight: new Map(), retries: new Map() }
const pending = device => device?.generated === true && !device.bound && device.id && device.instance_id && !device.fp
const sameDevice = (a, b) => a?.generated === true && !a.bound && a.id === b.id && a.instance_id === b.instance_id && !a.fp

// Device initialization is durable before this optional, delayed network work.
// A failed issuance never replaces the stable ID or manufactures a fingerprint.
export function refreshGeneratedDeviceFp(qq, profileId = 1, options = {}) {
  const key = `${String(qq)}:${Number(profileId)}`
  if (state.inflight.has(key)) return state.inflight.get(key)
  const operation = refresh(qq, profileId, key, options)
  state.inflight.set(key, operation)
  return operation.finally(() => { if (state.inflight.get(key) === operation) state.inflight.delete(key) })
}

async function refresh(qq, profileId, key, options) {
  const now = options.now || Date.now
  const store = options.store || { loadProfile, saveProfile }
  const original = await store.loadProfile(qq, profileId)
  const device = original.device
  if (!pending(device)) return { ok: true, skipped: true }
  const attemptKey = `${key}:${device.instance_id}`
  const previous = state.retries.get(attemptKey)
  if (previous?.nextAt > now()) return { ok: false, cooldown: true }
  const generation = getAccountGeneration(qq, profileId), lifetime = getProfileLifetime(qq, profileId)
  const current = () => getAccountGeneration(qq, profileId) === generation && getProfileLifetime(qq, profileId) === lifetime
  const service = options.deviceService || new DeviceService(options)
  let issued
  try {
    issued = await service.requestDeviceFp(device.raw, { deviceId: device.id, deviceGuid: device.raw.bbsDeviceId })
    if (issued.device_id !== device.id || !/^[0-9a-f]{13}$/i.test(issued.device_fp || "")) throw new Error("fingerprint issuance rejected")
  } catch {
    const failures = Math.min((previous?.failures || 0) + 1, 10)
    state.retries.set(attemptKey, { failures, nextAt: now() + Math.min(6 * 3600000, 60000 * 2 ** (failures - 1)) })
    // Keep a bounded process-local cooldown without writing failure metadata
    // into a profile that may currently be used by another business request.
    if (state.retries.size > 2048) state.retries.delete(state.retries.keys().next().value)
    return { ok: false, retryable: true }
  }
  const saved = await withProfileWrite(qq, profileId, async () => {
    if (!current()) return false
    const latest = await store.loadProfile(qq, profileId)
    if (!current() || !sameDevice(latest.device, device)) return false
    latest.device = { ...latest.device, fp: issued.device_fp, fp_source: "mihoyo", updated_at: new Date(now()).toISOString() }
    const save = () => store.saveProfile(latest)
    if (latest.account?.cookie) await withPendingLoginSync(qq, profileId, save, options.syncOptions)
    else await save()
    return latest
  })
  if (!saved) return { ok: false, changed: true }
  state.retries.delete(attemptKey)
  if (saved.account?.cookie) {
    try {
      await syncCurrentLoginProfile(qq, profileId, {
        ...options.syncOptions,
        accountService: { get: (user, id) => store.loadProfile(user, id) },
        forceSync: true,
      })
    } catch { /* Durable pending marker retains the cache repair. */ }
  }
  return { ok: true, profile: saved }
}

export function startGeneratedDeviceFpRefresh(options = {}) {
  const runtimeKey = Symbol.for("lotus-plugin.generated-device-fp-runtime")
  globalThis[runtimeKey]?.stop()
  let stopped = false, timer, releaseSpacing
  const schedule = delay => {
    timer = setTimeout(async () => {
      try {
        const profiles = await (options.listProfiles || listAllProfiles)({ skipInvalid: true })
        for (const profile of profiles) {
          if (stopped) break
          if (!pending(profile.device)) continue
          await refreshGeneratedDeviceFp(profile.user.qq, profile.profile.id, options)
          if (!stopped) await new Promise(resolve => {
            releaseSpacing = resolve
            timer = setTimeout(() => { releaseSpacing = undefined; resolve() }, options.spacingMs ?? 1000)
            timer.unref?.()
          })
        }
      } catch {
        ;(options.logger || globalThis.logger)?.warn?.("[Lotus-Plugin] 虚拟设备指纹补全暂不可用，保留已保存设备，稍后重试")
      }
      if (!stopped) schedule(options.retryDelayMs ?? 60000)
    }, delay)
    timer.unref?.()
  }
  const runtime = { stop() { stopped = true; clearTimeout(timer); releaseSpacing?.(); releaseSpacing = undefined } }
  globalThis[runtimeKey] = runtime
  schedule(options.delayMs ?? 30000)
  return runtime
}
