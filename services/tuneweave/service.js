import fs from "node:fs/promises"
import { createWriteStream } from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import YAML from "yaml"
import { resolveData } from "../../core/path.js"

export const TUNEWEAVE_MANIFEST_URL = "https://raw.githubusercontent.com/MOPELotus/TuneWeave/main/release-manifest.json"
let initializing = null
const runFile = promisify(execFile)

export class TuneWeaveService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.spawn = options.spawn || spawn
    this.root = options.root || resolveData("tuneweave")
    this.config = { api_url: "http://127.0.0.1:7832", request_timeout_ms: 30000, ...options.config }
    this.legacyAccountsFile = options.legacyAccountsFile || resolveData("netease", "accounts.yaml")
    this.platform = options.platform || process.platform
    this.arch = options.arch || process.arch
  }

  async request(route, { method = "GET", body } = {}) {
    const response = await this.fetch(`${this.config.api_url.replace(/\/+$/, "")}${route}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.config.request_timeout_ms),
    }).catch(() => { throw new Error("TuneWeave 无法连接，请先发送 #初始化TuneWeave 或检查服务状态。") })
    let json
    try { json = await response.json() } catch { throw new Error("TuneWeave 返回了无效响应。") }
    if (!response.ok || json?.ok !== true) {
      const code = json?.error?.code || `HTTP ${response.status}`
      // Never expose upstream payloads, login cookies or credentials in chat/logs.
      const reason = json?.error?.details?.upstream_code === 405 ? "网易云今日没有更多可评定歌曲（405）" : code
      throw new Error(`TuneWeave 请求失败：${reason}`)
    }
    return json.data
  }

  async status() {
    try {
      const health = await this.request("/healthz")
      const capabilities = await this.request("/v1/capabilities?platform=netease")
      const platform = Array.isArray(capabilities) ? capabilities.find(item => item.platform === "netease" && item.registered) : null
      const ready = ["platform_api", "qr_login", "account_profile", "caller_managed_credentials"].every(capability => platform?.capabilities?.includes(capability))
      return { ok: ready, reachable: true, version: health.version || "未知", apiUrl: this.config.api_url, capabilities, message: ready ? "网易云登录与扩展 API 可用" : "当前版本缺少所需能力，请升级 TuneWeave。" }
    } catch (error) {
      return { ok: false, reachable: false, apiUrl: this.config.api_url, message: error.message }
    }
  }

  async requireReady() {
    const status = await this.status()
    if (!status.ok) throw new Error(status.message)
    return status
  }

  async publicDownload(url, timeoutMs = 60000) {
    try { return await this.fetch(url, { signal: AbortSignal.timeout(timeoutMs) }) } catch {
      // Public release files only. curl honors deployment proxy settings on
      // Node versions where fetch does not; account requests never use this.
      const { stdout } = await runFile("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "3", "--retry-all-errors", "--connect-timeout", "15", "--max-time", String(Math.ceil(timeoutMs / 1000)), url], {
        encoding: "buffer", maxBuffer: 128 * 1024 * 1024, windowsHide: true,
      }).catch(() => { throw new Error("TuneWeave 官方发布文件下载失败，请检查网络/代理；网络受限时需要可用的 curl。") })
      return new Response(stdout)
    }
  }

  async initialize({ onProgress } = {}) {
    if (initializing) return initializing
    initializing = this.installAndStart(onProgress)
    try { return await initializing } finally { initializing = null }
  }

  async installAndStart(onProgress = async () => {}) {
    const status = await this.status()
    if (status.ok) return { ...status, already: true }
    if (status.reachable) throw new Error(status.message)
    const url = new URL(this.config.api_url)
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("远程 TuneWeave 请先自行部署；自动初始化只支持本机 HTTP 地址。")
    }
    const executable = path.join(this.root, "bin", this.platform === "win32" ? "tuneweave.exe" : "tuneweave")
    try { await fs.access(executable) } catch {
      await onProgress("正在下载 TuneWeave 官方发布文件并校验 SHA-256。")
      const manifestResponse = await this.publicDownload(TUNEWEAVE_MANIFEST_URL)
      if (!manifestResponse.ok) throw new Error(`TuneWeave 版本清单下载失败：HTTP ${manifestResponse.status}`)
      const artifact = selectTuneWeaveArtifact(await manifestResponse.json(), this.platform, this.arch)
      await fs.mkdir(path.dirname(executable), { recursive: true })
      const temporary = `${executable}.download`
      try {
        const [download, checksumResponse] = await Promise.all([
          this.publicDownload(artifact.download_url, 180000),
          this.publicDownload(artifact.verification.checksum_url),
        ])
        if (!download.ok || !checksumResponse.ok) throw new Error("TuneWeave 下载失败。")
        const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0].toLowerCase()
        if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("TuneWeave 校验文件无效。")
        const hash = crypto.createHash("sha256")
        const stream = Readable.fromWeb(download.body)
        stream.on("data", chunk => hash.update(chunk))
        await pipeline(stream, createWriteStream(temporary, { mode: 0o700 }))
        if (hash.digest("hex") !== checksum) throw new Error("TuneWeave SHA-256 校验不匹配。")
        await fs.chmod(temporary, 0o700)
        await fs.rename(temporary, executable)
      } finally { await fs.rm(temporary, { force: true }) }
    }
    await onProgress("正在启动本机 TuneWeave 服务。")
    await fs.mkdir(path.join(this.root, "accounts"), { recursive: true, mode: 0o700 })
    const bootstrapCookie = await this.bootstrapCookie()
    const log = await fs.open(path.join(this.root, "server.log"), "a", 0o600)
    let child
    try {
      child = this.spawn(executable, [], {
        cwd: this.root,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, ...(bootstrapCookie ? { TUNEWEAVE_NETEASE_COOKIE: bootstrapCookie } : {}), TUNEWEAVE_BIND: `${url.hostname === "localhost" ? "127.0.0.1" : url.hostname}:${url.port || "80"}`, TUNEWEAVE_DATA_DIR: path.join(this.root, "accounts"), TUNEWEAVE_LOG_DIR: path.join(this.root, "logs") },
      })
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
      child.unref()
    } finally { await log.close() }
    await fs.writeFile(path.join(this.root, "process.json"), JSON.stringify({ pid: child.pid, api_url: this.config.api_url }), { mode: 0o600 })
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      const ready = await this.status()
      if (ready.ok) return { ...ready, pid: child.pid }
      if (ready.reachable) throw new Error(ready.message)
      if (child.exitCode !== null) break
    }
    throw new Error("TuneWeave 启动未通过健康检查，请查看 data/tuneweave/server.log。")
  }

  async bootstrapCookie() {
    const file = path.join(this.root, "bootstrap.json")
    try { return JSON.parse(await fs.readFile(file, "utf8")).cookie || "" } catch (error) { if (error.code !== "ENOENT") throw error }
    let accounts
    try { accounts = YAML.parse(await fs.readFile(this.legacyAccountsFile, "utf8"))?.accounts || [] } catch (error) { if (error.code === "ENOENT") return ""; throw error }
    const legacy = accounts.find(account => account.cookie && !account.tuneweave_account)
    if (!legacy) return ""
    // TuneWeave's documented startup Cookie config bootstraps its default
    // account. Other legacy accounts must log in using their own QR alias.
    await fs.writeFile(file, JSON.stringify({ cookie: legacy.cookie }), { mode: 0o600 })
    return legacy.cookie
  }

  async resume() {
    // Startup resumes an explicitly initialized service; it never downloads it.
    try { await fs.access(path.join(this.root, "process.json")) } catch { return { skipped: true } }
    return this.initialize()
  }
}

export function selectTuneWeaveArtifact(manifest, platform, arch) {
  const system = { linux: "linux", win32: "windows", darwin: "macos" }[platform]
  const architecture = { x64: "x86_64", arm64: "aarch64" }[arch]
  const artifact = manifest?.artifacts?.find(item => item.platform === system && item.architecture === architecture)
  if (!artifact || artifact.verification?.algorithm !== "sha256") throw new Error(`TuneWeave 暂无 ${platform}/${arch} 的预编译文件，请自行部署。`)
  for (const value of [artifact.download_url, artifact.verification.checksum_url]) {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/MOPELotus/TuneWeave/releases/download/")) throw new Error("TuneWeave 下载地址不属于官方发布仓库。")
  }
  return artifact
}
