import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import YAML from "yaml"
import { isCookieRefreshableResponse } from "../../core/captcha/mysHandler.js"

import {
  LEGACY_CAPTCHA_HANDLER_NAMESPACES,
  LOTUS_CONFIG_DISABLED_PLUGIN_NAMES,
  LOTUS_CAPTCHA_HANDLER_NAMESPACE,
  LOTUS_INTERCEPT_PRIORITY,
  LOTUS_RUNTIME_DISABLED_PLUGIN_NAMES,
} from "../../core/intercept/priority.js"

let runtimeInstalled = false
let handlerPatchInstalled = false

export async function installLotusRuntimeInterception() {
  if (runtimeInstalled) return { ok: true, already: true }
  runtimeInstalled = true

  const results = await Promise.allSettled([
    ensureYunzaiConflictDisableConfig(),
    patchRuntimeDisableConfig(),
    patchPluginsLoader(),
    patchGenshinMysInfoCookieRefresh(),
  ])

  return {
    ok: results.every(item => item.status === "fulfilled" && item.value?.ok !== false),
    results,
  }
}

export async function installLotusCaptchaHandlerOverride(handlerModule = null) {
  const Handler = handlerModule || await importYunzaiDefault("../../../../lib/plugins/handler.js")
  if (!Handler?.add || !Handler?.del) {
    return { ok: false, reason: "handler module unavailable" }
  }

  if (!handlerPatchInstalled) {
    const originalAdd = Handler.add.bind(Handler)
    Handler.add = cfg => {
      const key = cfg?.key || cfg?.event
      if (key === "mys.req.err") {
        if (LEGACY_CAPTCHA_HANDLER_NAMESPACES.includes(cfg?.ns)) {
          logDebug(`skip legacy captcha handler ${cfg.ns}`)
          return
        }
        if (cfg?.ns === LOTUS_CAPTCHA_HANDLER_NAMESPACE) {
          return originalAdd({
            ...cfg,
            priority: LOTUS_INTERCEPT_PRIORITY,
          })
        }
      }
      return originalAdd(cfg)
    }
    handlerPatchInstalled = true
  }

  for (const ns of LEGACY_CAPTCHA_HANDLER_NAMESPACES) {
    Handler.del(ns, "mys.req.err")
  }

  return { ok: true }
}

export async function ensureYunzaiConflictDisableConfig(options = {}) {
  const file = options.file || path.join(process.cwd(), "config", "config", "group.yaml")
  const disabledNames = options.disabledNames || LOTUS_CONFIG_DISABLED_PLUGIN_NAMES

  try {
    let config = {}
    try {
      config = YAML.parse(await fs.readFile(file, "utf8")) || {}
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }

    if (!isPlainObject(config)) config = {}
    if (!isPlainObject(config.default)) config.default = {}

    const currentDisable = Array.isArray(config.default.disable)
      ? config.default.disable
      : config.default.disable
        ? [config.default.disable]
        : []

    const nextDisable = unique([
      ...currentDisable,
      ...disabledNames,
    ])
    const added = nextDisable.filter(name => !currentDisable.includes(name))
    const changed = added.length > 0 || !Array.isArray(config.default.disable)

    if (changed) {
      config.default.disable = nextDisable
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, YAML.stringify(config), "utf8")
      clearYunzaiCfgCache(options.cfg)
      logInfo(`已写入冲突功能禁用配置：${added.join("、") || "格式修正"}`)
    }

    return {
      ok: true,
      file,
      changed,
      added,
      disabled: nextDisable,
    }
  } catch (error) {
    logWarn(`写入冲突功能禁用配置失败：${error?.message || error}`)
    return {
      ok: false,
      file,
      reason: error?.message || String(error),
    }
  }
}

async function patchRuntimeDisableConfig() {
  const cfg = await importYunzaiDefault("../../../../lib/config/config.js")
  if (!cfg?.getGroup || cfg.__lotusDisablePatch) {
    return { ok: true, skipped: true }
  }

  await ensureYunzaiConflictDisableConfig({ cfg })

  const originalGetGroup = cfg.getGroup.bind(cfg)
  cfg.getGroup = (...args) => {
    const group = originalGetGroup(...args) || {}
    const disable = Array.isArray(group.disable) ? group.disable : []
    return {
      ...group,
      disable: unique([
        ...disable,
        ...LOTUS_RUNTIME_DISABLED_PLUGIN_NAMES,
      ]),
    }
  }
  cfg.__lotusDisablePatch = true
  logDebug("runtime disable config patched")
  return { ok: true }
}

