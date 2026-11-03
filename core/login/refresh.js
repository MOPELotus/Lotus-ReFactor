import { getProfileLifetime, getProfileSnapshotGuard } from "../config/profile.js"
import { AccountService, getAccountGeneration, accountChangedError } from "./account.js"
import { PendingLoginSyncStore } from "./syncState.js"
import { checkProfileGenshinSync, registerProfileWithGenshin } from "../../services/genshinBridge/profile.js"
import { readStokenCredentials } from "./credentials.js"

export { isAccountChangedError } from "./account.js"

const stateKey = Symbol.for("lotus.loginCredentialSync.coordinator")
const state = globalThis[stateKey] ||= { queues: new Map(), refreshing: new Map(), revisions: new Map() }
const defaultStore = new PendingLoginSyncStore()
const keyFor = (qq, profileId) => `${qq}:${profileId}`
const signature = profile => JSON.stringify([profile?.account?.stuid, profile?.account?.ltuid, profile?.account?.cookie, profile?.account?.stoken_cookie, profile?.device])

const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)

export function assertLoginProfileUnchanged(expected, current, { qq, profileId = 1, expectedGeneration, expectedLifetime } = {}) {
  if (!expected) return
  const changed = () => { throw accountChangedError("登录账号或设备已变化，本次操作已停止，请重新发送原指令。") }
  const guard = getProfileSnapshotGuard(expected)
  if (guard && (guard.qq !== String(qq) || guard.profileId !== Number(profileId))) changed()
  const generation = expectedGeneration ?? guard?.generation
  const lifetime = expectedLifetime ?? guard?.lifetime
  if ((generation !== undefined && generation !== getAccountGeneration(qq, profileId))
    || (lifetime !== undefined && lifetime !== getProfileLifetime(qq, profileId))) changed()
  if ((expected.user?.qq && String(expected.user.qq) !== String(qq))
    || (expected.profile?.id && Number(expected.profile.id) !== Number(profileId))) changed()
  let before, after
  try {
    before = readStokenCredentials(expected.account)
    after = readStokenCredentials(current?.account)
  } catch { changed() }
  if (!before.stuid || before.stuid !== after.stuid || before.mid !== after.mid
    || stable(expected.device || {}) !== stable(current?.device || {})) changed()
}

export async function markLoginSyncPending(qq, profileId = 1, options = {}) {
  const key = keyFor(qq, profileId)
  state.revisions.set(key, (state.revisions.get(key) || 0) + 1)
  await (options.pendingStore || defaultStore).add(key)
}

// The low-level AccountService remains usable with an isolated store. Only
// actual business refresh entrypoints opt into persistent cache reconciliation.
export async function exchangeLoginWithPending(qq, profileId = 1, options = {}) {
  const accountService = options.accountService || new AccountService()
  return withPendingLoginSync(qq, profileId, async () => {
    if (options.expectedProfile && typeof accountService.get === "function") {
      assertLoginProfileUnchanged(options.expectedProfile, await accountService.get(qq, profileId), { ...options, qq, profileId })
    }
    return accountService.refresh(qq, profileId)
  }, options)
}

// A cache reconciliation must not consume the marker while the corresponding
// profile write is still in progress, whether it changes tokens or devices.
export async function withPendingLoginSync(qq, profileId, save, options = {}) {
  const key = keyFor(qq, profileId)
  state.refreshing.set(key, (state.refreshing.get(key) || 0) + 1)
  try {
    await markLoginSyncPending(qq, profileId, options)
    return await save()
  } finally {
    const remaining = state.refreshing.get(key) - 1
    if (remaining) state.refreshing.set(key, remaining)
    else state.refreshing.delete(key)
  }
}

