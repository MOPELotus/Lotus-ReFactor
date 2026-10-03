import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

export function safeMediaName(value = "media") {
  return String(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "media"
}

export async function sendMediaFile(e, file, config = {}) {
  const stat = await fs.stat(file)
  const ext = path.extname(file).toLowerCase()
  const segment = globalThis.segment
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) && segment?.image) {
    return e.reply(segment.image(file))
  }
  if ([".mp4", ".mkv", ".flv", ".mov", ".m4v"].includes(ext)
    && stat.size <= Number(config.video_size_limit_mb || 100) * 1024 * 1024 && segment?.video) {
    return e.reply(segment.video(file))
  }
  if (e.isGroup && e.group?.sendFile) return e.group.sendFile(file, path.basename(file))
  if (e.friend?.sendFile) return e.friend.sendFile(file, path.basename(file))
  throw new Error("当前适配器不支持发送文件")
}

export async function runMediaProcess(command, args, { cwd, env, timeoutMs = 600000, spawnImpl = spawn } = {}) {
  const owned = cwd && await fs.access(path.join(cwd, ".lotus-media-task.json")).then(() => true, () => false)
  const marker = owned ? path.join(cwd, ".lotus-media-process.json") : null
  if (marker) await fs.writeFile(marker, JSON.stringify({ state: "starting" }))
  let child
  const grouped = process.platform !== "win32"
  const kill = signal => {
    if (!child) return
    try {
      if (grouped && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch { child.kill(signal) }
  }
  const completion = new Promise((resolve, reject) => {
    child = spawnImpl(command, args, { cwd, env, windowsHide: true, detached: grouped })
    let output = ""
    let timedOut = false
    let killTimer
    const timer = setTimeout(() => {
      timedOut = true
      kill("SIGTERM")
      killTimer = setTimeout(() => kill("SIGKILL"), 2000)
    }, timeoutMs)
    const collect = chunk => { output = (output + chunk.toString()).slice(-16000) }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    child.on("error", error => { clearTimeout(timer); clearTimeout(killTimer); reject(error) })
    child.on("close", code => {
      clearTimeout(timer); clearTimeout(killTimer)
      if (timedOut || code !== 0) reject(new Error(timedOut ? `${command} 执行超时` : `${command} 执行失败：${output}`))
      else resolve({ code, output })
    })
  })
  completion.catch(() => {}) // Registration may still be awaiting disk when spawn fails.
  try {
    if (marker && child?.pid) await fs.writeFile(marker, JSON.stringify({ state: "running", pid: child.pid }))
    return await completion
  } catch (error) {
    kill("SIGKILL")
    await completion.catch(() => {})
    throw error
  } finally {
    if (marker) await fs.rm(marker, { force: true })
  }
}

export async function packMediaFiles(files, target, options = {}) {
  if (process.platform === "win32") {
    const quote = value => `'${value.replace(/'/g, "''")}'`
    await runMediaProcess("powershell.exe", ["-NoProfile", "-Command",
      `Compress-Archive -LiteralPath ${files.map(quote).join(",")} -DestinationPath ${quote(target)}`], options)
  } else {
    await runMediaProcess("zip", ["-j", target, ...files], options)
  }
  return target
}

export function mediaLimitFailure(info, config) {
  if (config.duration_limit_seconds > 0 && info.duration > config.duration_limit_seconds) {
    return { ok: false, reason: "duration_limit", info, limitSeconds: config.duration_limit_seconds }
  }
  return null
}

export function mediaFailureMessage(result = {}) {
  if (result.reason === "duration_limit") return `视频时长超过 ${Math.round(result.limitSeconds / 60)} 分钟限制。`
  if (result.reason === "estimated_size_limit") return `视频预估大小 ${result.estimatedSizeMb} MB 超过 ${result.limitMb} MB 限制。`
  return result.reason || "下载失败"
}
