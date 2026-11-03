import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { createWriteStream, createReadStream } from "node:fs"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { loadGlobalConfig } from "../../core/config/global.js"
import { rootPath } from "../../core/path.js"

const DEFAULT_MODELS = ["PP-HGNetV2-B4.onnx", "d-fine-n.onnx", "yolo11n.onnx", "dinov3-small.onnx", "atten.onnx"]
const modelDownloads = new Map()
export function normalizeTestNineConfig(config = {}) {
  return { enable: config.enable !== false, endpoint: config.endpoint || "http://127.0.0.1:9645/pass_uni", timeout_ms: Number(config.timeout_ms || 60000), model_dir: config.model_dir || "data/test_nine/model", model_repo: config.model_repo || "luguoyixiazi/model_save", model_files: Array.isArray(config.model_files) && config.model_files.length ? config.model_files.map(String) : DEFAULT_MODELS }
}
export class TestNineEnvService {
  constructor(options = {}) { this.config = options.config; this.fetch = options.fetch || globalThis.fetch; this.onProgress = options.onProgress }
  async getConfig() { return normalizeTestNineConfig(this.config || (await loadGlobalConfig()).captcha?.test_nine) }
  async ensureEnv(options = {}) {
    const config = await this.getConfig()
    const models = (options.downloadModels !== false) ? await this.ensureModels(config, options) : await this.modelStatus(config)
    await import("onnxruntime-node")
    return { ok: models.ok, models, runtime: "onnxruntime-node", reason: models.ok ? "" : "验证码模型不完整" }
  }
  async modelStatus(config = null) {
    const cfg = normalizeTestNineConfig(config || await this.getConfig()), modelDir = path.resolve(rootPath, cfg.model_dir)
    const items = await Promise.all(cfg.model_files.map(async file => {
      if (path.basename(file) !== file || !file.endsWith(".onnx")) throw new Error("无效的模型文件名")
      const target = path.join(modelDir, file), stat = await fs.stat(target).catch(e => { if (e.code !== "ENOENT") throw e; return null })
      return { file, path: target, ok: Boolean(stat?.isFile() && stat.size > 0), status: stat?.size ? "exists" : "missing" }
    }))
    return { ok: items.every(i => i.ok), modelDir, repo: cfg.model_repo, items }
  }
  async ensureModels(config = null, options = {}) {
    const cfg = normalizeTestNineConfig(config || await this.getConfig())
    const key = JSON.stringify([path.resolve(rootPath, cfg.model_dir), cfg.model_repo, cfg.model_files])
    if (modelDownloads.has(key)) return modelDownloads.get(key)
    const pending = this.downloadModels(cfg, options)
    modelDownloads.set(key, pending)
    try { return await pending } finally { if (modelDownloads.get(key) === pending) modelDownloads.delete(key) }
  }
  async downloadModels(cfg, options) {
    const status = await this.modelStatus(cfg)
    if (status.ok && !options.checkUpdates) return status
    const response = await this.fetch(`https://huggingface.co/api/models/${cfg.model_repo}?blobs=true`, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`获取模型校验信息失败：HTTP ${response.status}`)
    const metadata = await response.json()
    if (!/^[a-f0-9]{40}$/.test(metadata.sha || "")) throw new Error("模型仓库版本无效")
    const missing = []
    for (const item of status.items) {
      const expected = metadata.siblings?.find(i => i.rfilename === item.file)?.lfs
      if (!/^[a-f0-9]{64}$/.test(expected?.sha256 || "") || !Number.isSafeInteger(expected.size) || expected.size <= 0) throw new Error(`模型 ${item.file} 缺少有效校验信息`)
      let intact = false
      if (item.ok) {
        const hash = createHash("sha256")
        for await (const chunk of createReadStream(item.path)) hash.update(chunk)
        intact = hash.digest("hex") === expected.sha256
      }
      if (!intact) missing.push({ ...item, expected })
    }
    if (!missing.length) return { ...status, revision: metadata.sha, changed: false }
    await fs.mkdir(status.modelDir, { recursive: true })
    for (const item of missing) {
      await (options.onProgress || this.onProgress)?.(`下载验证码模型 ${item.file}`)
      const { expected } = item
      const result = await this.fetch(`https://huggingface.co/${cfg.model_repo}/resolve/${metadata.sha}/${encodeURIComponent(item.file)}`, { signal: AbortSignal.timeout(600000) })
      if (!result.ok || !result.body) throw new Error(`模型下载失败：HTTP ${result.status}`)
      const temp = `${item.path}.${randomUUID()}.part`, hash = createHash("sha256"); let size = 0
      try {
        await pipeline(Readable.fromWeb(result.body), new Transform({ transform(chunk, encoding, callback) { size += chunk.length; hash.update(chunk); callback(size > expected.size ? new Error("模型超出预期体积") : null, chunk) } }), createWriteStream(temp, { flags: "wx" }))
        if (size !== expected.size || hash.digest("hex") !== expected.sha256) throw new Error(`模型 ${item.file} 校验失败`)
        await fs.rename(temp, item.path)
      } finally { await fs.rm(temp, { force: true }) }
    }
    return { ...await this.modelStatus(cfg), revision: metadata.sha, changed: true }
  }
}