async function patchPluginsLoader() {
  const loader = await importYunzaiDefault("../../../../lib/plugins/loader.js")
  if (!loader?.priority) return { ok: true, skipped: true }

  if (!loader.__lotusInterceptPatch) {
    patchLoaderMethod(loader, "load")
    patchLoaderMethod(loader, "changePlugin")
    patchLoaderMethod(loader, "importPlugin")
    loader.__lotusInterceptPatch = true
  }

  scheduleEnforce(loader)
  enforceLotusInterception(loader)
  return { ok: true }
}

async function patchGenshinMysInfoCookieRefresh() {
  const MysInfo = await importRuntimeDefault("genshin", "model", "mys", "mysInfo.js")
  if (!MysInfo?.prototype?.checkCode || MysInfo.prototype.__lotusCookieRefreshPatch) {
    return { ok: true, skipped: true }
  }

  const originalCheckCode = MysInfo.prototype.checkCode
  MysInfo.prototype.checkCode = async function lotusCheckCode(res, type, mysApi = {}, data = {}, isTask = false) {
    if (isCookieRefreshableResponse(res)) {
      const handler = this.e?.runtime?.handler || {}
      if (handler.has?.("mys.req.err")) {
        const handled = await handler.call("mys.req.err", this.e, {
          mysApi,
          type,
          res,
          data,
          mysInfo: this,
        })
        if (handled) {
          res = handled
        }
      }
    }
    return originalCheckCode.call(this, res, type, mysApi, data, isTask)
  }
  MysInfo.prototype.__lotusCookieRefreshPatch = true
  logDebug("genshin MysInfo cookie refresh patch installed")
  return { ok: true }
}

function patchLoaderMethod(loader, name) {
  if (typeof loader[name] !== "function") return
  const original = loader[name].bind(loader)
  loader[name] = async (...args) => {
    const result = await original(...args)
    enforceLotusInterception(loader)
    return result
  }
}

function scheduleEnforce(loader) {
  for (const delay of [0, 1000, 5000]) {
    setTimeout(() => enforceLotusInterception(loader), delay).unref?.()
  }
  globalThis.Bot?.once?.("online", () => enforceLotusInterception(loader))
}

export function enforceLotusInterception(loader) {
  if (!Array.isArray(loader?.priority)) return { ok: false, reason: "loader priority unavailable" }

  loader.priority = loader.priority
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const diff = numericPriority(a.entry.priority) - numericPriority(b.entry.priority)
      if (diff) return diff
      if (isLotusEntry(a.entry) && !isLotusEntry(b.entry)) return -1
      if (!isLotusEntry(a.entry) && isLotusEntry(b.entry)) return 1
      return a.index - b.index
    })
    .map(item => item.entry)

  return { ok: true, pruned: 0 }
}

export function isLotusEntry(entry) {
  return String(entry?.key || "").startsWith("Lotus-Plugin")
    || String(entry?.name || "").startsWith("[Lotus-Plugin]")
}

async function importYunzaiDefault(relativePath) {
  try {
    const module = await import(new URL(relativePath, import.meta.url))
    return module.default || module
  } catch {
    return null
  }
}

async function importRuntimeDefault(...segments) {
  try {
    const modulePath = path.join(process.cwd(), "plugins", ...segments)
    const module = await import(pathToFileURL(modulePath).href)
    return module.default || module
  } catch {
    return null
  }
}

function numericPriority(value) {
  return Number.isFinite(value) || value === Number.NEGATIVE_INFINITY || value === Number.POSITIVE_INFINITY
    ? value
    : 5000
}

function unique(values) {
  return [...new Set(values.filter(value => value !== undefined && value !== null && value !== ""))]
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function clearYunzaiCfgCache(cfg) {
  if (cfg?.config && typeof cfg.config === "object") {
    delete cfg.config["config.group"]
  }
}

function logDebug(message) {
  globalThis.logger?.debug?.(`[Lotus-Plugin] ${message}`)
}

function logInfo(message) {
  globalThis.logger?.mark?.(`[Lotus-Plugin] ${message}`)
    || globalThis.logger?.info?.(`[Lotus-Plugin] ${message}`)
}

function logWarn(message) {
  globalThis.logger?.warn?.(`[Lotus-Plugin] ${message}`)
    || globalThis.logger?.error?.(`[Lotus-Plugin] ${message}`)
}
