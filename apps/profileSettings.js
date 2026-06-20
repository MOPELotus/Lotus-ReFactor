const BasePlugin = globalThis.plugin

import { buildProfileCardData } from "./profile.js"
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { loadGlobalConfig } from "../core/config/global.js"
import {
  isProfileLoginRequiredError,
  loadProfile,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import {
  parseProfileIdFromSettingsMessage,
  updateProfileSettings,
} from "../core/config/profileSettings.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { registerGroupCheckinProfiles } from "../services/checkin/groupRegister.js"
import { ScheduledSigninService } from "../services/checkin/scheduled.js"

export class LotusProfileSettings extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Profile Settings",
      dsc: "Lotus profile setting commands",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: `^#注册自动签到${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#注册本群签到${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#(绑定|设置|切换)(通知群|签到通知群|本群通知)${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#(启用|开启|关闭|禁用)社区签到${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#(启用|开启|关闭|禁用)(原神|崩坏2|崩二|崩坏3|崩三|未定事件簿|未定|星铁|崩铁|绝区零|绝|因缘精灵)(游戏)?签到${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#(启用|开启|关闭|禁用)全部游戏签到${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#(启用|开启|关闭|禁用)签到通知${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#(跟随|继承)(全局)?签到时间${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#随机签到时间${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#(固定|设置)签到时间${PROFILE_ID_SUFFIX_PATTERN}\\s+\\d{1,2}:\\d{2}$`, fnc: "updateSettings" },
        { reg: `^#设置通知(私聊|群聊)${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#绑定(国际服|海外服)(cookie|Cookie)${PROFILE_ID_SUFFIX_PATTERN}\\s+.+$`, fnc: "updateSettings" },
        { reg: `^#(启用|开启|关闭|禁用)(国际服|海外服)(签到)?${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#设置(国际服|海外服)语言${PROFILE_ID_SUFFIX_PATTERN}\\s+[a-zA-Z_-]+$`, fnc: "updateSettings" },
        { reg: `^#绑定云(原神|绝区零)token${PROFILE_ID_SUFFIX_PATTERN}\\s+.+$`, fnc: "updateSettings" },
        { reg: `^#(启用|开启|关闭|禁用)云(原神|绝区零)(签到)?${PROFILE_ID_SUFFIX_PATTERN}$`, fnc: "updateSettings" },
        { reg: `^#(绑定|设置|切换)(原神|星铁|崩铁|绝区零|绝)(uid|UID)${PROFILE_ID_SUFFIX_PATTERN}\\s*\\d{8,10}$`, fnc: "updateSettings" },
      ],
    })
  }

  async updateSettings() {
    const profileId = parseProfileIdFromSettingsMessage(this.e.msg)
    if (isRegisterGroupCommand(this.e.msg)) return this.bulkRegisterGroup(profileId)

    let result
    try {
      result = await updateProfileSettings({
        e: this.e,
        message: this.e.msg,
        nickname: this.e.sender?.card || this.e.sender?.nickname || "",
      })
    } catch (error) {
      if (!isProfileLoginRequiredError(error)) throw error
      await replyText(this, `[荷花插件]${error.message}`)
      return true
    }
    if (!result.ok) {
      await replyText(this, `[荷花插件]配置指令无法识别：${result.reason}`)
      return true
    }
    await tryAddLateSchedule(result.profile, result.action)

    const image = await renderTemplate("profile-card", buildProfileCardData(result.profile, result.profiles), {
      saveId: `lotus-profile-settings-${this.e.user_id}-${profileId}`,
    })
    await replyImage(this, image, `[荷花插件]${result.message}`)
    return true
  }

  async bulkRegisterGroup(profileId) {
    if (!this.e?.group_id) {
      await replyText(this, "[荷花插件]请在目标群内执行 #注册本群签到。普通用户切换通知群请在目标群发送 #绑定通知群。")
      return true
    }

    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "checkin.group_register")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以为本群批量注册签到。普通用户切换通知群请发送 #绑定通知群。")
      return true
    }

    if (!this.e.group?.getMemberMap) {
      await this.replyBulkRegisterStatus({
        title: "注册本群签到",
        badge: "失败",
        message: "无法读取本群成员列表，机器人可能不在该群或适配器不支持。",
        items: [{ label: "群号", value: String(this.e.group_id) }],
      })
      return true
    }

    try {
      const result = await registerGroupCheckinProfiles({
        group: this.e.group,
        groupId: this.e.group_id,
        profileId,
      })
      await tryAddLateSchedulesForGroup(result.results)
      await this.replyBulkRegisterStatus({
        title: "注册本群签到",
        badge: `+${result.updated}`,
        message: "已为本群存在有效登录态的 profile 注册签到通知；缺少 profile 或 cookie/stoken 的成员已跳过。下方明细只展示部分样例。",
        items: [
          { label: "群号", value: result.groupId },
          { label: "profile", value: `P${result.profileId}` },
          { label: "群成员", value: String(result.totalMembers) },
          { label: "注册/已有/跳过", value: `${result.updated}/${result.existing}/${result.skipped}` },
          { label: "明细展示", value: "注册/已有前10条，跳过前6条" },
          ...result.results
            .filter(item => item.updated || item.existing)
            .slice(0, 10)
            .map(item => ({
              label: `${item.nickname || "群成员"} (${item.qq})`,
              value: item.updated ? `已注册 P${item.profileId}` : `已存在 P${item.profileId}`,
            })),
          ...result.results
            .filter(item => item.skipped)
            .slice(0, 6)
            .map(item => ({
              label: `${item.nickname || "群成员"} (${item.qq})`,
              value: groupRegisterSkipReason(item.reason),
            })),
        ],
      })
    } catch (error) {
      await this.replyBulkRegisterStatus({
        title: "注册本群签到",
        badge: "失败",
        message: error.message || "批量注册失败。",
        items: [{ label: "群号", value: String(this.e.group_id) }],
      })
    }
    return true
  }

  async replyBulkRegisterStatus({ title, badge, message, items }) {
    const image = await renderStatusCard({
      title,
      subtitle: "荷花插件签到",
      badge,
      message,
      userId: this.e.user_id,
      items,
    }, {
      saveId: `lotus-group-register-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, `[荷花插件]${title}${badge}`)
  }
}

function isRegisterGroupCommand(message = "") {
  return new RegExp(`^#注册本群签到${PROFILE_ID_SUFFIX_PATTERN}$`).test(String(message || ""))
}

async function tryAddLateSchedule(profile, action) {
  if (action?.type !== "register") return
  try {
    await new ScheduledSigninService().addLateProfileAndNotify(profile, {
      bot: globalThis.Bot,
    })
  } catch (error) {
    logger?.warn?.(`[Lotus-Plugin] late schedule after profile settings skipped: ${error.message}`)
  }
}

async function tryAddLateSchedulesForGroup(results = []) {
  const service = new ScheduledSigninService()
  for (const item of results.filter(result => result.ok)) {
    try {
      const profile = await loadProfile(item.qq, item.profileId)
      await service.addLateProfileAndNotify(profile, {
        bot: globalThis.Bot,
      })
    } catch (error) {
      logger?.warn?.(`[Lotus-Plugin] late schedule after group register skipped for ${item.qq}: ${error.message}`)
    }
  }
}

function groupRegisterSkipReason(reason = "") {
  if (reason === "missing_profile") return "跳过：未找到 profile"
  if (reason === "missing_login") return "跳过：缺少 cookie/stoken"
  return `跳过：${reason || "未知原因"}`
}
