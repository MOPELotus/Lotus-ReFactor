import { ToolInstallerService } from "./installer.js"
import { TuneWeaveService } from "../tuneweave/service.js"
import { TestNineEnvService } from "../testNine/env.js"

export async function initializeEnvironment(config, { onProgress, modelEnv, ...mediaOptions } = {}) {
  let models
  const local = config.captcha?.test_nine
  if (local?.enable === false) models = { name: "本地验证码", ok: true, skipped: true, reason: "跳过本地服务自动准备；验证码回退顺序不变" }
  else {
    try {
      await onProgress?.("正在检查本地验证码模型。")
      const env = await (modelEnv || new TestNineEnvService({ config: local, onProgress })).ensureEnv()
      models = { name: "本地验证码", ok: env.ok, changed: env.models?.changed === true, status: `${env.runtime} · 模型 ${env.models?.items?.filter(item => item.ok).length || 0}/${env.models?.items?.length || 0}`, reason: env.reason }
    } catch (error) { models = { name: "本地验证码", ok: false, reason: error.message } }
  }
  const media = await initializeMediaTools(config, { onProgress, ...mediaOptions })
  const items = [models, ...media.items]
  return { ...media, skipped: items.every(item => item.skipped), ok: items.every(item => item.ok), items }
}

// All initialization aliases prepare the same shared media environment.
export async function initializeMediaTools(config, { onProgress, installer, tuneweave } = {}) {
  const result = await (installer || new ToolInstallerService({ config: config.tools, onProgress })).ensureAll()
  try {
    const ready = await (tuneweave || new TuneWeaveService({ config: config.tuneweave })).initialize({ onProgress })
    result.items.push({ name: "TuneWeave", ok: ready.ok, changed: ready.updated === true || ready.installed === true, status: ready.version, reason: ready.message })
  } catch (error) {
    result.items.push({ name: "TuneWeave", ok: false, reason: error.message })
  }
  result.ok = result.items.every(item => item.ok)
  return result
}
