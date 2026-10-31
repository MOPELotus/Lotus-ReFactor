import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { resolveData } from "../../core/path.js"

export class CoinShopStore {
  constructor(file = resolveData("coinShop", "plans.json")) {
    this.file = file
    this.ready = null
    this.plans = []
    this.trackers = []
    this.tail = Promise.resolve()
  }

  async load() {
    if (!this.ready) this.ready = (async () => {
      try {
        const data = JSON.parse(await fs.readFile(this.file, "utf8"))
        if (![1, 2].includes(data.version) || !Array.isArray(data.plans) || (data.version === 2 && !Array.isArray(data.trackers))) throw new Error("米游币兑换计划文件格式异常")
        this.plans = data.plans
        this.trackers = data.trackers || []
      } catch (error) { if (error.code !== "ENOENT") throw error }
    })()
    await this.ready
  }

  async list() {
    await this.load()
    await this.tail
    return structuredClone(this.plans)
  }

  async change(edit) {
    return this.mutate("plans", edit)
  }

  async listTrackers() {
    await this.load()
    await this.tail
    return structuredClone(this.trackers)
  }

  async changeTrackers(edit) {
    return this.mutate("trackers", edit)
  }

  async mutate(kind, edit) {
    await this.load()
    const task = this.tail.catch(() => {}).then(async () => {
      const next = structuredClone(this[kind])
      const value = edit(next)
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 2, plans: kind === "plans" ? next : this.plans, trackers: kind === "trackers" ? next : this.trackers }, null, 2), { mode: 0o600 })
        await fs.rename(temporary, this.file)
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
      this[kind] = next
      return structuredClone(value)
    })
    this.tail = task.then(() => {}, () => {})
    return task
  }

  async update(id, fields, expectedStatuses = null) {
    return this.change(plans => {
      const plan = plans.find(item => item.id === id)
      if (!plan) throw new Error("兑换计划不存在")
      if (expectedStatuses && !expectedStatuses.includes(plan.status)) return null
      Object.assign(plan, fields)
      return plan
    })
  }
}
