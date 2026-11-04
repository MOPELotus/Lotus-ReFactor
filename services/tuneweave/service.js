import fs from "node:fs/promises"
import { createWriteStream, createReadStream } from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import http from "node:http"
import https from "node:https"
import YAML from "yaml"
import { setTimeout as sleep } from "node:timers/promises"
import { TUNEWEAVE_REQUIRED_VERSION, compareTuneWeaveVersions } from "./version.js"
import { resolveData } from "../../core/path.js"

export const TUNEWEAVE_MANIFEST_URL = "https://raw.githubusercontent.com/MOPELotus/TuneWeave/main/release-manifest.json"
const operations = new Map()
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

  async request(route, { method = "GET", body, credentials = [], onCredentialUpdates } = {}) {
    const target = `${this.config.api_url.replace(/\/+$/, "")}${route}`
    const options = {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.config.request_timeout_ms),
    }
    const response = await (credentials.length ? requestCredentialJson(target, { ...options, credentials }) : this.fetch(target, options))
      .catch(() => { throw new Error("TuneWeave 无法连接，请先发送 #初始化环境 或检查服务状态。") })
    const updates = String(response.headers?.get("X-TuneWeave-Updated-Credential") || "").split(",").map(value => value.trim()).filter(Boolean).map(value => {
      const split = value.indexOf("="); return { platform: value.slice(0, split), credential: value.slice(split + 1) }
    }).filter(item => /^[a-z]+$/.test(item.platform) && item.credential.startsWith("twc1_"))
    if (updates.length) await onCredentialUpdates?.(updates)
    let json
    try { json = await response.json() } catch { throw new Error("TuneWeave 返回了无效响应。") }
    if (!response.ok || json?.ok !== true) {
      const code = json?.error?.code || `HTTP ${response.status}`
      // Never expose upstream payloads, login cookies or credentials in chat/logs.
      const reason = json?.error?.details?.upstream_code === 405 ? "网易云今日没有更多可评定歌曲（405）" : code
      const error = new Error(`TuneWeave 请求失败：${reason}`)
      error.code = code; error.platform = json?.error?.platform
      throw error
    }
    return json.data
  }

  async status() {
    try {
      const health = await this.request("/healthz")
      const capabilities = await this.request("/v1/capabilities?platform=netease")
      const platform = Array.isArray(capabilities) ? capabilities.find(item => item.platform === "netease" && item.registered) : null
      const ready = ["platform_api", "qr_login", "account_profile", "caller_managed_credentials"].every(capability => platform?.capabilities?.includes(capability))
      const requiresUpdate = compareTuneWeaveVersions(health.version, TUNEWEAVE_REQUIRED_VERSION) < 0
      return { ok: ready, reachable: true, version: health.version, requiredVersion: TUNEWEAVE_REQUIRED_VERSION, requiresUpdate, apiUrl: this.config.api_url, capabilities,
        message: requiresUpdate ? `低于插件最低要求 ${TUNEWEAVE_REQUIRED_VERSION}，等待开机延迟更新或发送 #初始化环境。` : ready ? "网易云登录与扩展 API 可用" : "当前版本缺少所需能力，请升级 TuneWeave。" }
    } catch (error) {
      return { ok: false, reachable: false, apiUrl: this.config.api_url, message: error.message }
    }
  }

  async requireReady() {
    const status = await this.status()
    if (!status.ok) throw new Error(status.message)
    if (compareTuneWeaveVersions(status.version, TUNEWEAVE_REQUIRED_VERSION) < 0) throw new Error(`TuneWeave ${status.version} 低于要求 ${TUNEWEAVE_REQUIRED_VERSION}，请等待开机延迟更新或发送 #初始化环境`)
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

  get executable() { return path.join(this.root, "bin", this.platform === "win32" ? "tuneweave.exe" : "tuneweave") }

  async lifecycle(work) {
    const key = path.resolve(this.root), previous = operations.get(key) || Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    operations.set(key, current)
    try { return await current } finally { if (operations.get(key) === current) operations.delete(key) }
  }

  localUrl() {
    const url = new URL(this.config.api_url)
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("远程 TuneWeave 请自行升级；自动安装与重启只支持本机、由本插件管理的实例。")
    }
    return url
  }

  async initialize({ onProgress = async () => {} } = {}) {
    return this.lifecycle(async () => {
      const status = await this.status()
      try { this.localUrl() } catch {
        if (!status.ok || status.requiresUpdate) throw new Error(status.message)
        return { ...status, already: true }
      }
      try {
        const manifest = await this.releaseManifest()
        if (status.reachable) {
          const comparison = compareTuneWeaveVersions(status.version, manifest.version)
          const intact = comparison > 0 || comparison === 0 && await this.verifyInstalled(manifest)
          if (comparison < 0 || !intact) return await this.updateInstalled({ notify: onProgress, status, manifest, repair: !intact && comparison === 0 })
          if (!status.ok) throw new Error(status.message)
          return { ...status, already: true }
        }
        this.localUrl()
        let release
        if (!await this.verifyInstalled(manifest)) {
          await onProgress("正在下载 TuneWeave 官方发布文件并校验 SHA-256。")
          release = await this.downloadRelease(manifest)
          let backup = null
          const previous = `${this.executable}.previous-${crypto.randomUUID()}`
          try {
            try { await fs.rename(this.executable, previous); backup = previous } catch (error) { if (error.code !== "ENOENT") throw error }
            await fs.rename(release.file, this.executable)
            const ready = await this.startInstalled(release.version)
            if (backup) await fs.rm(backup, { force: true })
            return { ...ready, installed: true }
          } catch (error) {
            if (backup) {
              await fs.rename(backup, this.executable)
              try { await this.startInstalled() } catch {}
            }
            throw error
          } finally { await fs.rm(release.file, { force: true }) }
        }
        await onProgress("正在启动本机 TuneWeave 服务。")
        const ready = await this.startInstalled(release?.version)
        if (compareTuneWeaveVersions(ready.version, manifest.version) < 0) return await this.updateInstalled({ notify: onProgress, status: ready, manifest })
        return { ...ready, installed: Boolean(release) }
      } catch (error) {
        // Update/verification availability is separate from service readiness.
        // Never accept an unhealthy service or one below the required version.
        const current = await this.status()
        if (!current.ok || compareTuneWeaveVersions(current.version, TUNEWEAVE_REQUIRED_VERSION) < 0) throw error
        return { ...current, already: true, updateDeferred: true, message: "现有 TuneWeave 服务可用，联网更新或校验暂未完成，稍后重试。" }
      }
    })
  }

  async releaseManifest() {
    const response = await this.publicDownload(TUNEWEAVE_MANIFEST_URL)
    if (!response.ok) throw new Error(`TuneWeave 版本清单下载失败：HTTP ${response.status}`)
    const manifest = await response.json()
    if (compareTuneWeaveVersions(manifest.version, TUNEWEAVE_REQUIRED_VERSION) < 0) throw new Error(`发布包 ${manifest.version} 低于要求 ${TUNEWEAVE_REQUIRED_VERSION}`)
    return manifest
  }

  async releaseChecksum(manifest) {
    const artifact = selectTuneWeaveArtifact(manifest, this.platform, this.arch)
    const response = await this.publicDownload(artifact.verification.checksum_url)
    if (!response.ok) throw new Error("TuneWeave 校验文件下载失败")
    const checksum = (await response.text()).trim().split(/\s+/)[0].toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("TuneWeave 校验文件无效")
    return checksum
  }

  async verifyInstalled(manifest) {
    try { await fs.access(this.executable) } catch (error) { if (error.code === "ENOENT") return false; throw error }
    const expected = await this.releaseChecksum(manifest), hash = crypto.createHash("sha256")
    for await (const chunk of createReadStream(this.executable)) hash.update(chunk)
    return hash.digest("hex") === expected
  }

  async downloadRelease(manifest) {
    manifest ||= await this.releaseManifest()
    const artifact = selectTuneWeaveArtifact(manifest, this.platform, this.arch)
    const releasePath = `/MOPELotus/TuneWeave/releases/download/v${String(manifest.version).replace(/^v/, "")}/`
    if (![artifact.download_url, artifact.verification.checksum_url].every(value => new URL(value).pathname.startsWith(releasePath))) throw new Error("TuneWeave 发布清单版本与下载地址不一致")
    await fs.mkdir(path.dirname(this.executable), { recursive: true })
    const file = `${this.executable}.download-${crypto.randomUUID()}`
    try {
      const [download, checksumResponse] = await Promise.all([
        this.publicDownload(artifact.download_url, 180000),
        this.publicDownload(artifact.verification.checksum_url),
      ])
      if (!download.ok || !checksumResponse.ok || !download.body) throw new Error("TuneWeave 下载失败")
      const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0].toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("TuneWeave 校验文件无效")
      const hash = crypto.createHash("sha256"), stream = Readable.fromWeb(download.body)
      stream.on("data", chunk => hash.update(chunk))
      await pipeline(stream, createWriteStream(file, { mode: 0o700, flags: "wx" }))
      if (hash.digest("hex") !== checksum) throw new Error("TuneWeave SHA-256 校验不匹配")
      await fs.chmod(file, 0o700)
      return { file, version: manifest.version }
    } catch (error) { await fs.rm(file, { force: true }); throw error }
  }

  async startInstalled(expectedVersion) {
    const url = this.localUrl()
    let recorded = false
    try { await fs.access(path.join(this.root, "process.json")); recorded = true } catch (error) { if (error.code !== "ENOENT") throw error }
    if (recorded && (await this.managedProcess()).alive) throw new Error("TuneWeave 托管进程仍在运行，保留当前进程记录，请先确认健康状态")
    await fs.mkdir(path.join(this.root, "accounts"), { recursive: true, mode: 0o700 })
    const bootstrapCookie = await this.bootstrapCookie()
    const log = await fs.open(path.join(this.root, "server.log"), "a", 0o600)
    let child
    try {
      child = this.spawn(this.executable, [], {
        cwd: this.root, detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, ...(bootstrapCookie ? { TUNEWEAVE_NETEASE_COOKIE: bootstrapCookie } : {}), TUNEWEAVE_BIND: `${url.hostname === "localhost" ? "127.0.0.1" : url.hostname}:${url.port || "80"}`, TUNEWEAVE_DATA_DIR: path.join(this.root, "accounts"), TUNEWEAVE_LOG_DIR: path.join(this.root, "logs") },
      })
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
      child.unref()
    } finally { await log.close() }
    await fs.writeFile(path.join(this.root, "process.json"), JSON.stringify({ pid: child.pid, api_url: this.config.api_url, identity: await processIdentity(child.pid, this.platform).catch(() => null) }), { mode: 0o600 })
    try {
      for (let i = 0; i < 30; i++) {
        await sleep(1000)
        if (child.exitCode !== null || child.signalCode !== null) break
        const ready = await this.status()
        if (ready.ok) {
          if (expectedVersion && compareTuneWeaveVersions(ready.version, expectedVersion) !== 0) throw new Error("TuneWeave 启动后的版本与校验发布包不符")
          await sleep(100)
          if (child.exitCode !== null || child.signalCode !== null || !await processAlive(child.pid)) throw new Error("TuneWeave 子进程已退出")
          return { ...ready, pid: child.pid }
        }
        if (ready.reachable) throw new Error(ready.message)
      }
      throw new Error("TuneWeave 启动未通过健康检查，请查看 data/tuneweave/server.log。")
    } catch (error) {
      // Only terminate the child created by this start attempt.
      if (await processAlive(child.pid)) await this.stopManaged(child.pid)
      throw error
    }
  }

  async managedProcess() {
    this.localUrl()
    let state
    try { state = JSON.parse(await fs.readFile(path.join(this.root, "process.json"), "utf8")) } catch { throw new Error("没有本插件的 TuneWeave 进程记录，请由部署方升级服务") }
    if (!Number.isInteger(state.pid) || state.pid <= 0 || new URL(state.api_url).href !== new URL(this.config.api_url).href) throw new Error("TuneWeave 进程记录与当前实例不一致")
    if (!await processAlive(state.pid)) return { ...state, alive: false }
    const actual = await processIdentity(state.pid, this.platform), executable = await fs.realpath(this.executable).catch(error => {
      if (error.code === "ENOENT" && state.identity?.executable === path.resolve(this.executable)) return state.identity.executable
      throw error
    })
    const samePath = this.platform === "win32" ? actual.executable.toLowerCase() === executable.toLowerCase() : actual.executable === executable
    if (!samePath || state.identity && (state.identity.executable !== actual.executable || state.identity.started !== actual.started)) throw new Error("TuneWeave 进程身份不匹配，保留当前服务，请由部署方检查")
    return { ...state, identity: actual, alive: true }
  }

  async stopManaged(expectedPid) {
    const state = await this.managedProcess()
    if (expectedPid && state.pid !== expectedPid) throw new Error("TuneWeave 进程已变化，取消重启")
    if (state.alive) {
      process.kill(state.pid, "SIGTERM")
      for (let i = 0; i < 100 && await processAlive(state.pid); i++) await sleep(100)
      if (await processAlive(state.pid)) {
        // Recheck identity before terminating a process that did not shut down.
        await this.managedProcess()
        process.kill(state.pid, "SIGKILL")
        for (let i = 0; i < 50 && await processAlive(state.pid); i++) await sleep(100)
      }
      if (await processAlive(state.pid)) throw new Error("TuneWeave 旧进程未停止，取消替换程序")
    }
    await fs.rm(path.join(this.root, "process.json"), { force: true })
  }

  async updateIfRequired({ notify = async () => {} } = {}) {
    return this.lifecycle(() => this.updateInstalled({ notify }))
  }

  async updateInstalled({ notify, status, manifest, repair = false } = {}) {
    status ||= await this.status()
    if (!status.reachable) return { ...status, skipped: true, reason: "not_running" }
    const targetVersion = manifest?.version || TUNEWEAVE_REQUIRED_VERSION
    if (!repair && compareTuneWeaveVersions(status.version, targetVersion) >= 0) return { ...status, skipped: true, reason: "up_to_date" }
    const state = await this.managedProcess()
    if (!state.alive) throw new Error("TuneWeave 托管进程未运行，取消自动替换")
    const send = async message => { try { await notify?.(message) } catch (error) { globalThis.logger?.warn?.(`[Lotus-Plugin] TuneWeave 更新通知失败：${error.message}`) } }
    await send(`TuneWeave 当前 ${status.version}，正在${repair ? "修复" : "更新至"} ${targetVersion}；下载校验后自动重启服务。`)
    let release, backup, replaced = false, stopped = false
    try {
      release = await this.downloadRelease(manifest)
      if ((await this.managedProcess()).pid !== state.pid) throw new Error("下载期间 TuneWeave 进程已变化，取消更新")
      try { await this.stopManaged(state.pid); stopped = true }
      catch (error) { stopped = !await processAlive(state.pid); throw error }
      backup = `${this.executable}.previous-${crypto.randomUUID()}`
      try { await fs.rename(this.executable, backup) } catch (error) { if (error.code === "ENOENT") backup = null; else throw error }
      try { await fs.rename(release.file, this.executable); replaced = true }
      catch (error) { if (backup) await fs.rename(backup, this.executable); backup = null; throw error }
      const ready = await this.startInstalled(release.version)
      if (backup) await fs.rm(backup, { force: true }); backup = null
      await send(`TuneWeave 已从 ${status.version} 更新至 ${ready.version}，服务已自动重启并通过健康与能力检查。`)
      return { ...ready, updated: true, previousVersion: status.version }
    } catch (error) {
      let recovery = "旧服务保持运行"
      if (stopped) {
        try {
          if (replaced && backup) {
            // A failed start normally already stopped its child.
            try { const current = await this.managedProcess(); if (current.alive) await this.stopManaged(current.pid) } catch (checkError) {
              if (!/没有本插件/.test(checkError.message)) throw checkError
            }
            await fs.rm(this.executable, { force: true })
            await fs.rename(backup, this.executable); backup = null
          }
          await this.startInstalled(status.version)
          recovery = `已恢复 ${status.version} 并重新启动`
        } catch (rollbackError) { recovery = `恢复旧服务失败：${rollbackError.message}` }
      }
      await send(`TuneWeave 更新失败：${error.message}；${recovery}。`)
      const failure = new Error(`TuneWeave 更新失败：${error.message}；${recovery}`)
      failure.notified = true
      throw failure
    } finally {
      if (release) await fs.rm(release.file, { force: true })
    }
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
    // Resume existing installations without downloading or updating at boot.
    // Updates are scheduled separately after the configured startup delay.
    try { await fs.access(path.join(this.root, "process.json")); await fs.access(this.executable) } catch { return { skipped: true } }
    return this.lifecycle(async () => {
      const status = await this.status()
      if (status.reachable) return status
      return this.startInstalled()
    })
  }

}

