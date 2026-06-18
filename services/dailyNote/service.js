import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  listProfileIds,
  loadProfile,
} from "../../core/config/profile.js"
import { deviceHeaders } from "../../core/devices/service.js"

const GAME_NAMES = Object.freeze({
  gs: "原神",
  sr: "星铁",
  zzz: "绝区零",
})

export class DailyNoteService {
  constructor(options = {}) {
    this.MysApi = options.MysApi
  }

  async collect({ qq, profileId, games = ["gs", "sr", "zzz"] } = {}) {
    const profileIds = profileId ? [profileId] : await listProfileIds(qq)
    const results = []

    for (const id of profileIds) {
      const profile = await loadProfile(qq, id).catch(error => {
        results.push({
          ok: false,
          profileId: id,
          game: "",
          uid: "",
          error: error.message,
        })
        return null
      })
      if (!profile) continue

      if (!profile.account?.cookie) {
        results.push({
          ok: false,
          profileId: id,
          game: "",
          uid: "",
          error: "profile 未保存 cookie",
        })
        continue
      }

      for (const game of games) {
        const roles = normalizeRoles(profile.account?.game_roles?.[game])
        if (!roles.length) {
          results.push({
            ok: false,
            profileId: id,
            game,
            uid: "",
            error: "未同步 UID",
          })
          continue
        }

        for (const role of roles) {
          results.push(await this.queryDailyNote(profile, game, role))
        }
      }
    }

    return results
  }

  async queryDailyNote(profile, game, role) {
    const uid = String(role.uid || role.game_uid || role)
    const profileId = profile.profile?.id || 1
    try {
      const MysApi = this.MysApi || await loadGenshinMysApi()
      const api = new MysApi(uid, profile.account.cookie, {
        game,
        device: profile.device?.id || "",
        log: false,
      })
      const res = await api.getData("dailyNote", {
        headers: deviceHeaders(profile.device),
      })

      if (!res || res.retcode !== 0) {
        return {
          ok: false,
          profileId,
          game,
          uid,
          nickname: role.nickname || "",
          error: res?.message || "dailyNote 查询失败",
          raw: res,
        }
      }

      return {
        ok: true,
        profileId,
        game,
        uid,
        nickname: role.nickname || "",
        data: res.data,
        summary: formatDailyNote(game, res.data),
        details: formatDailyNoteDetails(game, res.data),
      }
    } catch (error) {
      return {
        ok: false,
        profileId,
        game,
        uid,
        nickname: role.nickname || "",
        error: error.message,
      }
    }
  }
}

export function formatDailyNote(game, data = {}) {
  if (game === "gs") {
    return [
      `树脂 ${valuePair(data.current_resin, data.max_resin)}`,
      data.home_coin_recovery_time !== undefined ? `洞天宝钱 ${valuePair(data.current_home_coin, data.max_home_coin)}` : "",
      data.resin_recovery_time > 0 ? `回满 ${formatSeconds(data.resin_recovery_time)}` : "已回满",
    ].filter(Boolean).join(" · ")
  }

  if (game === "sr") {
    return [
      `开拓力 ${valuePair(data.current_stamina, data.max_stamina)}`,
      data.current_train_score !== undefined ? `活跃 ${valuePair(data.current_train_score, data.max_train_score)}` : "",
      data.stamina_recover_time > 0 ? `回满 ${formatSeconds(data.stamina_recover_time)}` : "已回满",
    ].filter(Boolean).join(" · ")
  }

  if (game === "zzz") {
    const energy = data.energy?.progress || data.energy || {}
    const vitality = data.vitality || {}
    return [
      `电量 ${valuePair(energy.current, energy.max)}`,
      vitality.current !== undefined ? `活跃 ${valuePair(vitality.current, vitality.max)}` : "",
      energy.rest || (data.energy?.restore > 0 ? `回满 ${formatSeconds(data.energy.restore)}` : ""),
    ].filter(Boolean).join(" · ")
  }

  return "未知游戏"
}

export function formatDailyNoteDetails(game, data = {}) {
  if (game === "gs") {
    return [
      detail("每日委托", data.is_extra_task_reward_received === true || data.is_extra_task_reward_received === 1 ? "奖励已领取" : "奖励未领取", data.is_extra_task_reward_received !== undefined),
      detail("探索派遣", expeditionCountText(data, {
        acceptedKeys: ["current_expedition_num"],
        totalKeys: ["max_expedition_num"],
      })),
      detail("最快派遣", fastestExpeditionText(data.expeditions, "remained_time")),
      detail("周本减半", weeklyDiscountText(data)),
      detail("参量质变仪", transformerText(data.transformer), data.transformer?.obtained),
    ].filter(Boolean)
  }

  if (game === "sr") {
    return [
      detail("委托执行", expeditionCountText(data, {
        acceptedKeys: [
          "accepted_expedition_num",
          "accepted_epedition_num",
          "current_expedition_num",
        ],
        totalKeys: ["total_expedition_num", "max_expedition_num"],
      })),
      detail("最快委托", fastestExpeditionText(data.expeditions, "remaining_time")),
      detail("每日实训", valuePair(data.current_train_score, data.max_train_score), data.current_train_score !== undefined),
      detail("模拟宇宙", valuePair(data.current_rogue_score, data.max_rogue_score), data.current_rogue_score !== undefined),
      detail("历战余响", valuePair(data.weekly_cocoon_cnt, data.weekly_cocoon_limit), data.weekly_cocoon_cnt !== undefined),
      detail("备用开拓力", String(data.current_reserve_stamina), data.current_reserve_stamina !== undefined),
    ].filter(Boolean)
  }

  if (game === "zzz") {
    const vitality = data.vitality || {}
    const vhs = data.vhs_sale || data.vhs || {}
    return [
      detail("活跃度", valuePair(vitality.current, vitality.max), vitality.current !== undefined),
      detail("录像店", vhs.sale_state || vhs.status || vhs.text, Boolean(vhs.sale_state || vhs.status || vhs.text)),
      detail("刮刮乐", data.card_sign === true || data.card_sign?.status ? "已完成" : "未完成", data.card_sign !== undefined),
    ].filter(Boolean)
  }

  return []
}

