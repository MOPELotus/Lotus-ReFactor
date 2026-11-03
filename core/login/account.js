import {
  ensureProfile,
  listProfileIds,
  loadLoggedInProfile,
  loadProfile,
  saveProfile,
  withProfileWrite,
  getProfileLifetime,
} from "../config/profile.js"
import { MihoyoClient } from "../mihoyo/client.js"
import {
  buildStokenCookie,
  cookieUidValues,
  parseAccountCookie,
  parseStokenCookie,
  needsAccountCookieRefresh,
} from "../mihoyo/cookies.js"
import {
  normalizeGameRolesFromApi,
  pickCurrentUid,
} from "../mihoyo/roles.js"
import { formatLocalIso } from "../time.js"
import { exchangeStokenCredentials, readStokenCredentials } from "./credentials.js"

const stateKey = Symbol.for("lotus.loginAccount.state")
const state = globalThis[stateKey] ||= {}
const refreshes = state.refreshes ||= new Map()
const accountWrites = state.accountWrites ||= new Map()
const accountGenerations = state.accountGenerations ||= new Map()

export function getAccountGeneration(qq, profileId = 1) {
  return generation(`${qq}:${profileId}`)
}

function generation(key) {
  return accountGenerations.get(key) || 0
}

function beginAccountChange(key) {
  const value = generation(key) + 1
  accountGenerations.set(key, value)
  return value
}

export function accountChangedError(message = "account changed; please repeat the command") {
  const error = new Error(message)
  error.code = "LOTUS_ACCOUNT_CHANGED"
  return error
}

export function isAccountChangedError(error) {
  return error?.code === "LOTUS_ACCOUNT_CHANGED"
}

function assertGeneration(key, expected) {
  if (generation(key) !== expected) {
    throw accountChangedError("account changed during login operation; stale result discarded")
  }
}

// Serialize account writes across all service instances. Token requests happen
// outside this lock, so a new login or logout can supersede an in-flight refresh.
function writeAccount(qq, profileId, operation) {
  const key = `${qq}:${profileId}`
  const task = (accountWrites.get(key) || Promise.resolve()).catch(() => {}).then(() => withProfileWrite(qq, profileId, operation))
  accountWrites.set(key, task)
  return task.finally(() => {
    if (accountWrites.get(key) === task) accountWrites.delete(key)
  })
}

function matchesAccountUid(account = {}, expected) {
  const ids = [account.stuid, account.ltuid, ...cookieUidValues(account.cookie), ...cookieUidValues(account.stoken_cookie)]
    .filter(value => value !== undefined && value !== null && String(value).trim() !== "")
    .map(value => String(value).trim())
  return ids.length > 0 && ids.every(uid => uid === String(expected))
}

function credentialIdentity(account) {
  return JSON.stringify(readStokenCredentials(account))
}

export class AccountService {
  constructor(options = {}) {
    this.client = options.client || new MihoyoClient(options)
    this.preserveLoginSession = options.preserveLoginSession === true
    this.store = options.store || { ensureProfile, loadLoggedInProfile, loadProfile, saveProfile, listProfileIds }
  }

