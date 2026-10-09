import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"

export function safeMediaName(value = "media") {
  let cleaned = String(value).toWellFormed().normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`
  let output = ""
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(cleaned)) {
    if (Buffer.byteLength(output + segment, "utf8") > 180) break
    output += segment
  }
  output = output.replace(/[ .]+$/g, "")
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(output)) output = `_${output}`
  return output || "media"
}

export async function sendMediaFile(e, file, config = {}) {
  file = path.resolve(file)
  const stat = await fs.stat(file)
  const ext = path.extname(file).toLowerCase()
  const name = config.file_name || path.basename(file)
  // Adapters turn local paths into unescaped file:// strings; NapCat then
  // decodeURIComponent()s them. Keep display names separate from that path.
  let transferDir
  let transferFile = file
  if (/[^A-Za-z0-9_./-]/.test(file)) {
    const parent = /[^A-Za-z0-9_./-]/.test(path.dirname(file)) ? os.tmpdir() : path.dirname(file)
    transferDir = await fs.mkdtemp(path.join(parent, ".lotus-media-upload-"))
    const transferExt = /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : ".bin"
    transferFile = path.join(transferDir, `media-${randomUUID()}${transferExt}`)
    try {
      try { await fs.link(file, transferFile) } catch (error) {
        if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EMLINK"].includes(error.code)) throw error
        await fs.copyFile(file, transferFile, fs.constants.COPYFILE_FICLONE)
      }
    } catch (error) { await fs.rm(transferDir, { recursive: true, force: true }); throw error }
  }
  try {
    const segment = globalThis.segment
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) && segment?.image) {
      return await e.reply(segment.image(transferFile, name))
    }
    if ([".mp4", ".mkv", ".flv", ".mov", ".m4v"].includes(ext)
      && stat.size <= Number(config.video_size_limit_mb || 100) * 1024 * 1024 && segment?.video) {
      return await e.reply(segment.video(transferFile, name))
    }
    if (e.isGroup && e.group?.sendFile) return await e.group.sendFile(transferFile, name)
    if (e.friend?.sendFile) return await e.friend.sendFile(transferFile, name)
    throw new Error("当前适配器不支持发送文件")
  } finally {
    if (transferDir) await fs.rm(transferDir, { recursive: true, force: true })
  }
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
