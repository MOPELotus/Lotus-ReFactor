import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import fsSync from "node:fs"
import { loadGlobalConfig } from "../../core/config/global.js"
import { resolveData, rootPath } from "../../core/path.js"
import { runProcess } from "../python/env.js"

const DEFAULT_MODEL_FILES = [
  "PP-HGNetV2-B4.onnx",
  "d-fine-n.onnx",
  "yolo11n.onnx",
  "dinov3-small.onnx",
  "atten.onnx",
]

export class TestNineEnvService {
  constructor(options = {}) {
    this.config = options.config
    this.pythonConfig = options.pythonConfig
    this.spawn = options.spawn || spawn
    this.fetch = options.fetch || globalThis.fetch
    this.onProgress = options.onProgress
  }

  async getConfig() {
    if (this.config) return normalizeTestNineConfig(this.config)
    const globalConfig = await loadGlobalConfig()
    this.pythonConfig ||= globalConfig.python || {}
    return normalizeTestNineConfig(globalConfig.captcha?.test_nine || {})
  }

  async getPythonExecutable() {
    const config = await this.getConfig()
    const venvPath = resolveMaybeData(config.venv_path)
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

  async ensureEnv(options = {}) {
    const onProgress = options.onProgress || this.onProgress
    const config = await this.getConfig()
    const installRequirements = options.installRequirements ?? config.install_requirements
    const downloadModels = options.downloadModels ?? config.download_models
    const submoduleRoot = resolveMaybeRoot(config.submodule_path)
    await emitProgress(onProgress, `test_nine：检查子模块 ${submoduleRoot}`)
    if (!await exists(path.join(submoduleRoot, "main.py"))) {
      await emitProgress(onProgress, "test_nine：子模块缺失，跳过本地模型初始化")
      return {
        ok: false,
        reason: "test_nine_submodule_missing",
        submoduleRoot,
      }
    }

    const venvPath = resolveMaybeData(config.venv_path)
    await this.ensureVenv(venvPath, { onProgress })
    const python = await this.getPythonExecutable()
    await emitProgress(onProgress, "test_nine：检查依赖指纹")
    const fingerprint = await this.getFingerprintStatus(venvPath, config)

    if (installRequirements && fingerprint.stale) {
      await emitProgress(onProgress, `test_nine：安装 Python 依赖（${fingerprint.reasons.join(", ") || "首次初始化"}）`)
      await runProcess(this.spawn, python.command, [
        "-m",
        "pip",
        "install",
        "-r",
        path.join(rootPath, "python", "requirements-test-nine.txt"),
      ], {
        cwd: rootPath,
      })
      await emitProgress(onProgress, "test_nine：Python 依赖安装完成")
    } else if (installRequirements) {
      await emitProgress(onProgress, "test_nine：Python 依赖未变化")
    }

    const models = downloadModels
      ? await this.ensureModels(config, { onProgress })
      : await this.modelStatus(config)
    await emitProgress(onProgress, "test_nine：同步模型目录")
    const link = await linkModelDirectory({
      submoduleRoot,
      modelDir: resolveMaybeData(config.model_dir),
    })
    await addSubmoduleExclude(submoduleRoot, "/model/")

    if (installRequirements || downloadModels) {
      await this.writeFingerprint(venvPath, fingerprint.current)
    }

    return {
      ok: true,
      python,
      submoduleRoot,
      fingerprint: fingerprint.current,
      fingerprintStale: fingerprint.stale,
      fingerprintReasons: fingerprint.reasons,
      models,
      link,
    }
  }

  async ensureVenv(venvPath, options = {}) {
    const onProgress = options.onProgress || this.onProgress
    const pyvenv = path.join(venvPath, "pyvenv.cfg")
    try {
      await fs.access(pyvenv)
      return
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    const systemPython = this.pythonConfig?.system_python || "python"
    await emitProgress(onProgress, `test_nine：创建虚拟环境 ${venvPath}`)
    await runProcess(this.spawn, systemPython, ["-m", "venv", venvPath], {
      cwd: rootPath,
    })
    await emitProgress(onProgress, "test_nine：虚拟环境创建完成")
  }

  async ensureModels(config = null, options = {}) {
    const onProgress = options.onProgress || this.onProgress
    const normalized = normalizeTestNineConfig(config || await this.getConfig())
    const modelDir = resolveMaybeData(normalized.model_dir)
    await fs.mkdir(modelDir, { recursive: true })
    const items = []
    for (const file of normalized.model_files) {
      const target = path.join(modelDir, file)
      if (await exists(target)) {
        await emitProgress(onProgress, `test_nine：模型已存在 ${file}`)
        items.push({ file, ok: true, status: "exists", path: target })
        continue
      }
      await emitProgress(onProgress, `test_nine：下载模型 ${file}`)
      await this.downloadModel(normalized.model_repo, file, target)
      await emitProgress(onProgress, `test_nine：模型下载完成 ${file}`)
      items.push({ file, ok: true, status: "downloaded", path: target })
    }
    return {
      ok: items.every(item => item.ok),
      modelDir,
      repo: normalized.model_repo,
      items,
    }
  }

  async modelStatus(config = null) {
    const normalized = normalizeTestNineConfig(config || await this.getConfig())
    const modelDir = resolveMaybeData(normalized.model_dir)
    const items = []
    for (const file of normalized.model_files) {
      const target = path.join(modelDir, file)
      items.push({
        file,
        ok: await exists(target),
        status: await exists(target) ? "exists" : "missing",
        path: target,
      })
    }
    return {
      ok: items.every(item => item.ok),
      modelDir,
      repo: normalized.model_repo,
      items,
    }
  }

  async downloadModel(repo, file, target) {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    const url = `https://huggingface.co/${repo}/resolve/main/${encodeURIComponentPath(file)}`
    const response = await this.fetch(url, {
      headers: {
        "User-Agent": "Lotus-Plugin test_nine setup",
      },
    })
    if (!response.ok) throw new Error(`download test_nine model ${file} failed: HTTP ${response.status}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (response.body && typeof response.body.getReader === "function") {
      await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(target))
      return target
    }
    await fs.writeFile(target, Buffer.from(await response.arrayBuffer()))
    return target
  }

  async getFingerprintStatus(venvPath, config = null) {
    const current = await this.buildFingerprint(config)
    const file = path.join(venvPath, "lotus-test-nine-fingerprint.json")
    let saved = null
    try {
      saved = JSON.parse(await fs.readFile(file, "utf8"))
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    return diffTestNineFingerprint(saved, current)
  }

  async buildFingerprint(config = null) {
    const normalized = normalizeTestNineConfig(config || await this.getConfig())
    const requirements = path.join(rootPath, "python", "requirements-test-nine.txt")
    const raw = await fs.readFile(requirements, "utf8")
    return {
      requirements_sha256: createHash("sha256").update(raw).digest("hex"),
      test_nine_commit: await this.readTestNineCommit(normalized.submodule_path),
      model_repo: normalized.model_repo,
      model_files: normalized.model_files,
    }
  }

  async writeFingerprint(venvPath, fingerprint = null) {
    const current = fingerprint || await this.buildFingerprint()
    const data = {
      ...current,
      updated_at: new Date().toISOString(),
    }
    await fs.writeFile(path.join(venvPath, "lotus-test-nine-fingerprint.json"), JSON.stringify(data, null, 2), "utf8")
    return data
  }

  async readTestNineCommit(submodulePath = "test_nine") {
    try {
      const result = await runProcess(this.spawn, "git", [
        "-C",
        resolveMaybeRoot(submodulePath),
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

export function normalizeTestNineConfig(config = {}) {
  return {
    enable: config.enable !== false,
    auto_start: config.auto_start !== false,
    endpoint: config.endpoint || "http://127.0.0.1:9645/pass_uni",
    timeout_ms: Number(config.timeout_ms || 20000),
    submodule_path: config.submodule_path || "test_nine",
    venv_path: config.venv_path || "data/python/test_nine_venv",
    model_dir: config.model_dir || "data/test_nine/model",
    model_repo: config.model_repo || "luguoyixiazi/model_save",
    model_files: Array.isArray(config.model_files) && config.model_files.length
      ? config.model_files.map(String)
      : DEFAULT_MODEL_FILES,
    install_requirements: config.install_requirements !== false,
    download_models: config.download_models !== false,
  }
}

export function diffTestNineFingerprint(saved, current) {
  if (!saved) {
    return {
      current,
      saved: null,
      stale: true,
      reasons: ["missing"],
    }
  }
  const reasons = []
  if (saved.requirements_sha256 !== current.requirements_sha256) reasons.push("requirements")
  if ((saved.test_nine_commit || "") !== (current.test_nine_commit || "")) reasons.push("test_nine_commit")
  if ((saved.model_repo || "") !== (current.model_repo || "")) reasons.push("model_repo")
  if (JSON.stringify(saved.model_files || []) !== JSON.stringify(current.model_files || [])) reasons.push("model_files")
  return {
    current,
    saved,
    stale: reasons.length > 0,
    reasons,
  }
}

export async function linkModelDirectory({ submoduleRoot, modelDir } = {}) {
  const link = path.join(submoduleRoot, "model")
  await fs.mkdir(modelDir, { recursive: true })
  const stat = await fs.lstat(link).catch(error => {
    if (error?.code === "ENOENT") return null
    throw error
  })
  if (stat) {
    if (stat.isSymbolicLink()) {
      const real = await fs.realpath(link).catch(() => "")
      const target = await fs.realpath(modelDir).catch(() => modelDir)
      if (real === target) return { ok: true, status: "linked", link, target: modelDir }
      await fs.rm(link, { recursive: true, force: true })
    } else if (stat.isDirectory()) {
      return { ok: true, status: "existing_directory", link, target: link }
    } else {
      await fs.rm(link, { force: true })
    }
  }
  const type = process.platform === "win32" ? "junction" : "dir"
  await fs.symlink(modelDir, link, type)
  return { ok: true, status: "created", link, target: modelDir }
}

export async function addSubmoduleExclude(submoduleRoot, line) {
  const gitInfoDir = await resolveGitInfoDir(submoduleRoot)
  if (!gitInfoDir) return false
  const excludeFile = path.join(gitInfoDir, "exclude")
  await fs.mkdir(path.dirname(excludeFile), { recursive: true })
  let current = ""
  try {
    current = await fs.readFile(excludeFile, "utf8")
  } catch (error) {
    if (error?.code !== "ENOENT") return false
    current = ""
  }
  if (current.split(/\r?\n/).includes(line)) return false
  await fs.appendFile(excludeFile, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${line}\n`, "utf8")
  return true
}

async function resolveGitInfoDir(submoduleRoot) {
  const dotGit = path.join(submoduleRoot, ".git")
  const stat = await fs.lstat(dotGit).catch(error => {
    if (error?.code === "ENOENT") return null
    throw error
  })
  if (!stat) return ""
  if (stat.isDirectory()) return path.join(dotGit, "info")
  if (stat.isFile()) {
    const text = await fs.readFile(dotGit, "utf8").catch(() => "")
    const match = text.match(/^gitdir:\s*(.+)$/im)
    if (!match) return ""
    const gitDir = path.isAbsolute(match[1].trim())
      ? match[1].trim()
      : path.resolve(submoduleRoot, match[1].trim())
    return path.join(gitDir, "info")
  }
  return ""
}

function resolveMaybeData(value = "") {
  const text = String(value || "")
  if (path.isAbsolute(text)) return text
  if (text.startsWith("data/") || text.startsWith("data\\")) return resolveData(text.slice(5))
  return path.resolve(rootPath, text)
}

function resolveMaybeRoot(value = "") {
  const text = String(value || "")
  if (path.isAbsolute(text)) return text
  return path.resolve(rootPath, text)
}

function encodeURIComponentPath(value = "") {
  return String(value).split("/").map(encodeURIComponent).join("/")
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
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
