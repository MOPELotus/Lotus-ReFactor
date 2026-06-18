export function parseSchedulerSettingsCommand(message = "") {
  const text = String(message || "").trim()
  let match = text.match(/^#签到随机模式$/)
  if (match) return { ok: true, type: "mode", mode: "random" }

  match = text.match(/^#签到固定模式(?:\s+(\d{1,2}:\d{2}))?$/)
  if (match) {
    const time = match[1] ? normalizeTime(match[1]) : ""
    if (match[1] && !time) return { ok: false, reason: "invalid_time" }
    return { ok: true, type: "mode", mode: "fixed", fixedTime: time }
  }

  match = text.match(/^#签到计划生成\s+(\d{1,2}:\d{2})$/)
  if (match) {
    const time = normalizeTime(match[1])
    if (!time) return { ok: false, reason: "invalid_time" }
    return { ok: true, type: "planCron", time }
  }

  return { ok: false, reason: "unknown_command" }
}

export function applySchedulerSettings(config, command) {
  const next = structuredClone(config)
  next.scheduler ||= {}

  if (command.type === "mode") {
    next.scheduler.mode = command.mode
    if (command.fixedTime) next.scheduler.fixed_time = command.fixedTime
    return next
  }

  if (command.type === "planCron") {
    next.scheduler.plan_generate_cron = timeToCron(command.time)
    return next
  }

  throw new Error(`Unsupported scheduler command: ${command.type}`)
}

export function describeSchedulerSettings(command, config) {
  if (command.type === "mode") {
    if (command.mode === "random") return "全局签到模式已切换为随机。"
    return `全局签到模式已切换为固定，时间 ${config.scheduler.fixed_time || "未改变"}。`
  }
  if (command.type === "planCron") return `明日计划生成时间已改为 ${command.time}。`
  return "调度配置已更新。"
}

export function timeToCron(time) {
  const normalized = normalizeTime(time)
  if (!normalized) throw new Error(`Invalid time: ${time}`)
  const [hours, minutes] = normalized.split(":")
  return `0 ${Number(minutes)} ${Number(hours)} * * ?`
}

function normalizeTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return ""
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return ""
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

