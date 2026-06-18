import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { rootPath } from "../../core/path.js"

export class AtlasUpdateService {
  constructor(options = {}) {
    this.spawn = options.spawn || spawn
    this.fs = options.fs || fs
  }

  async run(config = {}, options = {}) {
    const root = resolveBackendRoot(config.backend_root)
    if (!await exists(path.join(root, "package.json"), this.fs)) {
      return {
        ok: false,
        reason: "backend_missing",
        root,
      }
    }

    const mode = options.mode === "initial" ? "initial" : "incremental"
    const command = mode === "initial"
      ? config.initial_command || config.update_command || "node"
      : config.update_command || "node"
    const args = mode === "initial"
      ? Array.isArray(config.initial_args) ? config.initial_args : ["src/scrape.mjs", "--mode", "full"]
      : Array.isArray(config.update_args) ? config.update_args : ["src/scrape.mjs", "--mode", "incremental"]
    const result = await runSpawn(this.spawn, command, args, {
      cwd: root,
      timeoutMs: Number(config.update_timeout_ms || 1800000),
      outputLimit: Number(config.update_output_limit || 12000),
    })
    const sync = result.ok && config.sync_after_update !== false
      ? await syncBackendOutput({
          backendRoot: root,
          dataRoot: config.data_root,
          syncGallery: config.sync_gallery !== false,
          fsImpl: this.fs,
        })
      : null
    return {
      ...result,
      root,
      mode,
      command,
      args,
      sync,
    }
  }

  async checkAndRun(config = {}) {
    const root = resolveBackendRoot(config.backend_root)
    if (!await exists(path.join(root, "package.json"), this.fs)) {
      return {
        ok: false,
        reason: "backend_missing",
        root,
      }
    }

    const local = await readLocalVersionSnapshot(config, this.fs)
    if (!local.ready) {
      if (config.auto_update?.run_on_missing_data === false) {
        return {
          ok: true,
          skipped: true,
          reason: "local_data_missing",
          root,
          local,
        }
      }
      const result = await this.run(config, { mode: "initial" })
      return {
        ...result,
        checked: true,
        check: {
          reason: "local_data_missing",
          local,
        },
      }
    }

    const remote = await this.fetchRemoteVersions(config)
    if (!remote.ok) {
      return {
        ...remote,
        checked: true,
        root,
      }
    }

    const diff = compareVersionSnapshots(local.versions, remote.versions)
    if (!diff.changed) {
      return {
        ok: true,
        skipped: true,
        reason: "versions_unchanged",
        root,
        checked: true,
        local,
        remote,
        diff,
      }
    }

    const result = await this.run(config, { mode: "incremental" })
    return {
      ...result,
      checked: true,
      check: {
        reason: "versions_changed",
        local,
        remote,
        diff,
      },
    }
  }

  async fetchRemoteVersions(config = {}) {
    const root = resolveBackendRoot(config.backend_root)
    if (!await exists(path.join(root, "package.json"), this.fs)) {
      return {
        ok: false,
        reason: "backend_missing",
        root,
      }
    }
    const command = config.version_command || "node"
    const args = Array.isArray(config.version_args) ? config.version_args : ["src/scrape.mjs", "--list-versions"]
    const result = await runSpawn(this.spawn, command, args, {
      cwd: root,
      timeoutMs: Number(config.update_timeout_ms || 1800000),
      outputLimit: Number(config.update_output_limit || 12000),
    })
    if (!result.ok) {
      return {
        ...result,
        command,
        args,
        reason: result.reason || "version_check_failed",
      }
    }
    return {
      ...result,
      command,
      args,
      versions: parseVersionOutput(result.stdout),
    }
  }
}

export function resolveBackendRoot(value = "nanoka-atlas-backend") {
  const text = String(value || "nanoka-atlas-backend")
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(rootPath, text)
}

export function resolveAtlasDataRoot(value = "data/atlas") {
  const text = String(value || "data/atlas")
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(rootPath, text)
}

export async function syncBackendOutput({
  backendRoot,
  dataRoot = "data/atlas",
  syncGallery = true,
  fsImpl = fs,
} = {}) {
  const root = resolveBackendRoot(backendRoot)
  const targetRoot = resolveAtlasDataRoot(dataRoot)
  const copied = []

  await copyDir(path.join(root, "data"), path.join(targetRoot, "data"), fsImpl)
  copied.push("data")

  if (syncGallery && await exists(path.join(root, "gallery"), fsImpl)) {
    await copyDir(path.join(root, "gallery"), path.join(targetRoot, "gallery"), fsImpl)
    copied.push("gallery")
  }

  return {
    ok: true,
    targetRoot,
    copied,
  }
}

