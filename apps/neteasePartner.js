const BasePlugin = globalThis.plugin

import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { buildPartnerItems, NeteasePartnerService } from "../services/neteasePartner/service.js"

export class LotusNeteasePartner extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Netease Partner",
      dsc: "Lotus netease music partner",
      event: "message",
      priority: 20,
      rule: [
        { reg: "^#合伙人测试$", fnc: "manualTest" },
        { reg: "^#合伙人登录$", fnc: "partnerLogin" },
        { reg: "^#合伙人日志$", fnc: "partnerLog" },
      ],
    })
    this.task = [
      {
        name: "荷花插件网易云合伙人任务",
        cron: "0 5 0 * * *",
        fnc: this.scheduledTask.bind(this),
        log: false,
      },
    ]
  }

  async init() {
    try {
      const globalConfig = await loadGlobalConfig()
      const config = globalConfig.netease_partner || {}
      this.task = [
        {
          name: "荷花插件网易云合伙人任务",
          cron: config.schedule || "0 5 0 * * *",
          fnc: this.scheduledTask.bind(this),
          log: false,
        },
      ]
      await this.scheduleStartupCatchUp(config)
    } catch (error) {
      logger?.warn?.(`[Lotus-Plugin] load netease partner task failed: ${error.message}`)
    }
  }

  async scheduleStartupCatchUp(config) {
    const service = new NeteasePartnerService()
    if (!await service.shouldCatchUp(config).catch(() => false)) return
    logger?.mark?.("[Lotus-Plugin] netease partner catch-up scheduled in 60s")
    setTimeout(() => {
      this.scheduledTask({ trigger: "启动补跑" }).catch(error => {
        logger?.error?.(`[Lotus-Plugin] netease partner catch-up failed: ${error.stack || error.message}`)
      })
    }, 60 * 1000)
  }

  async scheduledTask(options = {}) {
    const globalConfig = await loadGlobalConfig()
    const config = globalConfig.netease_partner || {}
    if (config.enable === false) {
      return {
        ok: true,
        disabled: true,
      }
    }
    const report = await new NeteasePartnerService().executeTask(
      config,
      options.trigger || "自动任务",
      { recordRun: true },
    )
    logger?.mark?.(`[Lotus-Plugin] netease partner task finished: ${report.accounts?.length || 0} account(s)`)
    return report
  }

  async partnerLogin() {
    const globalConfig = await loadGlobalConfig()
    if (!await this.requireMaster(globalConfig)) return true
    const service = new NeteasePartnerService()
    try {
      const config = globalConfig.netease_partner || {}
      const qr = await service.createQrLogin(config.api_url)
      const image = await renderTemplate("qr-login", {
        title: "网易云登录",
        subtitle: "音乐合伙人",
        badge: "5 MIN",
        notice: "使用网易云音乐 App 扫码确认。完成后荷花插件会把账号 cookie 保存到 data/netease/accounts.yaml。",
        qrDataUrl: qr.qrimg,
        profileId: "netease",
      }, {
        saveId: `lotus-netease-qr-${this.e.user_id || "master"}`,
      })
      await replyImage(this, image, "[荷花插件]网易云登录二维码已生成。")
      const result = await service.waitQrLogin({
        apiUrl: config.api_url,
        key: qr.key,
        qq: this.e.user_id,
        timeoutMs: config.login_timeout_ms,
        pollMs: config.login_poll_ms,
      })
      await this.renderReport("合伙人登录", {
        trigger: "扫码登录",
        accounts: [{
          nickname: result.account.nickname,
          total: 1,
          success: 1,
          skip: 0,
          fail: 0,
        }],
      }, "完成")
    } catch (error) {
      await this.renderError("合伙人登录", error)
    }
    return true
  }

  async manualTest() {
    const globalConfig = await loadGlobalConfig()
    if (!await this.requireMaster(globalConfig)) return true
    await replyText(this, "[荷花插件]网易云合伙人任务启动中。")
    try {
      const report = await new NeteasePartnerService().executeTask(globalConfig.netease_partner || {}, "手动测试")
      await this.renderReport("合伙人测试", report, "完成")
    } catch (error) {
      await this.renderError("合伙人测试", error)
    }
    return true
  }

  async partnerLog() {
    const globalConfig = await loadGlobalConfig()
    if (!await this.requireMaster(globalConfig)) return true
    const report = await new NeteasePartnerService().latestLog()
    if (!report) {
      await this.renderReport("合伙人日志", {
        trigger: "最近日志",
        accounts: [{ nickname: "暂无日志", total: 0, success: 0, skip: 0, fail: 0 }],
      }, "空")
      return true
    }
    await this.renderReport("合伙人日志", report, "LOG")
    return true
  }

  async requireMaster(globalConfig) {
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e.user_id, this.e.group_id, "netease.partner")
    if (permission.ok) return true
    await this.renderReport("网易云合伙人", {
      trigger: "权限检查",
      accounts: [{ nickname: `拒绝：${permission.reason}`, total: 0, success: 0, skip: 0, fail: 1 }],
    }, "拒绝")
    return false
  }

  async renderReport(title, report, badge) {
    const image = await renderStatusCard({
      title,
      subtitle: report.trigger || "网易云音乐合伙人",
      badge,
      message: `生成时间：${report.time || new Date().toISOString()}`,
      userId: this.e.user_id,
      items: buildPartnerItems(report),
    }, {
      saveId: `lotus-netease-partner-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, `[荷花插件]${title}报告已生成。`)
  }

  async renderError(title, error) {
    const image = await renderStatusCard({
      title,
      subtitle: "网易云音乐合伙人",
      badge: "失败",
      message: error.message,
      userId: this.e.user_id,
      items: [
        { label: "建议", value: "检查 API 服务地址、账号 cookie 或稍后重试。" },
      ],
    }, {
      saveId: `lotus-netease-partner-error-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, `[荷花插件]${title}失败。`)
  }
}
