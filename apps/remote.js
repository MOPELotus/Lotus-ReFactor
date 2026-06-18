const BasePlugin = globalThis.plugin

import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { RemoteSpawnService } from "../services/remote/spawn.js"
import { RemoteFileService, extractUploadSource } from "../services/remote/file.js"
import { createRemoteOtpSetup, remoteOtpStatus } from "../services/remote/otp.js"
import {
  parseRemoteDownload,
  parseRemoteSpawn,
  parseRemoteUpload,
} from "../services/remote/parse.js"

export class LotusRemote extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Remote",
      dsc: "Lotus guarded remote spawn",
      event: "message",
      priority: 1,
      rule: [
        {
          reg: "^#远程(2FA|OTP)(初始化|重置|绑定)$",
          fnc: "setupOtp",
        },
        {
          reg: "^#远程(2FA|OTP)状态$",
          fnc: "otpStatus",
        },
        {
          reg: "^#(远程管理员spawn|admin\\s+spawn|远程spawn|spawn)\\s+\\d{6}\\s+(pwsh|powershell|cmd)\\s+[\\s\\S]+$",
          fnc: "spawnCommand",
        },
        {
          reg: "^#远程下载\\s+\\d{6}\\s+[\\s\\S]+$",
          fnc: "download",
        },
        {
          reg: "^#(远程上传(覆盖)?|上传)\\s+\\d{6}\\s+[\\s\\S]+$",
          fnc: "upload",
        },
      ],
    })
  }

  async setupOtp() {
    const permission = await this.checkRemoteMaster()
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以初始化远程 2FA。")
      return true
    }

    try {
      const setup = await createRemoteOtpSetup({
        userId: this.e.user_id,
        issuer: "荷花插件",
        overwrite: true,
      })
      const image = await renderTemplate("qr-login", {
        title: "远程 2FA 初始化",
        subtitle: "Microsoft Authenticator / TOTP",
        badge: setup.reused ? "已有" : "新建",
        notice: "使用 Microsoft Authenticator 扫描二维码添加荷花插件远程管理。之后执行远程 spawn、管理员 spawn、上传、下载时输入 6 位一次性验证码。",
        userId: this.e.user_id,
        qrDataUrl: setup.qrDataUrl,
        profileId: setup.config.account,
      }, {
        saveId: `lotus-remote-otp-${this.e.user_id || "master"}`,
      })
      await replyImage(this, image, "[荷花插件]远程 2FA 二维码已生成。")
    } catch (error) {
      await replyText(this, `[荷花插件]远程 2FA 初始化失败：${error.message}`)
    }
    return true
  }

  async otpStatus() {
    const permission = await this.checkRemoteMaster()
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以查看远程 2FA 状态。")
      return true
    }
    const globalConfig = await loadGlobalConfig()
    const status = await remoteOtpStatus(globalConfig.remote || {})
    const image = await renderStatusCard({
      title: "远程 2FA 状态",
      subtitle: `QQ ${this.e.user_id}`,
      badge: status.ok ? "已配置" : "未配置",
      message: status.message,
      userId: this.e.user_id,
      items: [
        { label: "来源", value: status.source || "-" },
        { label: "账号", value: status.account || "-" },
        { label: "创建时间", value: status.createdAt || "-" },
      ],
    }, {
      saveId: `lotus-remote-otp-status-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, "[荷花插件]远程 2FA 状态已生成。")
    return true
  }

  async spawnCommand() {
    const parsed = parseRemoteSpawn(this.e.msg)
    if (!parsed) {
      await replyText(this, "[荷花插件]格式：#远程spawn 123456 pwsh Get-Process")
      return true
    }

    await replyText(this, "[荷花插件]正在 spawn 远程命令，完成后返回摘要图。")
    const result = await new RemoteSpawnService().spawnCommand({
      e: this.e,
      ...parsed,
    })
    const image = await renderStatusCard({
      title: "远程 Spawn",
      subtitle: `QQ ${this.e.user_id} · ${parsed.shell}`,
      badge: result.ok ? "成功" : "失败",
      message: result.ok
        ? (result.stdout || "命令运行成功，无 stdout。").slice(0, 220)
        : `${result.reason || result.stderr || "命令运行失败"}`.slice(0, 220),
      userId: this.e.user_id,
      items: [
        { label: "阶段", value: result.stage || "spawn" },
        { label: "管理员", value: parsed.admin ? "请求" : "否" },
        { label: "退出码", value: result.code ?? "-" },
        { label: "超时", value: result.timedOut ? "是" : "否" },
        { label: "stderr", value: result.stderr ? result.stderr.slice(0, 80) : "无" },
      ],
    }, {
      saveId: `lotus-remote-${this.e.user_id || "system"}`,
    })
    await replyImage(this, image, "[荷花插件]远程 spawn 完成。")
    return true
  }

  async download() {
    const parsed = parseRemoteDownload(this.e.msg)
    if (!parsed) {
      await replyText(this, "[荷花插件]格式：#远程下载 123456 C:\\path\\file.txt")
      return true
    }

    await replyText(this, "[荷花插件]正在校验远程下载请求。")
    const result = await new RemoteFileService().download({
      e: this.e,
      ...parsed,
    })
    if (result.ok && globalThis.segment?.file) {
      await this.e.reply(globalThis.segment.file(result.path, result.name))
    }
    const image = await renderRemoteFileResult("远程下载", result, this.e.user_id)
    await replyImage(this, image, result.ok ? "[荷花插件]远程下载完成。" : "[荷花插件]远程下载失败。")
    return true
  }

  async upload() {
    const parsed = parseRemoteUpload(this.e.msg)
    if (!parsed) {
      await replyText(this, "[荷花插件]格式：#远程上传 123456 C:\\target\\file.txt，或 #上传 123456 C:\\target\\file.txt，并在同一条消息附带文件。")
      return true
    }

    const source = extractUploadSource(this.e)
    if (!source) {
      await replyText(this, "[荷花插件]没有找到可上传的文件，请在同一条消息附带文件或文件 URL。")
      return true
    }

    await replyText(this, "[荷花插件]正在校验并写入上传文件。")
    const result = await new RemoteFileService().upload({
      e: this.e,
      otp: parsed.otp,
      target: parsed.target,
      overwrite: parsed.overwrite,
      source,
    })
    const image = await renderRemoteFileResult("远程上传", result, this.e.user_id)
    await replyImage(this, image, result.ok ? "[荷花插件]远程上传完成。" : "[荷花插件]远程上传失败。")
    return true
  }

  async checkRemoteMaster() {
    const globalConfig = await loadGlobalConfig()
    return new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e.user_id, this.e.group_id, "remote.spawn")
  }
}

async function renderRemoteFileResult(title, result, userId) {
  return renderStatusCard({
    title,
    subtitle: `QQ ${userId}`,
    badge: result.ok ? "成功" : "失败",
    message: result.ok
      ? `${result.name || "文件"} · ${formatBytes(result.size || 0)}`
      : `${result.reason || "操作失败"}`,
    userId,
    items: [
      { label: "阶段", value: result.stage || "-" },
      { label: "大小", value: result.size ? formatBytes(result.size) : "-" },
      { label: "限制", value: result.maxBytes ? formatBytes(result.maxBytes) : "-" },
      { label: "覆盖", value: result.overwrite ? "是" : "否" },
    ],
  }, {
    saveId: `lotus-remote-file-${userId || "system"}`,
  })
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
