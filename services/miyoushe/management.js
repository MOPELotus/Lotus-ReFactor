import { loadLoggedInProfile, normalizeProfileId, saveProfile, withProfileWrite } from "../../core/config/profile.js"
import { ProfileSigninService } from "../checkin/profileSignin.js"
import { SchedulerService, dateString } from "../../core/scheduler/service.js"
import { loadGlobalConfig } from "../../core/config/global.js"
import { PermissionService } from "../../core/permissions/service.js"
import { MiyousheClient } from "./client.js"
import { SIGNIN_GAMES } from "./tasks.js"
import { createCaptchaEventReporter } from "../../core/captcha/notify.js"
import { isUserVisibleCaptchaEvent, formatCaptchaMessage } from "../../core/captcha/events.js"
import { notifyUser } from "../../core/transport/notify.js"

const CAPTCHA_STATE_TTL_MS = 60 * 60 * 1000
const MAX_CAPTCHA_JOBS = 100

function publicCaptchaEvent(event, now) {
  if (!isUserVisibleCaptchaEvent(event)) return null
  const result = { type: event.type, message: formatCaptchaMessage(event), time: now }
  if (event.type === "captcha:manual-link") {
    try {
      const link = new URL(event.link)
      if (["http:", "https:"].includes(link.protocol)) result.link = link.href
    } catch {}
  }
  return result
}

