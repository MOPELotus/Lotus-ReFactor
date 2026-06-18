const BasePlugin = globalThis.plugin

import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { TestNineServerService } from "../services/testNine/server.js"

export class LotusTestNine extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] TestNine",
      dsc: "Lotus test_nine local service manager",
      event: "message",
      priority: 10,
      rule: [
        { reg: "^#启动testnine服务$", fnc: "start" },
        { reg: "^#停止testnine服务$", fnc: "stop" },
        { reg: "^#testnine状态$", fnc: "status" },
      ],
    })
  }

  async start() {
    if (!await this.canManage()) return true
    await replyText(this, "[荷花插件]正在启动 test_nine 本地服务，首次会检查 venv 和模型。")
    const globalConfig = await loadGlobalConfig()
    const result = await new TestNineServerService({
      config: globalConfig.captcha?.test_nine,
      pythonConfig: globalConfig.python,
    }).start()
    await replyImage(this, await renderServerStatus("test_nine 服务", result, this.e.user_id), result.ok
      ? "[荷花插件]test_nine 服务已启动。"
      : "[荷花插件]test_nine 服务启动失败。")
    return true
  }

  async stop() {
    if (!await this.canManage()) return true
    const result = new TestNineServerService().stop()
    await replyImage(this, await renderServerStatus("test_nine 服务", result, this.e.user_id), "[荷花插件]test_nine 服务停止指令已发送。")
    return true
  }

  async status() {
    if (!await this.canManage()) return true
    const result = new TestNineServerService().status()
    await replyImage(this, await renderServerStatus("test_nine 状态", result, this.e.user_id), "[荷花插件]test_nine 状态已生成。")
    return true
  }

  async canManage() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e.user_id, this.e.group_id, "captcha.manage")
    if (permission.ok) return true
    await replyText(this, "[荷花插件]只有 bot 主人可以管理 test_nine 服务。")
    return false
  }
}

async function renderServerStatus(title, result, userId) {
  return renderStatusCard({
    title,
    subtitle: result.endpoint || "http://127.0.0.1:9645/pass_uni",
    badge: result.ok ? result.running === false ? "停止" : "完成" : "失败",
    message: result.ok
      ? result.alreadyRunning ? "服务已经在运行。" : result.stopped ? "停止信号已发送。" : result.running === false ? "服务未运行。" : "本地服务状态正常。"
      : `操作失败：${result.reason || "unknown"}`,
    userId,
    items: [
      { label: "PID", value: result.pid || "-" },
      { label: "启动时间", value: result.startedAt || "-" },
      { label: "日志", value: result.logFile || "-" },
      { label: "输出", value: (result.lastOutput || "").slice(-120) || "无" },
    ],
  }, {
    saveId: `lotus-test-nine-${userId || "system"}`,
  })
}
