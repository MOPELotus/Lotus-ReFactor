import fs from "node:fs/promises"
import path from "node:path"
import { loadGlobalConfig } from "../config/global.js"
import { listAllProfiles } from "../config/profile.js"
import { resolveData } from "../path.js"
import { formatLocalIso } from "../time.js"

export class SchedulerService {
  constructor(options = {}) {
    this.config = options.config
    this.random = options.random || Math.random
  }

  async getOrCreatePlan(date = nextDateString(), options = {}) {
    const file = schedulePlanPath(date)
    if (!options.force) {
      const existing = await readPlan(file)
      if (existing) return existing
    }

    const config = this.config || (await loadGlobalConfig()).scheduler
    const profiles = options.profiles || await listAllProfiles()
    const plan = this.generatePlan({
      date,
      profiles,
      config,
    })
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(plan, null, 2), "utf8")
    return plan
  }

  async getPlan(date = dateString()) {
    return readPlan(schedulePlanPath(date))
  }

  async savePlan(plan) {
    if (!plan?.date) throw new Error("schedule plan date is required")
    const file = schedulePlanPath(plan.date)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(plan, null, 2), "utf8")
    return file
  }

  async addLateProfileToExistingPlans(profile, options = {}) {
    const now = options.now || new Date()
    const dates = options.dates || [dateString(now), nextDateString(now)]
    const results = []
    for (const date of dates) {
      results.push(await this.addLateProfileToExistingPlan(profile, date, {
        ...options,
        now,
      }))
    }
    return results
  }

  async addLateProfileToExistingPlan(profile, date, options = {}) {
    if (!isProfileCheckinEnabled(profile)) {
      return {
        ok: false,
        date,
        skipped: true,
        reason: "profile_disabled",
      }
    }

    const plan = await this.getPlan(date)
    if (!plan) {
      return {
        ok: false,
        date,
        skipped: true,
        reason: "plan_not_found",
      }
    }

    if (hasPlanEntry(plan, profile)) {
      return {
        ok: true,
        date,
        skipped: true,
        reason: "entry_exists",
      }
    }

    const scheduler = normalizeSchedulerConfig(this.config || (await loadGlobalConfig()).scheduler)
    if (!scheduler.late_registration.enable) {
      return {
        ok: false,
        date,
        skipped: true,
        reason: "late_registration_disabled",
      }
    }

    const now = options.now || new Date()
    if (date === dateString(now) && minuteOfDay(now) > parseTime(scheduler.late_registration.window_end)) {
      return {
        ok: false,
        date,
        skipped: true,
        reason: "late_window_expired",
      }
    }

    const lateCount = plan.entries.filter(entry => entry.mode === "late_random").length
    const entry = createLateEntry(profile, scheduler, lateCount, now)
    plan.entries.push(entry)
    plan.entries.sort((a, b) => a.time.localeCompare(b.time) || a.qq.localeCompare(b.qq) || a.profileId - b.profileId)
    await this.savePlan(plan)

    return {
      ok: true,
      date,
      entry,
      plan,
    }
  }

  generatePlan({ date = nextDateString(), profiles = [], config = {} } = {}) {
    const scheduler = normalizeSchedulerConfig(config)
    const randomProfiles = []
    const fixedEntries = []

    for (const profile of profiles.filter(isProfileCheckinEnabled)) {
      const mode = resolveProfileScheduleMode(profile, scheduler)
      if (mode === "random") {
        randomProfiles.push(profile)
      } else {
        fixedEntries.push(createEntry(profile, profile.schedule?.fixed_time || scheduler.fixed_time, "fixed"))
      }
    }

    const randomEntries = distributeRandomProfiles(randomProfiles, scheduler, this.random)
    const entries = [...fixedEntries, ...randomEntries]
      .sort((a, b) => a.time.localeCompare(b.time) || a.qq.localeCompare(b.qq) || a.profileId - b.profileId)

    return {
      version: 1,
      date,
      mode: scheduler.mode,
      window: scheduler.random,
      generatedAt: formatLocalIso(),
      entries,
    }
  }
}

export function isProfileCheckinEnabled(profile) {
  return profile?.enabled === true
}

export function schedulePlanPath(date) {
  return resolveData("schedules", `${date}.json`)
}

export function nextDateString(now = new Date()) {
  const next = new Date(now.getTime())
  next.setDate(next.getDate() + 1)
  return dateString(next)
}

export function dateString(date = new Date()) {
  const pad = value => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function resolveProfileScheduleMode(profile, scheduler) {
  const profileMode = profile.schedule?.mode || "inherit"
  if (profileMode === "random" && profile.schedule?.allow_random !== false) return "random"
  if (profileMode === "fixed") return "fixed"
  if (scheduler.mode === "random") return "random"
  return "fixed"
}

function distributeRandomProfiles(profiles, scheduler, random) {
  if (!profiles.length) return []
  const start = parseTime(scheduler.random.window_start)
  const end = parseTime(scheduler.random.window_end)
  const span = Math.max(0, end - start)
  const step = span / profiles.length

  return profiles.map((profile, index) => {
    const slotStart = start + step * index
    const jitter = step <= 1 ? 0 : Math.floor(random() * Math.max(1, step))
    const minute = Math.min(end, Math.round(slotStart + jitter))
    return createEntry(profile, formatMinute(minute), "random")
  })
}

function createEntry(profile, time, mode) {
  return {
    qq: String(profile.user?.qq || ""),
    profileId: profile.profile?.id || 1,
    name: profile.profile?.name || "",
    time,
    mode,
    notified: false,
    done: false,
  }
}

function createLateEntry(profile, scheduler, lateCount, now) {
  const start = parseTime(scheduler.late_registration.window_start)
  const end = parseTime(scheduler.late_registration.window_end)
  const slots = Math.max(1, end - start + 1)
  const minute = start + (lateCount % slots)
  return {
    ...createEntry(profile, formatMinute(minute), "late_random"),
    late: true,
    lateRegisteredAt: formatLocalIso(now),
  }
}

function normalizeSchedulerConfig(config = {}) {
  return {
    enable: config.enable ?? true,
    plan_generate_cron: config.plan_generate_cron || "0 30 10 * * ?",
    run_due_cron: config.run_due_cron || "0 * * * * ?",
    mode: config.mode || "fixed",
    fixed_time: config.fixed_time || "04:30",
    random: {
      window_start: config.random?.window_start || "00:00",
      window_end: config.random?.window_end || "23:30",
      notify_before: config.random?.notify_before ?? true,
    },
    late_registration: {
      enable: config.late_registration?.enable ?? true,
      window_start: config.late_registration?.window_start || "23:30",
      window_end: config.late_registration?.window_end || "23:59",
      notify: config.late_registration?.notify ?? true,
    },
  }
}

async function readPlan(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function parseTime(value = "00:00") {
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/)
  if (!match) throw new Error(`Invalid time: ${value}`)
  return Math.min(24 * 60 - 1, Number(match[1]) * 60 + Number(match[2]))
}

function formatMinute(value) {
  const minute = Math.max(0, Math.min(24 * 60 - 1, Number(value)))
  const hours = Math.floor(minute / 60)
  const minutes = minute % 60
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

function hasPlanEntry(plan, profile) {
  const qq = String(profile?.user?.qq || "")
  const profileId = Number(profile?.profile?.id || 1)
  return plan.entries.some(entry => entry.qq === qq && Number(entry.profileId || 1) === profileId)
}

function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}
