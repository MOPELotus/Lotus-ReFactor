import {
  ensureProfile,
  loadProfile,
  saveProfile,
} from "../../core/config/profile.js"
import {
  groupMemberDisplayName,
  normalizeGroupMemberEntries,
} from "../group/members.js"

export async function registerGroupCheckinProfiles({
  group,
  groupId = "",
  profileId = 1,
  skipUserIds = [],
} = {}) {
  if (!group?.getMemberMap) throw new Error("group is unavailable")
  const resolvedGroupId = String(groupId || group.group_id || "")
  if (!resolvedGroupId) throw new Error("group id is required")

  const skipSet = new Set(skipUserIds.map(String))
  const members = normalizeGroupMemberEntries(await group.getMemberMap())
    .filter(member => member.user_id && !skipSet.has(member.user_id))

  const results = []
  for (const member of members) {
    const qq = member.user_id
    const existing = await profileExists(qq, profileId)
    if (existing) {
      results.push({
        qq,
        profileId,
        nickname: groupMemberDisplayName(member),
        created: false,
        reason: "exists",
      })
      continue
    }

    const profile = await ensureProfile({
      qq,
      profileId,
      nickname: groupMemberDisplayName(member),
    })
    profile.enabled = true
    profile.profile.notify ||= {}
    profile.profile.notify.fallback_groups ||= []
    if (!profile.profile.notify.fallback_groups.map(String).includes(resolvedGroupId)) {
      profile.profile.notify.fallback_groups.push(resolvedGroupId)
    }
    await saveProfile(profile)
    results.push({
      qq,
      profileId,
      nickname: groupMemberDisplayName(member),
      created: true,
    })
  }

  const created = results.filter(item => item.created).length
  return {
    groupId: resolvedGroupId,
    profileId,
    totalMembers: members.length,
    created,
    existing: results.length - created,
    results,
  }
}

async function profileExists(qq, profileId) {
  try {
    await loadProfile(qq, profileId)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}
