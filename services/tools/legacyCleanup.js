import fs from "node:fs/promises"
import path from "node:path"
import { rootPath } from "../../core/path.js"

const references = (value, target) => String(value).split(/[\0\n]/).some(part => part.includes(target))

// Unknown process visibility is not evidence that an old environment is idle.
export async function legacyEnvironmentInUse(target, { procRoot = "/proc", platform = process.platform } = {}) {
  if (platform !== "linux") return { known: false, inUse: false }
  let entries
  try { entries = await fs.readdir(procRoot) } catch { return { known: false, inUse: false } }
  let unknown = false
  for (const pid of entries.filter(value => /^\d+$/.test(value))) {
    const base = path.join(procRoot, pid)
    try {
      for (const name of ["cmdline", "environ", "maps"]) {
        if (references(await fs.readFile(path.join(base, name), "utf8"), target)) return { known: true, inUse: true }
      }
      for (const name of ["cwd", "exe"]) {
        if (references(await fs.readlink(path.join(base, name)), target)) return { known: true, inUse: true }
      }
      for (const descriptor of await fs.readdir(path.join(base, "fd"))) {
        try {
          if (references(await fs.readlink(path.join(base, "fd", descriptor)), target)) return { known: true, inUse: true }
        } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error }
      }
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) unknown = true
    }
  }
  return { known: !unknown, inUse: false }
}

export async function cleanupLegacyEnvironment({ root = rootPath, config = {}, signal, inspectUsage = legacyEnvironmentInUse } = {}) {
  const skipped = reason => ({ ok: true, removed: false, reason })
  const target = path.join(path.resolve(root), "data", "python", "test_nine_venv")
  let ownedStat
  signal?.throwIfAborted()
  // A current custom model/tool path may deliberately reuse the old folder.
  const configuredPaths = [config.captcha?.test_nine?.model_dir, config.tools?.dir, config.tools?.bin_dir]
  if (configuredPaths.some(value => value && references(path.resolve(root, value), target))) return skipped("configured_path_in_use")
  try {
    for (const relative of ["data", "data/python", "data/python/test_nine_venv"]) {
      const stat = await fs.lstat(path.join(root, relative))
      if (stat.isSymbolicLink() || !stat.isDirectory()) return skipped("unsafe_path")
    }
    ownedStat = await fs.lstat(target)
    const [venv, markerStat] = await Promise.all([
      fs.lstat(path.join(target, "pyvenv.cfg")), fs.lstat(path.join(target, "lotus-test-nine-fingerprint.json")),
    ])
    if (!venv.isFile() || !markerStat.isFile() || venv.isSymbolicLink() || markerStat.isSymbolicLink() || markerStat.size > 65536) return skipped("ownership_unconfirmed")
    const marker = JSON.parse(await fs.readFile(path.join(target, "lotus-test-nine-fingerprint.json"), "utf8"))
    if (!/^[a-f0-9]{64}$/i.test(marker.requirements_sha256 || "")
      || !/^[a-f0-9]{40}$/i.test(marker.test_nine_commit || "")
      || typeof marker.model_repo !== "string" || !Array.isArray(marker.model_files)
      || !marker.model_files.length || !marker.model_files.every(file => typeof file === "string" && path.basename(file) === file && file.endsWith(".onnx"))) return skipped("ownership_unconfirmed")
  } catch (error) {
    return skipped(error.code === "ENOENT" ? "not_present" : "ownership_unconfirmed")
  }
  const usage = await inspectUsage(target)
  if (!usage.known || usage.inUse) return skipped(usage.inUse ? "process_in_use" : "process_visibility_unknown")
  signal?.throwIfAborted()
  // Recheck the path immediately before removal; never follow a replacement
  // symlink out of the plugin's fixed legacy directory.
  const stat = await fs.lstat(target)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== ownedStat.ino || stat.dev !== ownedStat.dev
    || await fs.realpath(target) !== target) return skipped("unsafe_path")
  await fs.rm(target, { recursive: true })
  return { ok: true, removed: true, component: "legacy_test_nine_venv" }
}
