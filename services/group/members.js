import fs from "node:fs/promises"
import path from "node:path"
import { resolveData } from "../../core/path.js"

export async function generateGroupMembersCsv(group, options = {}) {
  if (!group?.getMemberMap) throw new Error("group is unavailable")
  const groupId = String(group.group_id || options.groupId || "")
  if (!groupId) throw new Error("group id is required")

  const memberMap = await group.getMemberMap()
  const rows = [["QQ号", "昵称/群名片", "性别", "头衔", "是否管理员", "是否群主"]]
  for (const member of normalizeGroupMemberEntries(memberMap)) {
    rows.push([
      member.user_id,
      groupMemberDisplayName(member),
      sexLabel(member.sex),
      member.title || "无",
      member.is_admin ? "是" : "否",
      member.is_owner ? "是" : "否",
    ])
  }

  const file = resolveData("groups", `${groupId}.csv`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "\ufeff" + rows.map(toCsvLine).join("\r\n"), "utf8")
  return {
    file,
    groupId,
    count: rows.length - 1,
  }
}

function toCsvLine(row) {
  return row.map(value => {
    const text = String(value ?? "")
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }).join(",")
}

export function normalizeGroupMemberEntries(source = []) {
  let entries = []
  if (source instanceof Map) {
    entries = Array.from(source.entries()).map(([userId, member]) => normalizeMember(userId, member))
  } else if (Array.isArray(source)) {
    entries = source.map(item => Array.isArray(item)
      ? normalizeMember(item[0], item[1])
      : normalizeMember(item?.user_id || item?.userId || item?.qq || item?.id || item?.uin, item))
  } else if (source && typeof source === "object") {
    entries = Object.entries(source).map(([userId, member]) => normalizeMember(userId, member))
  }
  return entries.filter(member => member.user_id)
}

export function groupMemberDisplayName(member = {}) {
  return member.card || member.nickname || member.name || "群成员"
}

function normalizeMember(userId, member = {}) {
  const value = member && typeof member === "object" ? member : {}
  return {
    ...value,
    user_id: String(value.user_id || value.userId || value.qq || value.id || value.uin || userId || ""),
  }
}

function sexLabel(value) {
  if (value === "male") return "男"
  if (value === "female") return "女"
  return "未知"
}
