import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import YAML from "yaml"
import {
  resolveData,
  rootPath,
} from "../../core/path.js"
import { solveCaptcha } from "../../core/captcha/service.js"
import { decodeProcessChunk, PythonEnvService, withUtf8ProcessEnv } from "../python/env.js"
import { buildBbsToolsConfig } from "./config.js"

export class MihoyoBbsToolsRunner {
  constructor(options = {}) {
    this.python = options.python || new PythonEnvService(options)
    this.spawn = options.spawn || spawn
    this.moduleDir = options.moduleDir || path.join(rootPath, "MihoyoBBSTools")
    this.captchaSolver = options.captchaSolver || solveCaptcha
  }

  async runProfile(profile, options = {}) {
    const taskId = options.taskId || `bbs-${Date.now()}-${profile.user?.qq || "user"}-${profile.profile?.id || 1}`
    const workDir = resolveData("tmp", "mihoyo-bbs-tools", taskId)
    const configFile = path.join(workDir, "config.yaml")
    const eventFile = path.join(workDir, "events.jsonl")
    const resultFile = path.join(workDir, "result.json")
    const captchaDir = path.join(workDir, "captcha")

    await fs.mkdir(workDir, { recursive: true })
    await fs.mkdir(captchaDir, { recursive: true })
    await fs.writeFile(configFile, YAML.stringify(buildBbsToolsConfig(profile)), "utf8")

    const python = options.ensureVenv === false
      ? await this.python.getPythonExecutable()
      : await this.python.ensureVenv({ installRequirements: options.installRequirements !== false })

    try {
      await this.spawnRunner(python.command, [
        ...(python.args || []),
        path.join(rootPath, "python", "lotus_bbs_runner.py"),
        "--config",
        configFile,
        "--module-dir",
        this.moduleDir,
        "--event-file",
        eventFile,
        "--result-file",
        resultFile,
        "--captcha-dir",
        captchaDir,
        "--mihoyobbs-version",
        options.mihoyobbsVersion || "2.102.1",
        "--task-id",
        taskId,
        "--user-id",
        String(profile.user?.qq || ""),
        "--profile-id",
        String(profile.profile?.id || 1),
      ], {
        captchaDir,
        onCaptchaEvent: options.onCaptchaEvent,
        captchaTimeoutMs: options.captchaTimeoutMs,
        captchaSolver: this.captchaSolver,
      })

      const result = JSON.parse(await fs.readFile(resultFile, "utf8"))
      const events = await readJsonl(eventFile)
      return {
        ...result,
        taskId,
        workDir,
        events,
      }
    } finally {
      if (options.keepWorkDir !== true) {
        await fs.rm(workDir, { recursive: true, force: true })
      }
    }
  }

  async spawnRunner(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(command, args, {
        cwd: rootPath,
        env: withUtf8ProcessEnv(process.env),
        windowsHide: true,
      })
      const stopCaptcha = watchCaptchaRequests(options.captchaDir, {
        onCaptchaEvent: options.onCaptchaEvent,
        timeoutMs: options.captchaTimeoutMs,
        solveCaptcha: options.captchaSolver,
      })
      let stderr = ""
      child.stderr?.on("data", chunk => {
        stderr += decodeProcessChunk(chunk)
      })
      child.on("error", reject)
      child.on("close", code => {
        stopCaptcha()
        if (code === 0 || code === 1) {
          resolve({ code, stderr })
          return
        }
        const error = new Error(`MihoyoBBSTools runner exited with code ${code}`)
        error.stderr = stderr
        reject(error)
      })
    })
  }
}

export function watchCaptchaRequests(captchaDir, options = {}) {
  if (!captchaDir) return () => {}
  const handled = new Set()
  const interval = setInterval(async () => {
    let files = []
    try {
      files = await fs.readdir(captchaDir)
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith(".request.json") || handled.has(file)) continue
      handled.add(file)
      handleCaptchaRequest(path.join(captchaDir, file), options).catch(error => {
        logger?.error?.(`[Lotus-Plugin] captcha bridge failed: ${error.stack || error.message}`)
      })
    }
  }, 500)
  interval.unref?.()
  return () => clearInterval(interval)
}

export async function handleCaptchaRequest(requestFile, options = {}) {
  const raw = await fs.readFile(requestFile, "utf8")
  const request = JSON.parse(raw)
  const responseFile = requestFile.replace(/\.request\.json$/, ".response.json")
  const result = await solveCaptchaRequest(request, options)
  await fs.writeFile(responseFile, JSON.stringify(result, null, 2), "utf8")
  return result
}

export async function solveCaptchaRequest(request, options = {}) {
  const solver = options.solveCaptcha || solveCaptcha
  const result = await solver({
    gt: request.gt,
    challenge: request.challenge,
  }, {
    request,
    maxChallengeRefreshAttempts: 0,
    onCaptchaEvent: options.onCaptchaEvent,
  })

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      provider: result.provider,
      attempts: result.attempts,
    }
  }

  return {
    ok: true,
    provider: result.provider,
    token: result.token,
    validate: result.validate || result.token,
    challenge: result.challenge || request.challenge,
    costMs: result.costMs,
  }
}

async function readJsonl(file) {
  try {
    const raw = await fs.readFile(file, "utf8")
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}
