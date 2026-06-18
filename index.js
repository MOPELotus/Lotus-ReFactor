import fs from "node:fs/promises"
import { installLotusRuntimeInterception } from "./services/intercept/runtime.js"
import { ensureGlobalConfig } from "./core/config/global.js"
import { autoStartTestNineServer } from "./services/testNine/server.js"

const pluginName = "Lotus-Plugin"
const appsDir = new URL("./apps/", import.meta.url)

logger?.info?.("---- Lotus-Plugin refactor loading ----")

await ensureGlobalConfig().then(result => {
  if (result.created) logger?.mark?.(`[${pluginName}] created default config: ${result.file}`)
}).catch(error => {
  logger?.warn?.(`[${pluginName}] global config init skipped: ${error.message}`)
})

await installLotusRuntimeInterception().catch(error => {
  logger?.debug?.(`[${pluginName}] runtime interception skipped: ${error.message}`)
})

autoStartTestNineServer().catch(error => {
  logger?.warn?.(`[${pluginName}] test_nine auto start failed: ${error.message}`)
})

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
  if (exported) apps[name] = exported
}

logger?.info?.(`Lotus-Plugin refactor loaded: ${Object.keys(apps).length} app(s)`)

export { apps }
