import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"
import { createMediaTask, releaseMediaTask, recoverMediaTasks } from "../services/media/tasks.js"
import { downloadMedia } from "../services/media/download.js"
import { runMediaProcess, sendMediaFile } from "../services/media/files.js"
import { BilibiliService, buildBBDownArgs, selectCompletedMediaFiles } from "../services/bilibili/service.js"
import { migrateGlobalConfig } from "../core/config/global.js"
import { ToolInstallerService } from "../services/tools/installer.js"

const rootFor = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-media-test-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(20)])

test("same Bilibili video: concurrent tasks and a delayed send use separate files and ZIPs", async t => {
  const root = await rootFor(t)
  const service = new BilibiliService({ tasksDir: root })
  let resolutions = 0
  service.getInfo = async () => { resolutions++; return { type: "video", bvid: "BV1234567890", title: "same title", duration: 1, pages: [{ page: 1 }, { page: 2 }] } }
  service.downloadWithBBDown = async (plan, config, dir) => {
    const files = [path.join(dir, "P1.mp4"), path.join(dir, "P2.mp4")]
    await Promise.all(files.map(file => fs.writeFile(file, mp4)))
    return files
  }
  const results = await Promise.all(Array.from({ length: 6 }, () => service.download("same")))
  assert.equal(resolutions, 6)
  assert.equal(new Set(results.map(result => result.taskDir)).size, 6)
  assert.equal(new Set(results.flatMap(result => result.files)).size, 6)
  const original = await fs.readFile(results[1].files[0])
  await service.releaseTask(results[0])
  assert.deepEqual(await fs.readFile(results[1].files[0]), original)
  const later = await service.download("same")
  assert.notEqual(later.taskDir, results[1].taskDir)
  assert.deepEqual(await fs.readFile(results[1].files[0]), original)
  for (const result of [...results.slice(1), later]) await service.releaseTask(result)
  assert.deepEqual(await fs.readdir(root), [])
})

test("a failed Bilibili task removes only itself", async t => {
  const root = await rootFor(t)
  const service = new BilibiliService({ tasksDir: root })
  service.getInfo = async () => ({ type: "video", bvid: "BV1234567890", title: "same", pages: [{ page: 1 }], duration: 1 })
  let calls = 0
  service.downloadWithBBDown = async (plan, config, dir) => {
    const file = path.join(dir, "video.mp4")
    await fs.writeFile(file, mp4)
    if (++calls === 2) throw new Error("forced failure")
    return [file]
  }
  const good = await service.download("same")
  await assert.rejects(service.download("same"), /forced failure/)
  assert.equal((await fs.readFile(good.files[0])).length, mp4.length)
  assert.equal((await fs.readdir(root)).length, 1)
  await service.releaseTask(good)
})

test("real BBDown subprocess contract keeps its output in the invocation directory", async t => {
  if (process.platform === "win32") return t.skip("Unix executable fixture")
  const root = await rootFor(t)
  const tool = path.join(root, "BBDown")
  await fs.writeFile(tool, '#!/usr/bin/env node\nrequire("fs").writeFileSync(require("path").join(process.cwd(),"video.mp4"),"test-output")\n')
  await fs.chmod(tool, 0o755)
  const service = new BilibiliService({ tasksDir: path.join(root, "tasks") })
  service.getInfo = async () => ({ type: "video", url: "https://www.bilibili.com/video/BV1234567890", bvid: "BV1234567890", title: "title", pages: [{ page: 1 }], duration: 1 })
  const result = await service.download("same", { tools_path: root, multi_page_policy: "first" })
  assert.equal(await fs.readFile(result.files[0], "utf8"), "test-output")
  await service.releaseTask(result)
  const args = await buildBBDownArgs("https://www.bilibili.com/video/BV1234567890", root, { page: 2, config: { use_aria2: false, resolution: 64 } })
  assert.ok(args.includes("2"))
  assert.deepEqual(selectCompletedMediaFiles(["P1.mp4", "1_video.m4s", "1_audio.m4a"]), ["P1.mp4"])
})

test("legacy cache/cleanup settings migrate away without changing other settings", () => {
  const config = migrateGlobalConfig({ bilibili: { enableCache: true, cacheTTL: 42, cleanup: { enable: false }, download: { cache_enable: true, cache_ttl_seconds: 42, resolution: 80 } } })
  assert.equal(config.bilibili.download.resolution, 80)
  assert.equal("cache_enable" in config.bilibili.download, false)
  assert.equal("cache_ttl_seconds" in config.bilibili.download, false)
  assert.equal("cleanup" in config.bilibili, false)
  assert.equal("enableCache" in config.bilibili, false)
  assert.equal(config.douyin.download.multi_page_policy, "zip")
})

