import { parseAccountCookie } from "../../core/mihoyo/cookies.js"

// This is an account-wide compatibility cache. Explicit profile requests must
// carry their own device context rather than select from this shared cache.
export async function syncZzzDeviceWithRedis(profile = {}, { redis = globalThis.redis, isCurrent } = {}) {
  if (!redis?.set) return
  const account = profile.account || {}
  const ltuid = account.ltuid || account.stuid || parseAccountCookie(account.cookie).ltuid
  const device = profile.device || {}
  // Never combine one profile's FP with an older/other profile's cached ID.
  // Missing legacy tuples remain untouched until a complete device is bound.
  if (!ltuid || !device.id || !device.fp) return
  const prefix = `ZZZ:DEVICE_FP:${ltuid}`
  const bind = buildZzzBindDevice(device)
  const assertCurrent = async () => {
    if (isCurrent && await isCurrent() === false) throw new Error("device changed during cache synchronization")
  }
  await assertCurrent()
  // All callers, including direct ZZZ bridges, share an account-level cache.
  // Sequential SETs could mix two profiles' ID/FP across await boundaries.
  if (typeof redis.multi !== "function") throw new Error("atomic device cache synchronization unavailable")
  const transaction = redis.multi()
  transaction.set(`${prefix}:FP`, String(device.fp))
  transaction.set(`${prefix}:ID`, String(device.id))
  if (bind) transaction.set(`${prefix}:BIND`, JSON.stringify(bind))
  else transaction.del(`${prefix}:BIND`)
  const result = await transaction.exec()
  if (!result || result.some?.(entry => entry instanceof Error || (Array.isArray(entry) && entry[0] instanceof Error))) throw new Error("device cache synchronization failed")
  await assertCurrent()
}

function buildZzzBindDevice(device = {}) {
  const raw = device.raw || {}
  const bind = {
    deviceName: raw.deviceName || device.name || "",
    deviceBoard: raw.deviceBoard || raw.board || "",
    deviceModel: raw.deviceModel || device.model || "",
    oaid: raw.oaid || "",
    androidVersion: raw.androidVersion || raw.osVersion || device.android_version || "",
    deviceFingerprint: raw.deviceFingerprint || raw.deviceInfo || "",
    deviceProduct: raw.deviceProduct || raw.productName || raw.product || "",
  }
  return Object.values(bind).some(Boolean) ? bind : null
}
