import fs from "node:fs/promises"
import path from "node:path"
import { resolveData, rootPath } from "../../core/path.js"
import { runMediaProcess } from "./files.js"

export async function findMediaTool(name, toolsPath = "data/tools/bin") {
  const configured = toolsPath === "data/tools/bin" ? resolveData("tools", "bin") : path.resolve(rootPath, toolsPath)
  for (const dir of [configured, ...(process.env.PATH || "").split(path.delimiter)]) {
    const file = path.join(dir, process.platform === "win32" ? `${name}.exe` : name)
    try { await fs.access(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return file } catch {}
  }
  return null
}

export async function prepareVideo(file, { tools_path, timeout_ms = 600000, codec } = {}) {
  const warnings = []
  const ffprobe = await findMediaTool("ffprobe", tools_path)
  let videoCodec = codec
  let audioCodec
  if (ffprobe) {
    const probe = await runMediaProcess(ffprobe, ["-v", "error", "-show_streams", "-of", "json", file], { cwd: path.dirname(file), timeoutMs: Math.min(timeout_ms, 30000) })
    const streams = JSON.parse(probe.output).streams || []
    const video = streams.find(stream => stream.codec_type === "video")
    if (!video) throw new Error("下载的文件没有可用视频流")
    videoCodec = video.codec_name
    audioCodec = streams.find(stream => stream.codec_type === "audio")?.codec_name
  }
  const conversion = path.extname(file) !== ".mp4" || videoCodec && !["h264"].includes(videoCodec) || audioCodec && !["aac", "mp3"].includes(audioCodec)
  if (!conversion) return { file, warnings }
  const ffmpeg = await findMediaTool("ffmpeg", tools_path)
  if (!ffmpeg) return { file, warnings: ["未找到 FFmpeg，保留原视频文件，兼容性取决于客户端"] }
  const target = file.replace(/\.[^.]+$/, "-compatible.mp4")
  await runMediaProcess(ffmpeg, ["-nostdin", "-v", "error", "-i", file, "-map", "0:v:0", "-map", "0:a?",
    "-c:v", videoCodec === "h264" ? "copy" : "libx264", "-c:a", audioCodec === "aac" || !audioCodec ? "copy" : "aac", "-movflags", "+faststart", target],
  { cwd: path.dirname(file), timeoutMs: timeout_ms })
  const stat = await fs.stat(target)
  if (!stat.size) throw new Error("FFmpeg 未生成有效视频")
  return { file: target, warnings }
}
