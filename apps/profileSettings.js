const BasePlugin = globalThis.plugin

import { buildProfileCardData } from "./profile.js"
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { loadGlobalConfig } from "../core/config/global.js"
import { PROFILE_ID_SUFFIX_PATTERN } from "../core/config/profile.js"
import {
  parseProfileIdFromSettingsMessage,
  updateProfileSettings,
} from "../core/config/profileSettings.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { registerGroupCheckinProfiles } from "../services/checkin/groupRegister.js"

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
    if (await this.tryBulkRegisterGroup(profileId)) return true

    const result = await updateProfileSettings({
      e: this.e,
      message: this.e.msg,
      nickname: this.e.sender?.card || this.e.sender?.nickname || "",
    })
    if (!result.ok) {
      await replyText(this, `[荷花插件]配置指令无法识别：${result.reason}`)
      return true
    }

    const image = await renderTemplate("profile-card", buildProfileCardData(result.profile, result.profiles), {
      saveId: `lotus-profile-settings-${this.e.user_id}-${profileId}`,
    })
    await replyImage(this, image, `[荷花插件]${result.message}`)
    return true
  }

  async tryBulkRegisterGroup(profileId) {
    if (!new RegExp(`^#注册本群签到${PROFILE_ID_SUFFIX_PATTERN}$`).test(String(this.e?.msg || ""))) return false
    if (!this.e?.group_id) return false

    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e.user_id, this.e.group_id, "checkin.group_register")
    if (!permission.ok) return false

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
      await this.replyBulkRegisterStatus({
        title: "注册本群签到",
        badge: `+${result.created}`,
        message: "已为本群没有对应 profile 的成员创建默认自动签到配置；已有配置未被覆盖。",
        items: [
          { label: "群号", value: result.groupId },
          { label: "profile", value: `P${result.profileId}` },
          { label: "群成员", value: String(result.totalMembers) },
          { label: "新建/已有", value: `${result.created}/${result.existing}` },
          ...result.results
            .filter(item => item.created)
            .slice(0, 10)
            .map(item => ({
              label: `${item.nickname || "群成员"} (${item.qq})`,
              value: `已创建 P${item.profileId}`,
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
