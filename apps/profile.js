const BasePlugin = globalThis.plugin

import {
  ensureProfile,
  listProfileIds,
  parseProfileIdFromMessage,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { maskSecret } from "../core/mihoyo/cookies.js"
import { renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"

export class LotusProfile extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Profile",
      dsc: "Lotus profile card",
      event: "message",
      priority: 20,
      rule: [
        {
          reg: `^#(Lotus|荷花)?(配置|资料|资料卡|我的配置)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "profileCard",
        },
      ],
    })
  }

  async profileCard() {
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)
    const profile = await ensureProfile({
      qq: userId,
      profileId,
      nickname: this.e.sender?.card || this.e.sender?.nickname || "",
    })
    const profiles = await listProfileIds(userId)
    const image = await renderTemplate("profile-card", buildProfileCardData(profile, profiles), {
      saveId: `lotus-profile-${userId}-${profileId}`,
    })

    await replyImage(this, image, `[荷花插件]profile ${profileId} 配置资料卡`)
    return true
  }
}

export function buildProfileCardData(profile, profiles = []) {
  const account = profile.account || {}
  const games = profile.games?.cn || {}
  const os = profile.games?.os || {}
  const cloud = profile.cloud_games?.cn || {}
  const device = profile.device || {}
  const bbs = profile.mihoyobbs || {}
  const profileId = profile.profile?.id || 1
  const roleCounts = countRoles(account.game_roles)
  const currentUid = account.current_uid || {}
  const userId = String(profile.user?.qq || "")
  const nickname = profile.user?.nickname || (userId ? `QQ ${userId}` : "配置资料卡")
  const notifyEnabled = profile.profile?.notify?.enable !== false

  return {
    title: nickname,
    subtitle: `profile ${profileId} · ${profile.profile?.name || "default"}`,
    badge: account.cookie ? "已登录" : "未登录",
    avatar: qqAvatar(userId),
    summary: account.cookie
      ? `签到模式：${scheduleModeText(profile)} · 通知：${notifyEnabled ? "开启" : "关闭"}。敏感字段已脱敏显示。`
      : "当前 profile 尚未扫码登录，可使用 #扫码登录 或 #扫码登录2 绑定对应槽位。",
    account: [
      { label: "通行证", value: maskSecret(account.ltuid || account.stuid) || "未绑定" },
      { label: "Cookie", value: account.cookie ? "已保存" : "未保存" },
      { label: "SToken", value: account.stoken ? "已保存" : "未保存" },
      { label: "设备信息", value: device.bound ? `${device.name || device.model || "已绑定"}` : "未绑定" },
    ],
    roles: [
      { label: "原神", value: roleText(roleCounts.gs, currentUid.gs) },
      { label: "星铁", value: roleText(roleCounts.sr, currentUid.sr) },
      { label: "绝区零", value: roleText(roleCounts.zzz, currentUid.zzz) },
    ],
    settings: [
      ...gameSettingRows(games, bbs),
      os.enable ? { label: "国际服", value: `${os.lang || "zh-cn"} · ${os.cookie ? "已保存" : "未保存"}` } : null,
      hasCloudEnabled(cloud) ? { label: "云游戏", value: cloudText(cloud) } : null,
    ].filter(Boolean),
    warnings: [
      account.role_sync_error ? `角色同步：${account.role_sync_error}` : "",
      device.bound ? "" : "社区签到需要先绑定设备信息。",
    ].filter(Boolean),
  }
}

function countRoles(gameRoles = {}) {
  return {
    gs: Array.isArray(gameRoles.gs) ? gameRoles.gs.length : 0,
    sr: Array.isArray(gameRoles.sr) ? gameRoles.sr.length : 0,
    zzz: Array.isArray(gameRoles.zzz) ? gameRoles.zzz.length : 0,
  }
}

function roleText(count, currentUid) {
  if (!count) return "未同步"
  return currentUid ? `${count} 个 · 当前 ${currentUid}` : `${count} 个`
}

function scheduleText(schedule = {}, enabled = true) {
  if (!enabled) return "仅手动"
  if (!schedule || schedule.mode === "inherit") return "跟随全局"
  if (schedule.mode === "fixed") return schedule.fixed_time || "固定"
  return "随机"
}

function scheduleModeText(profile) {
  return scheduleText(profile.schedule, profile.enabled !== false)
}

function gameSettingRows(games = {}, bbs = {}) {
  const checkinList = Array.isArray(bbs.checkin_list)
    ? bbs.checkin_list.map(Number)
    : []
  return [
    ["原神", "genshin", 2],
    ["崩坏2", "honkai2", 3],
    ["崩坏3", "honkai3rd", 1],
    ["未定事件簿", "tears_of_themis", 4],
    ["大别野", "", 5],
    ["星铁", "honkai_sr", 6],
    ["绝区零", "zzz", 8],
    ["因缘精灵", "hna", 9],
    ["星布谷地", "", 10],
  ].map(([label, key, forumId]) => ({
    label,
    value: `游戏 ${key ? games[key]?.checkin ? "开启" : "关闭" : "无"} · 社区 ${bbs.enable && checkinList.includes(forumId) ? "开启" : "关闭"}`,
  }))
}

function cloudText(cloud = {}) {
  const enabled = []
  if (cloud.genshin?.enable) enabled.push(`云原神${cloud.genshin.token ? "" : "(缺 token)"}`)
  if (cloud.zzz?.enable) enabled.push(`云绝区零${cloud.zzz.token ? "" : "(缺 token)"}`)
  return enabled.length ? enabled.join(" / ") : "关闭"
}

function hasCloudEnabled(cloud = {}) {
  return Boolean(cloud.genshin?.enable || cloud.zzz?.enable)
}

function qqAvatar(qq) {
  const id = String(qq || "1102305070")
  return `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`
}
