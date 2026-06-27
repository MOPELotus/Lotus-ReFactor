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
    ...patch,
    reply: async payload => {
      messages.push(summarizeReply(payload))
      if (forwardReplies && shouldForwardReply(payload) && baseReply) {
        forwarded.push(summarizeReply(payload))
        return baseReply(payload)
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
  if (payload?.type === "button") return "[按钮]"
  if (payload?.file) return "[文件]"
  return payload ? "[消息]" : ""
}

export function shouldForwardReply(payload) {
  if (Array.isArray(payload)) return payload.some(shouldForwardReply)
  return payload?.type === "image" || typeof payload?.file === "string"
}

export async function importRuntimeModule(pluginName, ...segments) {
  const file = path.join(process.cwd(), "plugins", pluginName, ...segments)
  return import(pathToFileURL(file).href)
}
