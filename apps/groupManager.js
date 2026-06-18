const BasePlugin = globalThis.plugin

import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage } from "../core/transport/reply.js"
import {
  cleanupBotLeaveGroup,
  cleanupMemberLeave,
  summarizeCleanupResult,
} from "../services/group/cleanup.js"
import { generateGroupMembersCsv } from "../services/group/members.js"

export class LotusGroupManager extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Group Manager",
      dsc: "Lotus group member export",
      event: "message",
      priority: 20,
      rule: [
        {
          reg: "^#(?:Lotus|荷花)?群成员\\s*(\\d*)$",
          fnc: "sendGroupMembersFile",
        },
        {
          reg: "^#群清理退群\\s+\\d+\\s*(\\d*)$",
          fnc: "manualCleanupMemberLeave",
        },
      ],
    })
  }

  async sendGroupMembersFile() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e.user_id, this.e.group_id, "group.members.export")
    if (!permission.ok) {
      await this.replyStatus("群成员导出", "拒绝", "只有 bot 主人可以导出群成员列表。", [
        { label: "原因", value: permission.reason },
      ])
      return true
    }

    const groupId = this.e.msg.match(/\d+/)?.[0] || (this.e.isGroup ? String(this.e.group_id) : "")
    const group = groupId ? globalThis.Bot?.pickGroup?.(Number(groupId)) : this.e.group
    if (!group?.getMemberMap) {
      await this.replyStatus("群成员导出", "失败", "无法获取目标群，机器人可能不在该群。", [
        { label: "群号", value: groupId || "未指定" },
      ])
      return true
    }

    try {
      const result = await generateGroupMembersCsv(group, { groupId })
      await sendFile(this.e, result.file, `${result.groupId}.csv`)
      await this.replyStatus("群成员导出", "完成", "CSV 已生成并尝试发送。建议用 VSCode 或 Notepad++ 打开。", [
        { label: "群号", value: result.groupId },
        { label: "成员数", value: String(result.count) },
      ])
    } catch (error) {
      logger?.error?.(`[Lotus-Plugin] group member export failed: ${error.stack || error.message}`)
      await this.replyStatus("群成员导出", "失败", error.message, [
        { label: "群号", value: groupId || "未知" },
      ])
    }
    return true
  }

  async manualCleanupMemberLeave() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e.user_id, this.e.group_id, "group.cleanup")
    if (!permission.ok) {
      await this.replyStatus("群配置清理", "拒绝", "只有 bot 主人可以执行群配置清理。", [
        { label: "原因", value: permission.reason },
      ])
      return true
    }

    const match = String(this.e.msg || "").match(/^#群清理退群\s+(\d+)\s*(\d*)$/)
    const userId = match?.[1]
    const groupId = match?.[2] || (this.e.isGroup ? String(this.e.group_id) : "")
    if (!userId) {
      await this.replyStatus("群配置清理", "失败", "缺少用户 QQ。", [])
      return true
    }

    const result = await cleanupMemberLeave({
      userId,
      groupId,
      groups: globalThis.Bot?.gl,
      config: globalConfig.groups?.cleanup,
      reason: "manual_cleanup",
    })
    await this.replyStatus(
      "群配置清理",
      result.actions?.some(item => item.dryRun) ? "预览" : "完成",
      "清理结果已写入审计日志。默认 dry-run 只预览和记录，不会删除配置。",
      summarizeCleanupResult(result),
    )
    return true
  }

  async replyStatus(title, badge, message, items) {
    const image = await renderStatusCard({
      title,
      subtitle: "荷花插件群管理",
      badge,
      message,
      userId: this.e?.user_id || "user",
      items,
    }, {
      saveId: `lotus-group-members-${this.e?.user_id || "user"}`,
    })
    await replyImage(this, image, `[荷花插件]${title}${badge}`)
  }
}

export class LotusGroupNoticeCleaner extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Group Notice Cleaner",
      dsc: "Lotus group decrease cleanup",
      event: "notice.group.decrease",
      priority: 20,
      rule: [
        {
          fnc: "noticeGroupDecrease",
        },
      ],
    })
  }

  async noticeGroupDecrease() {
    const globalConfig = await loadGlobalConfig()
    const cleanupConfig = globalConfig.groups?.cleanup || {}
    if (cleanupConfig.enable === false) return false

    const e = this.e || {}
    const groupId = String(e.group_id || "")
    const leavingUserId = String(e.user_id || "")
    const botId = String(globalThis.Bot?.uin || e.self_id || "")

    try {
      if (leavingUserId && botId && leavingUserId === botId) {
        const result = await cleanupBotLeaveGroup({
          groupId,
          memberIds: memberIdsFromGroupCache(groupId),
          groups: globalThis.Bot?.gl,
          config: cleanupConfig,
        })
        logger?.mark?.(`[Lotus-Plugin] bot leave group cleanup ${groupId}: ${result.memberCount} members`)
        return true
      }

      if (leavingUserId) {
        const result = await cleanupMemberLeave({
          userId: leavingUserId,
          groupId,
          groups: globalThis.Bot?.gl,
          config: cleanupConfig,
          reason: e.sub_type === "kick" ? "member_kick" : "member_leave",
        })
        logger?.mark?.(`[Lotus-Plugin] member leave cleanup ${leavingUserId}: ${result.actions.length} profiles`)
        return true
      }
    } catch (error) {
      logger?.error?.(`[Lotus-Plugin] group cleanup failed: ${error.stack || error.message}`)
    }
    return false
  }
}

async function sendFile(e, file, name) {
  if (e.isGroup && e.group?.sendFile) return e.group.sendFile(file, name)
  if (e.friend?.sendFile) return e.friend.sendFile(file, name)
  throw new Error("当前适配器不支持发送文件")
}

function memberIdsFromGroupCache(groupId) {
  const cache = globalThis.Bot?.gml?.get?.(Number(groupId)) || globalThis.Bot?.gml?.get?.(String(groupId))
  if (!cache) return []
  if (cache instanceof Map) return [...cache.keys()].map(String)
  if (Array.isArray(cache)) return cache.map(item => String(item?.user_id || item?.userId || item?.qq || item)).filter(Boolean)
  if (typeof cache === "object") return Object.keys(cache).map(String)
  return []
}