  async saveLoginResult({ qq, profileId = 1, result, nickname = "" } = {}) {
    if (!result?.stoken || !result?.cookie) {
      throw new Error("login result must include stoken and cookie")
    }

    const candidate = {}
    const needsExchange = needsAccountCookieRefresh({ cookie: result.cookie, stoken_cookie: result.stoken })
    applyLoginResult(candidate, result)
    const key = `${qq}:${profileId}`
    const expected = beginAccountChange(key)
    const lifetime = getProfileLifetime(qq, profileId)
    let client = this.client
    if (needsExchange || needsAccountCookieRefresh(candidate.account)) {
      if (!this.preserveLoginSession && typeof client.withDevice === "function") {
        const existing = await this.store.loadProfile?.(qq, profileId).catch(error => {
          if (error?.code === "ENOENT") return null
          throw new Error("登录档案读取失败，已保留原档案，请检查后重试")
        })
        assertGeneration(key, expected)
        client = client.withDevice(existing?.device || {})
      }
      applyLoginResult(candidate, await exchangeStokenCredentials(client, readStokenCredentials(candidate.account)))
    }
    await this.trySyncGameRoles(candidate, client)
    return writeAccount(qq, profileId, async () => {
      assertGeneration(key, expected)
      if (getProfileLifetime(qq, profileId) !== lifetime) throw accountChangedError("profile archived during login operation; stale result discarded")
      const profile = await this.store.ensureProfile({ qq, profileId, nickname })
      assertGeneration(key, expected)
      // Role lists belong to the MYS identity, not to the QQ/profile slot.
      // An unavailable role API must not bridge the previous account's UIDs
      // using a newly confirmed account's cookie.
      const sameAccount = matchesAccountUid(profile.account, candidate.account.stuid)
      const currentUid = sameAccount ? profile.account.current_uid : {}
      profile.account = {
        ...profile.account,
        ...(!sameAccount ? { game_roles: { gs: [], sr: [], zzz: [] } } : {}),
        ...candidate.account,
      }
      if (candidate.account.roles_updated_at) delete profile.account.role_sync_error
      profile.account.current_uid = pickCurrentUid(profile.account.game_roles, currentUid)
      await this.store.saveProfile(profile)
      return profile
    })
  }

  async get(qq, profileId = 1) {
    return this.store.loadLoggedInProfile(qq, profileId)
  }

  async refresh(qq, profileId = 1) {
    const accountKey = `${qq}:${profileId}`
    const expected = generation(accountKey)
    const key = `${accountKey}:${expected}`
    if (refreshes.has(key)) return refreshes.get(key)
    const operation = this.refreshCredentials(qq, profileId, expected)
    refreshes.set(key, operation)
    try {
      return await operation
    } finally {
      if (refreshes.get(key) === operation) refreshes.delete(key)
    }
  }

  async refreshCredentials(qq, profileId, expected = generation(`${qq}:${profileId}`)) {
    const key = `${qq}:${profileId}`
    const lifetime = getProfileLifetime(qq, profileId)
    const original = await this.store.loadLoggedInProfile(qq, profileId)
    assertGeneration(key, expected)
    const identity = credentialIdentity(original.account)
    const client = this.client.withDevice?.(original.device || {}) || this.client
    const result = await exchangeStokenCredentials(client, readStokenCredentials(original.account))
    const candidate = {}
    applyLoginResult(candidate, result)
    await this.trySyncGameRoles(candidate, client)
    return writeAccount(qq, profileId, async () => {
      // Keep settings changed while token exchange or role lookup was running.
      assertGeneration(key, expected)
      if (getProfileLifetime(qq, profileId) !== lifetime) throw accountChangedError("profile archived during token refresh; stale result discarded")
      const latest = await this.store.loadLoggedInProfile(qq, profileId)
      assertGeneration(key, expected)
      if (credentialIdentity(latest.account) !== identity) {
        throw accountChangedError("account changed during token refresh; stale result discarded")
      }
      const currentUid = latest.account.current_uid
      latest.account = { ...latest.account, ...candidate.account }
      if (candidate.account.roles_updated_at) delete latest.account.role_sync_error
      latest.account.current_uid = pickCurrentUid(latest.account.game_roles, currentUid)
      await this.store.saveProfile(latest)
      return latest
    })
  }

  async refreshAll(qq, profileIds = [1]) {
    const results = []
    for (const profileId of profileIds) {
      try {
        results.push({
          profileId,
          ok: true,
          profile: await this.refresh(qq, profileId),
        })
      } catch (error) {
        results.push({
          profileId,
          ok: false,
          error,
        })
      }
    }
    return results
  }

