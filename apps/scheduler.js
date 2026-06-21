const BasePlugin = globalThis.plugin

import { loadGlobalConfig, saveGlobalConfig } from "../core/config/global.js"
import { listProfileIds, loadProfile } from "../core/config/profile.js"
import { PermissionService } from "../core/permissions/service.js"
import { SchedulerService, cronToMinuteOfDay, nextDateString } from "../core/scheduler/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { ScheduledSigninService } from "../services/checkin/scheduled.js"
import {
  applySchedulerSettings,
  describeSchedulerSettings,
  parseSchedulerSettingsCommand,
} from "../core/scheduler/settings.js"

export class LotusScheduler extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Scheduler",
      dsc: "Lotus checkin schedule plan",
      event: "message",
      priority: 20,
      rule: [
        { reg: "^#生成签到计划$", fnc: "generatePlan" },
        { reg: "^#我的签到时间$", fnc: "myPlan" },
        { reg: "^#执行到期签到$", fnc: "runDueCommand" },
        { reg: "^#签到(随机|固定)模式(\\s+\\d{1,2}:\\d{2})?$", fnc: "updateSchedulerSettings" },
        { reg: "^#签到计划生成\\s+\\d{1,2}:\\d{2}$", fnc: "updateSchedulerSettings" },
      ],
    })
    this.task = [
      {
        name: "荷花插件自动签到调度",
        cron: "0 * * * * ? *",
        fnc: this.runDueCheckins.bind(this),
        log: false,
      },
      {
        name: "荷花插件生成明日签到计划",
        cron: "0 0 0 * * ? *",
        fnc: this.generateTomorrowPlanTask.bind(this),
        log: false,
      },
      {
        name: "荷花插件签到计划补偿检查",
        cron: "0 */10 * * * ? *",
        fnc: this.catchUpTomorrowPlanTask.bind(this),
        log: false,
      },
    ]
  }

  async init() {
    try {
      const globalConfig = await loadGlobalConfig()
      this.task = [
        {
          name: "荷花插件自动签到调度",
          cron: globalConfig.scheduler?.run_due_cron || "0 * * * * ? *",
          fnc: this.runDueCheckins.bind(this),
          log: false,
        },
        {
          name: "荷花插件生成明日签到计划",
          cron: globalConfig.scheduler?.plan_generate_cron || "0 0 0 * * ? *",
          fnc: this.generateTomorrowPlanTask.bind(this),
          log: false,
        },
        {
          name: "荷花插件签到计划补偿检查",
          cron: globalConfig.scheduler?.catch_up_cron || "0 */10 * * * ? *",
          fnc: this.catchUpTomorrowPlanTask.bind(this),
          log: false,
        },
      ]
      this.scheduleStartupCatchUp(globalConfig)
    } catch (error) {
      logger?.warn?.(`[Lotus-Plugin] load scheduler cron failed, fallback defaults: ${error.message}`)
    }
  }

  async generatePlan() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "scheduler.generate")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以生成全局签到计划。")
      return true
    }
    const date = nextDateString()
    const generated = await new ScheduledSigninService({
      scheduler: new SchedulerService({ config: globalConfig.scheduler }),
    }).ensureTomorrowPlanAndNotify({
      config: globalConfig,
      date,
      force: true,
      forceNotify: true,
      bot: globalThis.Bot,
    })
    const { plan, notifications } = generated
    const image = await renderSchedulePlan(plan, {
      title: "签到计划",
      subtitle: `${date} · 全局计划`,
      userId: this.e.user_id,
      notifications,
    })
    await replyImage(this, image, "[荷花插件]明日签到计划已生成。")
    return true
  }

  async myPlan() {
    const date = nextDateString()
    const globalConfig = await loadGlobalConfig()
    const scheduler = new SchedulerService({ config: globalConfig.scheduler })
    const userId = String(this.e.user_id)
    await addMissingProfilesToPlan(userId, date, scheduler, globalConfig)
    const plan = await scheduler.getPlan(date)
    if (!plan) {
      await replyText(this, "[荷花插件]明日签到计划尚未生成，请等待计划生成任务，或由 bot 主人执行 #生成签到计划。")
      return true
    }
    const entries = plan.entries.filter(item => item.qq === userId)
    if (!entries.length) {
      await replyText(this, "[荷花插件]明日计划里没有找到你的 profile。")
      return true
    }
    const image = await renderSchedulePlan({ ...plan, entries }, {
      title: "我的签到时间",
      subtitle: `${date} · QQ ${userId}`,
      userId,
    })
    await replyImage(this, image, "[荷花插件]这是你明日的签到时间。")
    return true
  }

  async generateTomorrowPlanTask() {
    const globalConfig = await loadGlobalConfig()
    if (globalConfig.scheduler?.enable === false) {
      return {
        ok: true,
        disabled: true,
      }
    }
    const generated = await new ScheduledSigninService({
      scheduler: new SchedulerService({ config: globalConfig.scheduler }),
    }).ensureTomorrowPlanAndNotify({
      config: globalConfig,
      bot: globalThis.Bot,
    })
    logger?.mark?.(`[Lotus-Plugin] tomorrow schedule ready: ${generated.plan.date}, notify ${generated.notifications.length}`)
    return generated
  }

  scheduleStartupCatchUp(globalConfig) {
    setTimeout(() => {
      this.catchUpTomorrowPlanTask({ trigger: "启动补偿" }).catch(error => {
        logger?.error?.(`[Lotus-Plugin] schedule catch-up failed: ${error.stack || error.message}`)
      })
    }, 60 * 1000).unref?.()
    return globalConfig
  }

  async catchUpTomorrowPlanTask(options = {}) {
    const globalConfig = await loadGlobalConfig()
    if (globalConfig.scheduler?.enable === false) {
      return {
        ok: true,
        disabled: true,
      }
    }
    const now = options.now || new Date()
    const generateMinute = cronToMinuteOfDay(globalConfig.scheduler?.plan_generate_cron || "0 0 0 * * ? *")
    if (!Number.isFinite(generateMinute)) {
      return {
        ok: false,
        skipped: true,
        reason: "invalid_plan_generate_cron",
      }
    }
    const currentMinute = now.getHours() * 60 + now.getMinutes()
    if (currentMinute <= generateMinute) {
      return {
        ok: true,
        skipped: true,
        reason: "before_generate_time",
      }
    }
    const scheduler = new SchedulerService({ config: globalConfig.scheduler })
    const date = nextDateString(now)
    const existing = await scheduler.getPlan(date)
    if (existing) {
      return {
        ok: true,
        skipped: true,
        reason: "plan_exists",
        date,
      }
    }
    logger?.mark?.(`[Lotus-Plugin] schedule catch-up creating tomorrow plan: ${date}`)
    return this.generateTomorrowPlanTask({ trigger: options.trigger || "补偿检查" })
  }

  async runDueCommand() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "scheduler.run_due")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以执行到期签到。")
      return true
    }
    await replyText(this, "[荷花插件]正在检查并执行到期签到任务。")
    const result = await this.runDueCheckins({ notify: true })
    const image = await renderStatusCard({
      title: "到期签到",
      subtitle: result.date,
      badge: String(result.count),
      message: result.count ? "已执行所有到期且未完成的签到任务，结果会分别通知对应用户。" : "当前没有到期且未完成的签到任务。",
      userId: this.e.user_id,
      items: result.results.slice(0, 8).map(({ entry, outcome }) => ({
        label: `QQ ${entry.qq} · P${entry.profileId}`,
        value: `${outcome.ok ? "成功" : "失败"} · ${outcome.stage}`,
      })),
    }, {
      saveId: `lotus-run-due-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, "[荷花插件]到期签到检查完成。")
    return true
  }

  async updateSchedulerSettings() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "scheduler.manage")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以修改全局签到调度。")
      return true
    }
    const command = parseSchedulerSettingsCommand(this.e.msg)
    if (!command.ok) {
      await replyText(this, `[荷花插件]调度指令无法识别：${command.reason}`)
      return true
    }
    const next = applySchedulerSettings(globalConfig, command)
    await saveGlobalConfig(next)
    const image = await renderStatusCard({
      title: "调度配置",
      subtitle: "荷花插件调度",
      badge: "已保存",
      message: describeSchedulerSettings(command, next),
      userId: this.e.user_id,
      items: [
        { label: "模式", value: next.scheduler.mode },
        { label: "固定时间", value: next.scheduler.fixed_time },
        { label: "计划生成", value: next.scheduler.plan_generate_cron },
        { label: "到期扫描", value: next.scheduler.run_due_cron },
      ],
    }, {
      saveId: `lotus-scheduler-settings-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, "[荷花插件]调度配置已更新。")
    return true
  }

  async runDueCheckins(options = {}) {
    const globalConfig = await loadGlobalConfig()
    if (globalConfig.scheduler?.enable === false) {
      return {
        ok: true,
        date: "",
        count: 0,
        results: [],
        disabled: true,
      }
    }
    const result = await new ScheduledSigninService({
      scheduler: new SchedulerService({ config: globalConfig.scheduler }),
    }).runDue(options)
    if (result.count) {
      logger?.mark?.(`[Lotus-Plugin] scheduled checkin executed: ${result.count}`)
    }
    return result
  }
}

