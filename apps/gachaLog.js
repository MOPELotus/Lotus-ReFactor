const BasePlugin = globalThis.plugin

import path from "node:path"
import { pathToFileURL } from "node:url"
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  isMissingProfileError,
  listProfileIds,
  loadProfile,
  parseProfileIdFromMessage,
  profileLoginRequiredMessage,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import {
  AuthKeyService,
  buildGachaLogUrl,
  getServer,
} from "../services/mihoyoAuthKey/service.js"
import { ZzzGachaBridge } from "../services/pluginBridge/zzzGacha.js"
import { GenshinGachaDisplayBridge } from "../services/pluginBridge/genshinGacha.js"
import { StarRailGachaDisplayBridge } from "../services/pluginBridge/starRailGacha.js"
import { StarRailGachaService } from "../services/starRailGacha/service.js"

export class LotusGachaLog extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Gacha Log",
      dsc: "Lotus profile aware gacha log update",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        {
          reg: "^#更新(全部|所有)抽卡记录$",
          fnc: "allGachaLogs",
        },
        {
          reg: `^#更新抽卡记录${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "genshinGachaLog",
        },
        {
          reg: `^#(原神)?(全部)?(抽卡|抽奖|角色|武器|集录|常驻|up|新手|全部)池*(记录|祈愿|分析)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "genshinGachaView",
        },
        {
          reg: `^\\*更新抽卡记录${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "starRailGachaLog",
        },
        {
          reg: `^#星铁更新抽卡记录${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "starRailGachaLog",
        },
        {
          reg: `^\\*(星铁)?(全部)?(抽卡|抽奖|角色|角色联动|光锥|光锥联动|常驻|新手|全部)池*(记录|祈愿|分析)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "starRailGachaView",
        },
        {
          reg: `^%更新抽卡记录${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "zzzGachaLog",
        },
        {
          reg: `^#(zzz|ZZZ|绝区零)(刷新|更新)抽卡(链接|记录)?${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "zzzGachaLog",
        },
      ],
    })
  }

  async genshinGachaLog() {
    return this.updateGachaLog("gs")
  }

  async genshinGachaView() {
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)
    try {
      const profile = await loadProfile(userId, profileId)
      const role = pickRole(profile, "gs")
      if (!role) {
        await replyText(this, `[荷花插件]profile ${profileId} 没有同步原神 UID。`)
        return true
      }
      const uid = String(role.uid || role.game_uid)
      const display = await new GenshinGachaDisplayBridge().render({
        e: this.e,
        qq: userId,
        uid,
        viewMessage: viewMessageForGenshin(this.e.msg),
      })
      await this.reply(display.button ? [display.image, display.button] : display.image)
    } catch (error) {
      if (isMissingProfileError(error)) {
        await replyText(this, `[荷花插件]${profileLoginRequiredMessage(profileId)}`)
        return true
      }
      logger?.error?.(`[Lotus-Plugin] genshin gacha view failed: ${error.stack || error.message}`)
      await replyText(this, `[荷花插件]原神抽卡记录读取失败：${error.message}`)
    }
    return true
  }

  async starRailGachaLog() {
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)
    try {
      await replyText(this, `[荷花插件]正在为 profile ${profileId} 更新星铁五星与垫抽记录。`)
      const result = await this.runStarRailGachaLog({ userId, profileId })
      if (result.skipped) {
        await replyText(this, `[荷花插件]profile ${profileId} 没有同步星铁 UID。`)
        return true
      }
      const canonical = await new StarRailGachaService().loadLog(userId, result.uid)
      await new StarRailGachaDisplayBridge().syncLegacy({
        qq: userId,
        uid: result.uid,
        data: canonical || result.data,
      })
      const visiblePools = result.pools.filter(pool => pool.total || pool.totalDraws)
      const image = await renderStatusCard({
        title: "星铁抽卡记录",
        subtitle: `QQ ${userId} · Profile ${profileId} · UID ${result.uid}`,
        badge: result.added ? `新增 ${result.added}` : "已是最新",
        message: "已通过官方小程序接口更新五星和抽数；重复更新会按记录 ID 合并，不会叠加。",
        userId,
        items: visiblePools.length
          ? visiblePools.map(pool => ({
            label: pool.name,
            value: `五星 ${pool.total}（新增 ${pool.added}）· 已抽 ${pool.totalDraws} · 当前垫 ${pool.pity}`,
          }))
          : [{ label: "记录", value: "当前没有可用抽卡数据" }],
      }, {
        saveId: `lotus-gacha-${userId}-${profileId}-sr`,
      })
      await replyImage(this, image, "[荷花插件]星铁抽卡记录更新完成。")
    } catch (error) {
      if (isMissingProfileError(error)) {
        await replyText(this, `[荷花插件]${profileLoginRequiredMessage(profileId)}`)
        return true
      }
      const message = translateGachaError(error)
      logger?.error?.(`[Lotus-Plugin] star rail gacha update failed: ${error.stack || error.message}`)
      const image = await renderStatusCard({
        title: "星铁抽卡记录",
        subtitle: `QQ ${userId} · Profile ${profileId}`,
        badge: "失败",
        message,
        userId,
        items: [
          { label: "阶段", value: "profile Cookie / 星铁官方活动接口" },
          { label: "建议", value: "检查 profile 登录状态与星铁 UID；无需 authkey。" },
        ],
      }, { saveId: `lotus-gacha-error-${userId}-${profileId}-sr` })
      await replyImage(this, image, `[荷花插件]星铁抽卡记录更新失败：${message}`)
    }
    return true
  }

  async starRailGachaView() {
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)
    try {
      const profile = await loadProfile(userId, profileId)
      const role = pickRole(profile, "sr")
      if (!role) {
        await replyText(this, `[荷花插件]profile ${profileId} 没有同步星铁 UID。`)
        return true
      }
      const uid = String(role.uid || role.game_uid)
      const data = await new StarRailGachaService().loadLog(userId, uid)
      if (!data) {
        await replyText(this, `[荷花插件]profile ${profileId} 暂无星铁抽卡记录，请先使用 *更新抽卡记录${profileId === 1 ? "" : profileId}。`)
        return true
      }
      const display = await new StarRailGachaDisplayBridge().render({
        e: this.e,
        uid,
        data,
        viewMessage: viewMessageForStarRail(this.e.msg),
      })
      await this.reply(display.button ? [display.image, display.button] : display.image)
    } catch (error) {
      if (isMissingProfileError(error)) {
        await replyText(this, `[荷花插件]${profileLoginRequiredMessage(profileId)}`)
        return true
      }
      logger?.error?.(`[Lotus-Plugin] star rail gacha view failed: ${error.stack || error.message}`)
      await replyText(this, `[荷花插件]星铁抽卡记录读取失败：${error.message}`)
    }
    return true
  }

  async zzzGachaLog() {
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)
    try {
      await replyText(this, `[荷花插件]正在为 profile ${profileId} 更新绝区零抽卡记录。`)
      const result = await this.runZzzGachaLog({ userId, profileId })
      const image = await renderStatusCard({
        title: "绝区零抽卡记录",
        subtitle: `QQ ${userId} · Profile ${profileId} · UID ${result.uid}`,
        badge: "完成",
        message: "绝区零抽卡记录更新流程已结束。",
        userId,
        items: result.pools.length
          ? result.pools.map(pool => ({
            label: pool.name,
            value: `新增 ${pool.added} / 总计 ${pool.total}`,
          }))
          : [{ label: "卡池", value: "无新增记录" }],
      }, {
        saveId: `lotus-zzz-gacha-${userId}-${profileId}`,
      })
      await replyImage(this, image, "[荷花插件]绝区零抽卡记录更新完成。")
    } catch (error) {
      if (isMissingProfileError(error)) {
        await replyText(this, `[荷花插件]${profileLoginRequiredMessage(profileId)}`)
        return true
      }

      const message = translateGachaError(error)
      logger?.error?.(`[Lotus-Plugin] zzz gacha update failed: ${error.stack || error.message}`)
      const image = await renderStatusCard({
        title: "绝区零抽卡记录",
        subtitle: `QQ ${userId} · Profile ${profileId}`,
        badge: "失败",
        message,
        userId,
        items: [
          { label: "阶段", value: "荷花插件 authkey / 绝区零抽卡接口" },
          { label: "建议", value: "检查 profile stoken、绝区零 UID 和登录状态。" },
        ],
      }, {
        saveId: `lotus-zzz-gacha-error-${userId}-${profileId}`,
      })
      await replyImage(this, image, `[荷花插件]绝区零抽卡记录更新失败：${message}`)
    }

    return true
  }

  async updateGachaLog(game) {
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)

    try {
      await replyText(this, `[荷花插件]正在为 profile ${profileId} 获取 authkey 并更新抽卡记录。`)
      const result = await this.runGenshinGachaLog({ userId, profileId, game })
      if (result.skipped) {
        await replyText(this, `[荷花插件]profile ${profileId} 没有同步${game === "sr" ? "星铁" : "原神"} UID。`)
        return true
      }

      const image = await renderStatusCard({
        title: "抽卡记录",
        subtitle: `QQ ${userId} · Profile ${profileId} · UID ${result.uid}`,
        badge: "完成",
        message: result.messages.join("\n").slice(0, 180) || "抽卡记录更新流程已结束。",
        userId,
        items: [
          { label: "游戏", value: game === "sr" ? "星铁" : "原神" },
          { label: "Region", value: result.region },
          { label: "Authkey", value: "已获取" },
          { label: "消息数", value: String(result.messages.length) },
        ],
      }, {
        saveId: `lotus-gacha-${userId}-${profileId}-${game}`,
      })
      await replyImage(this, image, "[荷花插件]抽卡记录更新完成。")
    } catch (error) {
      if (isMissingProfileError(error)) {
        await replyText(this, `[荷花插件]${profileLoginRequiredMessage(profileId)}`)
        return true
      }

      const message = translateGachaError(error)
      logger?.error?.(`[Lotus-Plugin] gacha log update failed: ${error.stack || error.message}`)
      const image = await renderStatusCard({
        title: "抽卡记录",
        subtitle: `QQ ${userId} · Profile ${profileId}`,
        badge: "失败",
        message,
        userId,
        items: [
          { label: "阶段", value: "authkey / GachaLog" },
          { label: "建议", value: "检查 profile stoken、UID 和登录状态。" },
        ],
      }, {
        saveId: `lotus-gacha-error-${userId}-${profileId}-${game}`,
      })
      await replyImage(this, image, `[荷花插件]抽卡记录更新失败：${message}`)
    }

    return true
  }

  async allGachaLogs() {
    const userId = String(this.e.user_id)
    const profileIds = await listProfileIds(userId)
    if (!profileIds.length) {
      await replyText(this, "[荷花插件]没有找到你的 profile。")
      return true
    }

    await replyText(this, "[荷花插件]开始批量更新所有 profile 的原神/星铁/绝区零抽卡记录。")
    const results = []
    for (const profileId of profileIds) {
      try {
        results.push(await this.runGenshinGachaLog({ userId, profileId, game: "gs" }))
      } catch (error) {
        results.push({ ok: false, profileId, game: "gs", error: error.message })
      }
      try {
        results.push(await this.runStarRailGachaLog({ userId, profileId }))
      } catch (error) {
        results.push({ ok: false, profileId, game: "sr", error: error.message })
      }
      try {
        results.push(await this.runZzzGachaLog({ userId, profileId }))
      } catch (error) {
        results.push({ ok: false, profileId, game: "zzz", error: error.message })
      }
    }

    const done = results.filter(item => item.ok).length
    const skipped = results.filter(item => item.skipped).length
    const failed = results.filter(item => !item.ok && !item.skipped).length
    const image = await renderStatusCard({
      title: "全部抽卡记录",
      subtitle: `QQ ${userId}`,
      badge: failed ? "部分失败" : "完成",
      message: `完成 ${done} 项，跳过 ${skipped} 项，失败 ${failed} 项。`,
      userId,
      items: results.slice(0, 18).map(item => ({
        label: `P${item.profileId} ${gameLabel(item.game)}`,
        value: item.ok
          ? `UID ${item.uid || "-"} · 完成`
          : item.skipped
            ? "未绑定 UID，跳过"
            : `失败：${item.error || "未知错误"}`,
      })),
    }, {
      saveId: `lotus-gacha-all-${userId}`,
    })
    await replyImage(this, image, "[荷花插件]全部抽卡记录更新完成。")
    return true
  }

  async runGenshinGachaLog({ userId, profileId, game }) {
    const messages = []
    const profile = await loadProfile(userId, profileId)
    const role = pickRole(profile, game)
    if (!role) {
      return {
        ok: false,
        skipped: true,
        profileId,
        game,
      }
    }

    const uid = String(role.uid || role.game_uid)
    const auth = await new AuthKeyService().getAuthKey({
      profile,
      game,
      uid,
      region: role.region || getServer(uid, game),
      authAppId: "webview_gacha",
    })
    const url = buildGachaLogUrl(auth)
    const GachaLog = await loadGachaLogModel()
    const event = createGachaEvent(this.e, {
      game,
      uid,
      url,
      messages,
    })

    await new GachaLog(event).logUrl()
    return {
      ok: true,
      profileId,
      game,
      uid,
      region: auth.region,
      messages,
    }
  }

  async runStarRailGachaLog({ userId, profileId }) {
    const profile = await loadProfile(userId, profileId)
    const role = pickRole(profile, "sr")
    if (!role) return { ok: false, skipped: true, profileId, game: "sr" }
    return new StarRailGachaService().updateByProfile({
      qq: userId,
      profile,
      profileId,
    })
  }

  async runZzzGachaLog({ userId, profileId }) {
    const profile = await loadProfile(userId, profileId)
    const role = pickRole(profile, "zzz")
    if (!role) {
      return {
        ok: false,
        skipped: true,
        profileId,
        game: "zzz",
      }
    }
    const result = await new ZzzGachaBridge().updateGachaLog({
      e: this.e,
      profile,
      profileId,
    })
    return {
      ok: true,
      profileId,
      game: "zzz",
      ...result,
    }
  }
}

function pickRole(profile, game) {
  const currentUid = profile.account?.current_uid?.[game]
  const roles = Array.isArray(profile.account?.game_roles?.[game])
    ? profile.account.game_roles[game]
    : []
  if (currentUid) {
    const matched = roles.find(role => String(role.uid || role.game_uid || role) === String(currentUid))
    if (matched) return matched
    return { uid: currentUid }
  }
  return roles[0]
}

function createGachaEvent(baseEvent, { game, uid, url, messages }) {
  return {
    ...baseEvent,
    msg: url,
    uid,
    isSr: game === "sr",
    isPrivate: true,
    reply: async msg => {
      const text = Array.isArray(msg) ? msg.join("\n") : String(msg)
      messages.push(text)
      return true
    },
  }
}

function gameLabel(game) {
  if (game === "gs") return "原神"
  if (game === "sr") return "星铁"
  if (game === "zzz") return "绝区零"
  return game || "-"
}

function viewMessageForStarRail(message = "") {
  const text = String(message).replace(/\\d+$/, "")
  if (/全部/.test(text)) return "#星铁全部记录"
  if (/角色联动/.test(text)) return "#星铁角色联动记录"
  if (/光锥联动/.test(text)) return "#星铁光锥联动记录"
  if (/光锥/.test(text)) return "#星铁光锥记录"
  if (/常驻/.test(text)) return "#星铁常驻记录"
  if (/新手/.test(text)) return "#星铁新手记录"
  return "#星铁角色记录"
}

function viewMessageForGenshin(message = "") {
  const text = String(message).replace(/\d+$/, "")
  if (/全部/.test(text)) return "#原神全部记录"
  if (/武器/.test(text)) return "#原神武器记录"
  if (/集录/.test(text)) return "#原神集录记录"
  if (/常驻/.test(text)) return "#原神常驻记录"
  if (/新手/.test(text)) return "#原神新手记录"
  return "#原神角色记录"
}

export function translateGachaError(error) {
  const message = String(error?.message || error || "未知错误").trim()
  if (!message) return "未知错误"
  if (/visit too frequently/i.test(message)) return "访问过于频繁，请稍后再试。"
  if (/authkey/i.test(message) && /timeout|timed out/i.test(message)) return "authkey 请求超时，请稍后重试。"
  if (/invalid authkey|authkey.*invalid/i.test(message)) return "authkey 已失效，请重新扫码登录后再试。"
  if (/login|stoken|cookie/i.test(message)) return message
    .replace(/stoken/gi, "stoken")
    .replace(/cookie/gi, "cookie")
    .replace(/login/gi, "登录")
  return message
}

async function loadGachaLogModel() {
  const file = path.join(process.cwd(), "plugins", "genshin", "model", "gachaLog.js")
  return (await import(pathToFileURL(file).href)).default
}
