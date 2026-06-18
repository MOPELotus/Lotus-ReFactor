import path from "node:path"
import { pathToFileURL } from "node:url"

export async function registerProfileWithGenshin({ qq, profile, modules } = {}) {
  const account = profile?.account || {}
  const ltuid = account.ltuid || account.stuid
  if (!qq || !ltuid || !account.cookie) {
    return {
      ok: false,
      reason: "missing_account",
    }
  }

  const { NoteUser, MysUser } = modules || await loadGenshinModels()
  const mysUser = await MysUser.create(String(ltuid))
  if (!mysUser) {
    return {
      ok: false,
      reason: "mys_user_create_failed",
    }
  }

  mysUser.setCkData?.({
    ltuid: String(ltuid),
    ck: account.cookie,
    type: "mys",
    uids: normalizeGameRoles(account.game_roles),
  })

  for (const [game, uids] of Object.entries(normalizeGameRoles(account.game_roles))) {
    mysUser.addUid?.(uids, game)
  }

  await mysUser.save?.()

  const noteUser = await NoteUser.create(String(qq))
  await noteUser.addMysUser(mysUser)

  return {
    ok: true,
    ltuid: String(ltuid),
    uids: normalizeGameRoles(account.game_roles),
  }
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
