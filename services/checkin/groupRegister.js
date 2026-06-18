import {
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
    const nickname = groupMemberDisplayName(member)
    const profile = await loadProfileIfExists(qq, profileId)
    if (!profile) {
      results.push({
        qq,
        profileId,
        nickname,
        ok: false,
        skipped: true,
        reason: "missing_profile",
      })
      continue
    }

    if (!hasSigninLoginState(profile)) {
      results.push({
        qq,
        profileId,
        nickname,
        ok: false,
        skipped: true,
        reason: "missing_login",
      })
      continue
    }

    const alreadyEnabled = profile.enabled === true
    const fallbackGroups = profile.profile?.notify?.fallback_groups || []
    const alreadyInGroup = fallbackGroups.map(String).includes(resolvedGroupId)
    profile.enabled = true
    profile.user ||= {}
    profile.user.nickname ||= nickname
    profile.profile ||= {}
    profile.profile.notify ||= {}
    profile.profile.notify.fallback_groups ||= []
    if (!alreadyInGroup) {
      profile.profile.notify.fallback_groups.push(resolvedGroupId)
    }
    if (!alreadyEnabled || !alreadyInGroup) {
      await saveProfile(profile)
    }
    results.push({
      qq,
      profileId,
      nickname,
      ok: true,
      registered: true,
      updated: !alreadyEnabled || !alreadyInGroup,
      existing: alreadyEnabled && alreadyInGroup,
    })
  }

  const updated = results.filter(item => item.updated).length
  const existing = results.filter(item => item.existing).length
  const skipped = results.filter(item => item.skipped).length
  return {
    groupId: resolvedGroupId,
    profileId,
    totalMembers: members.length,
    created: 0,
    updated,
    registered: updated + existing,
    existing,
    skipped,
    results,
  }
}

async function loadProfileIfExists(qq, profileId) {
  try {
    return await loadProfile(qq, profileId)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function hasSigninLoginState(profile) {
  const account = profile?.account || {}
  return Boolean(account.cookie && (account.stoken || account.stoken_cookie))
}
