import { AsyncLocalStorage } from "node:async_hooks"
import { bindMysApiOwner } from "./mys-request-context.js"

const STATE = Symbol.for("lotus-plugin.runtime-mys-device")
const PATCHED = Symbol.for("lotus-plugin.runtime-mys-device.getMysApi")
const CREATE_PATCHED = Symbol.for("lotus-plugin.runtime-mys-device.createMysApi")

// Keep upstream's selection and constructor intact. The scoped getMysInfo hook
// sees precisely the CK selected by that invocation, including shared cookies.
export function installMysDeviceCompatibility(Runtime) {
  const prototype = Runtime?.prototype
  if (typeof prototype?.getMysApi !== "function" || typeof prototype?.getMysInfo !== "function") {
    return { ok: true, skipped: true }
  }
  if (prototype.getMysApi[PATCHED]) {
    patchCreateMysApi(prototype)
    return { ok: true, already: true }
  }
  const context = globalThis[STATE] ||= new AsyncLocalStorage()
  const originalApi = prototype.getMysApi
  const originalInfo = prototype.getMysInfo

  prototype.getMysInfo = async function getMysInfo(...args) {
    const mys = await Reflect.apply(originalInfo, this, args)
    const pending = context.getStore()
    if (pending?.runtime === this) {
      pending.owner = selectedCookieOwner(mys)
      if (!pending.explicitDevice) {
        delete pending.options.device
        const device = ownerDevice(pending.owner)
        if (device) pending.options.device = device
      }
    }
    return mys
  }

  function getMysApi(...args) {
    const input = args[1] === undefined ? {} : args[1]
    // Preserve upstream's treatment of unsupported option values.
    if (!input || typeof input !== "object") return Reflect.apply(originalApi, this, args)
    const options = { ...input }
    const explicitDevice = "device" in input
    if (explicitDevice) options.device = input.device
    args[1] = options
    const pending = { runtime: this, options, explicitDevice }
    return context.run(pending, async () => {
      const api = await Reflect.apply(originalApi, this, args)
      bindMysApiOwner(api, pending.owner)
      return api
    })
  }
  Object.defineProperty(getMysApi, PATCHED, { value: true })
  prototype.getMysApi = getMysApi
  patchCreateMysApi(prototype)
  return { ok: true }
}

function patchCreateMysApi(prototype) {
  const original = prototype.createMysApi
  if (typeof original !== "function" || original[CREATE_PATCHED]) return
  function createMysApi(...args) {
    const input = args[2] === undefined ? {} : args[2]
    if (!input || typeof input !== "object") return Reflect.apply(original, this, args)
    // createMysApi is synchronous. Only use a selection already made by this
    // runtime, never perform a second CK selection or borrow the active user.
    const owners = new Map()
    for (const mys of Object.values(this._mysInfo || {})) {
      if (String(mys?.uid || "") !== String(args[0] || "") || mys?.ckInfo?.ck !== args[1]) continue
      const owner = selectedCookieOwner(mys)
      if (owner) owners.set(JSON.stringify([String(owner.ltuid), ownerDevice(owner)]), owner)
    }
    const owner = owners.size === 1 ? [...owners.values()][0] : null
    const device = ownerDevice(owner)
    if (!("device" in input) && device) args[2] = { ...input, device }
    const api = Reflect.apply(original, this, args)
    bindMysApiOwner(api, owner)
    return api
  }
  Object.defineProperty(createMysApi, CREATE_PATCHED, { value: true })
  prototype.createMysApi = createMysApi
}

function selectedCookieOwner(mys) {
  try {
    const user = mys?.ckUser
    const info = mys?.ckInfo
    if (!user || !info?.ck || user.ck !== info.ck) return ""
    if (!info.ltuid || !user.ltuid || String(info.ltuid) !== String(user.ltuid)) return ""
    return user
  } catch {
    return ""
  }
}

function ownerDevice(owner) {
  try {
    const device = owner?.device
    return typeof device === "string" && device.trim() ? device : ""
  } catch {
    return ""
  }
}
