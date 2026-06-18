import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { loadGlobalConfig } from "../../core/config/global.js"
import { resolveData } from "../../core/path.js"
import { normalizeTestNineConfig, TestNineEnvService } from "./env.js"

let running = null

export class TestNineServerService {
  constructor(options = {}) {
    this.spawn = options.spawn || spawn
    this.config = options.config
    this.pythonConfig = options.pythonConfig
  }

  async getConfig() {
    if (this.config) return normalizeTestNineConfig(this.config)
    const globalConfig = await loadGlobalConfig()
    this.pythonConfig ||= globalConfig.python || {}
    return normalizeTestNineConfig(globalConfig.captcha?.test_nine || {})
  }

  async start(options = {}) {
    if (running?.child && !running.child.killed) {
      return {
        ok: true,
        alreadyRunning: true,
        ...this.status(),
      }
    }

    const config = await this.getConfig()
    const envService = new TestNineEnvService({
      config,
      pythonConfig: this.pythonConfig,
      spawn: this.spawn,
    })
    const env = await envService.ensureEnv({
      installRequirements: options.installRequirements ?? config.install_requirements,
      downloadModels: options.downloadModels ?? config.download_models,
    })
    if (!env.ok) return env

    const logFile = resolveData("test_nine", "server.log")
    await fs.mkdir(path.dirname(logFile), { recursive: true })
    const child = this.spawn(env.python.command, ["main.py"], {
      cwd: env.submoduleRoot,
      env: {
        ...process.env,
        LOG_LEVEL: options.logLevel || process.env.LOG_LEVEL || "INFO",
      },
      windowsHide: true,
    })
    const state = {
      child,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      logFile,
      submoduleRoot: env.submoduleRoot,
      endpoint: config.endpoint,
      lastOutput: "",
    }
    running = state
    child.stdout?.on("data", chunk => appendServerLog(state, chunk.toString()))
    child.stderr?.on("data", chunk => appendServerLog(state, chunk.toString()))
    child.on("error", error => {
      state.lastError = error.message
      appendServerLog(state, `[error] ${error.message}\n`)
    })
    child.on("close", code => {
      state.closedAt = new Date().toISOString()
      state.code = code
      appendServerLog(state, `[close] code=${code}\n`)
      if (running === state) running = null
    })

    return {
      ok: true,
      alreadyRunning: false,
      pid: child.pid,
      endpoint: config.endpoint,
      logFile,
      startedAt: state.startedAt,
    }
  }

  stop() {
    if (!running?.child || running.child.killed) {
      return {
        ok: true,
        running: false,
        reason: "not_running",
      }
    }
    const pid = running.pid
    running.child.kill("SIGTERM")
    return {
      ok: true,
      running: false,
      stopped: true,
      pid,
    }
  }

  status() {
    if (!running?.child || running.child.killed) {
      return {
        ok: true,
        running: false,
      }
    }
    return {
      ok: true,
      running: true,
      pid: running.pid,
      startedAt: running.startedAt,
      endpoint: running.endpoint,
      logFile: running.logFile,
      lastOutput: running.lastOutput,
    }
  }
}

async function appendServerLog(state, text) {
  state.lastOutput = cap(`${state.lastOutput}${text}`, 1000)
  await fs.appendFile(state.logFile, text, "utf8").catch(() => null)
}

function cap(value, limit) {
  if (value.length <= limit) return value
  return value.slice(value.length - limit)
}
