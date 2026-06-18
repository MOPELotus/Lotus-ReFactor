const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  ensureProfile,
  listProfileIds,
  normalizeProfileId,
  parseProfileIdFromMessage,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { DeviceService } from "../core/devices/service.js"
import { renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { buildProfileCardData } from "./profile.js"

const pendingDeviceBind = new Map()

export class LotusDevice extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Device",
      dsc: "Lotus device binding",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        {
          reg: `^#(原神|星铁|绝区零)?绑定设备${PROFILE_ID_SUFFIX_PATTERN}([\\s\\S]*)$`,
          fnc: "bindDevice",
        },
        {
          reg: `^#设备信息${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "deviceInfo",
        },
      ],
    })
  }

  async bindDevice() {
    const userId = String(this.e.user_id)
    const profileId = parseDeviceProfileId(this.e.msg)
    const payload = extractJsonPayload(this.e.msg)

    if (!payload) {
      pendingDeviceBind.set(userId, profileId)
      this.setContext("receiveDeviceJson")
      await replyText(this, `[荷花插件]请发送 profile ${profileId} 的设备 JSON；发送“取消”可退出。`)
      return true
    }

    return this.saveDeviceJson(userId, profileId, payload)
  }

  async receiveDeviceJson() {
    const userId = String(this.e.user_id)
    const profileId = pendingDeviceBind.get(userId) || 1
    const message = String(this.e.msg || "")

    if (message.includes("取消")) {
      pendingDeviceBind.delete(userId)
      this.finish("receiveDeviceJson")
      await replyText(this, "[荷花插件]已取消绑定设备。")
      return true
    }

    const payload = extractJsonPayload(message)
    if (!payload) {
      await replyText(this, "[荷花插件]没有识别到设备 JSON，请重新发送，或发送“取消”。")
      return true
    }

    const result = await this.saveDeviceJson(userId, profileId, payload)
    this.finish("receiveDeviceJson")
    pendingDeviceBind.delete(userId)
    return result
  }

  async deviceInfo() {
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)
    const profile = await ensureProfile({
      qq: userId,
      profileId,
      nickname: this.e.sender?.card || this.e.sender?.nickname || "",
    })
    const profiles = await listProfileIds(userId)
    return await this.replyProfile(profile, userId, profileId, profiles)
  }

  async saveDeviceJson(userId, profileId, payload) {
    try {
      const service = new DeviceService()
      const profile = await service.bindDevice({
        qq: userId,
        profileId,
        input: payload,
        nickname: this.e.sender?.card || this.e.sender?.nickname || "",
      })
      return await this.replyProfile(profile, userId, profileId)
    } catch (error) {
      await replyText(this, `[荷花插件]设备绑定失败：${error.message}`)
      return true
    }
  }

  async replyProfile(profile, userId, profileId, profiles = [profileId]) {
    const image = await renderTemplate("profile-card", buildProfileCardData(profile, profiles), {
      saveId: `lotus-device-${userId}-${profileId}`,
    })
    await replyImage(this, image, `[荷花插件]profile ${profileId} 设备信息已更新。`)
    return true
  }
}

function parseDeviceProfileId(message = "") {
  const match = String(message).match(/^#(?:原神|星铁|绝区零)?绑定设备(\d*)/)
  return normalizeProfileId(match?.[1] || 1)
}

function extractJsonPayload(message = "") {
  const match = String(message || "").match(/(\{[\s\S]*\})/)
  return match?.[1] || ""
}
