export async function replyImage(target, image, fallbackText = "图片渲染完成。") {
  try {
    if (!image) throw new Error("empty image payload")
    await callReply(target, image)
    return {
      ok: true,
      fallback: false,
    }
  } catch (error) {
    if (!fallbackText) throw error
    await callReply(target, fallbackText)
    return {
      ok: false,
      fallback: true,
      error,
    }
  }
}

export async function replyText(target, text) {
  await callReply(target, text)
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
