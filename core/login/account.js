import {
  ensureProfile,
  listProfileIds,
  loadProfile,
  saveProfile,
} from "../config/profile.js"
import { MihoyoClient } from "../mihoyo/client.js"
import {
  buildAccountCookie,
  buildStokenCookie,
  parseAccountCookie,
  parseStokenCookie,
} from "../mihoyo/cookies.js"
import {
  normalizeGameRolesFromApi,
  pickCurrentUid,
} from "../mihoyo/roles.js"

export class AccountService {
  constructor(options = {}) {
    this.client = options.client || new MihoyoClient(options)
  }

  async saveLoginResult({ qq, profileId = 1, result, nickname = "" } = {}) {
    if (!result?.stoken || !result?.cookie) {
      throw new Error("login result must include stoken and cookie")
    }

    const profile = await ensureProfile({ qq, profileId, nickname })
    applyLoginResult(profile, result)
    await this.trySyncGameRoles(profile)
    await saveProfile(profile)
    return profile
  }

  async get(qq, profileId = 1) {
    return loadProfile(qq, profileId)
  }

  async refresh(qq, profileId = 1) {
    const profile = await loadProfile(qq, profileId)
    const account = profile.account || {}
    if (!account.stuid || !account.stoken) {
      throw new Error(`profile ${profileId} has no stoken`)
    }

    const res = await this.client.getCookieTokenByStoken({
      stuid: account.stuid,
      stoken: account.stoken,
      mid: account.mid,
    })
    const cookieToken = res?.data?.cookie_token
    if (!cookieToken) {
      throw new Error(res?.message || "cookie_token refresh failed")
    }

    profile.account.cookie = buildAccountCookie({
      ltuid: account.ltuid || account.stuid,
      ltoken: account.ltoken,
      cookieToken,
    })
    profile.account.updated_at = new Date().toISOString()
    await this.trySyncGameRoles(profile)
    await saveProfile(profile)
    return profile
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
    const profile = await loadProfile(qq, profileId)
    await this.hydrateGameRoles(profile)
    await saveProfile(profile)
    return profile
  }

  async clearLogin(qq, profileId = 1) {
    const profile = await loadProfile(qq, profileId)
    clearAccountSecrets(profile)
    await saveProfile(profile)
    return profile
  }

  async listSummaries(qq) {
    const ids = await listProfileIds(qq)
    const profiles = []
    for (const profileId of ids) {
      profiles.push(await loadProfile(qq, profileId))
    }
    return profiles
  }

  async trySyncGameRoles(profile) {
    try {
      await this.hydrateGameRoles(profile)
    } catch (error) {
      profile.account.role_sync_error = error.message || String(error)
      profile.account.roles_updated_at = ""
    }
    return profile
  }

  async hydrateGameRoles(profile) {
    if (typeof this.client.getAllGameRolesByCookie !== "function") return profile

    const cookie = profile?.account?.cookie
    if (!cookie) throw new Error("profile has no cookie")

    const res = await this.client.getAllGameRolesByCookie(cookie)
    if (res?.retcode !== 0) {
      throw new Error(res?.message || "game role sync failed")
    }

    const gameRoles = normalizeGameRolesFromApi(res?.data?.list)
    profile.account.game_roles = gameRoles
    profile.account.current_uid = pickCurrentUid(gameRoles, profile.account.current_uid)
    profile.account.roles_updated_at = new Date().toISOString()
    delete profile.account.role_sync_error
    return profile
  }
}

export function applyLoginResult(profile, result) {
  const stoken = parseStokenCookie(result.stoken)
  const cookie = parseAccountCookie(result.cookie)
  const stuid = stoken.stuid || cookie.ltuid
  const ltoken = stoken.ltoken || cookie.ltoken
  const ltuid = cookie.ltuid || stuid

  profile.account = {
    ...profile.account,
    ltuid,
    stuid,
    stoken: stoken.stoken,
    ltoken,
    mid: stoken.mid,
    cookie: result.cookie,
    stoken_cookie: buildStokenCookie({
      stuid,
      stoken: stoken.stoken,
      ltoken,
      mid: stoken.mid,
    }),
    updated_at: new Date().toISOString(),
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
