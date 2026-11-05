import { loadGlobalConfig } from "../config/global.js"
import { replyTextWithOptionalRecall } from "../transport/reply.js"
import { isUserVisibleCaptchaEvent } from "./events.js"

const replyReporters = new WeakMap()
const BATCH_DELAY_MS = 6000

// Capture the command event once: plugin instances may handle another user while
// this request is waiting for a manual challenge.
export function createRequestCaptchaReporter(target, options = {}) {
  const source = target?.e || target
  const captured = Object.create(source || null)
  if (typeof source?.reply === "function") captured.reply = source.reply.bind(source)
  return event => replyCaptchaEvent(captured, event, options)
}

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
  const sendImpl = typeof options.send === "function" ? options.send : async () => false
  const send = async message => {
    try { return await sendImpl(message) } catch {
      globalThis.logger?.warn?.("[Lotus-Plugin] captcha notification could not be delivered")
      return false
    }
  }
  const onComplete = typeof options.onComplete === "function" ? options.onComplete : () => {}

  return async event => {
    if (!isUserVisibleCaptchaEvent(event) || !event?.message) return false
    if (["captcha:manual-link", "captcha:manual-legacy"].includes(event.type)) {
      await send(event.message)
      return true
    }
    if (state.complete) {
      if (event.type !== "captcha:start") return false
      state = createReporterState()
    }

    state.entries.push({
      type: event.type,
      message: event.message,
    })
    clearFlushTimer(state)

    if (["captcha:success", "captcha:fail"].includes(event.type)) {
      await flushCaptchaEvents(state, { send, onComplete, complete: true })
      return true
    }
    if (state.entries.length === 1) {
      await send(event.message)
      return true
    }

    state.timer = setTimeout(() => {
      flushCaptchaEvents(state, { send, onComplete }).catch(error => {
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
  }).catch(() => {
    globalThis.logger?.warn?.("[Lotus-Plugin] captcha notification could not be delivered")
    return false
  })
}

async function flushCaptchaEvents(state, { send, onComplete, complete = false }) {
  if (state.complete || !state.entries.length) return
  clearFlushTimer(state)
  state.complete = complete
  const entries = state.entries.splice(0)

  try {
    // Attempts can span retries and separate business requests. Counts here
    // do not describe the task's final outcome; show only its latest status.
    await send(entries.at(-1).message)
  } finally {
    if (complete) onComplete()
  }
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
