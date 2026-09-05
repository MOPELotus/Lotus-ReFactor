import { registerProfileWithGenshin } from "../genshinBridge/profile.js"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { resolveServer } from "../../core/mihoyo/regions.js"
import { parseAccountCookie } from "../../core/mihoyo/cookies.js"
import { createIsolatedEvent, getRoleUid, importRuntimeModule, pickRole, shouldForwardReply } from "./common.js"

export class ZzzPanelBridge {
  constructor(options = {}) {
    this.loadPanelClass = options.loadPanelClass || loadPanelClass
    this.loadAvatarModule = options.loadAvatarModule || loadAvatarModule
    this.loadMysApiClass = options.loadMysApiClass || loadMysApiClass
    this.registerProfile = options.registerProfile || registerProfileWithGenshin
    this.syncDevice = options.syncDevice || syncZzzDeviceWithRedis
  }

  async updatePanel({ e, profile, profileId = 1, forwardReplies = true } = {}) {
    const Panel = await this.loadPanelClass()
    const context = await createZzzProfilePluginInstance({
      PluginClass: Panel,
      e,
      profile,
      profileId,
      command: "%更新面板",
      forwardReplies,
      registerProfile: this.registerProfile,
      syncDevice: this.syncDevice,
      loadMysApiClass: this.loadMysApiClass,
    })
    const { instance: panel, event, messages, forwarded, uid } = context

    const rendered = await runZzzPanelRefresh(panel, {
      uid,
      refreshPanelFunction: (await this.loadAvatarModule()).refreshPanel,
    })
    if (!forwarded.length && shouldForwardReply(rendered)) {
      await event.reply(rendered)
    }
    const renderedImage = rendered?.rendered === true || shouldForwardReply(rendered)
    return {
      ok: true,
      game: "zzz",
      uid,
      profileId,
      messages: messages.filter(Boolean),
      forwarded: renderedImage && !forwarded.length
        ? [...forwarded, "[图片]"]
        : forwarded,
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

export class ZzzProfileQueryBridge {
  constructor(options = {}) {
    this.loadPanelClass = options.loadPanelClass || loadPanelClass
    this.loadAvatarModule = options.loadAvatarModule || loadAvatarModule
    this.loadDamageClass = options.loadDamageClass || (() => loadZzzAppClass("damage.js", "Damage"))
    this.loadCardClass = options.loadCardClass || (() => loadZzzAppClass("card.js", "Card"))
    this.loadAbyssClass = options.loadAbyssClass || (() => loadZzzAppClass("abyss.js", "Abyss"))
    this.loadDeadlyClass = options.loadDeadlyClass || (() => loadZzzAppClass("deadly.js", "deadly"))
    this.loadVoidFrontBattleClass = options.loadVoidFrontBattleClass || (() => loadZzzAppClass("voidFrontBattle.js", "VoidFrontBattle"))
    this.loadClimbingTowerClass = options.loadClimbingTowerClass || (() => loadZzzAppClass("climbingTower.js", "ClimbingTower"))
    this.loadMonthlyClass = options.loadMonthlyClass || (() => loadZzzAppClass("monthly.js", "monthly"))
    this.loadHollowZeroClass = options.loadHollowZeroClass || (() => loadZzzAppClass("hollowZero.js", "HollowZero"))
    this.loadExplorationDetailClass = options.loadExplorationDetailClass || (() => loadZzzAppClass("explorationDetail.js", "ExplorationDetail"))
    this.loadMysApiClass = options.loadMysApiClass || loadMysApiClass
    this.registerProfile = options.registerProfile || registerProfileWithGenshin
    this.syncDevice = options.syncDevice || syncZzzDeviceWithRedis
    this.loadRankModule = options.loadRankModule || loadRankModule
  }

  async panel(options = {}) {
    const Panel = await this.loadPanelClass()
    return this.run({ ...options, PluginClass: Panel, method: "handleRule" })
  }

  async proficiency(options = {}) {
    const Panel = await this.loadPanelClass()
    return this.run({ ...options, PluginClass: Panel, method: "proficiency" })
  }

  async damage(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadDamageClass(), method: "charDamagePanel" })
  }

  async card(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadCardClass(), method: "card" })
  }

  async abyss(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadAbyssClass(), method: "abyss" })
  }

  async deadly(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadDeadlyClass(), method: "deadly" })
  }

  async voidFrontBattle(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadVoidFrontBattleClass(), method: "voidFrontBattle" })
  }

  async climbingTower(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadClimbingTowerClass(), method: "climbingTower" })
  }

  async monthly(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadMonthlyClass(), method: "monthly" })
  }

  async monthlyCollect(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadMonthlyClass(), method: "monthlyCollect" })
  }

  async hollowZero(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadHollowZeroClass(), method: "hollowZero" })
  }

  async hollowZeroS2(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadHollowZeroClass(), method: "hollowZeroS2" })
  }

  async explorationDetail(options = {}) {
    return this.run({ ...options, PluginClass: await this.loadExplorationDetailClass(), method: "explorationDetail" })
  }

  async groupRank({ e, profile, profileId = 1, command, mode = "weighted", character, forwardReplies = true } = {}) {
    if (!e?.group_id) return { ok: false, messages: ["请在群聊中使用该命令。"], forwarded: [] }
    const avatar = await this.loadAvatarModule()
    const rank = await this.loadRankModule()
    const ownUid = getRoleUid(pickRole(profile, "zzz"))
    if (ownUid && rank.setUidAndQQ) await rank.setUidAndQQ(String(e.group_id), ownUid, String(e.user_id))
    const uid2qqs = await rank.getUid2QQsMapping(String(e.group_id))
    const members = await e.group?.getMemberMap?.() || new Map()
    const memberIds = new Set(
      (members instanceof Map ? [...members.keys()] : Object.keys(members || {})).map(String),
    )
    const rows = []
    for (const [uid, qqs] of Object.entries(uid2qqs || {})) {
      const qq = qqs.find(id => memberIds.has(String(id)))
      if (!qq) continue
      const item = avatar.getPanel?.(uid, character)
      if (!item) continue
      if (item.weapon?.get_assets) await item.weapon.get_assets().catch(() => {})
      item.qq_avatar = await memberAvatar(e, qq)
      item.uid = String(uid)
      const rankValue = mode === "weighted" ? weightedScore(item) : Number(item.equip_score || 0)
      item.score_label = mode === "weighted" ? "加权分" : "面板分"
      item.score_value = rankValue.toFixed(2)
      item._rankValue = rankValue
      rows.push(item)
    }
    rows.sort((a, b) => b._rankValue - a._rankValue)
    const panel = new (await this.loadPanelClass())()
    const context = await createZzzProfilePluginInstance({ PluginClass: panel.constructor, e, profile, profileId, command, forwardReplies, registerProfile: this.registerProfile, syncDevice: this.syncDevice, loadMysApiClass: this.loadMysApiClass })
    context.instance.e = context.event
    context.instance.reply = context.event.reply.bind(context.event)
      // Runtime.render 的基础实现不会自动填充 ZZZ 模板依赖的 sys.currentPath；
      // 原 ZZZ Plugin 是在自己的 render() 中通过 beforeRender 注入这些路径的。
      // 这里沿用同一套路径约定，但模板仍由 Lotus-Plugin 提供，避免 CSS 变成裸 HTML。
      const rankRenderPath = "zzz-rank/index.html"
      const zzzLayoutPath = path.join(process.cwd(), "plugins", "ZZZ-Plugin", "resources", "common", "layout")
      await context.instance.e.runtime.render("Lotus-Plugin", rankRenderPath, {
        title: `${character}${mode === "weighted" ? "综合榜" : "排名"}`,
        list: rows,
        general: {},
      }, {
        // 对齐 ZZZ-Plugin 自身渲染参数，避免默认 1x/低质量截图导致头像和图标发糊。
        // ZZZ 渲染器内部还会乘以自身的 scaleCfgValue；这里设为 4，
        // 让最终截图尺寸明显放大，减少缩放后字体和细节发糊。
        scale: 4,
        quality: 100,
        beforeRender({ data }) {
          const renderPathDir = rankRenderPath.substring(0, rankRenderPath.lastIndexOf("/") + 1)
          // 以 Runtime 按实际安装路径计算出的资源根为准，避免开发目录名/部署目录名不一致。
          const rankResPath = data.pluResPath || data._res_path
          const zzzResPath = rankResPath?.replace(/plugins[\\/]Lotus-Plugin[\\/]resources[\\/]?$/, "plugins/ZZZ-Plugin/resources/") || rankResPath
          return {
            ...data,
            _res_path: rankResPath,
            pluResPath: rankResPath,
            defaultLayout: path.join(zzzLayoutPath, "index.html"),
            sys: {
              ...(data.sys || {}),
              scale: data.sys?.scale || 1,
              // defaultLayout 是 ZZZ 原布局，公共 style 也必须从 ZZZ-Plugin 资源根加载。
              resourcesPath: zzzResPath,
              currentPath: `${rankResPath}${renderPathDir}`,
              createdby: "Created By ZZZ-Plugin & Lotus-Plugin",
            },
          }
        },
      })
    context.forwarded.push("[图片]")
    return { ok: true, uid: "", profileId, messages: context.messages, forwarded: context.forwarded }
  }

  async run({ e, profile, profileId = 1, command, forwardReplies = true, PluginClass, method } = {}) {
    const context = await createZzzProfilePluginInstance({
      PluginClass,
      e,
      profile,
      profileId,
      command,
      forwardReplies,
      registerProfile: this.registerProfile,
      syncDevice: this.syncDevice,
      loadMysApiClass: this.loadMysApiClass,
    })
    const fn = context.instance?.[method]
    if (typeof fn !== "function") throw new Error(`ZZZ-Plugin ${method} 不可用`)
    const returned = await fn.call(context.instance)
    if (!context.forwarded.length && shouldForwardReply(returned)) {
      await context.event.reply(returned)
      context.forwarded.push("[图片]")
    }
    return {
      ok: true,
      game: "zzz",
      uid: context.uid,
      profileId,
      messages: context.messages.filter(Boolean),
      forwarded: context.forwarded,
    }
  }
}

