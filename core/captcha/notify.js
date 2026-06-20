import { loadGlobalConfig } from "../config/global.js"
import { replyTextWithOptionalRecall } from "../transport/reply.js"
import { isUserVisibleCaptchaEvent } from "./events.js"

export async function replyCaptchaEvent(target, event, options = {}) {
  if (!isUserVisibleCaptchaEvent(event) || !event?.message) return false
  const config = options.config || await loadGlobalConfig().catch(() => ({}))
  const notify = config?.captcha?.notify || {}
  await replyTextWithOptionalRecall(target, event.message, {
    autoRecall: notify.auto_recall === true,
    recallSeconds: notify.recall_seconds,
  })
  return true
}