// Node's fetch combines repeated header values. TuneWeave accepts one opaque
// credential per header, so use native HTTP for authenticated multi-source calls.
function requestCredentialJson(target, { method, headers, body, signal, credentials }) {
  if (credentials.length > 8 || credentials.some(value => typeof value !== "string" || !value.startsWith("twc1_") || value.length > 65536 || /[\r\n]/.test(value))) throw new Error("TuneWeave 凭据格式无效")
  const url = new URL(target), transport = url.protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method, headers: { ...headers, "X-TuneWeave-Credential": credentials }, signal }, response => {
      const chunks = []; let bytes = 0
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) response.destroy(new Error("TuneWeave 响应过大")); else chunks.push(chunk) })
      response.on("error", reject); response.on("aborted", () => reject(new Error("TuneWeave 响应中断")))
      response.on("end", () => { const resultHeaders = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) resultHeaders.set(key, Array.isArray(value) ? value.join(",") : value)
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, headers: resultHeaders, json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }) })
    })
    request.on("error", reject); request.end(body)
  })
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

async function processAlive(pid) {
  try {
    process.kill(pid, 0)
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false
    }
    return true
  } catch (error) { if (["ESRCH", "ENOENT"].includes(error.code)) return false; throw error }
}

async function processIdentity(pid, platform) {
  if (platform === "linux") {
    const [file, stat] = await Promise.all([fs.readlink(`/proc/${pid}/exe`), fs.readFile(`/proc/${pid}/stat`, "utf8")])
    return { executable: file.replace(/ \(deleted\)$/, ""), started: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] }
  }
  if (platform === "win32") {
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-Process -Id ${pid} -ErrorAction Stop; Write-Output $p.Path; Write-Output $p.StartTime.ToUniversalTime().Ticks`], { timeout: 15000, windowsHide: true })
    const [executable, started] = stdout.trim().split(/\r?\n/)
    return { executable: await fs.realpath(executable), started }
  }
  if (platform === "darwin") {
    const [file, birth] = await Promise.all([runFile("ps", ["-p", String(pid), "-o", "comm="], { timeout: 15000 }), runFile("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 15000 })])
    return { executable: await fs.realpath(file.stdout.trim()), started: birth.stdout.trim() }
  }
  throw new Error("当前系统无法核验 TuneWeave 托管进程身份，请手动升级")
}