test("recovery preserves active and unknown directories; ownership is required to release", async t => {
  const root = await rootFor(t)
  const task = await createMediaTask(root)
  await fs.mkdir(path.join(root, "historical-downloads"))
  await fs.mkdir(path.join(root, "task-unknown"))
  const result = await recoverMediaTasks(root)
  assert.equal(result.removed, 0)
  await assert.rejects(releaseMediaTask(root, path.dirname(root)))
  await assert.rejects(releaseMediaTask(root, path.join(root, "task-unknown")))
  await fs.access(task.dir)
  await releaseMediaTask(root, task.dir)
})

test("recovery removes a marked task only after its owner exits", async t => {
  if (process.platform !== "linux") return t.skip("Linux process verification")
  const root = await rootFor(t)
  const task = await createMediaTask(root)
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  await new Promise(resolve => child.on("close", resolve))
  await fs.writeFile(path.join(task.dir, ".lotus-media-task.json"), JSON.stringify({ version: 1, pid: child.pid, host: os.hostname() }))
  const result = await recoverMediaTasks(root)
  assert.equal(result.removed, 1)
  assert.deepEqual(await fs.readdir(root), [])
})

test("download validates real bytes and does not retain error pages or partial files", async t => {
  const root = await rootFor(t)
  for (const [body, headers] of [["<html>risk control</html>", {}], [mp4, { "content-length": "1000" }], [mp4, {}]]) {
    const fetch = async () => new Response(body, { headers })
    const base = path.join(root, "media")
    if (body === mp4 && !headers["content-length"]) {
      const result = await downloadMedia("https://cdn.test/media", base, { fetch, kind: "video" })
      assert.deepEqual(await fs.readFile(result.file), mp4)
      await fs.rm(result.file)
    } else await assert.rejects(downloadMedia("https://cdn.test/media", base, { fetch, kind: "video" }))
    assert.deepEqual(await fs.readdir(root), [])
  }
})

test("unknown-length downloads enforce actual byte limits", async t => {
  const root = await rootFor(t)
  await assert.rejects(downloadMedia("https://cdn.test/media", path.join(root, "video"), { fetch: async () => new Response(mp4), maxBytes: 8, kind: "video" }), /大小/)
  assert.deepEqual(await fs.readdir(root), [])
})

test("send completion precedes task deletion, including large video group-file routing", async t => {
  const root = await rootFor(t)
  const task = await createMediaTask(root)
  const file = path.join(task.dir, "video.mp4")
  await fs.writeFile(file, mp4)
  let finish
  const e = { isGroup: true, group: { sendFile: async target => {
    await fs.access(target)
    await new Promise(resolve => { finish = resolve })
    await fs.access(target)
  } } }
  const sending = sendMediaFile(e, file, { video_size_limit_mb: 0.000001 })
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1))
  await fs.access(file)
  finish()
  await sending
  await releaseMediaTask(root, task.dir)
  await assert.rejects(fs.access(file))
})

test("subprocess timeout waits for termination before allowing directory cleanup", async t => {
  const root = await rootFor(t)
  await assert.rejects(runMediaProcess(process.execPath, ["-e", 'setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 50 }), /超时/)
})

test("concurrent tool checks share installation work but not media tasks", async () => {
  const installer = new ToolInstallerService({ config: {} })
  let calls = 0
  installer.installTool = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true } }
  await Promise.all(Array.from({ length: 5 }, () => installer.ensureTool("ffmpeg", {})))
  assert.equal(calls, 1)
  await installer.ensureTool("ffmpeg", {})
  assert.equal(calls, 2)
})

test("recovery preserves an orphaned media subprocess even after the task owner exits", async t => {
  if (process.platform !== "linux") return t.skip("Linux process groups")
  const root = await rootFor(t)
  const task = await createMediaTask(root)
  const owner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  await new Promise(resolve => owner.on("close", resolve))
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: task.dir, detached: true, stdio: "ignore" })
  t.after(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} })
  await fs.writeFile(path.join(task.dir, ".lotus-media-task.json"), JSON.stringify({ version: 1, pid: owner.pid, host: os.hostname() }))
  await fs.writeFile(path.join(task.dir, ".lotus-media-process.json"), JSON.stringify({ state: "running", pid: child.pid }))
  assert.equal((await recoverMediaTasks(root)).removed, 0)
  await fs.access(task.dir)
  const closed = new Promise(resolve => child.on("close", resolve))
  process.kill(-child.pid, "SIGKILL")
  await closed
  assert.equal((await recoverMediaTasks(root)).removed, 1)
})
