import { loadGlobalConfig } from "../config/global.js"
import { replyForward, replyTextWithOptionalRecall } from "../transport/reply.js"
import { isUserVisibleCaptchaEvent } from "./events.js"

const replyReporters = new WeakMap()
const BATCH_DELAY_MS = 6000

export async function replyCaptchaEvent(target, event, options = {}) {
  if (!isUserVisibleCaptchaEvent(event) || !event?.message) return false
  const key = replyReporterKey(target)
  if (!key) {
    await replyCaptchaMessage(target, event.message, options)
    return true
  }

  let reporter = replyReporters.get(key)
  if (!reporter) {
    reporter = createCaptchaEventReporter({
      send: message => replyCaptchaMessage(target, message, options),
      sendForward: async messages => {
        const result = await replyForward(target, messages, {
          description: "荷花插件验证码过程",
          fallbackToMessages: false,
        })
        return result.ok
      },
      onComplete: () => {
        if (replyReporters.get(key) === reporter) replyReporters.delete(key)
      },
      batchDelayMs: options.batchDelayMs,
    })
    replyReporters.set(key, reporter)
  }

  await reporter(event)
  return true
}

export function createCaptchaEventReporter(options = {}) {
  let state = createReporterState()
  const delayMs = positiveDelay(options.batchDelayMs, BATCH_DELAY_MS)
  const send = typeof options.send === "function" ? options.send : async () => false
  const sendForward = typeof options.sendForward === "function" ? options.sendForward : null
  const onComplete = typeof options.onComplete === "function" ? options.onComplete : () => {}

  return async event => {
    if (!isUserVisibleCaptchaEvent(event) || !event?.message) return false
    if (state.complete) {
      if (event.type !== "captcha:start") return false
      state = createReporterState()
    }

    state.entries.push({
      type: event.type,
      message: event.message,
    })
    clearFlushTimer(state)

    if (state.entries.length === 1) {
      await send(event.message)
      return true
    }

    if (event.type === "captcha:success") {
      await flushCaptchaEvents(state, { send, sendForward, onComplete })
      return true
    }

    state.timer = setTimeout(() => {
      flushCaptchaEvents(state, { send, sendForward, onComplete }).catch(error => {
        globalThis.logger?.warn?.(`[Lotus-Plugin] captcha notice flush failed: ${error.message}`)
      })
    }, delayMs)
    if (typeof state.timer.unref === "function") state.timer.unref()
    return true
  }
}

function createReporterState() {
  return {
    entries: [],
    timer: null,
    complete: false,
  }
}

async function replyCaptchaMessage(target, message, options = {}) {
  const config = options.config || await loadGlobalConfig().catch(() => ({}))
  const notify = config?.captcha?.notify || {}
  return replyTextWithOptionalRecall(target, message, {
    autoRecall: notify.auto_recall === true,
    recallSeconds: notify.recall_seconds,
  })
}

async function flushCaptchaEvents(state, { send, sendForward, onComplete }) {
  if (state.complete || !state.entries.length) return
  clearFlushTimer(state)
  state.complete = true

  try {
    if (state.entries.length <= 2) {
      await send(state.entries.at(-1).message)
      return
    }

    const messages = buildCaptchaBatchMessages(state.entries)
    const forwarded = sendForward ? await sendForward(messages).catch(() => false) : false
    if (!forwarded) await send(messages.join("\n"))
  } finally {
    onComplete()
  }
}

function buildCaptchaBatchMessages(entries = []) {
  const count = type => entries.filter(entry => entry.type === type).length
  const starts = count("captcha:start")
  const success = count("captcha:success")
  const failed = count("captcha:fail")
  const omitted = Math.max(0, entries.length - 2)
  const summary = [
    `[荷花插件]验证码过程已合并：检测到 ${starts} 次`,
    `已通过 ${success} 次`,
    `失败 ${failed} 次`,
    `已省略 ${omitted} 条重复通知。`,
  ].join("，")
  const last = entries.at(-1)?.message || "[荷花插件]验证码流程结束。"
  return [summary, last]
}

function clearFlushTimer(state) {
  if (!state.timer) return
  clearTimeout(state.timer)
  state.timer = null
}

function positiveDelay(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function replyReporterKey(target) {
  const value = target?.e || target
  return value && (typeof value === "object" || typeof value === "function") ? value : null
}