export async function createZzzProfilePluginInstance({ PluginClass, e, profile, profileId = 1, command = "%面板", forwardReplies = true, registerProfile = registerProfileWithGenshin, syncDevice = syncZzzDeviceWithRedis, loadMysApiClass: loadMysApiClassImpl = loadMysApiClass } = {}) {
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

  await registerProfile({ qq: String(e.user_id), profile })
  await syncDevice(profile)

  const { event, messages, forwarded } = createIsolatedEvent(e, {
    msg: command,
    original_msg: command,
    uid,
    server,
    region: server,
    game: "zzz",
    isZZZ: true,
    mysSelfUid: true,
    noTips: false,
    forwardReplies,
  })

  await ensureRuntimeRender(event)

  const instance = new PluginClass()
  instance.e = event
  instance.reply = event.reply.bind(event)
  instance.getUID = async () => uid
  instance.getLtuid = async () => profile.account?.ltuid || profile.account?.stuid || parseAccountCookie(profile.account?.cookie).ltuid
  instance.getAPI = async () => createZzzApiContext({ uid, profile, event, loadMysApiClass: loadMysApiClassImpl })

  // ZZZ 角色面板查询通过运行时 handler 调用 getCharPanelTool。
  // Lotus 隔离实例未必经过 ZZZ loader 注册工具，因此补一个仅作用于本次事件的 fallback。
  const runtime = event.runtime || {}
  const handler = runtime.handler || {}
  const originalHas = typeof handler.has === "function" ? handler.has.bind(handler) : () => false
  const originalCall = typeof handler.call === "function" ? handler.call.bind(handler) : async () => false
  // 保留 Runtime 原型方法（尤其是 render）。直接对象展开会丢失原型方法，
  // 上游面板随后调用 e.runtime.render() 就会变成 “不是函数”。
  const scopedRuntime = runtime && typeof runtime === "object"
    ? Object.create(Object.getPrototypeOf(runtime))
    : {}
  Object.assign(scopedRuntime, runtime)
  scopedRuntime.e = event
  scopedRuntime.handler = {
    ...handler,
    has: key => key === "zzz.tool.panel" || originalHas(key),
    call: async (key, targetEvent, payload) => {
      if (key === "zzz.tool.panel" && typeof instance.getCharPanelTool === "function") {
        return instance.getCharPanelTool(targetEvent, payload)
      }
      return originalCall(key, targetEvent, payload)
    },
  }
  event.runtime = scopedRuntime

  return {
    instance,
    event,
    messages,
    forwarded,
    uid,
  }
}

