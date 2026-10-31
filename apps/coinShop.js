const BasePlugin = globalThis.plugin

import { loadGlobalConfig } from "../core/config/global.js"
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { replyText } from "../core/transport/reply.js"
import { CoinShopService } from "../services/coinShop/service.js"
import { CoinShopWeb } from "../services/coinShop/web.js"

const serviceKey = Symbol.for("Lotus-Plugin.coinShop")
if (!globalThis[serviceKey]) {
  const service = new CoinShopService()
  globalThis[serviceKey] = { service, web: new CoinShopWeb({ service }) }
}

export class LotusCoinShop extends BasePlugin {
  constructor(options = {}) {
    super({
      name: "[Lotus-Plugin] Coin Shop", dsc: "米游币兑换网页入口", event: "message", priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [{ reg: "^#(米游币兑换|米游币商城)$", fnc: "coinShop" }],
    })
    this.web = options.web || globalThis[serviceKey].web
    this.getConfig = options.getConfig || loadGlobalConfig
  }

  async init() {
    try { await this.web.start((await this.getConfig()).coin_shop) }
    catch (error) { globalThis.logger?.warn?.(`[Lotus-Plugin] 米游币兑换网页启动失败：${error.message}`) }
  }

  async coinShop() {
    if (this.e.isGroup || this.e.group_id) {
      await replyText(this, "请私聊机器人发送 #米游币兑换，获取你的专属网页登录链接。")
      return true
    }
    try {
      await this.web.start((await this.getConfig()).coin_shop)
      const url = this.web.issueTicket(String(this.e.user_id), String(this.e.self_id || ""))
      await replyText(this, `米游币兑换管理\n${url}\n\n专属登录链接 10 分钟内有效，使用一次后失效。请勿转发。\n进入网页后选择自己的 profile、商品和兑换目标，可开启商品或类别的持续追踪，也可创建单次预约。`)
    } catch (error) { await replyText(this, `[米游币兑换]${error.message}`) }
    return true
  }
}
