import { registerProfileWithGenshin } from "../genshinBridge/profile.js"
import { resolveServer } from "../../core/mihoyo/regions.js"
import { createIsolatedEvent, getRoleUid, importRuntimeModule, pickRole } from "./common.js"

export class MiaoPanelBridge {
  constructor(options = {}) {
    this.loadProfileList = options.loadProfileList || loadProfileList
    this.registerProfile = options.registerProfile || registerProfileWithGenshin
  }

  async updatePanel({ e, profile, profileId = 1, game = "gs", forwardReplies = true } = {}) {
    if (!["gs", "sr"].includes(game)) {
      throw new Error("miao 面板只支持原神和星铁")
    }

    const role = pickRole(profile, game)
    const uid = getRoleUid(role)
    if (!uid) {
      throw new Error(`profile ${profileId} 没有同步${game === "sr" ? "星铁" : "原神"} UID`)
    }
    const server = resolveServer({
      server: role.region,
      uid,
      game,
    })

    await this.registerProfile({ qq: String(e.user_id), profile })
    const ProfileList = await this.loadProfileList()
    const { event, messages, forwarded } = createIsolatedEvent(e, {
      msg: `${game === "sr" ? "#星铁" : "#原神"}更新面板${uid}`,
      uid,
      server,
      region: server,
      game,
      isSr: game === "sr",
      mysSelfUid: true,
      noTips: false,
      forwardReplies,
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

async function loadProfileList() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "profile", "ProfileList.js")
  return mod.default
}