async function ensureRuntimeRender(event) {
  if (typeof event?.runtime?.render === "function") return event.runtime
  try {
    const file = path.join(process.cwd(), "lib", "plugins", "runtime.js")
    const mod = await import(pathToFileURL(file).href)
    const Runtime = mod.default || mod.Runtime
    if (typeof Runtime === "function") {
      const runtime = new Runtime(event)
      event.runtime = runtime
      return runtime
    }
  } catch (error) {
    globalThis.logger?.debug?.(`[Lotus-Plugin] ZZZ runtime render init skipped: ${error.message}`)
  }
  return event.runtime
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

async function loadRankModule() {
  return importRuntimeModule("ZZZ-Plugin", "dist", "lib", "rank.js")
}

async function memberAvatar(e, qq) {
  try {
    const member = e.group?.pickMember?.(qq)
    return await member?.getAvatarUrl?.() || ""
  } catch { return "" }
}

function weightedScore(item) {
  const drive = Number(item.equip_score || 0)
  const weapon = item.weapon
  if (!weapon) return drive
  const rarity = weapon.rarity === "S" ? 10 : weapon.rarity === "A" ? 4 : 0
  const level = Math.floor(Number(weapon.level || 0) / 10)
  const refine = Math.max(0, Number(weapon.star || 1) - 1)
  const profession = weapon.profession && item.avatar_profession && weapon.profession === item.avatar_profession ? 6 : 0
  const suits = new Set((item.equip || []).flatMap(equip => Array.isArray(equip.equip_suit) ? equip.equip_suit.map(s => s.suit_id || s.id) : []))
  const suitBonus = Math.min(3, suits.size) * 2
  return drive + rarity + level + refine + profession + suitBonus
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

async function loadZzzAppClass(fileName, exportName) {
  try {
    return (await importRuntimeModule("ZZZ-Plugin", "dist", "apps", fileName))[exportName]
  } catch (error) {
    if (!/Cannot find module|ENOENT|ERR_MODULE_NOT_FOUND/.test(String(error?.message || error))) {
      throw error
    }
    return (await importRuntimeModule("ZZZ-Plugin", "apps", fileName))[exportName]
  }
}

async function createZzzApiContext({ uid, profile, event, loadMysApiClass: loadMysApiClassImpl = loadMysApiClass } = {}) {
  const MysZZZApi = await loadMysApiClassImpl()
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
  if (typeof panel.render === "function") {
    await panel.render("panel/refresh.html", finalData)
    return { rendered: true }
  }
  return panel.reply({ type: "image", file: "zzz-panel.png" })
}

export function buildZzzCookieMap(profile = {}, uid = "") {
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

export async function syncZzzDeviceWithRedis(profile = {}) {
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
