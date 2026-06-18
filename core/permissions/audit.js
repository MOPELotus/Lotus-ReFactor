import fs from "node:fs/promises"
import path from "node:path"
import { resolveData } from "../path.js"

export async function writePermissionAudit(entry = {}) {
  const file = resolveData("audit", "permissions.jsonl")
  const payload = {
    time: new Date().toISOString(),
    actor: String(entry.actor || ""),
    group: entry.group ? String(entry.group) : "",
    command: entry.command || null,
    result: entry.result || "",
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(payload)}\n`, "utf8")
  return file
}
