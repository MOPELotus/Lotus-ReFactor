import path from "node:path"
import { pathToFileURL } from "node:url"
import { notifyUser } from "./notify.js"

export async function collectMasterIds(bot = globalThis.Bot) {
  const values = [], config = bot?.config || {}
  for (const key of ["masterQQ", "master", "masters", "master_qq", "owner"]) append(values, config[key])
  if (!values.length) {
    const cfg = (await import(pathToFileURL(path.join(process.cwd(), "lib/config/config.js")).href)).default
    append(values, cfg.masterQQ); append(values, cfg.master)
  }
  return [...new Set(values.map(value => String(value).trim().split(":").at(-1)).filter(value => value && value !== "stdin"))]
}

export async function notifyBotMasters(message, { bot = globalThis.Bot } = {}) {
  const ids = await collectMasterIds(bot)
  const results = await Promise.all(ids.map(id => notifyUser(id, message, { bot, onlyKnownFriend: false, allowGroupFallback: false, at: false })))
  if (!ids.length || results.some(result => !result.ok)) globalThis.logger?.warn?.("[Lotus-Plugin] 主人私聊通知未全部送达")
  return { ok: Boolean(ids.length) && results.every(result => result.ok), results }
}

function append(target, value) {
  if (value instanceof Map) { for (const item of value.values()) append(target, item); return }
  if (Array.isArray(value) || value instanceof Set) { for (const item of value) append(target, item); return }
  if (value && typeof value === "object") { for (const item of Object.values(value)) append(target, item); return }
  if (value !== undefined && value !== null && value !== "") target.push(value)
}