export const MISSION_NAMES = { continuous_sign: "社区连续签到", read_post: "阅读帖子", like_post: "点赞帖子", share_post: "分享帖子" }
export function missionLabel(mission) {
  const key = String(mission.mission_key || "")
  return MISSION_NAMES[key] || (key.startsWith("bind_game_role") ? "绑定游戏角色" : key.startsWith("modify_signature") ? "完善个人签名" : `社区任务 ${mission.mission_id}`)
}
export function publicMiyousheSettings(profile) {
  return { enabled: Boolean(profile.enabled), community: Boolean(profile.mihoyobbs?.enable), tasks: { ...profile.mihoyobbs?.tasks }, forums: [...profile.mihoyobbs?.checkin_list || []],
    cn: Object.fromEntries(SIGNIN_GAMES.map(g => [g.key, Boolean(profile.games?.cn?.[g.key]?.checkin)])),
    os: Object.fromEntries(SIGNIN_GAMES.filter(g => g.osAct).map(g => [g.key, Boolean(profile.games?.os?.[g.key]?.checkin)])),
    osEnabled: Boolean(profile.games?.os?.enable), cloud: Object.fromEntries(["genshin", "zzz"].map(k => [k, Boolean(profile.cloud_games?.cn?.[k]?.enable)])),
    notify: Boolean(profile.profile?.notify?.enable) }
}
export class MiyousheManagement {
  constructor(options = {}) { this.loadProfile = options.loadProfile || loadLoggedInProfile; this.saveProfile = options.saveProfile || saveProfile; this.client = options.client || new MiyousheClient(options); this.runner = options.runner || new ProfileSigninService({ render: false }); this.runs = new Map(); this.captchaJobs = new Map(); this.notify = options.notify || notifyUser; this.bot = options.bot; this.now = options.now || Date.now; this.scheduler = options.scheduler || new SchedulerService(); this.loadConfig = options.loadConfig || loadGlobalConfig }
  key(qq, id) { return `${qq}:${normalizeProfileId(id)}` }
  async overview(qq, profileId = 1) {
    const id = normalizeProfileId(profileId), profile = await this.loadProfile(String(qq), id)
    let missions = null, missionError = ""
    try { missions = await this.client.missions(profile) } catch (error) { missionError = error.message }
    const account = profile.account || {}
    const date = dateString(new Date(this.now())), plan = await this.scheduler.getPlan(date)
    const entry = plan?.entries?.find(item => String(item.qq) === String(qq) && Number(item.profileId || 1) === id)
    const config = await this.loadConfig()
    return { profileId: id, nickname: profile.user?.nickname || "", account: { loggedIn: Boolean(account.cookie), refreshable: Boolean(account.stoken), deviceBound: Boolean(profile.device?.bound), roles: Object.entries(account.game_roles || {}).flatMap(([game, rows]) => (Array.isArray(rows) ? rows : []).map(role => ({ game, uid: String(role.uid || role.game_uid || role), nickname: role.nickname || "" }))) },
      settings: publicMiyousheSettings(profile), games: SIGNIN_GAMES.map(({ key, name, osAct }) => ({ key, name, overseas: Boolean(osAct) })),
      missions: missions ? { balance: missions.total_points, received: missions.already_received_points, remaining: missions.can_get_points,
        items: (missions.states || []).map(m => ({ id: m.mission_id, key: m.mission_key || "", name: missionLabel(m), done: Boolean(m.is_get_award), count: m.happened_times, automatic: Number(m.mission_id) === 58 || [59, 60, 61].includes(Number(m.mission_id)) })) } : null,
      missionError, running: this.runs.has(this.key(qq, id)), captcha: this.captchaState(qq, id),
      todaySchedule: { date, enabled: Boolean(profile.enabled) && config.scheduler?.enable !== false, time: entry?.time || "", done: Boolean(entry?.done), running: Boolean(entry?.runningAt), ok: entry?.done ? entry.ok === true : null } }
  }
  async settings(qq, profileId, input, actor = { user_id: String(qq) }) {
    if (Object.hasOwn(input, "schedule")) throw Object.assign(new Error("签到模式与时间由机器人主人统一安排，用户页面不提供修改"), { status: 403 })
    const id = normalizeProfileId(profileId)
    return withProfileWrite(String(qq), id, async () => {
      const profile = await this.loadProfile(String(qq), id)
      if (input.enabled === true && !profile.enabled && !new PermissionService({ permissions: (await this.loadConfig()).permissions }).can(actor, "checkin.register")) throw Object.assign(new Error("当前不允许注册自动签到，请联系机器人主人"), { status: 403 })
      const setBoolean = (key, target, field) => { if (input[key] !== undefined) { if (typeof input[key] !== "boolean") throw new Error(`${key} 必须为布尔值`); target[field] = input[key] } }
      setBoolean("enabled", profile, "enabled"); setBoolean("community", profile.mihoyobbs, "enable"); setBoolean("osEnabled", profile.games.os, "enable"); setBoolean("notify", profile.profile.notify, "enable")
      if (input.tasks !== undefined) for (const key of ["checkin", "read", "like", "cancel_like", "share"]) if (key in input.tasks) { if (typeof input.tasks[key] !== "boolean") throw new Error("任务开关必须为布尔值"); profile.mihoyobbs.tasks[key] = input.tasks[key] }
      if (input.forums !== undefined) {
        if (!Array.isArray(input.forums) || input.forums.some(id => ![1, 2, 3, 4, 5, 6, 8, 9, 10].includes(id))) throw new Error("社区分区无效")
        profile.mihoyobbs.checkin_list = [...new Set(input.forums)]
      }
      for (const side of ["cn", "os"]) if (input[side] !== undefined) for (const game of SIGNIN_GAMES) if (game.key in input[side]) {
        if (typeof input[side][game.key] !== "boolean" || side === "os" && !game.osAct) throw new Error("游戏开关无效")
        profile.games[side][game.key].checkin = input[side][game.key]
      }
      if (input.cloud !== undefined) for (const key of ["genshin", "zzz"]) if (key in input.cloud) { if (typeof input.cloud[key] !== "boolean") throw new Error("云游戏开关无效"); profile.cloud_games.cn[key].enable = input.cloud[key] }
      await this.saveProfile(profile)
      return publicMiyousheSettings(profile)
    })
  }
  captchaState(qq, profileId = 1) {
    const now = this.now()
    for (const [key, job] of this.captchaJobs) if (!this.runs.has(key) && now - job.updatedAt > CAPTCHA_STATE_TTL_MS) this.captchaJobs.delete(key)
    const job = this.captchaJobs.get(this.key(qq, profileId))
    return job ? structuredClone({ ...job, running: this.runs.has(this.key(qq, profileId)) }) : { events: [], running: false, status: "idle" }
  }
  async captchaStatus(qq, profileId = 1) {
    const id = normalizeProfileId(profileId)
    await this.loadProfile(String(qq), id)
    return this.captchaState(qq, id)
  }
  async run(qq, profileId) {
    const id = normalizeProfileId(profileId), key = this.key(qq, id)
    if (this.runs.has(key)) throw new Error("该 profile 的米游社任务正在执行")
    // Validate ownership before starting a detached job.
    const profile = await this.loadProfile(String(qq), id)
    if (this.runs.has(key)) throw new Error("该 profile 的米游社任务正在执行")
    const job = { events: [], status: "running", updatedAt: this.now() }
    this.captchaJobs.set(key, job)
    if (this.captchaJobs.size > MAX_CAPTCHA_JOBS) {
      for (const candidate of this.captchaJobs.keys()) {
        if (!this.runs.has(candidate) && candidate !== key) this.captchaJobs.delete(candidate)
        if (this.captchaJobs.size <= MAX_CAPTCHA_JOBS) break
      }
    }
    const reporter = createCaptchaEventReporter({ send: async message => {
      try {
        const sent = await this.notify(String(qq), message, { bot: this.bot, prefer: "private", allowGroupFallback: false, fallbackGroups: [] })
        return sent?.ok === true
      } catch {
        globalThis.logger?.warn?.("[Lotus-Plugin] 米游社任务验证码私聊通知失败，可在网页查看")
        return false
      }
    } })
    const onCaptchaEvent = async event => {
      const visible = publicCaptchaEvent(event, this.now())
      if (!visible) return
      job.events.push(visible)
      job.events = job.events.slice(-30)
      job.updatedAt = this.now()
      await reporter(visible).catch(() => {
        globalThis.logger?.warn?.("[Lotus-Plugin] 米游社任务验证码私聊通知失败，可在网页查看")
      })
    }
    const task = Promise.resolve().then(() => this.runner.run({ qq: String(qq), profileId: id, profile, onCaptchaEvent }))
    this.runs.set(key, task)
    void task.then(result => { job.status = result?.ok ? "completed" : "failed" }, () => {
      job.status = "failed"
      globalThis.logger?.warn?.("[Lotus-Plugin] 网页签到失败，请查看当前 profile 的执行记录")
    }).finally(() => {
      this.runs.delete(key)
      job.updatedAt = this.now()
    })
    return { running: true }
  }
}
