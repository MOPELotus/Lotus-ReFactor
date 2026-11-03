import { listAllProfiles, loadProfile, saveProfile, withProfileWrite } from "../config/profile.js"
import { generateVirtualDevice, needsGeneratedDevice } from "./generated.js"
import { withPendingLoginSync, syncCurrentLoginProfile } from "../login/refresh.js"

// Startup migration only: no network and no implicit create. An archived profile
// must not be brought back by a scan which listed it before the archive.
export async function ensureGeneratedProfileDevice(qq, profileId = 1, options = {}) {
  const store = options.store || { loadProfile, saveProfile }
  const result = await withProfileWrite(qq, profileId, async () => {
    const profile = await store.loadProfile(qq, profileId)
    if (!needsGeneratedDevice(profile.device)) return { profile, changed: false }
    const next = { ...profile, device: (options.generateDevice || generateVirtualDevice)() }
    const save = () => store.saveProfile(next)
    if (next.account?.cookie) await withPendingLoginSync(qq, profileId, save, options.syncOptions)
    else await save()
    return { profile: next, changed: true }
  })
  if (result.changed && result.profile.account?.cookie) {
    try {
      await syncCurrentLoginProfile(qq, profileId, {
        ...options.syncOptions,
        accountService: { get: (user, id) => store.loadProfile(user, id) },
        forceSync: true,
      })
    } catch {
      // The new identity is durable. Pending reconciliation can retry without
      // replacing it or exchanging credentials again.
      result.syncFailed = true
    }
  }
  return result
}

export async function ensureGeneratedProfileDevices(options = {}) {
  const result = { scanned: 0, generated: 0, preserved: 0, incomplete: 0, failed: 0, invalid: 0 }
  const profiles = await (options.listProfiles || listAllProfiles)({ skipInvalid: true, onError: () => { result.invalid++ } })
  for (const snapshot of profiles) {
    result.scanned++
    try {
      const { profile, changed } = await ensureGeneratedProfileDevice(snapshot.user.qq, snapshot.profile.id, options)
      if (changed) result.generated++
      else result.preserved++
      if (!profile.device?.id || !profile.device?.fp) result.incomplete++
    } catch {
      // Counts only: malformed YAML and transport errors can contain secrets.
      result.failed++
    }
  }
  return result
}
