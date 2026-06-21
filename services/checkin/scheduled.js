import { loadGlobalConfig } from "../../core/config/global.js"
import { isUserVisibleCaptchaEvent } from "../../core/captcha/events.js"
import { loadProfile } from "../../core/config/profile.js"
import { renderTemplate } from "../../core/render/service.js"
import { SchedulerService, dateString, nextDateString } from "../../core/scheduler/service.js"
import { formatLocalIso } from "../../core/time.js"
import { notifyProfile } from "../../core/transport/notify.js"
import { ProfileSigninService, renderSigninFailure } from "./profileSignin.js"

const scheduleTasks = new Map()
const planTasks = new Map()

export class ScheduledSigninService {
  constructor(options = {}) {
    this.scheduler = options.scheduler || new SchedulerService(options)
    this.signin = options.signin || new ProfileSigninService(options)
    this.notify = options.notify || notifyProfile
    this.bot = options.bot
    this.now = options.now || (() => new Date())
    this.renderTemplate = options.renderTemplate || renderTemplate
  }

  async runDue(options = {}) {
    const now = options.now || this.now()
    const planDate = options.date || dateString(now)
    return runScheduleTask(`run-due:${planDate}`, () => runPlanTask(planDate, () => this.runDuePlan(planDate, now, options)))
  }

  async runDuePlan(planDate, now, options = {}) {
    const plan = await this.scheduler.getPlan(planDate)
    if (!plan) {
      return {
        ok: true,
        date: planDate,
        count: 0,
        results: [],
        reason: "plan_not_found",
      }
    }
    const dueEntries = plan.entries.filter(entry => isDue(entry, now))
    const results = []
    for (const entry of dueEntries) {
      entry.runningAt = formatLocalIso()
      await this.scheduler.savePlan(plan)
      const outcome = await this.runEntry(entry, options)
      entry.done = true
      entry.doneAt = formatLocalIso()
      entry.ok = outcome.ok
      entry.stage = outcome.stage
      entry.message = outcome.message || outcome.error?.message || ""
      delete entry.runningAt
      await this.scheduler.savePlan(plan)
      results.push({ entry: { ...entry }, outcome })
    }
    return {
      ok: results.every(item => item.outcome.ok),
      date: planDate,
      count: results.length,
      results,
    }
  }

  async notifyPlan(plan, options = {}) {
    const results = []
    for (const entry of plan.entries) {
      if (entry.notified && !options.force) continue
      const profile = await loadProfile(entry.qq, entry.profileId).catch(() => null)
      if (!profile) continue
      const image = await this.renderTemplate("schedule-notice", {
        title: profile.user?.nickname || `QQ ${entry.qq}`,
        subtitle: `${plan.date} · profile ${entry.profileId}`,
        badge: entry.mode,
        message: `明日自动签到将在 ${entry.time} 左右执行。`,
        avatar: qqAvatar(entry.qq),
        userId: entry.qq,
        items: [
          { label: "签到时间", value: entry.time },
          { label: "模式", value: entry.mode },
          { label: "日期", value: plan.date },
        ],
      }, { saveId: `lotus-schedule-notice-${entry.qq}-${entry.profileId}` })
      const sent = await this.notify(profile, image, { bot: options.bot || this.bot })
      entry.notified = sent.ok
      results.push({ entry: { ...entry }, sent })
    }
    await this.scheduler.savePlan(plan)
    return results
  }

  async ensureTomorrowPlanAndNotify(options = {}) {
    const config = options.config || await loadGlobalConfig()
    const date = options.date || nextDateString(this.now())
    return runScheduleTask(`tomorrow-plan:${date}`, () => runPlanTask(date, async () => {
      const plan = await this.scheduler.getOrCreatePlan(date, {
        force: options.force,
      })
      const shouldNotify = options.forceNotify || config.scheduler?.random?.notify_before !== false
      const notifications = shouldNotify ? await this.notifyPlan(plan, options) : []
      return { plan, notifications }
    }))
  }

