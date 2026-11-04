import { loadGlobalConfig } from "../../core/config/global.js"
import { notifyBotMasters } from "../../core/transport/masters.js"
import { TuneWeaveService } from "./service.js"
import { prepareStartupEnvironment } from "../tools/runtime.js"

const lifecycles = globalThis[Symbol.for("lotus-plugin.environment-startup-lifecycles")] ||= new Map()

export async function waitForTuneWeaveStartup(config) {
  const service = new TuneWeaveService({ config: config.tuneweave }), key = `${service.root}:${service.config.api_url}`
  for (;;) {
    const handle = lifecycles.get(key)
    if (!handle) return { skipped: true }
    const result = await handle.completion
    if (lifecycles.get(key) === handle) return result
  }
}

export async function startTuneWeaveLifecycle(options = {}) {
  const config = options.config || await loadGlobalConfig(), service = options.service || new TuneWeaveService({ config: config.tuneweave })
  const key = `${service.root}:${service.config.api_url}`
  if (lifecycles.has(key)) {
    const current = lifecycles.get(key)
    if (!current.disposed) return current
    await current.dispose()
    return startTuneWeaveLifecycle(options)
  }
  const notify = options.notify || (message => notifyBotMasters(`[荷花插件]${message}`))
  const setTimer = options.setTimer || setTimeout, clearTimer = options.clearTimer || clearTimeout
  let settle
  const controller = new AbortController()
  const handle = {
    timer: null, job: null, disposed: false, attempts: 0,
    completion: new Promise(resolve => { settle = resolve }),
    async dispose() {
      this.disposed = true
      controller.abort()
      if (this.timer !== null) { clearTimer(this.timer); this.timer = null; settle({ skipped: true, reason: "cancelled" }) }
      await this.job
      if (lifecycles.get(key) === this) lifecycles.delete(key)
    },
  }
  lifecycles.set(key, handle)
  const reportFailure = async error => {
    globalThis.logger?.warn?.("[Lotus-Plugin] 启动环境维护失败，稍后有限重试；也可发送 #初始化环境")
    if (!error.notified) { try { await notify("启动环境维护失败，已保留原环境；稍后有限重试，也可发送 #初始化环境。") } catch {} }
  }
  try { handle.job = Promise.resolve().then(() => service.resume()); await handle.job } catch (error) { await reportFailure(error) }
  if (handle.disposed) {
    settle({ skipped: true, reason: "cancelled" })
    return handle
  }
  const send = async message => { try { await notify(message) } catch {} }
  const schedule = delay => {
    handle.timer = setTimer(() => {
      handle.timer = null
      handle.job = (async () => {
        handle.attempts++
        try {
          if (handle.disposed) return { skipped: true, reason: "cancelled" }
          // Routine checks are silent. Report actual changes after preparation,
          // rather than forwarding each component's inspection messages.
          const result = await (options.prepare || prepareStartupEnvironment)(config, { ...options, service, notify: async () => {}, signal: controller.signal })
          if (handle.disposed) return { skipped: true, reason: "cancelled" }
          const failures = (result.items || []).filter(item => !item.ok).map(item => `${item.name}${item.name === "本地验证码服务" ? `（${item.reason}）` : ""}`)
          const changed = (result.items || []).filter(item => item.changed || item.status === "installed").map(item => `${item.name}${item.name === "TuneWeave" && item.status ? ` ${item.status}` : ""}`)
          if (result.cleanup?.removed) changed.push("旧环境清理")
          if (!result.ok) await send(`启动环境尚未就绪：${failures.join("、") || "环境检查"}；已保留原文件，可发送 #初始化环境 重试。`)
          else if (changed.length) await send(`启动环境更新完成：${changed.join("、")}，已通过就绪检查。`)
          const deferred = (result.items || []).filter(item => item.updateDeferred).map(item => item.name)
          const updateDeferred = deferred.length > 0
          if (updateDeferred) globalThis.logger?.warn?.(`[Lotus-Plugin] ${deferred.join("、")}现有环境已通过就绪检查；更新暂未完成，稍后重试`)
          if ((!result.ok || updateDeferred) && handle.attempts < (options.maxAttempts ?? 3)) schedule(options.retryDelayMs ?? 300000)
          return result
        } catch (error) {
          if (handle.disposed) return { skipped: true, reason: "cancelled" }
          await reportFailure(error)
          if (handle.attempts < (options.maxAttempts ?? 3)) schedule(options.retryDelayMs ?? 300000)
          return { ok: false, reason: "startup_preparation_failed" }
        }
      })().then(settle)
    }, delay)
    handle.timer?.unref?.()
  }
  schedule(config.tuneweave?.update_delay_ms || 180000)
  return handle
}
