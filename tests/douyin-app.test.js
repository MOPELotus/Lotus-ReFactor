import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DouyinService } from "../services/douyin/service.js"
import { createDefaultGlobalConfig } from "../core/config/defaults.js"

globalThis.plugin = class { constructor(options) { Object.assign(this, options) } }
const { LotusDouyin } = await import("../apps/douyin.js")
const id = "7372484719365098803"
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(20)])

test("two actual Douyin plugin instances send the same work to independent groups and clean after each send", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-app-test-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = createDefaultGlobalConfig()
  const events = []
  const waiting = []
  const services = [1, 2].map(() => new DouyinService({
    tasksDir: root, visitor: { get: async () => "visitor" }, prepareVideo: async file => ({ file, warnings: [] }),
    fetch: async url => url.includes("detail") ? new Response(JSON.stringify({ status_code: 0, aweme_detail: { aweme_id: id, desc: "same", video: { duration: 1000, play_addr: { url_list: ["https://cdn.test/media"] } } } })) : new Response(mp4),
  }))
  const apps = [1, 2].map(groupId => {
    const app = new LotusDouyin()
    app.e = { user_id: groupId, group_id: groupId, isGroup: true, reply: async () => true, group: { sendFile: async file => {
      events.push({ groupId, file })
      await fs.access(file)
      await new Promise(resolve => { waiting[groupId - 1] = resolve })
      await fs.access(file)
    } } }
    return app
  })
  const tasks = apps.map((app, index) => app.handleWork(services[index], { id }, config, false))
  while (waiting.filter(Boolean).length < 2) await new Promise(resolve => setTimeout(resolve, 1))
  assert.notEqual(events[0].file, events[1].file)
  waiting[0]()
  await tasks[0]
  assert.equal((await fs.readdir(root)).length, 1)
  const stillSending = events.find(event => event.groupId === 2)
  assert.deepEqual(await fs.readFile(stillSending.file), mp4)
  waiting[1]()
  await tasks[1]
  assert.deepEqual(await fs.readdir(root), [])
})
