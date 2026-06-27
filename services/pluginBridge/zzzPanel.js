import { registerProfileWithGenshin } from "../genshinBridge/profile.js"
import { resolveServer } from "../../core/mihoyo/regions.js"
import { parseAccountCookie } from "../../core/mihoyo/cookies.js"
import { createIsolatedEvent, getRoleUid, importRuntimeModule, pickRole } from "./common.js"

export class ZzzPanelBridge {
  constructor(options = {}) {
    this.loadPanelClass = options.loadPanelClass || loadPanelClass
    this.loadAvatarModule = options.loadAvatarModule || loadAvatarModule
    this.loadMysApiClass = options.loadMysApiClass || loadMysApiClass
    this.registerProfile = options.registerProfile || registerProfileWithGenshin
    this.syncDevice = options.syncDevice || syncZzzDeviceWithRedis
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
    await this.syncDevice(profile)

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
    panel.getLtuid = async () => profile.account?.ltuid || profile.account?.stuid || parseAccountCookie(profile.account?.cookie).ltuid
    panel.getAPI = async () => this.createApiContext({ uid, profile, event })

    await runZzzPanelRefresh(panel, {
      uid,
      refreshPanelFunction: (await this.loadAvatarModule()).refreshPanel,
    })
    return {
      ok: true,
      game: "zzz",
      uid,
      profileId,
      messages: messages.filter(Boolean),
      forwarded,
    }
  }

  async createApiContext({ uid, profile, event } = {}) {
    const MysZZZApi = await this.loadMysApiClass()
    const cookieMap = buildZzzCookieMap(profile, uid)
    const api = new MysZZZApi(uid, cookieMap, {
      handler: event?.runtime?.handler || {},
      e: event,
    })
    return {
      api,
      uid,
      deviceFp: profile?.device?.fp || fallbackZzzDeviceFp(uid),
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

async function loadAvatarModule() {
  try {
    return await importRuntimeModule("ZZZ-Plugin", "dist", "lib", "avatar.js")
  } catch (error) {
    if (!/Cannot find module|ENOENT|ERR_MODULE_NOT_FOUND/.test(String(error?.message || error))) {
      throw error
    }
    return importRuntimeModule("ZZZ-Plugin", "lib", "avatar.js")
  }
}

async function loadMysApiClass() {
  try {
    return (await importRuntimeModule("ZZZ-Plugin", "dist", "lib", "mysapi.js")).default
  } catch (error) {
    if (!/Cannot find module|ENOENT|ERR_MODULE_NOT_FOUND/.test(String(error?.message || error))) {
      throw error
    }
    return (await importRuntimeModule("ZZZ-Plugin", "lib", "mysapi.js")).default
  }
}

async function runZzzPanelRefresh(panel, { uid, refreshPanelFunction } = {}) {
  if (typeof refreshPanelFunction !== "function") throw new Error("ZZZ-Plugin refreshPanel 函数不可用")
  const originalReply = panel.reply.bind(panel)
  let errorMsg = ""
  let result = null

  panel.reply = async msg => {
    errorMsg += `\n${summarizeZzzPanelReply(msg)}`
    return null
  }

  try {
    const { api, deviceFp } = await panel.getAPI()
    await originalReply("正在更新面板列表，请稍候...")
    if (typeof panel.getPlayerInfo === "function") await panel.getPlayerInfo()
    await globalThis.redis?.set?.(`ZZZ:PANEL:${uid}:LASTTIME`, Date.now())
    result = await refreshPanelFunction(api, deviceFp)
  } catch (error) {
    globalThis.logger?.error?.("面板列表更新失败：", error)
    errorMsg = `${error.message || error}${errorMsg}`
  } finally {
    panel.reply = originalReply
  }

  if (errorMsg && !result) {
    return panel.reply(`面板列表更新失败，请稍后再试或尝试%更新展柜面板：\n${errorMsg.trim()}`)
  }
  if (!result) return false

  const newChar = result.filter(item => item?.isNew)
  const finalData = {
    newChar: newChar.length,
    list: result,
  }
  if (typeof panel.render === "function") return panel.render("panel/refresh.html", finalData)
  return panel.reply({ type: "image", file: "zzz-panel.png" })
}

function buildZzzCookieMap(profile = {}, uid = "") {
  const account = profile.account || {}
  const cookie = account.cookie || ""
  const ltuid = account.ltuid || account.stuid || parseAccountCookie(cookie).ltuid
  if (!cookie) throw new Error("profile 未保存 cookie")
  if (!ltuid) throw new Error("profile cookie 缺少 ltuid")
  return {
    lotus: {
      ck: cookie,
      uid: String(uid),
      qq: String(profile.user?.qq || ""),
      ltuid: String(ltuid),
      device_id: profile.device?.id || "",
    },
  }
}

async function syncZzzDeviceWithRedis(profile = {}) {
  const redis = globalThis.redis
  if (!redis?.set) return
  const account = profile.account || {}
  const ltuid = account.ltuid || account.stuid || parseAccountCookie(account.cookie).ltuid
  if (!ltuid) return

  const prefix = `ZZZ:DEVICE_FP:${ltuid}`
  const device = profile.device || {}
  if (device.fp) await redis.set(`${prefix}:FP`, String(device.fp))
  if (device.id) await redis.set(`${prefix}:ID`, String(device.id))

  const bind = buildZzzBindDevice(device)
  if (bind) await redis.set(`${prefix}:BIND`, JSON.stringify(bind))
}

function buildZzzBindDevice(device = {}) {
  const raw = device.raw || {}
  const bind = {
    deviceName: raw.deviceName || device.name || "",
    deviceBoard: raw.deviceBoard || raw.board || "",
    deviceModel: raw.deviceModel || device.model || "",
    oaid: raw.oaid || "",
    androidVersion: raw.androidVersion || raw.osVersion || device.android_version || "",
    deviceFingerprint: raw.deviceFingerprint || raw.deviceInfo || "",
    deviceProduct: raw.deviceProduct || raw.productName || raw.product || "",
  }
  return Object.values(bind).some(Boolean) ? bind : null
}

function fallbackZzzDeviceFp(uid = "") {
  return /^(1[0-9])[0-9]{8}/i.test(String(uid || ""))
    ? "38d7f4c72b736"
    : "38d805c20d53d"
}

function summarizeZzzPanelReply(payload) {
  if (typeof payload === "string") return payload
  if (payload?.message) return String(payload.message)
  if (payload?.type === "image" || payload?.file) return "[图片]"
  return payload ? "[消息]" : ""
}