export async function readLocalVersionSnapshot(config = {}, fsImpl = fs) {
  const root = resolveAtlasDataRoot(config.data_root)
  const mapFile = path.join(root, "data", "map.json")
  const itemsRoot = path.join(root, "data", "items", config.locale || "简体中文")
  const map = await readJson(mapFile, fsImpl).catch(() => null)
  const itemsReady = await exists(itemsRoot, fsImpl)
  if (!map?.games || !itemsReady) {
    return {
      ready: false,
      root,
      mapReady: Boolean(map?.games),
      itemsReady,
      versions: {},
    }
  }

  return {
    ready: true,
    root,
    mapReady: true,
    itemsReady,
    fetchedAt: map.meta?.fetchedAt || "",
    versions: normalizeLocalVersions(map.games),
  }
}

export function parseVersionOutput(stdout = "") {
  const text = String(stdout || "").trim()
  if (!text) return {}
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      return normalizeRemoteVersions(JSON.parse(text.slice(start, end + 1)))
    } catch {
      // fall through to line parser
    }
  }
  const versions = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\b(gi|hsr|zzz|nte)\b\s*[:=]\s*([^\s,]+)/i)
    if (match) versions[match[1].toLowerCase()] = { latest: match[2], live: "" }
  }
  return versions
}

export function compareVersionSnapshots(local = {}, remote = {}) {
  const changes = []
  const games = new Set([...Object.keys(local), ...Object.keys(remote)])
  for (const game of games) {
    const left = local[game] || {}
    const right = remote[game] || {}
    if (!right.latest && !right.live) continue
    if ((right.latest || "") !== (left.latest || "") || (right.live || "") !== (left.live || "")) {
      changes.push({
        game,
        local: left,
        remote: right,
      })
    }
  }
  return {
    changed: changes.length > 0,
    changes,
  }
}

function runSpawn(spawnImpl, command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      windowsHide: true,
    })
    const limit = Number(options.outputLimit || 12000)
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, Number(options.timeoutMs || 1800000))

    child.stdout?.on("data", chunk => {
      stdout = cap(stdout + chunk.toString(), limit)
    })
    child.stderr?.on("data", chunk => {
      stderr = cap(stderr + chunk.toString(), limit)
    })
    child.on("error", error => {
      clearTimeout(timer)
      resolve({
        ok: false,
        reason: error.message,
        stdout: "",
        stderr: "",
      })
    })
    child.on("close", code => {
      clearTimeout(timer)
      resolve({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        stdout,
        stderr,
        reason: code === 0 && !timedOut ? "" : timedOut ? "timeout" : "non_zero_exit",
      })
    })
  })
}

function cap(value, limit) {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n...[truncated]`
}

async function exists(file, fsImpl) {
  try {
    await fsImpl.access(file)
    return true
  } catch {
    return false
  }
}

async function copyDir(source, target, fsImpl) {
  if (!await exists(source, fsImpl)) {
    throw new Error(`atlas source missing: ${source}`)
  }
  await fsImpl.mkdir(path.dirname(target), { recursive: true })
  await fsImpl.rm(target, { recursive: true, force: true })
  if (typeof fsImpl.cp === "function") {
    await fsImpl.cp(source, target, { recursive: true, force: true })
    return
  }
  await copyDirFallback(source, target, fsImpl)
}

async function copyDirFallback(source, target, fsImpl) {
  await fsImpl.mkdir(target, { recursive: true })
  const entries = await fsImpl.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) await copyDirFallback(from, to, fsImpl)
    else if (entry.isFile()) await fsImpl.copyFile(from, to)
  }
}

async function readJson(file, fsImpl) {
  return JSON.parse(await fsImpl.readFile(file, "utf8"))
}

function normalizeLocalVersions(games = {}) {
  const result = {}
  for (const [game, value] of Object.entries(games || {})) {
    result[game] = {
      latest: String(value?.game?.latestVersion || ""),
      live: String(value?.game?.liveVersion || ""),
    }
  }
  return result
}

function normalizeRemoteVersions(games = {}) {
  const result = {}
  for (const [game, value] of Object.entries(games || {})) {
    result[game] = {
      latest: String(value?.latest || value?.game?.latestVersion || ""),
      live: String(value?.live || value?.game?.liveVersion || ""),
    }
  }
  return result
}
