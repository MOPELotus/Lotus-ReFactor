const POLICY_ALLOW = "allow"
const POLICY_DENY = "deny"
const POLICY_INHERIT = "inherit"
const POLICY_MASTER_ONLY = "master_only"

export class PermissionService {
  constructor({ permissions = {}, masters = [] } = {}) {
    this.permissions = normalizePermissions(permissions)
    this.masters = new Set([...masters, ...readRuntimeMasters()].map(String))
  }

  can(subject, groupIdOrScope, scope) {
    return this.explain(subject, groupIdOrScope, scope).ok
  }

  explain(subject, groupIdOrScope, scope) {
    const target = resolvePermissionSubject(subject, groupIdOrScope, scope)
    const user = target.user
    const group = target.group
    const scopeRule = this.permissions.scopes[target.scope] || {}
    const policy = scopeRule.policy || POLICY_INHERIT

    if (this.permissions.users.deny.has(user)) {
      return deny("user_deny")
    }
    if (group && this.permissions.groups.deny.has(group)) {
      return deny("group_deny")
    }

    if (policy === POLICY_DENY) {
      return deny("scope_deny")
    }
    if (policy === POLICY_MASTER_ONLY) {
      return this.isMaster(target) ? allow("master") : deny("master_only")
    }
    if (policy === POLICY_ALLOW) {
      return allow("scope_allow")
    }

    if (this.permissions.users.allow.has(user)) {
      return allow("user_allow")
    }
    if (group && this.permissions.groups.allow.has(group)) {
      return allow("group_allow")
    }

    return this.permissions.default_policy === POLICY_DENY
      ? deny("default_deny")
      : allow("default_allow")
  }

  isMaster(subject) {
    const target = resolvePermissionSubject(subject)
    return target.eventIsMaster || this.masters.has(target.user)
  }
}

export function resolvePermissionSubject(subject, groupIdOrScope = "", scope = "") {
  if (isEventLike(subject)) {
    return {
      user: String(subject.user_id || subject.userId || ""),
      group: subject.group_id ? String(subject.group_id) : subject.groupId ? String(subject.groupId) : "",
      scope: scope || String(groupIdOrScope || ""),
      eventIsMaster: isTrue(subject.isMaster),
    }
  }

  if (subject && typeof subject === "object" && "user" in subject) {
    return {
      user: String(subject.user || ""),
      group: subject.group ? String(subject.group) : "",
      scope: subject.scope ? String(subject.scope) : scope || String(groupIdOrScope || ""),
      eventIsMaster: isTrue(subject.eventIsMaster) || isTrue(subject.isMaster),
    }
  }

  return {
    user: String(subject || ""),
    group: groupIdOrScope && scope ? String(groupIdOrScope) : "",
    scope: scope || "",
    eventIsMaster: false,
  }
}

export function normalizePermissions(permissions = {}) {
  return {
    default_policy: normalizePolicy(permissions.default_policy, POLICY_ALLOW),
    users: {
      allow: toSet(permissions.users?.allow),
      deny: toSet(permissions.users?.deny),
    },
    groups: {
      allow: toSet(permissions.groups?.allow),
      deny: toSet(permissions.groups?.deny),
    },
    scopes: normalizeScopes(permissions.scopes),
  }
}

export function migrateLegacyPermissionControl(legacy = {}) {
  const whitelist = [
    ...toArray(legacy.whitelist),
    ...toArray(legacy.whiteList),
    ...toArray(legacy.white_list),
  ]
  const blacklist = [
    ...toArray(legacy.blacklist),
    ...toArray(legacy.blackList),
    ...toArray(legacy.black_list),
  ]
  const mode = String(legacy.mode || "").toLowerCase()

  if (mode.includes("white")) {
    return {
      default_policy: POLICY_DENY,
      users: {
        allow: uniqueStrings(whitelist),
        deny: uniqueStrings(blacklist),
      },
      groups: {
        allow: [],
        deny: [],
      },
      scopes: {},
    }
  }

  return {
    default_policy: mode.includes("deny") ? POLICY_DENY : POLICY_ALLOW,
    users: {
      allow: uniqueStrings(whitelist),
      deny: uniqueStrings(blacklist),
    },
    groups: {
      allow: [],
      deny: [],
    },
    scopes: {},
  }
}

function normalizeScopes(scopes = {}) {
  const result = {}
  for (const [scope, rule] of Object.entries(scopes || {})) {
    result[scope] = {
      ...rule,
      policy: normalizePolicy(rule?.policy, POLICY_INHERIT),
    }
  }
  return result
}

function normalizePolicy(policy, fallback) {
  const value = String(policy || fallback)
  return [POLICY_ALLOW, POLICY_DENY, POLICY_INHERIT, POLICY_MASTER_ONLY].includes(value)
    ? value
    : fallback
}

function readRuntimeMasters() {
  const config = globalThis.Bot?.config || globalThis.Bot?.cfg || {}
  return [
    ...toArray(config.masterQQ),
    ...toArray(config.master),
    ...toArray(config.master_qq),
  ]
}

function isEventLike(value) {
  return value && typeof value === "object" && (
    Object.prototype.hasOwnProperty.call(value, "user_id")
    || Object.prototype.hasOwnProperty.call(value, "group_id")
    || Object.prototype.hasOwnProperty.call(value, "isMaster")
  )
}

function isTrue(value) {
  if (typeof value === "function") {
    try {
      return isTrue(value())
    } catch {
      return false
    }
  }
  return value === true || value === 1 || value === "true"
}

function toSet(value) {
  return new Set(toArray(value).map(String).filter(Boolean))
}

function toArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function uniqueStrings(values) {
  return [...new Set(toArray(values).map(String).filter(Boolean))]
}

function allow(reason) {
  return {
    ok: true,
    reason,
  }
}

function deny(reason) {
  return {
    ok: false,
    reason,
  }
}
