import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { TextDecoder } from "node:util"
import { loadGlobalConfig } from "../../core/config/global.js"
import { PermissionService } from "../../core/permissions/service.js"
import { verifyTotp } from "../../core/security/totp.js"
import { resolveData } from "../../core/path.js"
import { formatLocalIso } from "../../core/time.js"
import { loadRemoteOtpSecret } from "./otp.js"

const SHELL_ARGS = Object.freeze({
  pwsh: command => ["-NoProfile", "-NonInteractive", "-Command", powershellUtf8Command(command)],
  powershell: command => ["-NoProfile", "-NonInteractive", "-Command", powershellUtf8Command(command)],
  cmd: command => ["/d", "/q", "/c", `chcp 65001>nul & ${command}`],
})

export class RemoteSpawnService {
  constructor(options = {}) {
    this.spawn = options.spawn || spawn
    this.config = options.config
    this.isElevated = options.isElevated || (() => isProcessElevated(this.spawn))
  }

  async authorize({ e, otp, scope = "remote.spawn" } = {}) {
    const globalConfig = this.config || await loadGlobalConfig()
    const remote = globalConfig.remote || {}
    if (!remote.enable) return { ok: false, reason: "remote_disabled" }

    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(e, scope)
    if (!permission.ok) return permission

    if (remote.require_otp !== false) {
      const loaded = await loadRemoteOtpSecret(remote)
      if (!loaded.ok) return { ok: false, reason: "otp_secret_missing" }
      if (!verifyTotp(otp, loaded.secret)) return { ok: false, reason: "otp_invalid" }
    }

    return { ok: true, reason: "authorized" }
  }

  async spawnCommand({ e, otp, shell, command, admin = false } = {}) {
    const globalConfig = this.config || await loadGlobalConfig()
    const remote = globalConfig.remote || {}
    const auth = await this.authorize({ e, otp })
    if (!auth.ok) {
      await appendRemoteAudit({
        userId: String(e?.user_id || ""),
        groupId: String(e?.group_id || ""),
        action: "spawn",
        shell: String(shell || "").toLowerCase(),
        admin: Boolean(admin),
        command: redactSensitive(command),
        ok: false,
        reason: auth.reason,
      })
      return { ok: false, stage: "auth", reason: auth.reason }
    }

    const normalizedShell = String(shell || "").toLowerCase()
    if (!remote.shells?.includes(normalizedShell) || !SHELL_ARGS[normalizedShell]) {
      return { ok: false, stage: "validate", reason: "shell_not_allowed" }
    }

    if (admin) {
      if (remote.allow_admin !== true) {
        await appendRemoteAudit({
          userId: String(e?.user_id || ""),
          groupId: String(e?.group_id || ""),
          action: "spawn",
          shell: normalizedShell,
          admin: true,
          command: redactSensitive(command),
          ok: false,
          reason: "admin_disabled",
        })
        return { ok: false, stage: "validate", reason: "admin_disabled" }
      }
      if (!await this.isElevated()) {
        await appendRemoteAudit({
          userId: String(e?.user_id || ""),
          groupId: String(e?.group_id || ""),
          action: "spawn",
          shell: normalizedShell,
          admin: true,
          command: redactSensitive(command),
          ok: false,
          reason: "process_not_elevated",
        })
        return { ok: false, stage: "validate", reason: "process_not_elevated" }
      }
    }

    const result = await runShellSpawn(this.spawn, normalizedShell, command, {
      timeoutMs: remote.timeout_ms,
      outputLimit: remote.output_limit,
    })
    await appendRemoteAudit({
      userId: String(e?.user_id || ""),
      groupId: String(e?.group_id || ""),
      action: "spawn",
      shell: normalizedShell,
      admin: Boolean(admin),
      command: redactSensitive(command),
      ok: result.ok,
      code: result.code,
    })
    return result
  }
}

export async function isProcessElevated(spawnImpl = spawn) {
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function") return process.getuid() === 0
    return false
  }

  const command = "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
  const result = await runShellSpawn(spawnImpl, "powershell", command, {
    timeoutMs: 5000,
    outputLimit: 100,
  })
  return result.ok && /true/i.test(result.stdout)
}

export function runShellSpawn(spawnImpl, shell, command, options = {}) {
  return new Promise(resolve => {
    const args = SHELL_ARGS[shell](command)
    const child = spawnImpl(shell, args, {
      cwd: process.cwd(),
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32" && shell === "cmd",
    })
    const limit = Number(options.outputLimit || 12000)
    const byteLimit = Math.max(limit * 4, 4096)
    const stdout = createChunkCollector(byteLimit)
    const stderr = createChunkCollector(byteLimit)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, Number(options.timeoutMs || 30000))

    child.stdout?.on("data", chunk => {
      stdout.push(chunk)
    })
    child.stderr?.on("data", chunk => {
      stderr.push(chunk)
    })
    child.on("error", error => {
      clearTimeout(timer)
      resolve({
        ok: false,
        stage: "spawn",
        reason: error.message,
        stdout: "",
        stderr: "",
      })
    })
    child.on("close", code => {
      clearTimeout(timer)
      const decodedStdout = capOutput(decodeSpawnOutput(stdout.buffer), limit, stdout.truncated)
      const decodedStderr = capOutput(decodeSpawnOutput(stderr.buffer), limit, stderr.truncated)
      resolve({
        ok: code === 0 && !timedOut,
        stage: "spawn",
        code,
        timedOut,
        stdout: redactSensitive(decodedStdout),
        stderr: redactSensitive(decodedStderr),
      })
    })
  })
}

export function redactSensitive(value = "") {
  return String(value)
    .replace(/(stoken|cookie_token|ltoken|mid|authkey|password|secret)=([^;\s&]+)/gi, "$1=***")
    .replace(/(Cookie:\s*)([^\r\n]+)/gi, "$1***")
}

export async function appendRemoteAudit(entry) {
  const file = resolveData("audit", "remote.jsonl")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify({
    time: formatLocalIso(),
    ...entry,
  }) + "\n", "utf8")
}

function powershellUtf8Command(command = "") {
  return `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${command}`
}

function createChunkCollector(byteLimit) {
  const chunks = []
  let bytes = 0
  return {
    get buffer() {
      return Buffer.concat(chunks)
    },
    get truncated() {
      return bytes >= byteLimit
    },
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (bytes >= byteLimit) return
      const available = byteLimit - bytes
      const next = buffer.length > available ? buffer.subarray(0, available) : buffer
      chunks.push(next)
      bytes += next.length
    },
  }
}

function decodeSpawnOutput(buffer) {
  if (!buffer?.length) return ""
  const utf8 = buffer.toString("utf8")
  if (!looksMojibake(utf8)) return utf8
  try {
    const gb = new TextDecoder("gb18030").decode(buffer)
    if (!looksMojibake(gb)) return gb
  } catch {}
  return utf8
}

function looksMojibake(value = "") {
  if (!value) return false
  const replacementCount = (value.match(/\uFFFD/g) || []).length
  if (replacementCount >= 2) return true
  return /(?:锟斤拷|���|\?{3,})/.test(value)
}

function capOutput(value, limit, truncated = false) {
  if (value.length <= limit) return truncated ? `${value}\n...[truncated]` : value
  return `${value.slice(0, limit)}\n...[truncated]`
}
