const BasePlugin = globalThis.plugin
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { parseExecution, executionTasks, createDelegatedEvent, dispatchDelegated } from "../services/pluginBridge/delegate.js"

export class LotusExecute extends BasePlugin {
  constructor() {
    super({ name: "[Lotus-Plugin] Execute", dsc: "代操作与批量执行", event: "message", priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [{ reg: "^(#?代|#执行(?:\\s|$)|#execute(?:\\s|$))", fnc: "execute" }] })
  }

  async execute() {
    if (!this.e.isMaster) return false
    try {
      const options = parseExecution(this.e)
      const tasks = await executionTasks(this.e.bot || globalThis.Bot, options, this.e)
      if (!tasks.length) throw new Error("没有可执行的目标用户")
      let matched = 0, failed = 0
      for (let i = 0; i < tasks.length; i++) {
        try {
          const context = createDelegatedEvent(this.e, tasks[i], options)
          const result = await dispatchDelegated(context.event)
          if (result.matched || context.replyCount()) matched++
        } catch (error) { failed++; globalThis.logger?.warn?.(`[Lotus-Plugin] 代操作失败：${error.message}`) }
        if (i + 1 < tasks.length) await new Promise(resolve => setTimeout(resolve, options.gap * 1000))
      }
      await this.e.reply(`执行结束：已处理 ${matched}，异常 ${failed}，未命中或被拒绝 ${tasks.length - matched - failed}。具体业务结果以各指令回复为准。`)
    } catch (error) { await this.e.reply(`[荷花插件]${error.message}`) }
    return true
  }
}
