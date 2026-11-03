import { initializeEnvironment } from "./environment.js"
import { TestNineEnvService } from "../testNine/env.js"
import { TestNineServerService } from "../testNine/server.js"
import { cleanupLegacyEnvironment } from "./legacyCleanup.js"
import { TuneWeaveService } from "../tuneweave/service.js"

function localCaptchaEndpoint(value = "http://127.0.0.1:9645/pass_uni") {
  try {
    const url = new URL(value)
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password
  } catch { return false }
}

// Shared by the existing delayed TuneWeave lifecycle. This function neither
// schedules another timer nor touches an externally managed captcha service.
export async function prepareStartupEnvironment(config, options = {}) {
  const { signal, notify = async () => {} } = options
  const service = options.service || new TuneWeaveService({ config: config.tuneweave })
  const progress = async message => { signal?.throwIfAborted(); try { await notify(message) } catch {} }
  signal?.throwIfAborted()
  const local = { ...config.captcha?.test_nine, enable: true, auto_start: true, download_models: true }
  const isLocal = localCaptchaEndpoint(local.endpoint)
  // Legacy opt-out flags must not strand installations upgrading from old versions.
  // Remote endpoints still belong to their deployment owner.
  const effective = { ...config,
    tools: { ...config.tools, auto_install: true, ffmpeg: { ...config.tools?.ffmpeg, enable: true } },
    captcha: { ...config.captcha, test_nine: { ...local, auto_start: isLocal } },
  }
  let preparedModels
  const modelEnv = options.modelEnv || new TestNineEnvService({ config: local, onProgress: progress })
  const guardedModelEnv = { ensureEnv: async () => {
    signal?.throwIfAborted()
    preparedModels = await modelEnv.ensureEnv({ onProgress: progress })
    signal?.throwIfAborted()
    return preparedModels
  } }
  const tuneweave = { initialize: async ({ onProgress }) => {
    signal?.throwIfAborted()
    try { service.localUrl() } catch { return { ok: true, message: "外部服务由部署者维护" } }
    const result = await service.initialize({ onProgress })
    signal?.throwIfAborted()
    return result
  } }
  const result = await initializeEnvironment(effective, { modelEnv: guardedModelEnv, installer: options.installer, tuneweave, onProgress: progress })
  signal?.throwIfAborted()
  if (preparedModels?.ok) {
    try {
      const ready = await (options.captchaServer || new TestNineServerService({ config: local, envService: { ensureEnv: async () => preparedModels } })).start()
      signal?.throwIfAborted()
      if (!ready.ok) throw new Error("local server not ready")
    } catch (error) {
      signal?.throwIfAborted()
      result.items.push({ name: "本地验证码服务", ok: false, reason: error.code === "EADDRINUSE"
        ? "本地验证码端口被占用，未停止占用进程；请检查旧服务，原环境已保留"
        : "本地监听未就绪；已保留原环境" })
    }
  }
  result.ok = result.items.every(item => item.ok)
  if (result.ok && preparedModels?.ok) {
    try { result.cleanup = await (options.cleanup || cleanupLegacyEnvironment)({ config, signal }) }
    catch { signal?.throwIfAborted(); result.cleanup = { ok: false, removed: false, reason: "cleanup_deferred" } }
  }
  return result
}
