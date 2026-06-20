const BasePlugin = globalThis.plugin

import {
  LOTUS_CAPTCHA_HANDLER_NAMESPACE,
  LOTUS_INTERCEPT_PRIORITY,
} from "../core/intercept/priority.js"
import { isUserVisibleCaptchaEvent } from "../core/captcha/events.js"
import { solveMysRequestCaptcha } from "../core/captcha/mysHandler.js"
import { installLotusCaptchaHandlerOverride } from "../services/intercept/runtime.js"
import { replyText } from "../core/transport/reply.js"

export class LotusCaptchaHandler extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Captcha Handler",
      dsc: "Lotus global mys captcha handler",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      namespace: LOTUS_CAPTCHA_HANDLER_NAMESPACE,
      handler: [
        {
          key: "mys.req.err",
          fn: "mysReqErrHandler",
          priority: LOTUS_INTERCEPT_PRIORITY,
        },
      ],
    })
  }

  async init() {
    await installLotusCaptchaHandlerOverride()
  }

  async mysReqErrHandler(e, args, reject) {
    try {
      return await solveMysRequestCaptcha({
        e,
        args,
        reject,
        onCaptchaEvent: async event => {
          if (isUserVisibleCaptchaEvent(event) && event?.message) await replyText({ e }, event.message)
        },
      })
    } catch (error) {
      logger?.error?.(`[Lotus-Plugin] mys captcha handler failed: ${error.stack || error.message}`)
      return reject?.()
    }
  }
}
