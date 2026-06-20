import fs from "node:fs/promises"
import path from "node:path"
import {
  listProfileIds,
  loadProfile,
  profileFilePath,
  saveProfile,
} from "../../core/config/profile.js"
import { resolveData } from "../../core/path.js"
import { formatLocalFileTimestamp, formatLocalIso } from "../../core/time.js"

export async function cleanupMemberLeave({
  userId,
  groupId,
  groups,
  config = {},
  reason = "member_leave",
  now = () => new Date(),
} = {}) {
  const qq = String(userId || "")
  if (!qq) throw new Error("userId is required")
  const cleanup = normalizeCleanupConfig(config)
  const remainingMembers = await collectGroupMemberIds(groups, { excludeGroupId: groupId })
  const stillInOtherGroup = remainingMembers.has(qq)
  const profileIds = await listProfileIds(qq)
  const actions = []

  for (const profileId of profileIds) {
    const profile = await loadProfile(qq, profileId).catch(() => null)
    if (!profile) continue

    const originalGroups = (profile.profile?.notify?.fallback_groups || []).map(String)
    const nextGroups = cleanup.remove_group_fallback
      ? originalGroups.filter(id => id !== String(groupId || ""))
      : originalGroups
    const removedFallback = nextGroups.length !== originalGroups.length
    const privatePreferred = profile.profile?.notify?.prefer !== "group"
    const shouldArchive = cleanup.delete_orphan_profiles
      && !stillInOtherGroup
      && !(cleanup.keep_if_private_possible && privatePreferred)

    const action = {
      qq,
      profileId,
      groupId: groupId ? String(groupId) : "",
      reason,
      dryRun: cleanup.dry_run,
      stillInOtherGroup,
      removedFallback,
      archived: false,
      skippedArchiveReason: "",
    }

    if (shouldArchive) {
      if (cleanup.dry_run) {
        action.archived = false
        action.skippedArchiveReason = "dry_run"
      } else {
        action.archivePath = await archiveProfileFile(qq, profileId, now)
        action.archived = true
      }
    } else if (cleanup.delete_orphan_profiles) {
      action.skippedArchiveReason = stillInOtherGroup
        ? "still_in_other_group"
        : cleanup.keep_if_private_possible && privatePreferred
          ? "private_preferred"
          : "not_orphan"
    }

    if (removedFallback && !cleanup.dry_run && !action.archived) {
      profile.profile.notify.fallback_groups = nextGroups
      await saveProfile(profile)
    }

    actions.push(action)
  }

  await appendGroupCleanupAudit({
    time: formatLocalIso(now()),
    reason,
    userId: qq,
    groupId: groupId ? String(groupId) : "",
    stillInOtherGroup,
    dryRun: cleanup.dry_run,
    actions,
  })

  return {
    ok: true,
    userId: qq,
    groupId: groupId ? String(groupId) : "",
    stillInOtherGroup,
    profileCount: profileIds.length,
    actions,
  }
}

export async function cleanupBotLeaveGroup({
  groupId,
  memberIds = [],
  groups,
  config = {},
  now = () => new Date(),
} = {}) {
  const ids = [...new Set(memberIds.map(String).filter(Boolean))]
  const results = []
  for (const userId of ids) {
    results.push(await cleanupMemberLeave({
      userId,
      groupId,
      groups,
      config,
      reason: "bot_leave_group",
      now,
    }))
  }
  return {
    ok: true,
    groupId: groupId ? String(groupId) : "",
    memberCount: ids.length,
    results,
  }
}

export async function collectGroupMemberIds(groups, { excludeGroupId = "" } = {}) {
  const result = new Set()
  for (const group of normalizeGroups(groups)) {
    const groupId = String(group?.group_id || "")
    if (excludeGroupId && groupId === String(excludeGroupId)) continue
    if (!group?.getMemberMap) continue
    try {
      const map = await group.getMemberMap()
      for (const member of normalizeMemberEntries(map)) {
        if (member.user_id) result.add(String(member.user_id))
      }
    } catch (error) {
      logger?.warn?.(`[Lotus-Plugin] group cleanup skipped group ${groupId}: ${error.message}`)
    }
  }
  return result
}

export function normalizeCleanupConfig(config = {}) {
  const source = config.cleanup || config
  return {
    enable: source.enable !== false,
    dry_run: source.dry_run !== false,
    remove_group_fallback: source.remove_group_fallback !== false,
    delete_orphan_profiles: source.delete_orphan_profiles === true,
    keep_if_private_possible: source.keep_if_private_possible !== false,
  }
}

export function summarizeCleanupResult(result = {}) {
  const actions = result.actions || result.results?.flatMap(item => item.actions || []) || []
  const fallback = actions.filter(item => item.removedFallback).length
  const archived = actions.filter(item => item.archived).length
  const dryArchive = actions.filter(item => item.skippedArchiveReason === "dry_run").length
  return [
    { label: "用户", value: result.userId || `${result.memberCount || 0} 人` },
    { label: "群", value: result.groupId || "未知" },
    { label: "Profile", value: String(result.profileCount ?? actions.length) },
    { label: "移除群 fallback", value: String(fallback) },
    { label: "归档 profile", value: String(archived) },
    { label: "Dry-run", value: dryArchive ? `将归档 ${dryArchive} 个` : result.actions?.[0]?.dryRun ? "开启" : "关闭" },
  ]
}

function normalizeGroups(groups) {
  if (!groups) return []
  if (groups instanceof Map) return [...groups.values()]
  if (Array.isArray(groups)) return groups
  if (typeof groups.values === "function") return [...groups.values()]
  if (typeof groups === "object") return Object.values(groups)
  return []
}

function normalizeMemberEntries(source = []) {
  if (source instanceof Map) {
    return [...source.entries()].map(([userId, member]) => ({
      ...(member || {}),
      user_id: String(member?.user_id || userId || ""),
    }))
  }
  if (Array.isArray(source)) {
    return source.map(item => Array.isArray(item)
      ? { ...(item[1] || {}), user_id: String(item[1]?.user_id || item[0] || "") }
      : { ...(item || {}), user_id: String(item?.user_id || item?.userId || item?.qq || item?.id || "") })
  }
  if (source && typeof source === "object") {
    return Object.entries(source).map(([userId, member]) => ({
      ...(member || {}),
      user_id: String(member?.user_id || userId || ""),
    }))
  }
  return []
}

async function archiveProfileFile(qq, profileId, now) {
  const source = profileFilePath(qq, profileId)
  const stamp = formatLocalFileTimestamp(now())
  const target = path.join(resolveData("users-archive", stamp), path.basename(source))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.rename(source, target)
  return target
}

async function appendGroupCleanupAudit(row) {
  const file = resolveData("audit", "group-cleanup.jsonl")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(row)}\n`, "utf8")
}
