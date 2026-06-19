import {
  LEGACY_CAPTCHA_HANDLER_NAMESPACES,
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
    patchRuntimeDisableConfig(),
    patchPluginsLoader(),
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

async function patchRuntimeDisableConfig() {
  const cfg = await importYunzaiDefault("../../../../lib/config/config.js")
  if (!cfg?.getGroup || cfg.__lotusDisablePatch) {
    return { ok: true, skipped: true }
  }

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

  let pruned = 0
  for (const entry of loader.priority) {
    if (!entry || isLotusEntry(entry)) continue
    pruned += pruneConflictRules(entry)
  }

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

  return { ok: true, pruned }
}

export function pruneConflictRules(entry) {
  const rules = entry?.plugin?.rule
  if (!Array.isArray(rules) || !rules.length) return 0

  const before = rules.length
  entry.plugin.rule = rules.filter(rule => !isConflictRule(entry, rule))
  return before - entry.plugin.rule.length
}

export function isConflictRule(entry, rule) {
  const name = String(entry?.name || "")
  const key = String(entry?.key || "")
  const reg = String(rule?.reg || "")
  const fnc = String(rule?.fnc || "")

  if (name === "米哈游登录") return true
  if (name === "R插件工具和学习类" && fnc === "bili") return true
  if (name === "R插件工具和学习类" && /bilibili|b23|bili2233|BV/i.test(reg)) return true

  if (name === "xiaoyao-cvs-plugin" && /xiaoyao-cvs-plugin/i.test(key)) {
    return false
  }

  if (isMiaoWikiEntry(name, key)) {
    return fnc === "wiki"
      || /(?:图鉴|资料|天赋|技能|行迹|命座|命之座|星魂|照片|写真|图片|图像)/.test(reg)
  }

  if (isMiaoCharacterEntry(name, key)) {
    return fnc === "character"
  }

  if (isZzzAtlasEntry(name, key)) {
    if (fnc === "atlas" || fnc === "wiki") return true
    if (/(?:图鉴|资料|影画|天赋|音擎|驱动盘|邦布)/.test(reg)) return true
    return !/(?:面板|panel)/i.test(`${reg} ${fnc}`)
  }

  return false
}

function isMiaoWikiEntry(name, key) {
  return name.includes("喵喵:角色资料")
    || key.includes("miao-plugin/apps/wiki")
    || key.includes("miao-plugin\\apps\\wiki")
}

function isMiaoCharacterEntry(name, key) {
  return name.includes("喵喵角色卡片")
    || key.includes("miao-plugin/apps/character")
    || key.includes("miao-plugin\\apps\\character")
}

function isZzzAtlasEntry(name, key) {
  return name.includes("ZZZ-Plugin 图鉴")
    || name.includes("ZZZ-Plugin Atlas")
    || key.includes("ZZZ-Plugin/apps/atlas")
    || key.includes("ZZZ-Plugin\\apps\\atlas")
    || key.includes("ZZZ-Plugin/dist/apps/wiki")
    || key.includes("ZZZ-Plugin\\dist\\apps\\wiki")
    || key.includes("ZZZ-Plugin/apps/wiki")
    || key.includes("ZZZ-Plugin\\apps\\wiki")
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

function numericPriority(value) {
  return Number.isFinite(value) || value === Number.NEGATIVE_INFINITY || value === Number.POSITIVE_INFINITY
    ? value
    : 5000
}

function unique(values) {
  return [...new Set(values.filter(value => value !== undefined && value !== null && value !== ""))]
}

function logDebug(message) {
  globalThis.logger?.debug?.(`[Lotus-Plugin] ${message}`)
}
