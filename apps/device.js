const BasePlugin = globalThis.plugin

import fs from "node:fs/promises"
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  isProfileLoginRequiredError,
  listProfileIds,
  loadLoggedInProfile,
  normalizeProfileId,
  parseProfileIdFromMessage,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { resolveRoot } from "../core/path.js"
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
          reg: `^#(原神|星铁|绝区零)?绑定设备(?:信息)?${PROFILE_ID_SUFFIX_PATTERN}(?:\\s+[\\s\\S]*)?$`,
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

    try {
      await loadLoggedInProfile(userId, profileId)
    } catch (error) {
      if (!isProfileLoginRequiredError(error)) throw error
      await replyText(this, `[荷花插件]${error.message}`)
      return true
    }

    if (!payload) {
      pendingDeviceBind.set(userId, profileId)
      this.setContext("receiveDeviceJson")
      await replyText(this, `[荷花插件]请安装设备信息 APK，打开后获取设备信息，并把复制出的 JSON 发回来绑定到 profile ${profileId}；发送“取消”可退出。`)
      await sendDeviceInfoApk(this)
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
    let profile
    try {
      profile = await loadLoggedInProfile(userId, profileId)
    } catch (error) {
      if (!isProfileLoginRequiredError(error)) throw error
      await replyText(this, `[荷花插件]${error.message}`)
      return true
    }
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
  const match = String(message).match(/^#(?:原神|星铁|绝区零)?绑定设备(?:信息)?(\d*)/)
  return normalizeProfileId(match?.[1] || 1)
}

function extractJsonPayload(message = "") {
  const match = String(message || "").match(/(\{[\s\S]*\})/)
  return match?.[1] || ""
}

export function resolveDeviceInfoApkPath() {
  return resolveRoot("resources", "apk", "copy_device_info_1.2.apk")
}

async function sendDeviceInfoApk(target) {
  const apkPath = resolveDeviceInfoApkPath()
  try {
    await fs.access(apkPath)
  } catch {
    await replyText(target, `[荷花插件]设备信息 APK 文件缺失，请联系 bot 主人检查 ${apkPath}`)
    return
  }

  if (globalThis.segment?.file) {
    const payload = globalThis.segment.file(apkPath, "copy_device_info_1.2.apk")
    if (typeof target?.reply === "function") await target.reply(payload)
    else await target.e.reply(payload)
    return
  }
  await replyText(target, `[荷花插件]当前适配器不支持直接发送文件，请向 bot 主人索取设备信息 APK：${apkPath}`)
}
