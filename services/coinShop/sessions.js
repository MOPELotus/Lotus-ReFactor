import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

// Only token digests are stored. Browser credentials never enter URLs or files.
export class WebSessionStore {
  constructor(file, now = Date.now) { this.file = file; this.now = now }

  async load() {
    let data
    try { data = JSON.parse(await fs.readFile(this.file, "utf8")) }
    catch (error) {
      if (error.code === "ENOENT") return new Map()
      throw new Error("浏览器令牌文件无法读取，已保留原文件，请检查私有数据目录")
    }
    if (data?.version !== 1 || !Array.isArray(data.sessions)) throw new Error("浏览器令牌文件格式无效，已保留原文件")
    const sessions = new Map()
    for (const entry of data.sessions) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const [hash, session] = entry
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || !session || typeof session.qq !== "string"
        || !session.qq || typeof session.botId !== "string" || typeof session.owner !== "boolean"
        || !["user", "panel"].includes(session.purpose) || session.purpose === "panel" && !session.owner
        || typeof session.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(session.csrf)
        || !Number.isSafeInteger(session.expires) || session.expires <= this.now()) continue
      sessions.set(hash, { qq: session.qq, botId: session.botId, owner: session.owner,
        purpose: session.purpose, csrf: session.csrf, expires: session.expires })
    }
    return sessions
  }

  async save(sessions) {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const entries = [...sessions].filter(([, session]) => session.expires > this.now())
      await fs.writeFile(temporary, JSON.stringify({ version: 1, sessions: entries }), { mode: 0o600, flag: "wx" })
      await fs.rename(temporary, this.file)
    } catch (error) {
      globalThis.logger?.warn?.(`[Lotus-Plugin] browser session persistence failed: ${error.code || "write_failed"}`)
      throw Object.assign(new Error("浏览器登录状态暂时无法保存，请稍后重试"), { status: 503, cause: error })
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  }
}
