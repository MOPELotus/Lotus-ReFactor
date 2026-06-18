const POLICY_ALIASES = {
  allow: "allow",
  "允许": "allow",
  deny: "deny",
  "拒绝": "deny",
  inherit: "inherit",
  "继承": "inherit",
  master_only: "master_only",
  master: "master_only",
  "主人": "master_only",
  "主人限定": "master_only",
}

export function parsePermissionCommand(message = "") {
  const text = String(message || "").trim()
  if (/^#权限(列表|名单|配置)$/.test(text)) {
    return {
      type: "list",
    }
  }

  if (/^#签到(黑|白)名单列表$/.test(text)) {
    return {
      type: "list",
    }
  }

  let match = text.match(/^#自动签到(黑|白)名单$/)
  if (match) {
    return {
      type: "defaultPolicy",
      policy: match[1] === "白" ? "deny" : "allow",
    }
  }

  match = text.match(/^#权限(允许|拒绝|移除)(用户|群)\s+(.+)$/)
  if (match) {
    return {
      type: "listUpdate",
      action: actionName(match[1]),
      subject: subjectName(match[2]),
      id: normalizeId(match[3]),
    }
  }

  match = text.match(/^#权限(用户|群)(白名单|黑名单|移除)\s+(.+)$/)
  if (match) {
    return {
      type: "listUpdate",
      action: actionName(match[2]),
      subject: subjectName(match[1]),
      id: normalizeId(match[3]),
    }
  }

  match = text.match(/^#(添加|删除)(黑|白)名单\s*(.+)$/)
  if (match) {
    return {
      type: "listUpdate",
      action: legacyListAction(match[1], match[2]),
      subject: "users",
      id: normalizeId(match[3]),
    }
  }

  match = text.match(/^#权限设置\s+([\w.-]+)\s+([\w\u4e00-\u9fa5_]+)$/)
  if (match) {
    const policy = normalizePolicy(match[2])
    if (!policy) {
      return {
        type: "invalid",
        reason: "unknown_policy",
      }
    }
    return {
      type: "scopePolicy",
      scope: match[1],
      policy,
    }
  }

  return {
    type: "invalid",
    reason: "unknown_command",
  }
}

export function applyPermissionCommand(config, command) {
  const next = structuredClone(config)
  next.permissions ||= {}
  next.permissions.users ||= { allow: [], deny: [] }
  next.permissions.groups ||= { allow: [], deny: [] }
  next.permissions.scopes ||= {}

  if (command.type === "listUpdate") {
    updateList(next.permissions, command)
    return next
  }

  if (command.type === "scopePolicy") {
    next.permissions.scopes[command.scope] = {
      ...(next.permissions.scopes[command.scope] || {}),
      policy: command.policy,
    }
    return next
  }

  if (command.type === "defaultPolicy") {
    next.permissions.default_policy = command.policy
    return next
  }

  throw new Error(`Unsupported permission command: ${command.type}`)
}

export function summarizePermissions(permissions = {}) {
  const scopes = permissions.scopes || {}
  return [
    { label: "默认策略", value: permissions.default_policy || "allow" },
    { label: "用户白名单", value: summarizeList(permissions.users?.allow) },
    { label: "用户黑名单", value: summarizeList(permissions.users?.deny) },
    { label: "群白名单", value: summarizeList(permissions.groups?.allow) },
    { label: "群黑名单", value: summarizeList(permissions.groups?.deny) },
    {
      label: "Scope",
      value: Object.keys(scopes).length
        ? Object.entries(scopes).map(([scope, rule]) => `${scope}:${rule.policy || "inherit"}`).join(" / ").slice(0, 120)
        : "未配置",
    },
  ]
}

function updateList(permissions, command) {
  const bucket = permissions[command.subject]
  bucket.allow ||= []
  bucket.deny ||= []

  remove(bucket.allow, command.id)
  remove(bucket.deny, command.id)

  if (command.action === "allow") bucket.allow.push(command.id)
  if (command.action === "deny") bucket.deny.push(command.id)
}

function remove(list, id) {
  const index = list.map(String).indexOf(String(id))
  if (index >= 0) list.splice(index, 1)
}

function actionName(value) {
  if (value === "允许" || value === "白名单") return "allow"
  if (value === "拒绝" || value === "黑名单") return "deny"
  return "remove"
}

function legacyListAction(action, listType) {
  if (action === "删除") return "remove"
  return listType === "白" ? "allow" : "deny"
}

function subjectName(value) {
  return value === "群" ? "groups" : "users"
}

function normalizePolicy(value) {
  return POLICY_ALIASES[String(value || "").trim().toLowerCase()] || POLICY_ALIASES[String(value || "").trim()]
}

function normalizeId(value) {
  return String(value || "").trim().replace(/^@/, "")
}

function summarizeList(value) {
  const list = Array.isArray(value) ? value.map(String).filter(Boolean) : []
  if (!list.length) return "空"
  if (list.length <= 8) return list.join("、")
  return `${list.slice(0, 8).join("、")} 等 ${list.length} 项`
}