  async addLateProfileAndNotify(profile, options = {}) {
    const config = options.config || await loadGlobalConfig()
    const now = options.now || this.now()
    const dates = options.dates || [dateString(now), nextDateString(now)]
    const results = []
    for (const date of dates) {
      const items = await runPlanTask(date, () => this.scheduler.addLateProfileToExistingPlans(profile, {
        ...options,
        now,
        dates: [date],
      }))
      results.push(...items)
    }
    const added = results.filter(item => item.ok && !item.skipped && item.entry)
    if (!added.length || config.scheduler?.late_registration?.notify === false || options.notify === false) {
      return { results, notifications: [] }
    }
    const notifications = []
    for (const item of added) {
      const image = await this.renderTemplate("schedule-notice", {
        title: profile.user?.nickname || `QQ ${profile.user?.qq || ""}`,
        subtitle: `${item.date} · profile ${profile.profile?.id || 1}`,
        badge: "补入",
        message: `已加入今日补位计划，将在 ${item.entry.time} 左右执行。`,
        avatar: qqAvatar(profile.user?.qq),
        userId: profile.user?.qq,
        items: [
          { label: "签到时间", value: item.entry.time },
          { label: "模式", value: "新注册补位" },
          { label: "日期", value: item.date },
        ],
      }, { saveId: `lotus-late-schedule-${profile.user?.qq || "user"}-${profile.profile?.id || 1}-${item.date}` })
      notifications.push(await this.notify(profile, image, { bot: options.bot || this.bot }))
    }
    return { results, notifications }
  }

  async runEntry(entry, options = {}) {
    let profile = await loadProfile(entry.qq, entry.profileId).catch(() => null)
    try {
      const outcome = await this.signin.run({
        qq: entry.qq,
        profileId: entry.profileId,
        profile,
        refresh: true,
        installRequirements: false,
        onCaptchaEvent: async event => {
          if (isUserVisibleCaptchaEvent(event) && event?.message && profile) {
            await this.notify(profile, event.message, { bot: options.bot || this.bot }).catch(error => {
              logger?.warn?.(`[Lotus-Plugin] captcha notify failed: ${error.message}`)
            })
          }
        },
      })
      profile = outcome.profile || profile
      if (options.notify !== false && profile) {
        await this.notify(profile, outcome.image || outcome.message, { bot: options.bot || this.bot })
      }
      return outcome
    } catch (error) {
      const fallbackProfile = profile || {
        user: { qq: entry.qq },
        profile: { id: entry.profileId, notify: { prefer: "private", fallback_groups: [] } },
      }
      const image = await renderSigninFailure({
        stage: "schedule",
        profile: fallbackProfile,
        error,
        message: "计划签到执行失败。",
        advice: "检查 profile 配置文件是否存在，并确认签到环境已经初始化。",
      })
      if (options.notify !== false) {
        await this.notify(fallbackProfile, image, { bot: options.bot || this.bot }).catch(notifyError => {
          logger?.warn?.(`[Lotus-Plugin] scheduled signin notify failed: ${notifyError.message}`)
        })
      }
      return {
        ok: false,
        stage: "schedule",
        profile: fallbackProfile,
        error,
        image,
        message: error.message,
      }
    }
  }
}

function qqAvatar(qq) {
  const id = String(qq || "1102305070")
  return `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`
}

function isDue(entry, now) {
  if (entry.done || entry.runningAt) return false
  return timeToMinute(entry.time) <= now.getHours() * 60 + now.getMinutes()
}

function timeToMinute(value = "00:00") {
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return Number.POSITIVE_INFINITY
  return Number(match[1]) * 60 + Number(match[2])
}

async function runScheduleTask(key, task) {
  const current = scheduleTasks.get(key)
  if (current) return current
  const pending = Promise.resolve().then(task)
  scheduleTasks.set(key, pending)
  try {
    return await pending
  } finally {
    if (scheduleTasks.get(key) === pending) scheduleTasks.delete(key)
  }
}

async function runPlanTask(date, task) {
  const key = `plan:${date}`
  const previous = planTasks.get(key) || Promise.resolve()
  let release
  const pending = new Promise(resolve => {
    release = resolve
  })
  planTasks.set(key, pending)
  try {
    await previous.catch(() => {})
    return await task()
  } finally {
    release()
    if (planTasks.get(key) === pending) planTasks.delete(key)
  }
}
