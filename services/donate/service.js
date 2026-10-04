import fs from "node:fs/promises"
import path from "node:path"
import { load } from "cheerio"
import { resourcesPath } from "../../core/path.js"

export const DONATE_URL = "https://www.lotusshared.cn/donate"

// Snapshot of LotusSite/docs/donate.md and its original public/donate images.
// Bundle the page body so website anti-bot restrictions cannot break the command.
export async function loadDonateContent() {
  const root = path.join(resourcesPath, "donate")
  const markdown = await fs.readFile(path.join(root, "page.md"), "utf8")
  const body = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "")
  const [text] = body.split("<div")
  const title = text.match(/^# (.+)$/m)?.[1]
  const message = text.replace(/^# .+$/m, "").trim()
  const $ = load(body)
  const methods = $(".donate-card").toArray().map(element => {
    const section = $(element)
    return {
      title: section.find("h2").text().trim(),
      image: path.join(root, path.basename(section.find("img").attr("src") || "")),
      notice: section.find("p").text().trim(),
    }
  })
  if (!title || !message || methods.length !== 2) throw new Error("捐赠页正文不完整")
  return { title, message, methods }
}
