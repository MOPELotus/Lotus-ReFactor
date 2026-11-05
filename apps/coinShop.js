const BasePlugin = globalThis.plugin

import { loadGlobalConfig } from "../core/config/global.js"
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { USER_WEB_COMMAND_REG, OWNER_WEB_COMMAND_REG } from "../core/intercept/web-commands.js"
import { replyText } from "../core/transport/reply.js"
import { CoinShopService } from "../services/coinShop/service.js"
import { CoinShopWeb } from "../services/coinShop/web.js"
import { startGtMaintenance } from "../services/gtManual/runtime.js"
import { collectMasterIds } from "../core/transport/masters.js"
import { resolveData } from "../core/path.js"

const serviceKey = Symbol.for("Lotus-Plugin.coinShop")
if (!globalThis[serviceKey]) {
  const service = new CoinShopService()
  globalThis[serviceKey] = { service, web: new CoinShopWeb({ service,
    isOwner: async session => session.owner === true && (await collectMasterIds()).includes(String(session.qq)),
    sessionFile: resolveData("web", "sessions.json"),
  }) }
}

export class LotusCoinShop extends BasePlugin {
  constructor(options = {}) {
    super({
      name: "[Lotus-Plugin] Coin Shop", dsc: "米游社功能与插件控制面板", event: "message", priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [{ reg: USER_WEB_COMMAND_REG, fnc: "coinShop" }, { reg: OWNER_WEB_COMMAND_REG, fnc: "panel" }],
    })
    this.web = options.web || globalThis[serviceKey].web
    this.getConfig = options.getConfig || loadGlobalConfig
  }

  async init() {
    try { await this.web.start((await this.getConfig()).coin_shop) }
    catch (error) { globalThis.logger?.warn?.(`[Lotus-Plugin] 米游币兑换网页启动失败：${error.message}`) }
    startGtMaintenance({ getConfig: this.getConfig })
  }

  async coinShop() {
    if (this.e.isGroup || this.e.group_id) {
      await replyText(this, "请私聊机器人发送 #米游社功能，获取你的专属网页登录链接。")
      return true
    }
    try {
      await this.web.start((await this.getConfig()).coin_shop)
      const url = this.web.issueTicket(String(this.e.user_id), String(this.e.self_id || ""), this.e.isMaster === true)
      await replyText(this, `米游社功能\n${url}\n\n专属登录链接 ${this.web.ticketMinutes?.() ?? 10} 分钟内有效，使用一次后失效。登录后当前浏览器令牌有效期为 ${this.web.sessionHours?.("user") ?? 8} 小时，机器人重启后仍可使用，退出后撤销。请勿转发。\n进入总页管理自己的 profile、签到、社区任务、米游币与兑换计划。`)
    } catch (error) { await replyText(this, `[米游币兑换]${error.message}`) }
    return true
  }

  async panel() {
    if (this.e.isMaster !== true) { await replyText(this, "只有机器人主人可以获取荷花管理面板链接。"); return true }
    if (this.e.isGroup || this.e.group_id) { await replyText(this, "请主人私聊发送 #荷花管理面板，获取限时管理链接。"); return true }
    try {
      await this.web.start((await this.getConfig()).coin_shop)
      const url = this.web.issuePanelTicket(String(this.e.user_id), String(this.e.self_id || ""), true)
      await replyText(this, `荷花管理面板\n${url}\n\n仅主人使用：链接 ${this.web.ticketMinutes?.("panel") ?? 10} 分钟有效且仅能使用一次；登录后当前浏览器令牌有效期为 ${this.web.sessionHours?.("panel") ?? 24} 小时，机器人重启后保留，每次访问仍核对主人资格，退出后撤销。请勿转发。`)
    } catch (error) { await replyText(this, `[荷花管理面板]${error.message}`) }
    return true
  }
}
