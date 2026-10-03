import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"

const MARKER = ".lotus-media-task.json"

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** A directory is owned by one invocation, never by a video ID or a group. */
export async function createMediaTask(root) {
  await fs.mkdir(root, { recursive: true })
  const dir = await fs.mkdtemp(path.join(root, "task-"))
  try {
    await fs.writeFile(path.join(dir, MARKER), JSON.stringify({
      version: 1, id: randomUUID(), pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(),
    }), { flag: "wx" })
    return { dir, id: path.basename(dir), root: path.resolve(root) }
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true })
    throw error
  }
}

export async function releaseMediaTask(root, dir) {
  if (!dir || !isInside(root, dir) || path.dirname(path.resolve(dir)) !== path.resolve(root)) {
    throw new Error("拒绝清理不属于当前媒体任务的目录")
  }
  const stat = await fs.lstat(dir).catch(error => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (!stat) return
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("媒体任务目录无效")
  await fs.readFile(path.join(dir, MARKER), "utf8")
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}

/** Conservative recovery: unknown directories and any live owner/child stay untouched. */
export async function recoverMediaTasks(root) {
  const result = { removed: 0, retained: 0 }
  const report = () => {
    if (result.retained) globalThis.logger?.info?.(`[Lotus-Plugin] Media recovery retained ${result.retained} active or unverifiable entries in ${root}`)
    if (result.removed) globalThis.logger?.info?.(`[Lotus-Plugin] Media recovery removed ${result.removed} exited tasks in ${root}`)
    return result
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return []
    throw error
  })
  // Every external media process is registered before spawning. On other platforms
  // there is no reliable process-group liveness check, so recovery stays conservative.
  if (process.platform !== "linux") { result.retained = entries.length; return report() }
  for (const entry of entries) {
    const dir = path.join(root, entry.name)
    if (!entry.isDirectory() || !entry.name.startsWith("task-")) { result.retained++; continue }
    try {
      const marker = JSON.parse(await fs.readFile(path.join(dir, MARKER), "utf8"))
      if (marker.version !== 1 || marker.host !== os.hostname() || !Number.isSafeInteger(marker.pid) || marker.pid <= 0) {
        result.retained++; continue
      }
      let alive = true
      try { process.kill(marker.pid, 0) } catch (error) { alive = error.code !== "ESRCH" }
      let childAlive = false
      try {
        const child = JSON.parse(await fs.readFile(path.join(dir, ".lotus-media-process.json"), "utf8"))
        if (child.state !== "running" || !Number.isSafeInteger(child.pid) || child.pid <= 0) childAlive = true
        else {
          try { process.kill(-child.pid, 0); childAlive = true } catch (error) { childAlive = error.code !== "ESRCH" }
        }
      } catch (error) {
        if (error.code !== "ENOENT") childAlive = true
      }
      if (alive || childAlive) { result.retained++; continue }
      await releaseMediaTask(root, dir)
      result.removed++
    } catch { result.retained++ }
  }
  return report()
}
