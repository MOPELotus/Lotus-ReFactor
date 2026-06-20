import { registerProfileWithGenshin } from "../genshinBridge/profile.js"
import { resolveServer } from "../../core/mihoyo/regions.js"
import { createIsolatedEvent, getRoleUid, importRuntimeModule, pickRole } from "./common.js"

export class ZzzPanelBridge {
  constructor(options = {}) {
    this.loadPanelClass = options.loadPanelClass || loadPanelClass
    this.registerProfile = options.registerProfile || registerProfileWithGenshin
  }

  async updatePanel({ e, profile, profileId = 1, forwardReplies = true } = {}) {
    const role = pickRole(profile, "zzz")
    const uid = getRoleUid(role)
    if (!uid) {
      throw new Error(`profile ${profileId} 没有同步绝区零 UID`)
    }
    const server = resolveServer({
      server: role.region,
      uid,
      game: "zzz",
    })

    await this.registerProfile({ qq: String(e.user_id), profile })

    const { event, messages, forwarded } = createIsolatedEvent(e, {
      msg: "%更新面板",
      uid,
      server,
      region: server,
      game: "zzz",
      isZZZ: true,
      mysSelfUid: true,
      noTips: false,
      forwardReplies,
    })

    const Panel = await this.loadPanelClass()
    const panel = new Panel()
    panel.e = event
    panel.reply = event.reply.bind(event)
    panel.getUID = async () => uid

    await panel.refreshPanel()
    return {
      ok: true,
      game: "zzz",
      uid,
      profileId,
      messages: messages.filter(Boolean),
      forwarded,
    }
  }
}

async function loadPanelClass() {
  try {
    return (await importRuntimeModule("ZZZ-Plugin", "dist", "apps", "panel.js")).Panel
  } catch (error) {
    if (!/Cannot find module|ENOENT|ERR_MODULE_NOT_FOUND/.test(String(error?.message || error))) {
      throw error
    }
    return (await importRuntimeModule("ZZZ-Plugin", "apps", "panel.js")).Panel
  }
}
