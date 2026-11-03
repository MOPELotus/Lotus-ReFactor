import fs from "node:fs/promises"
import { ensureGeneratedProfileDevices } from "./core/devices/generated-profile.js"
import { startGeneratedDeviceFpRefresh } from "./core/devices/runtime.js"
import { installLotusRuntimeInterception } from "./services/intercept/runtime.js"
import { ensureGlobalConfig } from "./core/config/global.js"
import { startLoginCredentialRepair } from "./core/login/runtime.js"
import { checkTrackedSubmoduleRemoteUpdates, syncTrackedSubmodules } from "./services/pluginUpdate/service.js"

const pluginName = "Lotus-Plugin"
const appsDir = new URL("./apps/", import.meta.url)

logger?.info?.("---- Lotus-Plugin refactor loading ----")

let startupConfig = {}
await ensureGlobalConfig().then(result => {
  startupConfig = result.config || {}
  if (result.created) logger?.mark?.(`[${pluginName}] created default config: ${result.file}`)
}).catch(error => {
  logger?.warn?.(`[${pluginName}] global config init skipped: ${error.message}`)
})

// 只检查并通知，不在开机阶段自动改写子仓库，避免隐藏更新或阻塞启动。
void checkTrackedSubmoduleRemoteUpdates({ config: startupConfig }).then(result => {
  if (result.updates?.length) logger?.warn?.(`[${pluginName}] ${result.message}`)
}).catch(error => {
  logger?.debug?.(`[${pluginName}] submodule remote check skipped: ${error.message}`)
})

await ensureGeneratedProfileDevices().then(result => {
  if (result.generated || result.failed || result.invalid) logger?.info?.(`[${pluginName}] 设备初始化：${result.generated} 个虚拟设备已保存，${result.failed + result.invalid} 个档案暂未处理`)
}).catch(() => {
  logger?.warn?.(`[${pluginName}] 虚拟设备初始化暂不可用，已保留原档案`)
})

await installLotusRuntimeInterception().catch(error => {
  logger?.debug?.(`[${pluginName}] runtime interception skipped: ${error.message}`)
})

await syncTrackedSubmodules().then(result => {
  if (result.action === "submodules_updated") {
    logger?.mark?.("[" + pluginName + "] " + result.message)
  } else if (!result.ok) {
    logger?.warn?.("[" + pluginName + "] submodule sync skipped: " + result.message)
  }
}).catch(error => {
  logger?.debug?.("[" + pluginName + "] submodule sync skipped: " + error.message)
})

startLoginCredentialRepair()
startGeneratedDeviceFpRefresh()

const files = await fs.readdir(appsDir).catch(err => {
  logger?.error?.(`[${pluginName}] failed to read apps directory`)
  logger?.error?.(err)
  return []
})

const modules = await Promise.allSettled(
  files.filter(file => file.endsWith(".js")).map(file => import(new URL(file, appsDir))),
)

const apps = {}
for (const [index, result] of modules.entries()) {
  const file = files.filter(name => name.endsWith(".js"))[index]
  const name = file.replace(/\.js$/, "")

  if (result.status !== "fulfilled") {
    logger?.error?.(`[${pluginName}] failed to load app: ${name}`)
    logger?.error?.(result.reason)
    continue
  }

  const exported = result.value[Object.keys(result.value)[0]]
  if (exported) apps[name] = silencePluginLogs(exported)
}

logger?.info?.(`Lotus-Plugin refactor loaded: ${Object.keys(apps).length} app(s)`)

export { apps }

function silencePluginLogs(AppClass) {
  return class LotusSilentPluginLogs extends AppClass {
    constructor(...args) {
      super(...args)
      silenceEntries(this.rule)
      silenceEntries(this.task)
    }
  }
}

function silenceEntries(entries) {
  if (!entries) return
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (entry && typeof entry === "object") entry.log = false
  }
}
