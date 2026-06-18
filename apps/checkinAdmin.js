const BasePlugin = globalThis.plugin

import { loadGlobalConfig } from "../core/config/global.js"
import {
  listAllProfiles,
  listProfileIds,
  loadProfile,
} from "../core/config/profile.js"
import { AccountService } from "../core/login/account.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { isProfileCheckinEnabled } from "../core/scheduler/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { readCheckinAudit } from "../services/checkin/audit.js"
import { registerProfileWithGenshin } from "../services/genshinBridge/profile.js"
import {
  groupMemberDisplayName,
  normalizeGroupMemberEntries,
} from "../services/group/members.js"

export class LotusCheckinAdmin extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Checkin Admin",
      dsc: "Lotus checkin list, logs and batch refresh",
      event: "message",
      priority: 20,
      rule: [
        { reg: "^#签到名单列表$", fnc: "listProfiles" },
        { reg: "^#自动签到日志$", fnc: "checkinLogs" },
        { reg: "^#批量刷新签到$", fnc: "batchRefresh" },
      ],
    })
  }

  async listProfiles() {
    const globalConfig = await loadGlobalConfig()
    const view = await buildProfileListView(this.e, globalConfig)

    const image = await renderStatusCard({
      title: view.title,
      subtitle: view.subtitle,
      badge: view.badge,
      message: view.message,
      userId: this.e.user_id,
      items: view.items,
    }, {
      saveId: `lotus-checkin-list-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, "[荷花插件]签到名单已生成。")
    return true
  }

  async checkinLogs() {
    const globalConfig = await loadGlobalConfig()
    const master = isMaster(this.e, globalConfig)
    const rows = await readCheckinAudit({
      qq: master ? "" : this.e.user_id,
      limit: 12,
    })
    const image = await renderStatusCard({
      title: "签到日志",
      subtitle: master ? "最近全局记录" : `QQ ${this.e.user_id}`,
      badge: String(rows.length),
      message: rows.length ? "最近签到审计记录如下。" : "暂无签到审计记录。",
      userId: this.e.user_id,
      items: rows.map(row => ({
        label: `${timeShort(row.time)} · P${row.profileId}`,
        value: `${row.ok ? "成功" : "失败"} · ${row.stage || "-"} · QQ ${row.qq}`,
      })),
    }, {
      saveId: `lotus-checkin-logs-${this.e.user_id || "user"}`,
    })
    await replyImage(this, image, "[荷花插件]签到日志已生成。")
    return true
  }

  async batchRefresh() {
    const globalConfig = await loadGlobalConfig()
    if (!isMaster(this.e, globalConfig)) {
      await replyText(this, "[荷花插件]只有 bot 主人可以批量刷新签到账号。")
      return true
    }

    await replyText(this, "[荷花插件]正在批量刷新全部 profile 登录信息。")
    const profiles = await listAllProfiles()
    const account = new AccountService()
    const results = []
    for (const profile of profiles) {
      const qq = profile.user?.qq
      const profileId = profile.profile?.id || 1
      try {
        const refreshed = await account.refresh(qq, profileId)
        await registerProfileWithGenshin({ qq, profile: refreshed }).catch(() => null)
        results.push({ qq, profileId, ok: true })
      } catch (error) {
        results.push({ qq, profileId, ok: false, error })
      }
    }

    const okCount = results.filter(item => item.ok).length
    const image = await renderStatusCard({
      title: "批量刷新",
      subtitle: "荷花插件 profiles",
      badge: `${okCount}/${results.length}`,
      message: "已按 profile 粒度批量刷新，不会互相覆盖 cookie/stoken。",
      userId: this.e.user_id,
      items: results.slice(0, 14).map(item => ({
        label: `QQ ${item.qq} · P${item.profileId}`,
        value: item.ok ? "刷新成功" : `失败：${item.error?.message || "未知错误"}`.slice(0, 60),
      })),
    }, {
      saveId: `lotus-batch-refresh-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, "[荷花插件]批量刷新完成。")
    return true
  }
}

function isMaster(e, globalConfig) {
  return new PermissionService({ permissions: globalConfig.permissions }).isMaster(e?.user_id)
}

async function buildProfileListView(e, globalConfig) {
  if (isMaster(e, globalConfig)) return buildGlobalProfileListView()
  if (e?.group_id) return buildGroupProfileListView(e)
  return buildOwnProfileListView(e)
}

