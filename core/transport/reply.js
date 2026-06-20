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
