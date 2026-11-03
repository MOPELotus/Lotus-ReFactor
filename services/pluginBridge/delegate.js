import { randomUUID } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"

const delegated = Symbol.for("Lotus-Plugin.delegated")

export function parseExecution(e) {
  const raw = String(e.msg || e.raw_message || "").trim()
  const legacy = /^#execute\s+/i.test(raw)
  const quick = /^#?代/.test(raw)
  let text = raw.replace(legacy ? /^#execute\s+/i : quick ? /^#?代\s*/ : /^#执行\s*/, "")
  const options = { users: [], group: "本群", gap: 5, hold: false, command: "" }
  if (legacy) {
    const match = text.match(/\brun:\s*([\s\S]+)$/)
    if (!match) throw new Error("缺少 run: 后的指令")
    options.command = match[1]; text = text.slice(0, match.index)
    options.group = text.match(/\bin:(here|@s|@e|\d+)/)?.[1] || "本群"
    options.group = ({ here: "本群", "@s": "私聊", "@e": "全部群" })[options.group] || options.group
    options.gap = Number(text.match(/\bgap:(\d+)/)?.[1] ?? 5)
    options.hold = /\bhold:true\b/.test(text)
    text = text.match(/\bas:([\s\S]*?)(?=\s(?:in|gap|hold):|$)/)?.[1] || ""
  } else {
    // The command is the suffix after --, or the first # following the targets.
    const split = text.indexOf("--") >= 0 ? text.indexOf("--") : text.indexOf("#")
    if (split >= 0) {
      options.command = text.slice(split + (text.startsWith("--", split) ? 2 : 0)).trim()
      text = text.slice(0, split)
    } else if (quick) {
      const match = text.match(/^(\d+)?\s*(.+)$/s)
      options.command = match?.[2]?.trim() || ""
      text = match?.[1] || ""
    }
    options.group = text.match(/群=(本群|私聊|全部群|\d+)/)?.[1] || "本群"
    options.gap = Number(text.match(/间隔=(\d+(?:\.\d+)?)/)?.[1] ?? 5)
    options.hold = /静默=开/.test(text)
    text = text.replace(/(?:群|间隔|静默)=\S+/g, "")
  }
  const segments = e.message || []
  const plain = segments.filter(s => s.type === "text").map(s => s.text || "").join("")
  let commandOffset = plain.lastIndexOf(options.command)
  if (commandOffset < 0 && options.command) commandOffset = plain.indexOf(options.command.split(/\s/)[0])
  let offset = 0
  const routing = new Set()
  for (const segment of segments) {
    if (segment.type === "text") offset += String(segment.text || "").length
    else if (segment.type === "at" && String(segment.qq) !== String(e.self_id) && (commandOffset < 0 ? routing.size === 0 : offset <= commandOffset)) routing.add(segment)
  }
  const ats = [...routing].map(s => String(s.qq))
  options.users = /全员|@a\b/.test(text) ? "all" : [...new Set([...ats, ...(text.replace(/\[CQ:at[^\]]*\]/g, "").match(/\d+/g) || [])])]
  if (!options.command || options.users.length === 0) throw new Error("用法：#代 @用户 #体力2，或 #执行 全员 群=本群 间隔=5 静默=关 -- #体力")
  if (/^#?(?:代|执行|execute\b)/i.test(options.command) || e[delegated]) throw new Error("不能嵌套代操作或执行指令")
  if (!Number.isFinite(options.gap) || options.gap < 0 || options.gap > 86400) throw new Error("间隔需为 0–86400 秒")
  // Only mentions before the command select recipients. Mentions within the
  // delegated command remain arguments and must not create additional tasks.
  options.segments = segments.filter(s => s.type !== "text" && !routing.has(s) && !(s.type === "at" && String(s.qq) === String(e.self_id))).map(s => ({ ...s }))
  return options
}

export async function executionTasks(bot, options, e) {
  if (options.group === "私聊" && options.users === "all") throw new Error("私聊执行需指定用户")
  const groups = options.group === "全部群" ? [...bot.gl.keys()] : options.group === "私聊" ? [null] : [options.group === "本群" ? e.group_id || null : options.group]
  const tasks = []
  for (const groupId of groups) {
    const group = groupId ? bot.pickGroup(groupId) : null
    const users = options.users === "all" ? [...(await group?.getMemberMap() || new Map()).keys()] : options.users
    for (const userId of users) if (String(userId) !== String(e.self_id)) tasks.push({ userId: String(userId), groupId })
  }
  return tasks
}

export function createDelegatedEvent(base, task, options) {
  const bot = base.bot || globalThis.Bot?.[base.self_id] || globalThis.Bot
  const group = task.groupId ? bot.pickGroup(task.groupId) : null
  const friend = bot.pickFriend?.(task.userId)
  const member = group?.pickMember(task.userId)
  const destination = group || friend
  if (!destination?.sendMsg) throw new Error("目标会话不可用")
  const e = {
    bot, self_id: base.self_id || bot.uin, user_id: task.userId, from_id: task.userId,
    post_type: "message", message_type: group ? "group" : "private", sub_type: group ? "normal" : "friend",
    time: Math.floor(Date.now() / 1000), message_id: `lotus-execute-${randomUUID()}`,
    raw_message: options.command, original_msg: options.command,
    message: [{ type: "text", text: options.command }, ...(options.segments || []).map(s => ({ ...s }))],
    friend, ...(group ? { group, group_id: task.groupId, group_name: group.name, member } : {}),
    sender: { ...(member?.info || friend?.info || {}), user_id: task.userId },
    atme: true, atBot: true, [delegated]: true,
  }
  let replies = 0
  e.reply = async payload => { replies++; return options.hold ? { message_id: e.message_id } : destination.sendMsg(payload) }
  return { event: e, replyCount: () => replies }
}

export async function dispatchDelegated(event, loader = null) {
  loader ||= (await import(pathToFileURL(path.join(process.cwd(), "lib/plugins/loader.js")).href)).default
  // Bypass the initiating command's cooldown only for this authorized event.
  // No shared cooldown tables are deleted or modified by the adapter.
  const isolated = Object.create(loader)
  isolated.checkLimit = () => true
  isolated.setLimit = () => {}
  await isolated.deal(event)
  return { matched: Boolean(event.logFnc) }
}