export function dailyNoteGameName(game) {
  return GAME_NAMES[game] || game
}

function normalizeRoles(roles = []) {
  if (!Array.isArray(roles)) return []
  return roles
    .map(role => typeof role === "object" ? role : { uid: role })
    .filter(role => role.uid || role.game_uid)
}

function valuePair(current, max) {
  const left = current ?? "-"
  const right = max ?? "-"
  return `${left}/${right}`
}

function detail(label, value, condition = true) {
  if (!condition) return null
  const text = String(value ?? "").trim()
  if (!text || text === "-/-" || text === "undefined") return null
  return { label, value: text }
}

function expeditionCountText(data = {}, { acceptedKeys = [], totalKeys = [] } = {}) {
  const accepted = firstDefined(data, acceptedKeys)
  const total = firstDefined(data, totalKeys)
  if (accepted !== undefined && total !== undefined) return `${accepted}/${total}`

  const expeditions = Array.isArray(data.expeditions) ? data.expeditions : []
  if (!expeditions.length && total === undefined) return ""

  const active = expeditions.filter(item => isExpeditionAccepted(item)).length
  return total !== undefined ? `${active}/${total}` : `${active}/${expeditions.length}`
}

function fastestExpeditionText(expeditions = [], preferredTimeKey = "") {
  if (!Array.isArray(expeditions) || !expeditions.length) return ""
  const secondsList = expeditions
    .map(item => expeditionRemainingSeconds(item, preferredTimeKey))
    .filter(value => Number.isFinite(value) && value >= 0)
  if (!secondsList.length) return ""
  const min = Math.min(...secondsList)
  return min <= 0 ? "已有完成" : `${formatSeconds(min)} 后完成`
}

function expeditionRemainingSeconds(item = {}, preferredTimeKey = "") {
  const value = firstDefined(item, [
    preferredTimeKey,
    "remaining_time",
    "remained_time",
    "remain_time",
    "left_time",
    "finish_time",
  ].filter(Boolean))
  const number = Number(value)
  if (!Number.isFinite(number)) return Number.NaN
  if (String(preferredTimeKey || "").includes("finish") || Number(value) > 10_000_000_000) {
    return Math.max(0, Math.floor(number - Date.now() / 1000))
  }
  return Math.max(0, number)
}

function isExpeditionAccepted(item = {}) {
  const status = String(item.status || item.state || "").toLowerCase()
  if (["none", "idle", "empty", "未派遣"].includes(status)) return false
  return Boolean(item.avatars?.length || item.remaining_time !== undefined || item.remained_time !== undefined || item.status || item.state)
}

function weeklyDiscountText(data = {}) {
  if (data.remain_resin_discount_num === undefined || data.resin_discount_num_limit === undefined) return ""
  const used = Number(data.resin_discount_num_limit) - Number(data.remain_resin_discount_num)
  return `${Math.max(0, used)}/${data.resin_discount_num_limit}`
}

function transformerText(transformer = {}) {
  if (!transformer?.obtained) return ""
  if (transformer.reached || transformer.recovery_time?.reached) return "可用"
  const time = transformer.recovery_time
  if (!time || typeof time !== "object") return "冷却中"
  return [
    time.Day ? `${time.Day}天` : "",
    time.Hour ? `${time.Hour}小时` : "",
    time.Minute ? `${time.Minute}分钟` : "",
  ].filter(Boolean).join("") || "冷却中"
}

function firstDefined(source = {}, keys = []) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key]
  }
  return undefined
}

function formatSeconds(seconds) {
  const total = Number(seconds || 0)
  if (total <= 0) return "0分钟"
  const hours = Math.floor(total / 3600)
  const minutes = Math.ceil((total % 3600) / 60)
  if (hours > 0) return `${hours}小时${minutes}分钟`
  return `${minutes}分钟`
}

async function loadGenshinMysApi() {
  const file = path.join(process.cwd(), "plugins", "genshin", "model", "mys", "MysApi.js")
  return (await import(pathToFileURL(file).href)).default
}
