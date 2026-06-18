export async function notifyProfile(profile, payload, options = {}) {
  const userId = profile?.user?.qq
  const notify = profile?.profile?.notify || {}
  if (notify.enable === false && options.force !== true) {
    return {
      ok: true,
      skipped: true,
      reason: "notify_disabled",
      userId: String(userId || ""),
    }
  }
  return notifyUser(userId, payload, {
    ...options,
    prefer: options.prefer || notify.prefer,
    fallbackGroups: options.fallbackGroups || notify.fallback_groups,
  })
}

export async function notifyUser(userId, payload, options = {}) {
  if (!userId) throw new Error("notify userId is required")
  const bot = options.bot || globalThis.Bot
  if (!bot) throw new Error("Bot is unavailable")

  const normalizedUserId = normalizeId(userId)
  const attempts = []

  if (options.prefer !== "group") {
    const privateResult = await trySendPrivate(bot, normalizedUserId, payload, options)
    attempts.push(privateResult)
    if (privateResult.ok) {
      return {
        ok: true,
        channel: "private",
        userId: String(userId),
        attempts,
      }
    }
  }

  for (const groupId of collectCandidateGroups(bot, normalizedUserId, options)) {
    const groupResult = await trySendGroup(bot, groupId, normalizedUserId, payload, options)
    attempts.push(groupResult)
    if (groupResult.ok) {
      return {
        ok: true,
        channel: "group",
        userId: String(userId),
        groupId: String(groupId),
        attempts,
      }
    }
  }

  return {
    ok: false,
    channel: "none",
    userId: String(userId),
    attempts,
    reason: attempts.at(-1)?.reason || "no_available_channel",
  }
}

async function trySendPrivate(bot, userId, payload, options = {}) {
  try {
    if (options.onlyKnownFriend !== false && hasFriendMap(bot) && !isFriend(bot, userId)) {
      return {
        ok: false,
        channel: "private",
        skipped: true,
        reason: "not_friend",
      }
    }

    const friend = pickPrivateTarget(bot, userId)
    if (!friend?.sendMsg) {
      return {
        ok: false,
        channel: "private",
        skipped: true,
        reason: "private_target_unavailable",
      }
    }

    await friend.sendMsg(payload)
    return {
      ok: true,
      channel: "private",
    }
  } catch (error) {
    return {
      ok: false,
      channel: "private",
      reason: error.message || "private_send_failed",
      error,
    }
  }
}

async function trySendGroup(bot, groupId, userId, payload, options = {}) {
  try {
    if (!await isGroupMember(bot, groupId, userId)) {
      return {
        ok: false,
        channel: "group",
        groupId: String(groupId),
        skipped: true,
        reason: "not_group_member",
      }
    }

    const group = pickGroup(bot, groupId)
    if (!group?.sendMsg) {
      return {
        ok: false,
        channel: "group",
        groupId: String(groupId),
        skipped: true,
        reason: "group_target_unavailable",
      }
    }

    await group.sendMsg(options.at === false ? payload : withAt(userId, payload))
    return {
      ok: true,
      channel: "group",
      groupId: String(groupId),
    }
  } catch (error) {
    return {
      ok: false,
      channel: "group",
      groupId: String(groupId),
      reason: error.message || "group_send_failed",
      error,
    }
  }
}

function collectCandidateGroups(bot, userId, options = {}) {
  const ids = []
  appendIds(ids, options.fallbackGroups)
  appendIds(ids, options.groups)
  appendIds(ids, options.sourceEvent?.group_id)
  appendIds(ids, options.e?.group_id)
  appendIds(ids, groupsFromMemberMap(bot, userId))
  appendIds(ids, typeof bot.getGroupList === "function" ? bot.getGroupList() : [])
  return [...new Set(ids.map(String).filter(Boolean))]
}

function groupsFromMemberMap(bot, userId) {
  const groups = []
  const memberMap = bot?.gml
  if (!(memberMap instanceof Map)) return groups

  for (const [groupId, members] of memberMap.entries()) {
    if (mapHasId(members, userId)) groups.push(groupId)
  }
  return groups
}

async function isGroupMember(bot, groupId, userId) {
  const memberMap = getGroupMemberMap(bot, groupId)
  if (memberMap && mapHasId(memberMap, userId)) return true

  const group = pickGroup(bot, groupId, true)
  if (!group) return false
  if (typeof group.pickMember !== "function") return true
  return Boolean(await group.pickMember(userId))
}

function pickPrivateTarget(bot, userId) {
  if (typeof bot.pickUser === "function") return bot.pickUser(userId, true) || bot.pickUser(userId)
  if (typeof bot.pickFriend === "function") return bot.pickFriend(userId, true) || bot.pickFriend(userId)
  if (typeof bot.sendFriendMsg === "function") {
    return {
      sendMsg: payload => bot.sendFriendMsg(null, userId, payload),
    }
  }
  return null
}

function pickGroup(bot, groupId, strict = false) {
  if (typeof bot.pickGroup === "function") return bot.pickGroup(groupId, strict)
  if (typeof bot.sendGroupMsg === "function") {
    return {
      sendMsg: payload => bot.sendGroupMsg(null, groupId, payload),
    }
  }
  return null
}

function withAt(userId, payload) {
  const at = globalThis.segment?.at?.(Number(userId) || userId) || `@${userId}`
  return Array.isArray(payload)
    ? [at, "\n", ...payload]
    : [at, "\n", payload]
}

function hasFriendMap(bot) {
  return bot?.fl instanceof Map || bot?.getFriendMap?.() instanceof Map
}

function isFriend(bot, userId) {
  const friendMap = bot?.fl instanceof Map ? bot.fl : bot?.getFriendMap?.()
  return mapHasId(friendMap, userId)
}

function getGroupMemberMap(bot, groupId) {
  const map = bot?.gml
  if (!(map instanceof Map)) return null
  return map.get(Number(groupId)) || map.get(String(groupId)) || null
}

function mapHasId(map, id) {
  if (!(map instanceof Map)) return false
  return map.has(Number(id)) || map.has(String(id))
}

function appendIds(target, value) {
  if (Array.isArray(value)) {
    for (const item of value) appendIds(target, item)
    return
  }
  if (value instanceof Map) {
    for (const key of value.keys()) appendIds(target, key)
    return
  }
  if (value instanceof Set) {
    for (const item of value.values()) appendIds(target, item)
    return
  }
  if (value && typeof value === "object") {
    if ("group_id" in value) appendIds(target, value.group_id)
    else if ("groupId" in value) appendIds(target, value.groupId)
    return
  }
  if (value === undefined || value === null || value === "") return
  target.push(value)
}

function normalizeId(value) {
  const text = String(value)
  const numeric = Number(text)
  return Number.isSafeInteger(numeric) ? numeric : text
}
