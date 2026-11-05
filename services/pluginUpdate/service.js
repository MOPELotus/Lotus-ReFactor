import { spawn } from "node:child_process"
import { rootPath } from "../../core/path.js"
import { notifyUser } from "../../core/transport/notify.js"
import { collectMasterIds } from "../../core/transport/masters.js"

const DEFAULT_OUTPUT_LIMIT = 12000
const GIT_STATUS_ARGS = ["status", "--short", "--ignore-submodules=dirty"]

export async function checkPluginUpdate(options = {}) {
  const {
    cwd = rootPath,
    pull = true,
    updateSubmodules = true,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    runner = runGit,
  } = options

  const status = await runner(GIT_STATUS_ARGS, { cwd, outputLimit })
  const dirtyState = partitionDirtyStatus(splitStatusLines(status.stdout))
  const dirtyLines = dirtyState.blocking
  if (dirtyLines.length) {
    return {
      ok: false,
      action: "blocked_dirty",
      message: "当前仓库存在未提交改动，已停止自动更新。",
      dirty: dirtyLines.slice(0, 12),
      ignoredDirty: dirtyState.ignored.slice(0, 12),
    }
  }

  const remotes = await runner(["remote"], { cwd, outputLimit })
  if (!splitLines(remotes.stdout).length) {
    return {
      ok: false,
      action: "no_remote",
      message: "当前仓库没有配置 remote，无法自动检查更新。",
    }
  }

  await runner(["remote", "update"], { cwd, outputLimit })

  const branch = await runner(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, outputLimit })
  const upstream = await runner(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd,
    outputLimit,
    allowFailure: true,
  })
  if (upstream.code !== 0) {
    return {
      ok: false,
      action: "no_upstream",
      branch: branch.stdout.trim(),
      message: "当前分支没有上游跟踪分支，无法自动判断更新。",
      detail: upstream.stderr || upstream.stdout,
    }
  }

  const counts = await runner(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
    cwd,
    outputLimit,
  })
  const [ahead, behind] = parseAheadBehind(counts.stdout)
  const current = await latestCommit(runner, cwd, outputLimit)

  if (ahead > 0 && behind > 0) {
    return {
      ok: false,
      action: "diverged",
      branch: branch.stdout.trim(),
      upstream: upstream.stdout.trim(),
      ahead,
      behind,
      commit: current,
      message: "本地分支和上游已分叉，请手动处理后再更新。",
    }
  }
  if (ahead > 0) {
    return {
      ok: true,
      action: "ahead",
      branch: branch.stdout.trim(),
      upstream: upstream.stdout.trim(),
      ahead,
      behind,
      commit: current,
      message: "本地分支领先上游，无需拉取。",
      ignoredDirty: dirtyState.ignored.slice(0, 12),
    }
  }
  if (behind === 0) {
    return {
      ok: true,
      action: "up_to_date",
      branch: branch.stdout.trim(),
      upstream: upstream.stdout.trim(),
      ahead,
      behind,
      commit: current,
      message: "插件已是最新版本。",
      ignoredDirty: dirtyState.ignored.slice(0, 12),
    }
  }

  if (!pull) {
    return {
      ok: true,
      action: "behind",
      branch: branch.stdout.trim(),
      upstream: upstream.stdout.trim(),
      ahead,
      behind,
      commit: current,
      message: `检测到上游有 ${behind} 个新提交。`,
      ignoredDirty: dirtyState.ignored.slice(0, 12),
    }
  }

  const pullResult = await runner(["pull", "--ff-only"], { cwd, outputLimit })
  if (updateSubmodules) {
    await runner(["submodule", "update", "--init", "--recursive"], {
      cwd,
      outputLimit,
      allowFailure: true,
    })
  }
  const updated = await latestCommit(runner, cwd, outputLimit)

  return {
    ok: true,
    action: "updated",
    branch: branch.stdout.trim(),
    upstream: upstream.stdout.trim(),
    ahead: 0,
    behind,
    commit: updated,
    previousCommit: current,
    message: `已 fast-forward 更新 ${behind} 个提交，请按需重启机器人。`,
    output: pullResult.stdout || pullResult.stderr,
    ignoredDirty: dirtyState.ignored.slice(0, 12),
  }
}

