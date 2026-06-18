import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadGlobalConfig } from "../../core/config/global.js"
import { resolveData, rootPath } from "../../core/path.js"
import { RemoteSpawnService, appendRemoteAudit, redactSensitive } from "./spawn.js"

export class RemoteFileService {
  constructor(options = {}) {
    this.config = options.config
    this.fetch = options.fetch || globalThis.fetch
  }

  async download({ e, otp, file } = {}) {
    const globalConfig = this.config || await loadGlobalConfig()
    const auth = await new RemoteSpawnService({ config: globalConfig }).authorize({
      e,
      otp,
      scope: "remote.download",
    })
    if (!auth.ok) {
      await appendRemoteAudit({
        userId: String(e?.user_id || ""),
        groupId: String(e?.group_id || ""),
        action: "download",
        file: redactSensitive(file),
        ok: false,
        reason: auth.reason,
      })
      return { ok: false, stage: "auth", reason: auth.reason }
    }

    const target = normalizeLocalPath(file)
    if (!isPathAllowed(target, globalConfig.remote)) {
      await appendRemoteAudit({
        userId: String(e?.user_id || ""),
        groupId: String(e?.group_id || ""),
        action: "download",
        file: redactSensitive(target),
        ok: false,
        reason: "path_not_allowed",
      })
      return { ok: false, stage: "validate", reason: "path_not_allowed" }
    }
    const stat = await fs.stat(target).catch(error => {
      if (error?.code === "ENOENT") return null
      throw error
    })
    if (!stat || !stat.isFile()) return { ok: false, stage: "validate", reason: "file_not_found" }

    const maxBytes = Number(globalConfig.remote?.max_download_bytes || 52428800)
    if (stat.size > maxBytes) return { ok: false, stage: "validate", reason: "file_too_large", size: stat.size, maxBytes }

    await appendRemoteAudit({
      userId: String(e?.user_id || ""),
      groupId: String(e?.group_id || ""),
      action: "download",
      file: redactSensitive(target),
      ok: true,
      size: stat.size,
    })
    return {
      ok: true,
      stage: "download",
      path: target,
      name: path.basename(target),
      size: stat.size,
    }
  }

  async upload({ e, otp, target, source, overwrite = false } = {}) {
    const globalConfig = this.config || await loadGlobalConfig()
    const auth = await new RemoteSpawnService({ config: globalConfig }).authorize({
      e,
      otp,
      scope: "remote.upload",
    })
    if (!auth.ok) {
      await appendRemoteAudit({
        userId: String(e?.user_id || ""),
        groupId: String(e?.group_id || ""),
        action: "upload",
        file: redactSensitive(target),
        ok: false,
        reason: auth.reason,
      })
      return { ok: false, stage: "auth", reason: auth.reason }
    }

    if (!source) return { ok: false, stage: "validate", reason: "upload_source_missing" }

    const targetPath = normalizeLocalPath(target)
    if (!isPathAllowed(targetPath, globalConfig.remote)) {
      await appendRemoteAudit({
        userId: String(e?.user_id || ""),
        groupId: String(e?.group_id || ""),
        action: "upload",
        file: redactSensitive(targetPath),
        ok: false,
        reason: "path_not_allowed",
      })
      return { ok: false, stage: "validate", reason: "path_not_allowed" }
    }
    const allowOverwrite = overwrite || globalConfig.remote?.allow_overwrite_upload === true
    if (!allowOverwrite && await exists(targetPath)) {
      return { ok: false, stage: "validate", reason: "target_exists" }
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    let size = 0
    try {
      size = await writeUploadSource(targetPath, source, {
        fetch: this.fetch,
        maxBytes: Number(globalConfig.remote?.max_upload_bytes || 52428800),
      })
    } catch (error) {
      await appendRemoteAudit({
        userId: String(e?.user_id || ""),
        groupId: String(e?.group_id || ""),
        action: "upload",
        file: redactSensitive(targetPath),
        ok: false,
        reason: error.code || error.message,
      })
      return {
        ok: false,
        stage: "write",
        reason: error.code || error.message,
        size: error.size,
        maxBytes: error.maxBytes,
      }
    }

    await appendRemoteAudit({
      userId: String(e?.user_id || ""),
      groupId: String(e?.group_id || ""),
      action: "upload",
      file: redactSensitive(targetPath),
      ok: true,
      size,
      overwrite: allowOverwrite,
    })
    return {
      ok: true,
      stage: "upload",
      path: targetPath,
      name: path.basename(targetPath),
      size,
      overwrite: allowOverwrite,
    }
  }
}

export function extractUploadSource(e = {}) {
  if (e.file) return normalizeSource(e.file)
  const messages = Array.isArray(e.message) ? e.message : []
  for (const item of messages) {
    const source = normalizeSource(item)
    if (source) return source
  }
  return null
}

function normalizeSource(value) {
  if (!value || typeof value !== "object") return null
  const file = value.file || value.path || value.localPath
  const url = value.url || value.file_url
  const name = value.name || value.filename || value.file_name || (file ? path.basename(String(file)) : "")
  if (file) {
    return {
      type: "file",
      file: normalizeLocalPath(file),
      name,
    }
  }
  if (url && /^https?:\/\//i.test(url)) {
    return {
      type: "url",
      url,
      name,
    }
  }
  return null
}

async function writeUploadSource(targetPath, source, options = {}) {
  if (source.type === "file") {
    const stat = await fs.stat(source.file)
    if (stat.size > options.maxBytes) throw Object.assign(new Error("upload file too large"), {
      code: "file_too_large",
      size: stat.size,
      maxBytes: options.maxBytes,
    })
    await fs.copyFile(source.file, targetPath)
    return stat.size
  }

  if (source.type === "url") {
    if (typeof options.fetch !== "function") throw new Error("fetch is unavailable")
    const response = await options.fetch(source.url)
    if (!response.ok) throw new Error(`download upload source failed: HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > options.maxBytes) throw Object.assign(new Error("upload file too large"), {
      code: "file_too_large",
      size: buffer.byteLength,
      maxBytes: options.maxBytes,
    })
    await fs.writeFile(targetPath, buffer)
    return buffer.byteLength
  }

  throw new Error("unsupported upload source")
}

function normalizeLocalPath(value = "") {
  const text = String(value || "").trim()
  if (!text) throw new Error("file path is required")
  if (text.startsWith("file://")) return fileURLToPath(text)
  if (path.isAbsolute(text)) return path.normalize(text)
  return path.resolve(resolveData("remote"), text)
}

export function isPathAllowed(file, remoteConfig = {}) {
  if (remoteConfig.restrict_file_paths === false) return true
  const target = normalizeForCompare(file)
  const allowedRoots = (remoteConfig.allowed_paths || ["data/remote"])
    .map(resolveAllowedPath)
    .map(normalizeForCompare)
  return allowedRoots.some(root => target === root || target.startsWith(root + path.sep.toLowerCase()))
}

function resolveAllowedPath(value) {
  const text = String(value || "").trim()
  if (!text) return resolveData("remote")
  if (text === "workspace") return process.cwd()
  if (text === "plugin") return rootPath
  if (text === "data/remote") return resolveData("remote")
  if (path.isAbsolute(text)) return text
  return path.resolve(rootPath, text)
}

function normalizeForCompare(value) {
  return path.resolve(value).toLowerCase().replace(/[\\/]+$/, "")
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
