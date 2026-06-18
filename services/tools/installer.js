import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { loadGlobalConfig } from "../../core/config/global.js"
import { resolveData, rootPath } from "../../core/path.js"

const TOOL_NAMES = ["bbdown", "ffmpeg", "aria2"]

export class ToolInstallerService {
  constructor(options = {}) {
    this.config = options.config
    this.fetch = options.fetch || globalThis.fetch
    this.spawn = options.spawn || spawn
    this.platform = options.platform || process.platform
    this.arch = options.arch || process.arch
  }

  async getConfig() {
    if (this.config) return this.config
    const globalConfig = await loadGlobalConfig()
    return globalConfig.tools || {}
  }

  async ensureAll(options = {}) {
    const config = normalizeToolsConfig(options.config || await this.getConfig())
    if (config.auto_install === false) {
      return {
        ok: true,
        skipped: true,
        reason: "auto_install_disabled",
        items: TOOL_NAMES.map(name => ({ name, ok: true, skipped: true })),
      }
    }

    const items = []
    for (const name of TOOL_NAMES) {
      const item = config[name] || {}
      if (item.enable === false) {
        items.push({ name, ok: true, skipped: true, reason: "disabled" })
        continue
      }
      items.push(await this.ensureTool(name, config).catch(error => ({
        name,
        ok: false,
        reason: error.message,
      })))
    }

    return {
      ok: items.every(item => item.ok),
      skipped: false,
      binDir: resolveMaybeData(config.bin_dir || "data/tools/bin"),
      items,
    }
  }

  async ensureTool(name, config = null) {
    const normalized = normalizeToolsConfig(config || await this.getConfig())
    const tool = normalized[name]
    if (!tool) throw new Error(`unknown tool: ${name}`)

    const binDir = resolveMaybeData(normalized.bin_dir || "data/tools/bin")
    const existing = await findCommandExecutable(tool.command, [binDir])
    if (existing) {
      return {
        name,
        ok: true,
        status: "ready",
        path: existing,
      }
    }

    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    const release = await this.fetchLatestRelease(tool.repo, normalized.github_api)
    const asset = pickReleaseAsset(name, release.assets || [], {
      platform: this.platform,
      arch: this.arch,
      patterns: tool.asset_patterns,
    })
    if (!asset) throw new Error(`no release asset matched ${name} ${this.platform}/${this.arch}`)

    const toolsDir = resolveMaybeData(normalized.dir || "data/tools")
    const archiveDir = path.join(toolsDir, "downloads")
    const extractDir = path.join(toolsDir, name)
    await fs.mkdir(archiveDir, { recursive: true })
    await fs.mkdir(binDir, { recursive: true })
    await fs.rm(extractDir, { recursive: true, force: true })
    await fs.mkdir(extractDir, { recursive: true })

    const archive = path.join(archiveDir, safeFileName(asset.name))
    await this.downloadAsset(asset.browser_download_url || asset.url, archive)
    await extractArchive(this.spawn, archive, extractDir, {
      timeoutMs: normalized.timeout_ms,
    })

    const executable = await findExtractedExecutable(extractDir, tool.command)
    if (!executable) throw new Error(`${tool.command} executable not found in ${asset.name}`)

    const target = path.join(binDir, commandFileName(tool.command))
    await fs.copyFile(executable, target)
    if (this.platform !== "win32") await fs.chmod(target, 0o755).catch(() => null)

    return {
      name,
      ok: true,
      status: "installed",
      repo: tool.repo,
      asset: asset.name,
      path: target,
    }
  }

