import { spawn } from "node:child_process"
import { rootPath } from "../../core/path.js"

const DEFAULT_OUTPUT_LIMIT = 12000

export async function checkPluginUpdate(options = {}) {
  const {
    cwd = rootPath,
    pull = true,
    updateSubmodules = true,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    runner = runGit,
  } = options

  const status = await runner(["status", "--short"], { cwd, outputLimit })
  const dirtyLines = splitLines(status.stdout)
  if (dirtyLines.length) {
    return {
      ok: false,
      action: "blocked_dirty",
      message: "当前仓库存在未提交改动，已停止自动更新。",
      dirty: dirtyLines.slice(0, 12),
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
  }
}

export function runGit(args, options = {}) {
  const {
    cwd = rootPath,
    allowFailure = false,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
  } = options
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", chunk => {
      stdout = appendLimited(stdout, chunk, outputLimit)
    })
    child.stderr.on("data", chunk => {
      stderr = appendLimited(stderr, chunk, outputLimit)
    })
    child.on("error", reject)
    child.on("close", code => {
      const result = {
        code,
        stdout,
        stderr,
        args,
      }
      if (code === 0 || allowFailure) {
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

function appendLimited(current, chunk, limit) {
  const next = current + chunk.toString("utf8")
  if (next.length <= limit) return next
  return next.slice(0, limit)
}
