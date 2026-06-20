import fs from "node:fs/promises"
import path from "node:path"
import { resolveData } from "../../core/path.js"
import { formatLocalIso } from "../../core/time.js"

const CHECKIN_AUDIT_FILE = resolveData("audit", "checkin.jsonl")

export async function appendCheckinAudit(entry = {}) {
  const payload = {
    time: formatLocalIso(),
    qq: String(entry.qq || entry.profile?.user?.qq || ""),
    profileId: Number(entry.profileId || entry.profile?.profile?.id || 1),
    ok: Boolean(entry.ok),
    stage: entry.stage || "",
    source: entry.source || "manual",
    message: String(entry.message || "").slice(0, 300),
  }
  await fs.mkdir(path.dirname(CHECKIN_AUDIT_FILE), { recursive: true })
  await fs.appendFile(CHECKIN_AUDIT_FILE, `${JSON.stringify(payload)}\n`, "utf8")
  return payload
}

export async function readCheckinAudit({ qq, limit = 12 } = {}) {
  let raw = ""
  try {
    raw = await fs.readFile(CHECKIN_AUDIT_FILE, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }

  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(item => !qq || String(item.qq) === String(qq))
    .slice(-Number(limit || 12))
    .reverse()
}
