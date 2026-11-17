import { loadGlobalConfig } from "../../core/config/global.js"
import { createCaptchaEventReporter } from "../../core/captcha/notify.js"
import { loadProfile } from "../../core/config/profile.js"
import { renderTemplate } from "../../core/render/service.js"
import { SchedulerService, dateString, nextDateString } from "../../core/scheduler/service.js"
import { formatLocalIso } from "../../core/time.js"
import { notifyProfile } from "../../core/transport/notify.js"
import { communityForumName } from "../miyoushe/tasks.js"
import { ProfileSigninService, renderSigninFailure } from "./profileSignin.js"

const taskState = globalThis[Symbol.for("lotus-plugin.scheduled-signin-tasks")] ||= { schedules: new Map(), plans: new Map() }
const scheduleTasks = taskState.schedules
const planTasks = taskState.plans
const COMMUNITY_RETRY_DELAYS = [10, 60, 180].map(minutes => minutes * 60_000)
const COMMUNITY_RETRY_FALLBACK_DELAY = 6 * 60 * 60_000
export const COMMUNITY_RETRY_FINAL_CRON = "0 50,59 23 * * ? *"

export class ScheduledSigninService {
  constructor(options = {}) {
    this.scheduler = options.scheduler || new SchedulerService(options)
    this.signin = options.signin || new ProfileSigninService(options)
    this.notify = options.notify || notifyProfile
    this.loadProfile = options.loadProfile || loadProfile
    this.bot = options.bot
    this.now = options.now || (() => new Date())
    this.renderTemplate = options.renderTemplate || renderTemplate
  }

  async runDue(options = {}) {
    const now = options.now || this.now()
    const planDate = options.date || dateString(now)
    const task = options.communityRetriesOnly ? "community-retries" : "run-due"
    return runScheduleTask(`${task}:${planDate}`, () => runPlanTask(planDate, () => this.runDuePlan(planDate, now, options)))
  }

  async runDuePlan(planDate, now, options = {}) {
    let plan = await this.scheduler.getOrCreatePlan(planDate, { reconcile: true })
    if (!plan) {
      return {
        ok: true,
        date: planDate,
        count: 0,
        results: [],
        reason: "plan_not_found",
      }
    }
    // The shared plan lock waits for any live run, including across hot reloads.
    // A remaining marker therefore belongs to an interrupted process, not a
    // currently executing entry. Reconcile again after clearing stale markers
    // so disabled profiles and changed fixed times are respected on recovery.
    if (plan.entries.some(entry => entry.runningAt)) {
      for (const entry of plan.entries) delete entry.runningAt
      await this.scheduler.savePlan(plan)
      plan = await this.scheduler.getOrCreatePlan(planDate, { reconcile: true })
    }
    const dueEntries = plan.entries.filter(entry => (!options.communityRetriesOnly || entry.communityRetry) && isDue(entry, now))
    const results = []
    for (const entry of dueEntries) {
      const previous = entry.communityRetry
      const startedAt = this.now()
      if (previous && dateString(startedAt) !== planDate) break
      const finalRetry = previous && startedAt.getTime() >= communityRetryCutoff(startedAt)
      const retryDeadline = previous && new Date(startedAt).setHours(24, 0, 0, 0)
      entry.runningAt = formatLocalIso()
      await this.scheduler.savePlan(plan)
      const remaining = retryDeadline && retryDeadline - this.now().getTime()
      const retrySignal = retryDeadline ? (remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort()) : undefined
      const outcome = await this.runEntry(entry, { ...options, communityRetryForums: previous?.forums, retrySignal })
      const retryForums = outcome.result?.retryCommunityForums || []
      const attempts = previous ? previous.attempts + 1 : 0
      const tasks = outcome.result?.tasks || []
      const otherFailure = Boolean(previous?.otherFailure || tasks.some(row =>
        (row.status === "failed" || row.status === "unverified") && !row.retryable))
      const message = outcome.message || outcome.error?.message || ""
      const initialMessage = previous?.initialMessage ?? message
      const nextAt = retryForums.length && !finalRetry && nextCommunityRetry(this.now(), attempts, planDate)
      if (retryForums.length && nextAt && dateString(nextAt) === planDate) {
        entry.communityRetry = { forums: retryForums, attempts, nextAt: nextAt.toISOString(), otherFailure, initialMessage }
      } else {
        delete entry.communityRetry
      }
      const retriedAll = previous && previous.forums.every(id => tasks.some(row =>
        row.kind === "community" && row.key === id && ["success", "already"].includes(row.status)))
      entry.done = !entry.communityRetry
      if (entry.done) entry.doneAt = formatLocalIso()
      entry.ok = outcome.ok && (!previous || retriedAll && !otherFailure)
      entry.stage = outcome.stage
      entry.message = previous ? `${initialMessage}\n社区签到补跑第 ${attempts} 次：${message || "当前设置或设备不可用，未执行"}` : message
      delete entry.runningAt
      await this.scheduler.savePlan(plan)
      if (previous && options.notify !== false && outcome.profile) {
        const details = tasks.length || outcome.error ? message : outcome.skipped?.join("\n") || "本轮没有可补签的社区，请检查社区签到设置。"
        const lines = [
          `[荷花插件]社区签到补跑第 ${attempts} 次（Profile ${entry.profileId}）`,
          `本轮只补签：${previous.forums.map(communityForumName).join("、")}。游戏签到结果以首轮为准。`,
          details,
        ]
        if (entry.communityRetry) {
          const retryAt = new Date(entry.communityRetry.nextAt)
          const time = formatLocalIso(retryAt).slice(11, 16)
          const action = retryAt.getTime() >= communityRetryCutoff(retryAt) ? "做今天最后一次补签" : "再试"
          lines.push(`预计 ${time} 后${action}：${retryForums.map(communityForumName).join("、")}。`)
        } else if (!retriedAll) {
          lines.push("今日自动补跑已结束，仍有社区未确认签到。")
        }
        try { await this.notify(outcome.profile, lines.filter(Boolean).join("\n"), { bot: options.bot || this.bot }) }
        catch (error) { globalThis.logger?.warn?.(`[Lotus-Plugin] scheduled signin notify failed: ${error.message}`) }
      }
      results.push({ entry: { ...entry }, outcome })
    }
    return {
      ok: results.every(item => item.entry.ok),
      date: planDate,
      count: results.length,
      results,
    }
  }

