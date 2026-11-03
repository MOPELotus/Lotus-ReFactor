import { createRequestCaptchaReporter } from "../../core/captcha/notify.js"
import { ZzzGachaService } from "../zzzGacha/service.js"

export class ZzzGachaBridge {
  constructor(options = {}) {
    this.service = options.service || new ZzzGachaService(options)
  }

  async updateGachaLog({ e, profile, profileId = 1, onCaptchaEvent } = {}) {
    return this.service.updateByProfile({
      qq: String(e?.user_id || profile?.user?.qq || ""),
      profile,
      profileId,
      onCaptchaEvent: onCaptchaEvent || (e ? createRequestCaptchaReporter(e) : undefined),
    })
  }
}
