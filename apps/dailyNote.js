const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  parseProfileIdFromMessage,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import {
  DailyNoteService,
  dailyNoteGameName,
} from "../services/dailyNote/service.js"

export class LotusDailyNote extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Daily Note",
      dsc: "Lotus profile aware daily note",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        {
          reg: `^#全部体力${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "allDailyNote",
        },
        {
          reg: `^#?(多|全|全部)(体力|树脂|查询体力|便笺|便签)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "allDailyNote",
        },
        {
          reg: `^#体力${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "genshinDailyNote",
        },
        {
          reg: `^#?(体力|树脂|查询体力|便笺|便签)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "genshinDailyNote",
        },
        {
          reg: `^\\*体力${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "starRailDailyNote",
        },
        {
          reg: `^#星铁体力${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "starRailDailyNote",
        },
        {
          reg: `^%体力${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "zzzDailyNote",
        },
        {
          reg: `^#绝区零体力${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "zzzDailyNote",
        },
      ],
    })
  }

  async allDailyNote() {
    return this.replyDailyNote(["gs", "sr", "zzz"])
  }

  async genshinDailyNote() {
    return this.replyDailyNote(["gs"])
  }

  async starRailDailyNote() {
    return this.replyDailyNote(["sr"])
  }

  async zzzDailyNote() {
    return this.replyDailyNote(["zzz"])
  }

  async replyDailyNote(games) {
    const userId = String(this.e.user_id)
    const hasSuffix = /\d+$/.test(String(this.e.msg || ""))
    const profileId = hasSuffix ? parseProfileIdFromMessage(this.e.msg) : null

    await replyText(this, profileId
      ? `[荷花插件]正在查询 profile ${profileId} 的体力。`
      : "[荷花插件]正在查询当前 QQ 的所有 profile 体力。")

    const service = new DailyNoteService()
    const results = await service.collect({
      qq: userId,
      profileId,
      games,
    })

    if (!results.length) {
      await replyText(this, "[荷花插件]没有找到可查询的 profile，请先扫码登录并同步 UID。")
      return true
    }

    const image = await renderTemplate("daily-note-summary", buildDailyNoteRenderData({
      userId,
      profileId,
      games,
      results,
    }), {
      saveId: `lotus-daily-note-${userId}-${profileId || "all"}-${games.join("-")}`,
    })

    await replyImage(this, image, "[荷花插件]体力查询完成。")
    return true
  }
}

export function buildDailyNoteRenderData({ userId, profileId, games, results }) {
  const okCount = results.filter(item => item.ok).length
  return {
    title: profileId ? `Profile ${profileId} 体力` : "全部体力",
    subtitle: `QQ ${userId} · ${games.map(dailyNoteGameName).join(" / ")}`,
    badge: `${okCount}/${results.length}`,
    message: okCount
      ? "已按 profile、游戏和 UID 汇总查询结果；单项失败不会影响其他 UID。"
      : "没有成功的体力结果，请检查登录态、UID 同步和设备信息。",
    groups: groupResults(results),
  }
}

function groupResults(results) {
  const map = new Map()
  for (const item of results) {
    const key = `Profile ${item.profileId || "-"}`
    if (!map.has(key)) map.set(key, [])
    map.get(key).push({
      ...item,
      gameName: dailyNoteGameName(item.game),
      status: item.ok ? "成功" : "失败",
      detail: item.ok ? item.summary : item.error,
      details: item.details || [],
    })
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }))
}
