const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { createRequestCaptchaReporter } from "../core/captcha/notify.js"
import {
  loadProfile,
  parseProfileIdFromMessage,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { ProfileSigninService } from "../services/checkin/profileSignin.js"

export class LotusCheckin extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Checkin",
      dsc: "Lotus profile checkin runner",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        {
          reg: `^#((测试|开始|手动)签到|补签)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "runSignin",
        },
      ],
    })
  }

  async runSignin() {
    const onCaptchaEvent = createRequestCaptchaReporter(this.e)
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)
    let profile
    try {
      profile = await loadProfile(userId, profileId)
    } catch (error) {
      if (error?.code === "ENOENT") {
        await replyText(this, `[荷花插件]profile ${profileId} 尚未配置，请先使用 #扫码登录${profileId === 1 ? "" : profileId}。`)
        return true
      }
      throw error
    }

    if (!profile.account?.cookie) {
      await replyText(this, `[荷花插件]profile ${profileId} 尚未保存 cookie，请先扫码登录。`)
      return true
    }

    await replyText(this, `[荷花插件]开始执行 profile ${profileId} 签到，签到前会先刷新登录信息。`)

    try {
      const outcome = await new ProfileSigninService().run({
        qq: userId,
        profileId,
        profile,
        onCaptchaEvent,
      })
      await replyImage(this, outcome.image, outcome.ok
        ? `[荷花插件]profile ${profileId} 签到完成。`
        : `[荷花插件]profile ${profileId} 签到失败：${outcome.message}`)
    } catch (error) {
      logger?.error?.(`[Lotus-Plugin] checkin failed: ${error.stack || error.message}`)
      const image = await renderStatusCard({
        title: "签到失败",
        subtitle: `QQ ${userId} · Profile ${profileId}`,
        badge: "失败",
        message: error.message,
        userId,
        items: [
          { label: "阶段", value: "米游社 JS 任务" },
          { label: "建议", value: "先执行 #初始化环境，确认 profile 登录态和设备信息。" },
        ],
      }, {
        saveId: `lotus-checkin-error-${userId}-${profileId}`,
      })
      await replyImage(this, image, `[荷花插件]签到失败：${error.message}`)
    }

    return true
  }
}