export async function syncTrackedSubmodules(options = {}) {
  const {
    cwd = rootPath,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    timeoutMs = 120000,
    runner = runGit,
  } = options
  const run = args => runner(args, { cwd, outputLimit, timeoutMs, allowFailure: true })
  let pending = []
  try {
    const status = await run(["submodule", "status", "--recursive"])
    if (status.code !== 0) return submoduleFailure("submodule_status_failed", "无法读取子模块状态。", status)
    // Keep the leading status character: trimming would hide a synchronized entry.
    pending = String(status.stdout || "").split(/\r?\n/).filter(line => /^[+\-U]/.test(line))
    if (!pending.length) return { ok: true, action: "submodules_up_to_date", message: "子模块提交已同步。" }
    if (pending.some(line => line.startsWith("U"))) {
      return { ok: false, action: "submodule_conflict", message: "子模块引用存在合并冲突，已保留现场，请手动处理。", pending }
    }
    // Git checkout alone may carry local edits to another commit. Check all initialized
    // descendants first, including untracked files, before changing any checkout.
    const clean = await run(["submodule", "foreach", "--quiet", "--recursive",
      'lotus_changes=$(git status --porcelain --untracked-files=normal --ignore-submodules=all) || exit 1; if test -n "$lotus_changes"; then printf "%s\\n" "$displaypath has local changes"; exit 1; fi'])
    if (clean.code !== 0) return submoduleFailure("submodule_dirty", "子模块有本地改动或状态检查失败，已保留现场，请手动处理。", clean, pending)
    const update = await run(["submodule", "update", "--init", "--recursive", "--checkout"])
    if (update.code !== 0) return submoduleFailure("submodule_update_failed", "未能同步荷花指定的子模块版本，已保留现有文件，请检查网络或本地改动。", update, pending)
    const verified = await run(["submodule", "status", "--recursive"])
    if (verified.code !== 0 || /^[+\-U]/m.test(verified.stdout || "")) {
      return submoduleFailure("submodule_verify_failed", "子模块同步后仍与荷花指定版本不一致，请手动检查。", verified, pending)
    }
    return { ok: true, action: "submodules_updated", message: "已同步子模块追踪的提交。", pending }
  } catch (error) {
    return { ok: false, action: "submodule_update_failed", message: "子模块启动同步失败，已保留现有文件，请检查网络或本地改动。", detail: error.message, pending }
  }
}

function submoduleFailure(action, message, result, pending = []) {
  return { ok: false, action, message, pending, detail: result.stderr || result.stdout, timedOut: Boolean(result.timedOut) }
}

// Startup happens before adapters connect. Retry private delivery for a bounded
// period, remembering successful recipients to avoid duplicate startup messages.
export async function notifySubmoduleSyncFailure(result, options = {}) {
  if (result?.ok !== false) return { ok: true, skipped: true }
  const {
    initialDelayMs = 30000, retryDelayMs = 30000, maxAttempts = 10,
    collectMasters = collectMasterIds, notify = notifyUser,
    wait = milliseconds => new Promise(resolve => { const timer = setTimeout(resolve, milliseconds); timer.unref?.() }),
  } = options
  const sent = new Set()
  const message = `[荷花插件]启动时未能同步所需子模块：${result.message}\n已保留现有文件；请检查网络和本地改动，处理后重启机器人。`
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await wait(attempt === 0 ? initialDelayMs : retryDelayMs)
    try {
      const ids = await collectMasters()
      for (const id of ids) {
        if (sent.has(String(id))) continue
        const delivered = await notify(id, message, { prefer: "private", onlyKnownFriend: false, allowGroupFallback: false, at: false })
        if (delivered?.ok) sent.add(String(id))
      }
      if (ids.length && ids.every(id => sent.has(String(id)))) return { ok: true, notified: [...sent] }
    } catch (error) {
      globalThis.logger?.debug?.(`[Lotus-Plugin] submodule failure notification pending: ${error.message}`)
    }
  }
  globalThis.logger?.warn?.("[Lotus-Plugin] 子模块同步失败通知未全部送达，请检查主人配置及机器人连接。")
  return { ok: false, notified: [...sent] }
}

export function runGit(args, options = {}) {
  const {
    cwd = rootPath,
    allowFailure = false,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    timeoutMs = 120000,
  } = options
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    let timedOut = false
    let killTimer
    const stop = signal => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* The process may already have exited. */ }
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop("SIGTERM")
      killTimer = setTimeout(() => stop("SIGKILL"), 2000)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", chunk => {
      stdout = appendLimited(stdout, chunk, outputLimit)
    })
    child.stderr.on("data", chunk => {
      stderr = appendLimited(stderr, chunk, outputLimit)
    })
    child.on("error", error => { clearTimeout(timer); clearTimeout(killTimer); reject(error) })
    child.on("close", code => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      const result = {
        code: timedOut ? 124 : code,
        timedOut,
        stdout,
        stderr,
        args,
      }
      if ((!timedOut && code === 0) || allowFailure) {
        resolve(result)
        return
      }
      const error = new Error(`git ${args.join(" ")} failed: ${stderr || stdout || code}`)
      error.result = result
      reject(error)
    })
  })
}

async function latestCommit(runner, cwd, outputLimit) {
  const result = await runner(["log", "-1", "--pretty=%h %s"], {
    cwd,
    outputLimit,
    allowFailure: true,
  })
  return result.stdout.trim()
}

function parseAheadBehind(output = "") {
  const [ahead = 0, behind = 0] = output.trim().split(/\s+/).map(Number)
  return [Number.isFinite(ahead) ? ahead : 0, Number.isFinite(behind) ? behind : 0]
}

function splitLines(text = "") {
  return String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

function splitStatusLines(text = "") {
  return String(text || "").split(/\r?\n/).filter(line => line.trim())
}

function partitionDirtyStatus(lines = []) {
  const ignored = []
  const blocking = []
  for (const line of lines) {
    if (isIgnoredDirtyStatus(line)) ignored.push(line.trim())
    else blocking.push(line.trim())
  }
  return { blocking, ignored }
}

function isIgnoredDirtyStatus(line = "") {
  const normalized = String(line || "").replace(/\\/g, "/")
  const code = normalized.slice(0, 2)
  const file = normalized.slice(3).trim()
  if (file === "services/starRailTeamDamage/data/system-data.json") return true
  return false
}

function appendLimited(current, chunk, limit) {
  const next = current + chunk.toString("utf8")
  if (next.length <= limit) return next
  return next.slice(0, limit)
}