export function syncCurrentLoginProfile(qq, profileId = 1, options = {}) {
  const key = keyFor(qq, profileId)
  const task = (state.queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    const accountService = options.accountService || new AccountService()
    const pendingStore = options.pendingStore || defaultStore
    const checkSync = options.checkSync || checkProfileGenshinSync
    const syncProfile = options.syncProfile || registerProfileWithGenshin
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const profile = await accountService.get(qq, profileId)
      assertLoginProfileUnchanged(options.expectedProfile, profile, { ...options, qq, profileId })
      const expected = signature(profile), generation = getAccountGeneration(qq, profileId)
      const lifetime = getProfileLifetime(qq, profileId)
      const revision = state.revisions.get(key) || 0
      const isCurrent = async () => getAccountGeneration(qq, profileId) === generation
        && getProfileLifetime(qq, profileId) === lifetime
        && signature(await accountService.get(qq, profileId)) === expected
      const check = await checkSync({ qq, profile })
      if (check?.ok === false) throw new Error("login cache check unavailable")
      if (!await isCurrent()) continue
      // Existing canonical users must not gain a new binding just by refreshing.
      if (check?.bound !== false && (check?.needsSync !== false || options.forceSync)) {
        try {
          const result = await syncProfile({ qq, profile, isCurrent })
          if (result?.ok === false) throw new Error("login cache sync rejected")
        } catch (error) {
          if (!await isCurrent()) continue
          throw error
        }
      }
      if (!await isCurrent() || revision !== (state.revisions.get(key) || 0)) continue
      // Another exchange may have persisted the marker but not its new cookie.
      if (state.refreshing.has(key)) return { ok: false, pending: true, profile }
      await pendingStore.delete(key)
      return { ok: true, profile }
    }
    return { ok: false, pending: true }
  })
  state.queues.set(key, task)
  return task.finally(() => { if (state.queues.get(key) === task) state.queues.delete(key) })
}

export async function refreshAccountAndSync(qq, profileId = 1, options = {}) {
  const accountService = options.accountService || new AccountService()
  // Test/custom account adapters without a read operation cannot bridge caches.
  if (typeof accountService.get !== "function") {
    const profile = await accountService.refresh(qq, profileId)
    assertLoginProfileUnchanged(options.expectedProfile, profile, { ...options, qq, profileId })
    return profile
  }
  const lifetime = getProfileLifetime(qq, profileId)
  const generation = getAccountGeneration(qq, profileId)
  if (options.expectedProfile) {
    assertLoginProfileUnchanged(options.expectedProfile, await accountService.get(qq, profileId), { ...options, qq, profileId })
    if (getAccountGeneration(qq, profileId) !== generation || getProfileLifetime(qq, profileId) !== lifetime) {
      throw accountChangedError("读取登录状态期间账号已变化，请重新发送原指令。")
    }
  }
  let saved
  try {
    saved = await exchangeLoginWithPending(qq, profileId, { ...options, accountService })
    assertLoginProfileUnchanged(options.expectedProfile, saved, { ...options, qq, profileId })
  } catch (error) {
    if (getAccountGeneration(qq, profileId) !== generation || getProfileLifetime(qq, profileId) !== lifetime
      || ["LOTUS_ACCOUNT_CHANGED", "LOTUS_PROFILE_LOGIN_REQUIRED", "ENOENT"].includes(error?.code)) {
      throw accountChangedError("登录状态已变化，本次操作已停止，请重新发送原指令。")
    }
    throw error
  }
  try {
    await syncCurrentLoginProfile(qq, profileId, { ...options, accountService })
  } catch (error) {
    if (error?.code === "LOTUS_ACCOUNT_CHANGED") throw error
    ;(options.logger || globalThis.logger)?.warn?.("[Lotus-Plugin] refreshed credentials saved; cache synchronization pending retry")
  }
  // Never substitute an older snapshot after a concurrent login/logout.
  let latest
  try { latest = await accountService.get(qq, profileId) } catch {
    throw accountChangedError("登录状态已失效或变化，本次操作已停止，请重新发送原指令。")
  }
  if (getProfileLifetime(qq, profileId) !== lifetime) throw accountChangedError("profile 已归档，本次操作已停止，请重新发送原指令。")
  assertLoginProfileUnchanged(options.expectedProfile, latest, { ...options, qq, profileId })
  if (latest.account?.stuid !== saved.account?.stuid || latest.account?.ltuid !== saved.account?.ltuid) {
    throw accountChangedError("登录账号已变化，本次操作已停止，请重新发送原指令。")
  }
  return signature(latest) === signature(saved) ? saved : latest
}

export async function refreshAllAccountsAndSync(qq, profileIds = [1], options = {}) {
  const results = []
  for (const profileId of profileIds) {
    try { results.push({ profileId, ok: true, profile: await refreshAccountAndSync(qq, profileId, options) }) }
    catch (error) { results.push({ profileId, ok: false, error }) }
  }
  return results
}