async function buildGlobalProfileListView() {
  const profiles = (await listAllProfiles()).filter(isProfileCheckinEnabled)
  return {
    title: "签到名单",
    subtitle: "全局荷花插件 profiles",
    badge: String(profiles.length),
    message: profiles.length ? "当前已注册 profile 如下。" : "当前没有已注册 profile。",
    items: profiles.slice(0, 14).map(profile => ({
      label: `QQ ${profile.user?.qq} · P${profile.profile?.id || 1}`,
      value: profileSummary(profile),
    })),
  }
}

async function buildOwnProfileListView(e) {
  const profiles = (await loadProfilesForUser(e?.user_id)).filter(isProfileCheckinEnabled)
  return {
    title: "我的签到名单",
    subtitle: `QQ ${e?.user_id || "-"}`,
    badge: String(profiles.length),
    message: profiles.length ? "你已注册的 profile 如下。" : "你还没有注册自动签到 profile。",
    items: profiles.slice(0, 14).map(profile => ({
      label: `P${profile.profile?.id || 1} · ${profile.profile?.name || "profile"}`,
      value: profileSummary(profile),
    })),
  }
}

async function buildGroupProfileListView(e) {
  const profiles = (await listAllProfiles()).filter(isProfileCheckinEnabled)
  let members = []
  let readError = null
  try {
    members = normalizeGroupMemberEntries(await e.group?.getMemberMap?.())
  } catch (error) {
    readError = error
  }

  if (readError) {
    return {
      title: "本群签到名单",
      subtitle: `群 ${e.group_id}`,
      badge: "读取失败",
      message: "无法读取本群成员列表，暂时不能生成群内签到名单。",
      items: [{
        label: "错误",
        value: readError.message || "unknown error",
      }],
    }
  }

  const summary = summarizeGroupCheckinMembers(members, profiles)
  return {
    title: "本群签到名单",
    subtitle: `群 ${e.group_id}`,
    badge: `${summary.registeredMembers}/${summary.totalMembers}`,
    message: summary.profileCount
      ? "本群内已注册自动签到的成员如下。"
      : "本群暂无已注册自动签到的成员。",
    items: summary.items.slice(0, 14),
  }
}

async function loadProfilesForUser(userId) {
  if (!userId) return []
  const profileIds = await listProfileIds(userId)
  const profiles = []
  for (const profileId of profileIds) {
    profiles.push(await loadProfile(userId, profileId))
  }
  return profiles
}

export function summarizeGroupCheckinMembers(memberEntries = [], profiles = []) {
  const members = normalizeGroupMemberEntries(memberEntries)
  const memberIds = new Set(members.map(member => member.user_id))
  const groupedProfiles = new Map()

  for (const profile of profiles) {
    const qq = String(profile?.user?.qq || "")
    if (!qq || !memberIds.has(qq)) continue
    const list = groupedProfiles.get(qq) || []
    list.push(profile)
    groupedProfiles.set(qq, list)
  }

  const items = []
  for (const member of members) {
    const list = groupedProfiles.get(member.user_id) || []
    if (!list.length) continue
    items.push({
      label: `${memberName(member)} (${member.user_id})`,
      value: `${list.length} profile · ${summarizeProfiles(list)}`,
    })
  }

  return {
    totalMembers: members.length,
    registeredMembers: groupedProfiles.size,
    profileCount: Array.from(groupedProfiles.values()).reduce((sum, list) => sum + list.length, 0),
    items,
  }
}

function summarizeProfiles(profiles) {
  return profiles
    .sort((a, b) => (a.profile?.id || 1) - (b.profile?.id || 1))
    .map(profile => `P${profile.profile?.id || 1} ${profileSummary(profile)}`)
    .join("；")
}

function memberName(member) {
  return groupMemberDisplayName(member)
}

function profileSummary(profile) {
  const games = []
  if (profile.games?.cn?.genshin?.checkin) games.push("原")
  if (profile.games?.cn?.honkai_sr?.checkin) games.push("铁")
  if (profile.games?.cn?.zzz?.checkin) games.push("绝")
  return [
    profile.account?.cookie ? "已登录" : "未登录",
    profile.mihoyobbs?.enable ? "社区开" : "社区关",
    games.length ? games.join("/") : "游戏关",
    profile.schedule?.mode || "inherit",
  ].join(" · ")
}

function timeShort(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  const pad = item => String(item).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
