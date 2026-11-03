import { exchangeLoginWithPending, markLoginSyncPending, syncCurrentLoginProfile } from "./refresh.js"
import { listAllProfiles } from "../config/profile.js"
import { needsAccountCookieRefresh } from "../mihoyo/cookies.js"
import { registerProfileWithGenshin, checkProfileGenshinSync } from "../../services/genshinBridge/profile.js"
import { AccountService } from "./account.js"
import { PendingLoginSyncStore } from "./syncState.js"
import { credentialExchangeDiagnostics } from "./credentials.js"

const stateKey = Symbol.for("lotus.loginCredentialRepair.state")
const state = globalThis[stateKey] ||= { tail: Promise.resolve() }
state.audited ||= new Set()
const defaultPendingStore = new PendingLoginSyncStore()

// Share the queue across hot reloads. A stopped scan completes its current
// account, including cache synchronization, before the replacement scan starts.
export function repairLegacyLoginCredentials(options = {}) {
  const task = state.tail.catch(() => {}).then(() => repairProfiles(options))
  state.tail = task
  return task
}

async function repairProfiles(options) {
  const log = options.logger || globalThis.logger
  const summary = { checked: 0, repaired: 0, failed: 0, skipped: 0, invalid: 0, syncFailed: 0, synced: 0, auditFailed: 0 }
  if (options.shouldStop?.()) return summary
  const profiles = await (options.listProfiles || listAllProfiles)({
    skipInvalid: true,
    onError() {
      summary.invalid += 1
      // Parser errors can contain cookie excerpts; do not print their messages.
      log?.warn?.("[Lotus-Plugin] invalid profile skipped during legacy login scan; original file retained")
    },
  })
  summary.checked = profiles.length
  const service = options.accountService || new AccountService(options)
  const syncProfile = options.syncProfile || registerProfileWithGenshin
  const checkSync = options.checkSync || checkProfileGenshinSync
  const audited = options.audited || state.audited
  const pendingStore = options.pendingStore || (options.pendingSync ? {
    list: async () => new Set(options.pendingSync.keys()),
    add: async key => { options.pendingSync.set(key, true) },
    delete: async key => { options.pendingSync.delete(key) },
  } : defaultPendingStore)
  const pendingSync = await pendingStore.list()
  for (const profile of profiles) {
    if (options.shouldStop?.()) break
    const qq = String(profile.user.qq)
    const profileId = profile.profile.id
    const key = `${qq}:${profileId}`
    const loggedIn = profile.account?.cookie && (profile.account.stoken || profile.account.stoken_cookie)
    if (!needsAccountCookieRefresh(profile.account) && !pendingSync.has(key) && (!loggedIn || audited.has(key))) continue
    try {
      // Recheck after any earlier pending work before making network requests.
      const latest = await service.get(qq, profileId)
      if (options.shouldStop?.()) break
      if (needsAccountCookieRefresh(latest.account)) {
        // Persist before the exchange: after a crash, even an already canonical
        // account will still synchronize genshin caches without another refresh.
        await exchangeLoginWithPending(qq, profileId, { accountService: service, pendingStore })
        pendingSync.add(key)
        summary.repaired += 1
      } else if (!pendingSync.has(key)) {
        if (audited.has(key)) {
          summary.skipped += 1
          continue
        }
        let check
        try {
          check = await checkSync({ qq, profile: latest })
          if (check?.ok === false) throw new Error("cache consistency check unavailable")
        } catch {
          summary.auditFailed += 1
          log?.warn?.(`[Lotus-Plugin] profile ${profileId} genshin cache check unavailable; will retry without changing credentials`)
          continue
        }
        if (!check?.needsSync) {
          audited.add(key)
          summary.skipped += 1
          continue
        }
        await markLoginSyncPending(qq, profileId, { pendingStore })
        pendingSync.add(key)
      }
    } catch (error) {
      summary.failed += 1
      // Do not log response bodies, cookies, URLs containing tokens or account ids.
      const diagnostic = Object.entries(credentialExchangeDiagnostics(error)).map(([key, value]) => `${key}=${value}`).join(" ")
      log?.warn?.(`[Lotus-Plugin] profile ${profileId} legacy login repair failed; original credentials retained; retry later or use #刷新Cookie${profileId === 1 ? "" : profileId}${diagnostic ? `; ${diagnostic}` : ""}`)
      continue
    }
    try {
      const result = await syncCurrentLoginProfile(qq, profileId, {
        accountService: service, pendingStore, checkSync, syncProfile, forceSync: true,
      })
      if (result?.ok === false) throw new Error("profile cache sync pending")
      pendingSync.delete(key)
      audited.add(key)
      summary.synced += 1
    } catch {
      summary.syncFailed += 1
      log?.warn?.(`[Lotus-Plugin] profile ${profileId} login repaired but genshin cache sync failed; will retry cache sync without exchanging tokens`)
    }
  }
  if (summary.repaired || summary.failed || summary.invalid || summary.syncFailed || summary.auditFailed || summary.synced) {
    log?.info?.(`[Lotus-Plugin] legacy login repair: ${summary.repaired} repaired, ${summary.failed} failed, ${summary.invalid} invalid, ${summary.synced} caches synced, ${summary.syncFailed} cache sync failed, ${summary.auditFailed} cache checks unavailable`)
  }
  return summary
}

const runtimeKey = Symbol.for("lotus.loginCredentialRepair.runtime")

export function startLoginCredentialRepair(options = {}) {
  globalThis[runtimeKey]?.stop()
  let timer
  let stopped = false
  const audited = options.audited || new Set()
  const log = options.logger || globalThis.logger
  const schedule = delay => {
    timer = setTimeout(async () => {
      try {
        await repairLegacyLoginCredentials({ ...options, audited, shouldStop: () => stopped || options.shouldStop?.() })
      } catch {
        log?.warn?.("[Lotus-Plugin] legacy login scan failed; original credentials retained")
      }
      if (!stopped) schedule(options.retryDelayMs ?? 6 * 60 * 60 * 1000)
    }, delay)
    timer.unref?.()
  }
  const runtime = { stop() { stopped = true; clearTimeout(timer) } }
  globalThis[runtimeKey] = runtime
  schedule(options.delayMs ?? 30000)
  return runtime
}
