import path from "node:path"
import { pathToFileURL } from "node:url"
import { syncZzzDeviceWithRedis } from "./device.js"

const queuesKey = Symbol.for("lotus.genshinProfileSync.queues")
const queues = globalThis[queuesKey] ||= new Map()

export function registerProfileWithGenshin(options = {}) {
  const key = String(options.profile?.account?.ltuid || options.profile?.account?.stuid || options.qq || "")
  const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(() => registerProfile(options))
  queues.set(key, task)
  return task.finally(() => { if (queues.get(key) === task) queues.delete(key) })
}

async function registerProfile({ qq, profile, modules, isCurrent, syncDevice = syncZzzDeviceWithRedis } = {}) {
  const account = profile?.account || {}
  const ltuid = account.ltuid || account.stuid
  if (!qq || !ltuid || !account.cookie) return { ok: false, reason: "missing_account" }
  const assertCurrent = async () => {
    if (isCurrent && !await isCurrent()) throw new Error("account changed during cache synchronization")
  }
  const { NoteUser, MysUser } = modules || await loadGenshinModels()
  const mysUser = await MysUser.create(String(ltuid))
  if (!mysUser) return { ok: false, reason: "mys_user_create_failed" }
  const noteUser = await NoteUser.create(String(qq))
  // Automatic refresh reconciles existing bindings; explicit login/bind retains
  // the original addMysUser behavior.
  if (isCurrent && !noteUser?.mysUsers?.[String(ltuid)]) return { ok: false, reason: "account_binding_removed" }
  const gameRoles = normalizeGameRoles(account.game_roles)
  for (const [game, uids] of Object.entries(gameRoles)) {
    if (uids.length) {
      await assertCurrent()
      await mysUser.addQueryUid?.(uids, game)
    }
  }
  await assertCurrent()
  // setCkData mutates the cached MysUser. Defer it until async preparation is
  // finished and retain a compensation snapshot for a failed/stale save.
  const previous = { ck: mysUser.ck, type: mysUser.type, device: mysUser.device, uids: structuredClone(mysUser.uids || {}) }
  let writtenFields
  try {
    mysUser.setCkData?.({ ltuid: String(ltuid), ck: account.cookie, type: "mys", device: profile?.device?.id || "", uids: gameRoles })
    for (const [game, uids] of Object.entries(gameRoles)) mysUser.addUid?.(uids, game)
    writtenFields = cacheFields(mysUser)
    await mysUser.save?.()
    await assertCurrent()
    await syncDevice(profile, { isCurrent: assertCurrent })
    await assertCurrent()
    if (!isCurrent) await noteUser.addMysUser(mysUser)
    await assertCurrent()
    await noteUser.save?.()
    await assertCurrent()
  } catch (error) {
    // Lotus writers are serialized by ltuid. Do not replace an independently
    // updated cached object if another consumer changed it in the meantime.
    if (cacheFields(mysUser) === writtenFields) {
      Object.assign(mysUser, previous)
      await Promise.resolve().then(() => mysUser.save?.()).catch(() => {})
    }
    throw error
  }
  return { ok: true, ltuid: String(ltuid), uids: gameRoles }
}

function cacheFields(mysUser) {
  return JSON.stringify([mysUser.ck, mysUser.type, mysUser.device, mysUser.uids])
}

// Reconcile installations repaired before startup cache synchronization existed.
// Reading a NoteUser must not bind a previously unbridged canonical account.
export async function checkProfileGenshinSync({ qq, profile, modules } = {}) {
  const account = profile?.account || {}
  const ltuid = account.ltuid || account.stuid
  if (!qq || !ltuid || !account.cookie) return { ok: true, bound: false, needsSync: false }
  const { NoteUser } = modules || await loadGenshinModels()
  const noteUser = await NoteUser.create(String(qq))
  const mysUser = noteUser?.mysUsers?.[String(ltuid)]
  if (!mysUser) return { ok: true, bound: false, needsSync: false }
  const device = profile?.device?.id
  return { ok: true, bound: true, needsSync: mysUser.ck !== account.cookie
    || (typeof device === "string" && Boolean(device.trim()) && mysUser.device !== device) }
}

export function normalizeGameRoles(gameRoles = {}) {
  const result = {
    gs: [],
    sr: [],
    zzz: [],
  }

  for (const game of Object.keys(result)) {
    const roles = Array.isArray(gameRoles?.[game]) ? gameRoles[game] : []
    result[game] = roles
      .map(role => typeof role === "object" ? role.uid || role.game_uid : role)
      .filter(Boolean)
      .map(String)
  }

  return result
}

async function loadGenshinModels() {
  const base = path.join(process.cwd(), "plugins", "genshin", "model", "mys")
  const NoteUser = (await import(pathToFileURL(path.join(base, "NoteUser.js")).href)).default
  const MysUser = (await import(pathToFileURL(path.join(base, "MysUser.js")).href)).default
  return {
    NoteUser,
    MysUser,
  }
}
