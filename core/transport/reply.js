export async function replyImage(target, image, fallbackText = "图片渲染完成。") {
  try {
    if (!image) throw new Error("empty image payload")
    const reply = await callReply(target, image)
    return {
      ok: true,
      fallback: false,
      reply,
    }
  } catch (error) {
    if (!fallbackText) throw error
    const reply = await callReply(target, fallbackText)
    return {
      ok: false,
      fallback: true,
      error,
      reply,
    }
  }
}

export async function replyText(target, text) {
  return callReply(target, text)
}

export async function replyForward(target, messages = [], options = {}) {
  const payloads = messages.filter(Boolean)
  if (!payloads.length) {
    return {
      ok: false,
      fallback: false,
      error: new Error("empty forward payload"),
      reply: null,
    }
  }

  try {
    const e = target?.e || target
    const forward = await makeForwardMessage(e, payloads, options.description || options.title || "")
    if (!forward) throw new Error("forward message is unavailable")
    const reply = await callReply(target, forward)
    return {
      ok: true,
      fallback: false,
      reply,
    }
  } catch (error) {
    if (options.fallbackToMessages === false) throw error
    const replies = []
    for (const payload of payloads) {
      replies.push(await callReply(target, payload))
    }
    return {
      ok: false,
      fallback: true,
      error,
      reply: replies,
    }
  }
}

export async function replyTextWithOptionalRecall(target, text, options = {}) {
  const reply = await replyText(target, text)
  if (options.autoRecall === true) {
    scheduleRecall(target, reply, options.recallSeconds)
  }
  return reply
}

async function callReply(target, payload) {
  if (typeof target?.reply === "function") {
    return target.reply(payload)
  }
  if (typeof target?.e?.reply === "function") {
    return target.e.reply(payload)
  }
  throw new Error("reply target is unavailable")
}

async function makeForwardMessage(e, messages = [], description = "") {
  const bot = e?.bot || globalThis.Bot?.[e?.self_id] || globalThis.Bot || {}
  const userId = String(bot.uin || bot.self_id || e?.self_id || e?.user_id || "0")
  let nickname = String(bot.nickname || bot.name || "荷花插件")

  if (e?.isGroup && typeof bot.getGroupMemberInfo === "function") {
    try {
      const info = await bot.getGroupMemberInfo(e.group_id, userId)
      nickname = info?.card || info?.nickname || nickname
    } catch {}
  }

  const nodes = messages.map(message => ({
    user_id: userId,
    nickname,
    message,
  }))

  let forward = null
  if (typeof e?.group?.makeForwardMsg === "function") {
    forward = await e.group.makeForwardMsg(nodes)
  } else if (typeof e?.friend?.makeForwardMsg === "function") {
    forward = await e.friend.makeForwardMsg(nodes)
  } else if (typeof bot.makeForwardMsg === "function") {
    forward = await bot.makeForwardMsg(nodes)
  }

  return decorateForwardMessage(forward, description)
}

function decorateForwardMessage(forward, description = "") {
  if (!forward || !description) return forward
  if (typeof forward.data === "object") {
    const detail = forward.data?.meta?.detail
    if (detail) detail.news = [{ text: description }]
    return forward
  }
  if (typeof forward.data === "string") {
    forward.data = forward.data
      .replace(/\n/g, "")
      .replace(/<title color="#777777" size="26">(.+?)<\/title>/g, "___")
      .replace(/___+/, `<title color="#777777" size="26">${description}</title>`)
  }
  return forward
}

function scheduleRecall(target, reply, recallSeconds = 0) {
  const seconds = Number(recallSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return
  const ids = normalizeMessageIds(reply)
  if (!ids.length) return

  const e = target?.e || target
  const recall = getRecallFunction(e)
  if (!recall) return

  const timer = setTimeout(() => {
    for (const id of ids) {
      Promise.resolve(recall(id)).catch(error => {
        globalThis.logger?.debug?.(`[Lotus-Plugin] recall message failed: ${error.message}`)
      })
    }
  }, seconds * 1000)
  if (typeof timer.unref === "function") timer.unref()
}

function normalizeMessageIds(reply) {
  if (!reply) return []
  if (Array.isArray(reply)) return reply.flatMap(normalizeMessageIds)
  const id = reply.message_id ?? reply.data?.message_id ?? reply.messageId
  if (Array.isArray(id)) return id.map(String).filter(Boolean)
  return id !== undefined && id !== null ? [String(id)] : []
}

function getRecallFunction(e) {
  if (typeof e?.group?.recallMsg === "function") return id => e.group.recallMsg(id)
  if (typeof e?.friend?.recallMsg === "function") return id => e.friend.recallMsg(id)
  if (typeof e?.bot?.recallMsg === "function") return id => e.bot.recallMsg(id)
  return null
}