  async notifyPlan(plan, options = {}) {
    const results = []
    for (const entry of plan.entries) {
      if (entry.notified && !options.force) continue
      const profile = await this.loadProfile(entry.qq, entry.profileId).catch(() => null)
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
        reconcile: true,
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
    let profile = await this.loadProfile(entry.qq, entry.profileId).catch(() => null)
    try {
      const captchaReporter = createCaptchaEventReporter({
        send: async message => {
          if (!profile) return false
          const result = await this.notify(profile, message, { bot: options.bot || this.bot })
          return result.ok
        },
        sendForward: async messages => {
          if (!profile) return false
          const result = await this.notify(profile, messages.join("\n"), { bot: options.bot || this.bot })
          return result.ok
        },
      })
      const outcome = await this.signin.run({
        qq: entry.qq,
        profileId: entry.profileId,
        profile,
        refresh: true,
        source: options.communityRetryForums ? "scheduled_community_retry" : "scheduled",
        communityRetryForums: options.communityRetryForums,
        signal: options.retrySignal,
        onCaptchaEvent: async event => {
          await captchaReporter(event).catch(error => {
            logger?.warn?.(`[Lotus-Plugin] captcha notify failed: ${error.message}`)
          })
        },
      })
      profile = outcome.profile || profile
      if (options.communityRetryForums) return { ...outcome, profile }
      if (options.notify !== false && profile && (outcome.image || outcome.message)) {
        try { await this.notify(profile, outcome.image || outcome.message, { bot: options.bot || this.bot }) }
        catch (error) { globalThis.logger?.warn?.(`[Lotus-Plugin] scheduled signin notify failed: ${error.message}`) }
      }
      return outcome
    } catch (error) {
      const fallbackProfile = profile || {
        user: { qq: entry.qq },
        profile: { id: entry.profileId, notify: { prefer: "private", fallback_groups: [] } },
      }
      const image = options.communityRetryForums ? null : await renderSigninFailure({
        stage: "schedule",
        profile: fallbackProfile,
        error,
        message: "计划签到执行失败。",
        advice: "检查 profile 配置文件是否存在，并确认签到环境已经初始化。",
      })
      if (!options.communityRetryForums && options.notify !== false) {
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
  if (entry.communityRetry) return Date.parse(entry.communityRetry.nextAt) <= now.getTime()
  return timeToMinute(entry.time) <= now.getHours() * 60 + now.getMinutes()
}

function communityRetryCutoff(now) {
  return new Date(now).setHours(23, 50, 0, 0)
}

function nextCommunityRetry(now, attempts, planDate) {
  if (dateString(now) !== planDate) return null
  const cutoff = communityRetryCutoff(now)
  const delay = COMMUNITY_RETRY_DELAYS[attempts] ?? COMMUNITY_RETRY_FALLBACK_DELAY
  const next = now.getTime() < cutoff
    ? Math.min(now.getTime() + delay, cutoff)
    : new Date(now).setHours(23, 59, 0, 0)
  return next > now.getTime() ? new Date(next) : null
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
