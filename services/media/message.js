export function buildMediaMessageText(e = {}) {
  const chunks = [e.raw_message, e.msg]
  for (const item of e.message || []) {
    if ((item?.type === "json" || item?.type === "xml") && item.data) chunks.push(typeof item.data === "string" ? item.data : JSON.stringify(item.data))
    if (item?.type === "text") chunks.push(item.text || item.data?.text)
  }
  return chunks.filter(Boolean).join("\n")
}

/** Bounded card sizes without discarding any article text or image ordering. */
export function articlePages(article) {
  if (!article) return []
  const pages = []
  let page = []
  let length = 0
  const flush = () => { if (page.length) pages.push(page); page = []; length = 0 }
  for (const block of article.blocks) {
    if (block.type === "image") { flush(); pages.push([block]); continue }
    const units = Array.from(block.text || "")
    while (units.length) {
      const text = units.splice(0, 600 - length).join("")
      page.push({ type: "text", text })
      length += Array.from(text).length
      if (length >= 600) flush()
    }
  }
  flush()
  return pages
}