async function addMissingProfilesToPlan(userId, date, scheduler, globalConfig) {
  const profileIds = await listProfileIds(userId)
  if (!profileIds.length) return []
  const service = new ScheduledSigninService({ scheduler })
  const results = []
  for (const profileId of profileIds) {
    const profile = await loadProfile(userId, profileId).catch(() => null)
    if (!profile) continue
    results.push(await service.addLateProfileAndNotify(profile, {
      config: globalConfig,
      dates: [date],
      bot: globalThis.Bot,
    }))
  }
  return results
}

async function renderSchedulePlan(plan, meta) {
  const items = plan.entries.slice(0, 12).map(entry => ({
    label: `Profile ${entry.profileId}`,
    value: `${entry.time} · ${entry.mode}`,
  }))
  if (plan.entries.length > 12) {
    items.push({
      label: "更多",
      value: `另有 ${plan.entries.length - 12} 个 profile`,
    })
  }
  if (meta.notifications?.length) {
    const ok = meta.notifications.filter(item => item.sent?.ok).length
    items.push({
      label: "已通知",
      value: `${ok}/${meta.notifications.length}`,
    })
  }
  return renderStatusCard({
    title: meta.title,
    subtitle: meta.subtitle,
    badge: `${plan.entries.length}`,
    message: plan.mode === "random" ? "随机模式已按时间窗口均匀分布，重启会复用已生成计划。" : "固定模式计划已生成，允许用户级随机的 profile 会单独分布。",
    userId: meta.userId,
    items,
  }, {
    saveId: `lotus-schedule-${meta.userId || "system"}`,
  })
}
