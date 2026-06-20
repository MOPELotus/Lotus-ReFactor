import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  resolveData,
  rootPath,
} from "../../core/path.js"
import { loadGlobalConfig } from "../../core/config/global.js"
import { formatLocalIso } from "../../core/time.js"

export class PythonEnvService {
  constructor(options = {}) {
    this.config = options.config
    this.spawn = options.spawn || spawn
    this.onProgress = options.onProgress
  }

  async getConfig() {
    if (this.config) return this.config
    const globalConfig = await loadGlobalConfig()
    return globalConfig.python || {}
  }

  async getPythonExecutable() {
    const config = await this.getConfig()
    if (config.mode === "system") {
      return {
        command: config.system_python || "python",
        args: [],
        mode: "system",
      }
    }

    const venvPath = resolveMaybeData(config.venv_path || "data/python/venv")
    const executable = process.platform === "win32"
      ? path.join(venvPath, "Scripts", "python.exe")
      : path.join(venvPath, "bin", "python")
    return {
      command: executable,
      args: [],
      mode: "venv",
      venvPath,
    }
  }

  async ensureVenv(options = {}) {
    const { installRequirements = true } = options
    const onProgress = options.onProgress || this.onProgress
    const config = await this.getConfig()
    if (config.mode === "system") return this.getPythonExecutable()

    const venvPath = resolveMaybeData(config.venv_path || "data/python/venv")
    const pyvenv = path.join(venvPath, "pyvenv.cfg")
    try {
      await fs.access(pyvenv)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      const systemPython = config.system_python || "python"
      await emitProgress(onProgress, `Python：创建虚拟环境 ${venvPath}`)
      await runProcess(this.spawn, systemPython, ["-m", "venv", venvPath], {
        cwd: rootPath,
      })
      await emitProgress(onProgress, "Python：虚拟环境创建完成")
    }

    const python = await this.getPythonExecutable()
    await emitProgress(onProgress, "MihoyoBBSTools：检查依赖指纹")
    const status = await this.getFingerprintStatus(venvPath)
    if (installRequirements && status.stale) {
      await emitProgress(onProgress, `MihoyoBBSTools：安装 Python 依赖（${status.reasons.join(", ") || "首次初始化"}）`)
      await runProcess(this.spawn, python.command, [
        "-m",
        "pip",
        "install",
        "-r",
        path.join(rootPath, "MihoyoBBSTools", "requirements.txt"),
      ], {
        cwd: rootPath,
      })
      await emitProgress(onProgress, "MihoyoBBSTools：Python 依赖安装完成")
    } else if (installRequirements) {
      await emitProgress(onProgress, "MihoyoBBSTools：Python 依赖未变化")
    }

    if (installRequirements) await this.writeFingerprint(venvPath, status.current)
    return {
      ...python,
      fingerprint: status.current,
      fingerprintStale: status.stale,
      fingerprintReasons: status.reasons,
    }
  }

  async getFingerprintStatus(venvPath) {
    const current = await this.buildFingerprint()
    const file = path.join(venvPath, "lotus-fingerprint.json")
    let saved = null
    try {
      saved = JSON.parse(await fs.readFile(file, "utf8"))
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    return diffFingerprint(saved, current)
  }

  async buildFingerprint() {
    const requirements = path.join(rootPath, "MihoyoBBSTools", "requirements.txt")
    const raw = await fs.readFile(requirements, "utf8")
    const commit = await this.readBbsToolsCommit()
    return {
      requirements_sha256: createHash("sha256").update(raw).digest("hex"),
      bbstools_commit: commit,
    }
  }

  async writeFingerprint(venvPath, fingerprint = null) {
    const current = fingerprint || await this.buildFingerprint()
    const data = {
      ...current,
      updated_at: formatLocalIso(),
    }
    const file = path.join(venvPath, "lotus-fingerprint.json")
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8")
    return data
  }

  async readBbsToolsCommit() {
    try {
      const result = await runProcess(this.spawn, "git", [
        "-C",
        path.join(rootPath, "MihoyoBBSTools"),
        "rev-parse",
        "HEAD",
      ], {
        cwd: rootPath,
      })
      return result.stdout.trim()
    } catch {
      return ""
    }
  }
}

async function emitProgress(onProgress, message) {
  if (typeof onProgress !== "function") return
  try {
    await onProgress(message)
  } catch (error) {
    logger?.debug?.(`[Lotus-Plugin] progress callback failed: ${error.message}`)
  }
}

export function diffFingerprint(saved, current) {
  if (!saved) {
    const fingerprint = {
      current,
      saved: null,
      stale: true,
      reasons: ["missing"],
    }
    return fingerprint
  }

  const reasons = []
  if (saved.requirements_sha256 !== current.requirements_sha256) reasons.push("requirements")
  if ((saved.bbstools_commit || "") !== (current.bbstools_commit || "")) reasons.push("bbstools_commit")

  return {
    current,
    saved,
    stale: reasons.length > 0,
    reasons,
  }
}

export function runProcess(spawnImpl, command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd || rootPath,
      env: withUtf8ProcessEnv(options.env || process.env),
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", chunk => {
      stdout += decodeProcessChunk(chunk)
    })
    child.stderr?.on("data", chunk => {
      stderr += decodeProcessChunk(chunk)
    })
    child.on("error", reject)
    child.on("close", code => {
      if (code === 0) {
        resolve({ code, stdout, stderr })
        return
      }
      const error = new Error(`${command} exited with code ${code}`)
      error.code = code
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    })
  })
}

export function withUtf8ProcessEnv(env = process.env) {
  return {
    ...env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    PYTHONLEGACYWINDOWSSTDIO: "0",
  }
}

export function decodeProcessChunk(chunk) {
  if (chunk == null) return ""
  if (typeof chunk === "string") return chunk
  return new TextDecoder("utf-8", { fatal: false }).decode(chunk)
}

function resolveMaybeData(value) {
  if (path.isAbsolute(value)) return value
  if (value.startsWith("data/") || value.startsWith("data\\")) {
    return resolveData(value.slice(5))
  }
  return path.join(rootPath, value)
}
