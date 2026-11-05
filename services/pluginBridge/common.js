import path from "node:path"
import { pathToFileURL } from "node:url"
import { normalizeProfileId } from "../../core/config/profile.js"

export const GAME_UID_PATTERN = "[1-9]\\d{7,9}"
export const GAME_UID_REGEXP = new RegExp(`^${GAME_UID_PATTERN}$`)

export function pickRole(profile, game) {
  const currentUid = profile?.account?.current_uid?.[game]
  const roles = Array.isArray(profile?.account?.game_roles?.[game])
    ? profile.account.game_roles[game]
    : []

  if (currentUid) {
    return roles.find(role => String(role.uid || role.game_uid || role) === String(currentUid))
      || { uid: currentUid }
  }

  return roles[0] || null
}

export function getRoleUid(role) {
  return role ? String(role.uid || role.game_uid || role || "") : ""
}

export function splitProfileSuffix(message = "") {
  const text = String(message || "").trim()
  const match = text.match(/^(.*?)([1-9]\d{0,2})$/)
  if (!match) return { hasProfileSuffix: false, message: text, profileId: 1 }

  const body = match[1]
  const raw = match[2]
  if (!body || /\d$/.test(body)) return { hasProfileSuffix: false, message: text, profileId: 1 }

  try {
    const profileId = normalizeProfileId(raw)
    return {
      hasProfileSuffix: true,
      message: body.trimEnd(),
      profileId,
    }
  } catch {
    return { hasProfileSuffix: false, message: text, profileId: 1 }
  }
}

export function createIsolatedEvent(baseEvent, patch = {}) {
  const messages = []
  const forwarded = []
  const baseReply = baseEvent?.reply?.bind(baseEvent)
  const forwardReplies = patch.forwardReplies === true

  const event = {
    ...baseEvent,
    // Yunzai defines isMaster as a non-enumerable computed permission. Keep the
    // target event's result when building a profile-scoped bridge event.
    isMaster: baseEvent?.isMaster === true,
    ...patch,
    reply: async (payload, ...args) => {
      const clean = cleanBridgeReply(payload)
      if (clean === null) return true
      messages.push(summarizeReply(clean))
      if (forwardReplies && shouldForwardReply(clean) && baseReply) {
        forwarded.push(summarizeReply(clean))
        return baseReply(clean, ...args)
      }
      return true
    },
  }

  delete event.forwardReplies
  return {
    event,
    messages,
    forwarded,
  }
}

export function summarizeReply(payload) {
  if (Array.isArray(payload)) return payload.map(summarizeReply).filter(Boolean).join("\n")
  if (typeof payload === "string") return payload
  if (payload?.type === "image") return "[图片]"
  if (["node", "forward"].includes(payload?.type)) return "[合并转发]"
  if (["button", "keyboard"].includes(payload?.type)) return ""
  if (payload?.type === "text") return String(payload.text ?? payload.data?.text ?? "")
  if (payload?.file) return "[文件]"
  return payload ? "[消息]" : ""
}

// Only filter bridge-generated control segments; ordinary message text is kept.
export function cleanBridgeReply(payload) {
  if (Array.isArray(payload)) {
    const clean = payload.map(cleanBridgeReply).filter(item => item !== null)
    return clean.length ? clean : null
  }
  if (["button", "keyboard"].includes(payload?.type)) return null
  if (payload?.type === "node") {
    const data = Array.isArray(payload.data)
      ? payload.data.map(cleanForwardNode).filter(Boolean)
      : cleanForwardNode(payload.data)
    return data && (!Array.isArray(data) || data.length) ? { ...payload, data } : null
  }
  return payload
}

function cleanForwardNode(node) {
  if (!node || typeof node !== "object") return node
  if (node.type) return cleanBridgeReply(node)
  const result = { ...node }
  const fields = ["message", "content"].filter(key => key in node)
  for (const key of fields) result[key] = cleanBridgeReply(node[key])
  return fields.length && fields.every(key => result[key] === null) ? null : result
}

export function shouldForwardReply(payload) {
  if (Array.isArray(payload)) return payload.some(shouldForwardReply)
  return ["image", "node", "forward"].includes(payload?.type) || typeof payload?.file === "string"
}

export async function importRuntimeModule(pluginName, ...segments) {
  const file = path.join(process.cwd(), "plugins", pluginName, ...segments)
  return import(pathToFileURL(file).href)
}
