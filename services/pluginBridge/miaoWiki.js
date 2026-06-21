import { importRuntimeModule } from "./common.js"

export class MiaoWikiBridge {
  constructor(options = {}) {
    this.loadCalendar = options.loadCalendar || loadCalendar
    this.loadCalendarSr = options.loadCalendarSr || loadCalendarSr
    this.loadCalendarZZZ = options.loadCalendarZZZ || loadCalendarZZZ
    this.loadTodayMaterial = options.loadTodayMaterial || loadTodayMaterial
  }

  async renderCalendar({ e, game = "gs" } = {}) {
    const renderer = await this.calendarRenderer(game)
    return renderer.render(e)
  }

  async renderTodayMaterial({ e } = {}) {
    const renderer = await this.loadTodayMaterial()
    return renderer.render(e)
  }

  async calendarRenderer(game) {
    if (game === "sr") return this.loadCalendarSr()
    if (game === "zzz") return this.loadCalendarZZZ()
    return this.loadCalendar()
  }
}

async function loadCalendar() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "wiki", "Calendar.js")
  return mod.default
}

async function loadCalendarSr() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "wiki", "CalendarSr.js")
  return mod.default
}

async function loadCalendarZZZ() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "wiki", "CalendarZZZ.js")
  return mod.default
}

async function loadTodayMaterial() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "wiki", "TodayMaterial.js")
  return mod.default
}