  async fetchLatestRelease(repo, api = "https://api.github.com") {
    const base = String(api || "https://api.github.com").replace(/\/+$/, "")
    const response = await this.fetch(`${base}/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Lotus-Plugin tool installer",
      },
    })
    if (!response.ok) throw new Error(`GitHub release request failed: HTTP ${response.status}`)
    return response.json()
  }

  async downloadAsset(url, target) {
    const response = await this.fetch(url, {
      headers: {
        "User-Agent": "Lotus-Plugin tool installer",
      },
    })
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (response.body && typeof response.body.getReader === "function") {
      await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(target))
      return target
    }
    await fs.writeFile(target, Buffer.from(await response.arrayBuffer()))
    return target
  }
}

export function normalizeToolsConfig(config = {}) {
  return {
    auto_install: config.auto_install !== false,
    dir: config.dir || "data/tools",
    bin_dir: config.bin_dir || "data/tools/bin",
    github_api: config.github_api || "https://api.github.com",
    timeout_ms: Number(config.timeout_ms || 300000),
    bbdown: {
      enable: config.bbdown?.enable !== false,
      repo: config.bbdown?.repo || "nilaoda/BBDown",
      command: config.bbdown?.command || "BBDown",
      asset_patterns: config.bbdown?.asset_patterns,
    },
    ffmpeg: {
      enable: config.ffmpeg?.enable !== false,
      repo: config.ffmpeg?.repo || "BtbN/FFmpeg-Builds",
      command: config.ffmpeg?.command || "ffmpeg",
      asset_patterns: config.ffmpeg?.asset_patterns,
    },
    aria2: {
      enable: config.aria2?.enable !== false,
      repo: config.aria2?.repo || "aria2/aria2",
      command: config.aria2?.command || "aria2c",
      asset_patterns: config.aria2?.asset_patterns,
    },
  }
}

export function pickReleaseAsset(tool, assets = [], options = {}) {
  const patterns = (options.patterns || defaultAssetPatterns(tool, options.platform, options.arch))
    .map(pattern => pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i"))
  const candidates = assets
    .filter(asset => asset?.name && asset?.browser_download_url)
    .map(asset => ({
      asset,
      score: scoreReleaseAsset(asset.name, patterns),
    }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name))
  return candidates[0]?.asset || null
}

export function defaultAssetPatterns(tool, platform = process.platform, arch = process.arch) {
  const os = normalizePlatform(platform)
  const cpu = normalizeArch(arch)
  if (tool === "bbdown") {
    if (os === "windows") return [/BBDown.*(?:win|windows).*x64.*\.zip$/i, /BBDown.*\.zip$/i]
    if (os === "linux") return [/BBDown.*linux.*(?:x64|amd64).*\.tar\.gz$/i, /BBDown.*linux.*(?:x64|amd64).*\.zip$/i]
    if (os === "darwin") return [/BBDown.*(?:osx|mac|darwin).*\.zip$/i, /BBDown.*(?:osx|mac|darwin).*\.tar\.gz$/i]
  }
  if (tool === "ffmpeg") {
    if (os === "windows") return [/ffmpeg.*win64.*gpl.*\.zip$/i, /ffmpeg.*windows.*64.*\.zip$/i]
    if (os === "linux") {
      return cpu === "arm64"
        ? [/ffmpeg.*linuxarm64.*gpl.*\.tar\.xz$/i, /ffmpeg.*linux.*arm64.*\.tar\.xz$/i]
        : [/ffmpeg.*linux64.*gpl.*\.tar\.xz$/i, /ffmpeg.*linux.*(?:x64|amd64).*\.tar\.xz$/i]
    }
    if (os === "darwin") return [/ffmpeg.*macos64.*gpl.*\.zip$/i, /ffmpeg.*(?:mac|darwin).*\.zip$/i]
  }
  if (tool === "aria2") {
    if (os === "windows") return [/aria2.*win.*64.*\.zip$/i, /aria2.*windows.*\.zip$/i]
    if (os === "linux") return [/aria2.*linux.*(?:x64|amd64).*\.tar\.(?:gz|xz)$/i, /aria2.*linux.*\.zip$/i]
    if (os === "darwin") return [/aria2.*(?:mac|darwin|osx).*\.zip$/i, /aria2.*(?:mac|darwin|osx).*\.tar\.(?:gz|xz)$/i]
  }
  return [/\.zip$/i, /\.tar\.(?:gz|xz)$/i]
}

export function scoreReleaseAsset(name, patterns = []) {
  for (let index = 0; index < patterns.length; index += 1) {
    if (patterns[index].test(name)) return patterns.length - index
  }
  return -1
}

export async function findCommandExecutable(command, dirs = []) {
  const fileName = commandFileName(command)
  for (const dir of dirs.filter(Boolean)) {
    const candidate = path.join(resolveMaybeData(dir), fileName)
    if (await exists(candidate)) return candidate
  }
  return ""
}

export function normalizePlatform(platform = process.platform) {
  if (platform === "win32") return "windows"
  if (platform === "darwin") return "darwin"
  return "linux"
}

export function normalizeArch(arch = process.arch) {
  if (["x64", "amd64", "x86_64"].includes(arch)) return "x64"
  if (["arm64", "aarch64"].includes(arch)) return "arm64"
  return arch
}

async function extractArchive(spawnImpl, archive, target, options = {}) {
  const lower = archive.toLowerCase()
  if (lower.endsWith(".zip")) {
    if (process.platform === "win32") {
      const command = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`
      await runSpawn(spawnImpl, "powershell.exe", ["-NoProfile", "-Command", command], options)
      return
    }
    await runSpawn(spawnImpl, "unzip", ["-o", archive, "-d", target], options)
    return
  }
  if (/\.(tar\.gz|tgz|tar\.xz|txz)$/i.test(lower)) {
    await runSpawn(spawnImpl, "tar", ["-xf", archive, "-C", target], options)
    return
  }
  throw new Error(`unsupported archive: ${path.basename(archive)}`)
}

async function findExtractedExecutable(root, command) {
  const wanted = commandFileName(command).toLowerCase()
  const fallback = String(command || "").toLowerCase()
  const queue = [root]
  while (queue.length) {
    const dir = queue.shift()
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase()
        if (lower === wanted || lower === fallback) return full
      }
    }
  }
  return ""
}

function runSpawn(spawnImpl, command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd || rootPath,
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, Number(options.timeoutMs || 300000))

    child.stdout?.on("data", chunk => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", code => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) {
        resolve({ ok: true, code, stdout, stderr })
        return
      }
      const error = new Error(timedOut ? `${command} timed out` : stderr || stdout || `${command} exited with code ${code}`)
      error.code = code
      error.timedOut = timedOut
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    })
  })
}

function commandFileName(command) {
  if (process.platform === "win32" && !/\.exe$/i.test(command)) return `${command}.exe`
  return command
}

function resolveMaybeData(value = "") {
  const text = String(value || "")
  if (!text) return ""
  if (path.isAbsolute(text)) return text
  if (text.startsWith("data/") || text.startsWith("data\\")) return resolveData(text.slice(5))
  return path.resolve(rootPath, text)
}

function safeFileName(value = "asset") {
  return String(value || "asset").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
