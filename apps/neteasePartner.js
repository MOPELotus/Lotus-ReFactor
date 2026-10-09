const BasePlugin = globalThis.plugin

import { loadGlobalConfig, saveGlobalConfig } from "../core/config/global.js"
import { TuneWeaveService } from "../services/tuneweave/service.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { formatLocalDateTime } from "../core/time.js"
import { notifyUser } from "../core/transport/notify.js"
import { replyImage, replyText, replyForward } from "../core/transport/reply.js"
import { buildPartnerItems, buildPartnerLogMessages, NeteasePartnerService } from "../services/neteasePartner/service.js"

export class LotusNeteasePartner extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Netease Partner",
      dsc: "Lotus netease music partner",
      event: "message",
      priority: 20,
      rule: [
        { reg: "^#初始化TuneWeave$", fnc: "initializeTuneWeave" },
        { reg: "^#TuneWeave状态$", fnc: "tuneWeaveStatus" },
        { reg: "^#合伙人测试(?:[（(]执行[）)])?$", fnc: "manualTest" },
        { reg: "^#合伙人登录$", fnc: "partnerLogin" },
        { reg: "^#合伙人日志$", fnc: "partnerLog" },
      ],
    })
    this.task = [
      {
        name: "荷花插件网易云合伙人任务",
        cron: "0 5 0 * * ? *",
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
          cron: config.schedule || "0 5 0 * * ? *",
          fnc: this.scheduledTask.bind(this),
          log: false,
        },
      ]
      await new TuneWeaveService({ config: globalConfig.tuneweave }).resume()
      await this.scheduleStartupCatchUp(config)
    } catch (error) {
      logger?.warn?.(`[Lotus-Plugin] load netease partner task failed: ${error.message}`)
    }
  }

  async scheduleStartupCatchUp(config) {
    const globalConfig = await loadGlobalConfig()
    const service = new NeteasePartnerService({ config: globalConfig.tuneweave })
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
    let report
    try {
      const service = new NeteasePartnerService({ config: globalConfig.tuneweave })
      if (await service.hasRunToday()) return { ok: true, skipped: true, reason: "already_run_today" }
      report = await service.executeTask(config, options.trigger || "自动任务", { recordRun: true })
    } catch (error) {
      report = { trigger: options.trigger || "自动任务", time: formatLocalDateTime(), accounts: [{ nickname: "TuneWeave", total: 0, success: 0, skip: 0, fail: 1, details: [error.message] }] }
    }
    logger?.mark?.(`[Lotus-Plugin] netease partner task finished: ${report.accounts?.length || 0} account(s)`)
    await this.notifyMasters(globalConfig, report).catch(error => {
      logger?.warn?.(`[Lotus-Plugin] notify netease partner report failed: ${error.message}`)
    })
    return report
  }

  async initializeTuneWeave() {
    const config = await loadGlobalConfig()
    if (!await this.requireMaster(config)) return true
    try {
      const result = await new TuneWeaveService({ config: config.tuneweave }).initialize({
        onProgress: text => replyText(this, `[荷花插件]${text}`),
      })
      await replyText(this, `[荷花插件]TuneWeave 初始化完成 · ${result.version} · ${result.apiUrl}。`)
    } catch (error) { await replyText(this, `[荷花插件]TuneWeave 初始化失败：${error.message}`) }
    return true
  }

  async tuneWeaveStatus() {
    const config = await loadGlobalConfig()
    if (!await this.requireMaster(config)) return true
    const result = await new TuneWeaveService({ config: config.tuneweave }).status()
    await replyText(this, `[荷花插件]TuneWeave ${result.ok ? "就绪" : "未就绪"} · ${result.version || "未知版本"}\n${result.apiUrl}\n${result.message}`)
    return true
  }

  async partnerLogin() {
    const globalConfig = await loadGlobalConfig()
    if (!await this.requireMaster(globalConfig)) return true
    const service = new NeteasePartnerService({ config: globalConfig.tuneweave })
    try {
      const config = globalConfig.netease_partner || {}
      const qr = await service.createQrLogin(this.e.user_id)
      const image = await renderTemplate("qr-login", {
        title: "网易云登录",
        subtitle: "音乐合伙人",
        badge: "5 MIN",
        notice: "使用网易云音乐 App 扫码确认。完成后凭据由自托管 TuneWeave 保存，荷花插件仅保存账号信息。",
        qrDataUrl: qr.qrimg,
        profileId: "netease",
      }, {
        saveId: `lotus-netease-qr-${this.e.user_id || "master"}`,
      })
      await replyImage(this, image, "[荷花插件]网易云登录二维码已生成。")
      const result = await service.waitQrLogin({
        alias: qr.alias,
        key: qr.key,
        qq: this.e.user_id,
        timeoutMs: config.login_timeout_ms,
        pollMs: config.login_poll_ms,
      })
      globalConfig.netease_partner.enable = true
      await saveGlobalConfig(globalConfig)
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
      const report = await new NeteasePartnerService({ config: globalConfig.tuneweave }).executeTask(globalConfig.netease_partner || {}, "手动执行", { recordRun: true })
      await this.renderReport("合伙人测试", report, "完成")
    } catch (error) {
      await this.renderError("合伙人测试", error)
    }
    return true
  }

  async partnerLog() {
    const globalConfig = await loadGlobalConfig()
    if (!await this.requireMaster(globalConfig)) return true
    const report = await new NeteasePartnerService({ config: globalConfig.tuneweave }).latestLog()
    if (!report) {
      await this.renderReport("合伙人日志", {
        trigger: "最近日志",
        accounts: [{ nickname: "暂无日志", total: 0, success: 0, skip: 0, fail: 0 }],
      }, "空")
      return true
    }
    await replyForward(this, buildPartnerLogMessages(report), { title: "合伙人日志" })
    return true
  }

  async requireMaster(globalConfig) {
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "netease.partner")
    if (permission.ok) return true
    await this.renderReport("网易云合伙人", {
      trigger: "权限检查",
      accounts: [{ nickname: `拒绝：${permission.reason}`, total: 0, success: 0, skip: 0, fail: 1 }],
    }, "拒绝")
    return false
  }

  async renderReport(title, report, badge) {
    const image = await this.renderReportImage(title, report, badge, this.e.user_id)
    await replyImage(this, image, `[荷花插件]${title}报告已生成。`)
  }

  async renderReportImage(title, report, badge, userId = "master") {
    return renderStatusCard({
      title,
      subtitle: report.trigger || "网易云音乐合伙人",
      badge,
      message: `生成时间：${report.time || formatLocalDateTime()}`,
      userId,
      items: buildPartnerItems(report),
    }, {
      saveId: `lotus-netease-partner-${userId || "master"}`,
    })
  }

  async notifyMasters(globalConfig, report) {
    const config = globalConfig.netease_partner || {}
    if (config.notify_master === false) return
    const masters = await collectMasterIds()
    if (!masters.length) {
      logger?.debug?.("[Lotus-Plugin] netease partner report skipped: no master configured")
      return
    }
    const image = await this.renderReportImage("合伙人自动任务", report, report.accounts?.some(account => account.fail) ? "有失败" : "完成", "master")
    for (const master of masters) {
      const result = await notifyUser(master, image, {
        bot: globalThis.Bot,
        onlyKnownFriend: false,
        at: false,
      })
      if (!result.ok) {
        logger?.warn?.(`[Lotus-Plugin] netease partner report notify failed for ${master}: ${result.reason}`)
      }
    }
  }

  async renderError(title, error) {
    const image = await renderStatusCard({
      title,
      subtitle: "网易云音乐合伙人",
      badge: "失败",
      message: error.message,
      userId: this.e.user_id,
      items: [
        { label: "建议", value: "使用 #TuneWeave状态 检查服务，必要时 #初始化TuneWeave 或 #合伙人登录。" },
      ],
    }, {
      saveId: `lotus-netease-partner-error-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, `[荷花插件]${title}失败。`)
  }
}

async function collectMasterIds() {
  const values = []
  const config = globalThis.Bot?.config || {}
  appendIds(values, config.masterQQ)
  appendIds(values, config.master)
  appendIds(values, config.masters)
  appendIds(values, config.master_qq)
  appendIds(values, config.owner)
  if (!values.length) {
    // The bot config getter is available even when Bot.config is not populated.
    const { pathToFileURL } = await import("node:url")
    const { default: path } = await import("node:path")
    const cfg = (await import(pathToFileURL(path.join(process.cwd(), "lib/config/config.js")).href)).default
    appendIds(values, cfg.masterQQ)
    appendIds(values, cfg.master)
  }
  return [...new Set(values.map(value => String(value).trim().split(":").at(-1)).filter(value => value && value !== "stdin"))]
}

function appendIds(target, value) {
  if (Array.isArray(value)) {
    for (const item of value) appendIds(target, item)
    return
  }
  if (value instanceof Set) {
    for (const item of value) appendIds(target, item)
    return
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) appendIds(target, item)
    return
  }
  if (value === undefined || value === null || value === "") return
  target.push(value)
}
