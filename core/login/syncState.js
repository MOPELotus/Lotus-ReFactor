import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { resolveData } from "../path.js"

const queuesKey = Symbol.for("lotus.loginCredentialSync.fileQueues")
const queues = globalThis[queuesKey] ||= new Map()

function updateFile(file, operation) {
  const key = path.resolve(file)
  const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(operation)
  queues.set(key, task)
  return task.finally(() => { if (queues.get(key) === task) queues.delete(key) })
}

// Only profile identifiers are persisted here, never account cookies or tokens.
export class PendingLoginSyncStore {
  constructor(file = resolveData("login-credential-sync.json")) {
    this.file = file
  }

  async list() {
    let raw
    try {
      raw = await fs.readFile(this.file, "utf8")
    } catch (error) {
      if (error.code === "ENOENT") return new Set()
      throw error
    }
    const data = JSON.parse(raw)
    if (data?.version !== 1 || !Array.isArray(data.pending) || data.pending.some(key => typeof key !== "string")) {
      throw new Error("invalid pending login sync state")
    }
    return new Set(data.pending)
  }

  async add(key) {
    return updateFile(this.file, async () => {
      const pending = await this.list()
      if (pending.has(key)) return
      pending.add(key)
      await this.save(pending)
    })
  }

  async delete(key) {
    return updateFile(this.file, async () => {
      const pending = await this.list()
      if (!pending.delete(key)) return
      await this.save(pending)
    })
  }

  async save(pending) {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, pending: [...pending].sort() }) + "\n", { flag: "wx", mode: 0o600 })
      await fs.rename(temporary, this.file)
    } finally {
      await fs.unlink(temporary).catch(error => {
        if (error.code !== "ENOENT") throw error
      })
    }
  }
}
