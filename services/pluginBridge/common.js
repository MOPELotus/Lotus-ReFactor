import path from "node:path"
import { pathToFileURL } from "node:url"

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