  async syncGameRoles(qq, profileId = 1) {
    const lifetime = getProfileLifetime(qq, profileId)
    const original = await this.store.loadLoggedInProfile(qq, profileId)
    const candidate = structuredClone(original)
    await this.hydrateGameRoles(candidate)
    return writeAccount(qq, profileId, async () => {
      if (getProfileLifetime(qq, profileId) !== lifetime) throw accountChangedError("profile archived during role sync; stale result discarded")
      const latest = await this.store.loadLoggedInProfile(qq, profileId)
      if (credentialIdentity(latest.account) !== credentialIdentity(original.account)) {
        throw accountChangedError("account changed during role sync; stale result discarded")
      }
      latest.account.game_roles = candidate.account.game_roles
      latest.account.current_uid = pickCurrentUid(candidate.account.game_roles, latest.account.current_uid)
      latest.account.roles_updated_at = candidate.account.roles_updated_at
      delete latest.account.role_sync_error
      await this.store.saveProfile(latest)
      return latest
    })
  }

  async clearLogin(qq, profileId = 1) {
    const key = `${qq}:${profileId}`
    beginAccountChange(key)
    return writeAccount(qq, profileId, async () => {
      const profile = await this.store.loadLoggedInProfile(qq, profileId)
      clearAccountSecrets(profile)
      await this.store.saveProfile(profile)
      return profile
    })
  }

  async listSummaries(qq) {
    const ids = await this.store.listProfileIds(qq)
    const profiles = []
    for (const profileId of ids) {
      profiles.push(await this.store.loadProfile(qq, profileId))
    }
    return profiles
  }

  async trySyncGameRoles(profile, client = this.client) {
    try {
      await this.hydrateGameRoles(profile, client)
    } catch (error) {
      profile.account.role_sync_error = error.message || String(error)
      profile.account.roles_updated_at = ""
    }
    return profile
  }

  async hydrateGameRoles(profile, client = this.client) {
    if (typeof client.getAllGameRolesByCookie !== "function") return profile

    const cookie = profile?.account?.cookie
    if (!cookie) throw new Error("profile has no cookie")

    const res = await client.getAllGameRolesByCookie(cookie)
    if (res?.retcode !== 0) {
      throw new Error(res?.message || "game role sync failed")
    }

    const gameRoles = normalizeGameRolesFromApi(res?.data?.list)
    profile.account.game_roles = gameRoles
    profile.account.current_uid = pickCurrentUid(gameRoles, profile.account.current_uid)
    profile.account.roles_updated_at = formatLocalIso()
    delete profile.account.role_sync_error
    return profile
  }
}

export function applyLoginResult(profile, result) {
  const stoken = parseStokenCookie(result.stoken)
  const cookie = parseAccountCookie(result.cookie)
  const credentials = readStokenCredentials({ stoken_cookie: result.stoken, cookie: result.cookie })
  const stuid = credentials.stuid || stoken.stuid || cookie.ltuid
  if (!stoken.stoken || !stuid || (cookie.ltuid && String(cookie.ltuid) !== String(stuid))) {
    throw new Error("login result account id mismatch or missing stoken")
  }
  const ltoken = cookie.ltoken || stoken.ltoken
  const ltuid = cookie.ltuid || stuid

  profile.account = {
    ...profile.account,
    ltuid,
    stuid,
    stoken: stoken.stoken,
    ltoken,
    mid: stoken.mid || cookie.mid,
    cookie: result.cookie,
    stoken_cookie: buildStokenCookie({
      stuid,
      stoken: stoken.stoken,
      ltoken,
      mid: stoken.mid || cookie.mid,
    }),
    updated_at: formatLocalIso(),
  }

  if (result.game_roles) {
    profile.account.game_roles = {
      ...profile.account.game_roles,
      ...result.game_roles,
    }
  }

  return profile
}

export function clearAccountSecrets(profile) {
  profile.account ||= {}
  for (const key of [
    "ltuid",
    "stuid",
    "stoken",
    "ltoken",
    "mid",
    "cookie",
    "stoken_cookie",
    "updated_at",
    "roles_updated_at",
    "role_sync_error",
  ]) {
    profile.account[key] = ""
  }
  return profile
}
