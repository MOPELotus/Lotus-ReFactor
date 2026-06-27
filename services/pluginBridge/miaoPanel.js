import { registerProfileWithGenshin } from "../genshinBridge/profile.js"
import { resolveServer } from "../../core/mihoyo/regions.js"
import { createIsolatedEvent, getRoleUid, importRuntimeModule, pickRole } from "./common.js"

export class MiaoPanelBridge {
  constructor(options = {}) {
    this.loadProfileList = options.loadProfileList || loadProfileList
    this.registerProfile = options.registerProfile || registerProfileWithGenshin
  }

  async updatePanel({ e, profile, profileId = 1, game = "gs", forwardReplies = true } = {}) {
    const ProfileList = await this.loadProfileList()
    const { event, messages, forwarded, uid } = await createMiaoProfileEvent({
      e,
      profile,
      profileId,
      game,
      forwardReplies,
      registerProfile: this.registerProfile,
    })

    await ProfileList.refreshMys(event)
    return {
      ok: true,
      game,
      uid,
      profileId,
      messages: messages.filter(Boolean),
      forwarded,
    }
  }
}

export async function createMiaoProfileEvent({ e, profile, profileId = 1, game = "gs", msg, forwardReplies = true, registerProfile = registerProfileWithGenshin } = {}) {
  if (!["gs", "sr"].includes(game)) {
    throw new Error("miao 面板只支持原神和星铁")
  }

  const role = pickRole(profile, game)
  const uid = getRoleUid(role)
  if (!uid) {
    throw new Error(`profile ${profileId} 没有同步${gameLabel(game)} UID`)
  }
  const server = resolveServer({
    server: role.region,
    uid,
    game,
  })

  await registerProfile({ qq: String(e.user_id), profile })
  const command = msg || `${game === "sr" ? "#星铁" : "#原神"}更新面板${uid}`
  const { event, messages, forwarded } = createIsolatedEvent(e, {
    msg: command,
    original_msg: command,
    uid,
    server,
    region: server,
    game,
    isSr: game === "sr",
    mysSelfUid: true,
    noTips: false,
    forwardReplies,
  })
  event.runtime = createProfileScopedRuntime(event.runtime, {
    event,
    profile,
    profileId,
    uid,
    game,
  })

  return {
    event,
    messages,
    forwarded,
    uid,
    game,
    profileId,
  }
}

async function loadProfileList() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "profile", "ProfileList.js")
  return mod.default
}

export function createProfileScopedRuntime(runtime, { event, profile, profileId, uid, game } = {}) {
  if (!runtime || typeof runtime !== "object") return runtime
  const scoped = Object.create(Object.getPrototypeOf(runtime))
  Object.assign(scoped, runtime)
  scoped.e = event
  scoped._mysInfo = {}

  if (typeof runtime.getMysInfo === "function") {
    const originalGetMysInfo = runtime.getMysInfo
    scoped.getMysInfo = async function lotusProfileScopedGetMysInfo(...args) {
      const mysInfo = await originalGetMysInfo.apply(scoped, args)
      assertProfileMysInfo(mysInfo, { profile, profileId, uid, game })
      return mysInfo
    }
  }

  return scoped
}

function assertProfileMysInfo(mysInfo, { profile, profileId, uid, game } = {}) {
  if (!mysInfo) throw new Error(`profile ${profileId} 未能初始化 ${gameLabel(game)} MysInfo`)
  const actualUid = String(mysInfo.uid || "")
  if (actualUid !== String(uid)) {
    throw new Error(`profile ${profileId} ${gameLabel(game)} UID 隔离失败：期望 ${uid}，实际 ${actualUid || "空"}`)
  }
  if (!mysInfo.ckInfo?.ck) {
    throw new Error(`profile ${profileId} ${gameLabel(game)} CK 未被 miao/genshin 识别`)
  }

  const expectedLtuid = String(profile?.account?.ltuid || profile?.account?.stuid || "")
  const actualLtuid = String(mysInfo.ckInfo?.ltuid || "")
  if (expectedLtuid && actualLtuid && actualLtuid !== expectedLtuid) {
    throw new Error(`profile ${profileId} ${gameLabel(game)} CK 隔离失败：期望 ltuid ${expectedLtuid}，实际 ${actualLtuid}`)
  }
}

export function gameLabel(game) {
  return game === "sr" ? "星铁" : "原神"
}
