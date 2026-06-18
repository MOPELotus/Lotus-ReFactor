const BasePlugin = globalThis.plugin

import { loadGlobalConfig, saveGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import {
  applyPermissionCommand,
  parsePermissionCommand,
  summarizePermissions,
} from "../core/permissions/manage.js"
import { writePermissionAudit } from "../core/permissions/audit.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"

export class LotusPermissions extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Permissions",
      dsc: "Lotus scope permission manager",
      event: "message",
      priority: 20,
      rule: [
        {
          reg: "^#权限(列表|名单|配置)$",
          fnc: "permissionCommand",
        },
        {
          reg: "^#自动签到(黑|白)名单$",
          fnc: "permissionCommand",
        },
        {
          reg: "^#(添加|删除)(黑|白)名单\\s*.+$",
          fnc: "permissionCommand",
        },
        {
          reg: "^#签到(黑|白)名单列表$",
          fnc: "permissionCommand",
        },
        {
          reg: "^#权限(允许|拒绝|移除)(用户|群)\\s+.+$",
          fnc: "permissionCommand",
        },
        {
          reg: "^#权限(用户|群)(白名单|黑名单|移除)\\s+.+$",
          fnc: "permissionCommand",
        },
        {
          reg: "^#权限设置\\s+[\\w.-]+\\s+[\\w\\u4e00-\\u9fa5_]+$",
          fnc: "permissionCommand",
        },
      ],
    })
  }

  async permissionCommand() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
    if (!permission.isMaster(this.e)) {
      await replyText(this, "[荷花插件]只有 bot 主人可以修改或查看权限配置。")
      return true
    }

    const command = parsePermissionCommand(this.e.msg)
    if (command.type === "invalid") {
      await replyText(this, "[荷花插件]权限指令格式错误。")
      return true
    }

    let config = globalConfig
    let badge = "查看"
    let message = "当前权限配置如下。"

    if (command.type !== "list") {
      config = applyPermissionCommand(globalConfig, command)
      await saveGlobalConfig(config)
      await writePermissionAudit({
        actor: this.e.user_id,
        group: this.e.group_id,
        command,
        result: "ok",
      })
      badge = "已更新"
      message = formatUpdateMessage(command)
    }

    const image = await renderStatusCard({
      title: "权限配置",
      subtitle: "荷花插件 scope 权限",
      badge,
      message,
      userId: this.e.user_id,
      items: summarizePermissions(config.permissions),
    }, {
      saveId: `lotus-permissions-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, "[荷花插件]权限配置已更新。")
    return true
  }
}

function formatUpdateMessage(command) {
  if (command.type === "listUpdate") {
    const subject = command.subject === "groups" ? "群" : "用户"
    const action = command.action === "allow" ? "允许" : command.action === "deny" ? "拒绝" : "移除"
    return `已${action}${subject} ${command.id}。`
  }
  if (command.type === "scopePolicy") {
    return `已设置 scope ${command.scope} 为 ${command.policy}。`
  }
  if (command.type === "defaultPolicy") {
    return command.policy === "deny"
      ? "已切换为白名单模式：未列入允许名单的用户会被默认拒绝。"
      : "已切换为黑名单模式：未列入拒绝名单的用户会被默认允许。"
  }
  return "权限配置已更新。"
}
