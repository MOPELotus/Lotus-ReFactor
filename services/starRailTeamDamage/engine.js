import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import vm from "node:vm"

const SYSTEM_DATA_ENDPOINT = "https://api.lingyuan.design/api/v1/system_data/public?is_update=true&type=all"
const API_ORIGIN = "https://api.lingyuan.design"
const API_HEADERS = Object.freeze({
  version: "280",
  platform: "weixin",
  "content-type": "application/json",
  referer: "https://servicewechat.com/wx9660a6f443d341bb/202/page-frame.html",
  "user-agent": "Mozilla/5.0 MicroMessenger",
})

export class StarRailDpsEngine {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.timeoutMs = options.timeoutMs || 20000
    this.mainRoot = options.mainRoot || process.env.LOTUS_STAR_RAIL_DPS_MAIN_ROOT || ""
    this.dpsRoot = options.dpsRoot || process.env.LOTUS_STAR_RAIL_DPS_DPS_ROOT || ""
    this.engineRoot = options.engineRoot || process.env.LOTUS_STAR_RAIL_DPS_ENGINE_ROOT || ""
    this.systemDataCacheFile = options.systemDataCacheFile || path.resolve("data", "starrail-team-damage", "system-data.json")
    this.context = null
    this.req = null
    this.moduleFactories = null
    this.systemData = options.systemData || null
    this.timers = new Set()
  }

  async ensureSystemData() {
    if (this.systemData) return this.systemData
    this.systemData = await this.readSystemDataCache()
    if (this.systemData) return this.systemData
    if (!this.fetch) throw new Error("星铁队伍伤害公开字典未缓存，且当前环境没有 fetch")

    const json = await fetchJsonWithTimeout(this.fetch, SYSTEM_DATA_ENDPOINT, {
      headers: API_HEADERS,
      timeoutMs: this.timeoutMs,
    })
    this.systemData = json?.data || {}
    if (!Array.isArray(this.systemData.system_roles)) {
      throw new Error("星铁队伍伤害公开字典返回异常")
    }
    await this.writeSystemDataCache(this.systemData)
    return this.systemData
  }

  async calculate({ roleIds = [], roles = [], panelDataById = {}, battleCycle = 5, enemyTotal = 3, seed = 20260628 } = {}) {
    try {
      await this.ensureLoaded()
      await this.ensureSystemData()
      this.installSystemData()
      this.installSeededRandom(seed)

      const CharacterFactory = this.defaultModule("03f7")
      const BattleManager = this.defaultModule("6a1b")
      const Enemy = this.defaultModule("1b32")
      const BattleSingleton = this.defaultModule("b03c")
      const PublicDict = this.defaultModule("f84f")
      const configs = deepClone(this.defaultModule("0909"))
      const factory = new CharacterFactory()
      const instances = []
      const dpsCharacterConfigs = []
      const selectedRoleIds = roleIds.map(id => Number(id)).filter(Boolean)

      for (const roleId of selectedRoleIds) {
        const baseConfig = configs.find(item => Number(item.item_id) === Number(roleId))
        if (!baseConfig) throw new Error(`星铁队伍伤害暂不支持角色 ID ${roleId}`)
        const role = roles.find(item => Number(item.item_id) === Number(roleId)) || this.getSystemRole({ item_id: roleId })
        const panel = panelDataById[String(roleId)] || null
        const config = this.buildCharacterConfig({ baseConfig, role, panel })
        dpsCharacterConfigs.push(config)
        const character = factory.getInstance(config)
        await character.initAsync()
        instances.push(character)
      }

      if (!instances.length) throw new Error("星铁队伍伤害没有可计算角色")
      const enemies = createEnemies(Enemy, enemyTotal)
      const battleManager = new BattleManager(instances, enemies)
      BattleSingleton.setInstance(battleManager)
      battleManager.setBattleCycle(normalizeBattleCycle(battleCycle))
      battleManager.setBattleMode(PublicDict.BATTLE_MODE.AUTO)
      battleManager.battleStart()
      battleManager.logManager.getFormatBattleLogs?.()

      return {
        teamDps: battleManager.logManager.teamDps,
        totalDamage: battleManager.logManager.totalDamage,
        groupRoleDamages: battleManager.logManager.groupRoleDamages || [],
        battleLogs: battleManager.logManager.battleLogs || [],
        formatBattleLogs: battleManager.logManager.formatBattleLogs || [],
        actionQueue: (battleManager.actionQueue || []).map(item => ({
          name: item.name,
          objectId: item.object_id,
          actionPoints: item.actionPoints,
        })),
        dpsCharacterConfigs,
        enemyTotal: enemies.length,
        battleCycle: normalizeBattleCycle(battleCycle),
      }
    } finally {
      this.clearTimers()
    }
  }

  buildCharacterConfig({ baseConfig = {}, role = {}, panel = null } = {}) {
    const template = role?.dps_template || {}
    const config = {
      ...deepClone(baseConfig),
      rank: number(panel?.rank ?? template.rank ?? baseConfig.rank),
      props: deepClone(panel?.combatValues || template.combatValues || baseConfig.props || {}),
    }
    if (panel?.uid) config.uid = panel.uid

    const weapon = normalizeWeaponConfig(panel?.weapon || template.weapon)
    if (weapon) config.weaponConfig = weapon
    if (Array.isArray(panel?.relicList) && panel.relicList.length) {
      config.relicList = deepClone(panel.relicList)
    }
    if (Array.isArray(panel?.skills) && panel.skills.length) {
      config.skills = mergeSkillLevels(config.skills || [], panel.skills)
    }
    return config
  }

  async ensureLoaded() {
    if (this.req) return
    const roots = this.resolveEngineRoots()
    const sourceFiles = [
      path.join(roots.mainRoot, "app-service.js"),
      ...listDpsAppServiceFiles(roots.dpsRoot),
    ].filter(file => fs.existsSync(file))
    if (!sourceFiles.length) {
      throw new Error("星铁队伍伤害引擎未初始化：缺少微信小程序 DPS 解包文件")
    }

    const moduleFactories = Object.create(null)
    const webpackJsonp = []
    webpackJsonp.push = payload => Object.assign(moduleFactories, payload?.[1] || {})
    const wxStorage = new Map()
    const appGlobal = this.createAppGlobal(wxStorage)
    const context = this.createVmContext({ webpackJsonp, wxStorage, appGlobal })
    vm.createContext(context)

    for (const file of sourceFiles) {
      const code = await fsp.readFile(file, "utf8")
      vm.runInContext(code, context, { filename: path.basename(file), timeout: 30000 })
    }

    const req = createWebpackRequire(moduleFactories)
    this.context = context
    this.req = req
    this.moduleFactories = moduleFactories
    for (const id of ["03f7", "6a1b", "1b32", "b03c", "f84f", "0909"]) {
      if (!moduleFactories[id]) throw new Error(`星铁队伍伤害引擎缺少模块 ${id}`)
    }
  }

  createAppGlobal(wxStorage) {
    return {
      globalData: {
        $G: {
          game: {
            getGameDictByKey: key => this.getGameDictByKey(key),
            getSystemRole: query => this.getSystemRole(query),
            getSystemGuang: query => this.getSystemGuang(query),
            getSystemRelicBySetId: query => this.getSystemRelicBySetId(query),
            getSystemRoleAttr: () => null,
            getGuangLevelBaseAttr,
          },
          system: {
            toFixedFloor(value, digits = 0) {
              const multiple = 10 ** digits
              return Math.floor(Number(value || 0) * multiple) / multiple
            },
          },
        },
        $request: {
          post: async (url, options = {}) => {
            const json = await fetchJsonWithTimeout(this.fetch, `${API_ORIGIN}${url}`, {
              method: "POST",
              headers: API_HEADERS,
              body: JSON.stringify(options.data || {}),
              timeoutMs: this.timeoutMs,
            })
            return { data: json }
          },
        },
      },
      wxStorage,
    }
  }

  createVmContext({ webpackJsonp, wxStorage, appGlobal }) {
    const fakeWx = createFakeWx(wxStorage)
    const timerApi = createTimerApi(this.timers)
    const context = {
      console: createQuietConsole(),
      Promise,
      setTimeout: timerApi.setTimeout,
      clearTimeout: timerApi.clearTimeout,
      setInterval: timerApi.setInterval,
      clearInterval: timerApi.clearInterval,
      global: { webpackJsonp },
      wx: fakeWx,
      Math: Object.create(Math),
      require(request) {
        if (request.includes("common/vendor") || request.includes("common/runtime")) return {}
        return {}
      },
      define(name, factory) {
        const module = { exports: {} }
        factory(
          context.require,
          module,
          module.exports,
          context.global,
          {},
          context.global,
          context.global,
          {},
          {},
          createLocalStorage(),
          {},
          {},
          {},
          {},
          () => {},
          () => true,
          () => "",
          function XMLHttpRequest() {},
          function WebSocket() {},
          {},
          {},
          {},
        )
        return module.exports
      },
      __wxAppData: {},
      __wxAppCode__: {},
      __WXML_GLOBAL__: { entrys: {}, defines: {}, modules: {}, ops: [], total_ops: 0 },
      __GWX_GLOBAL__: {},
      Component() {},
      Page() {},
      App() {},
      Behavior() {},
      definePlugin() {},
      requirePlugin() {
        return {}
      },
      getApp() {
        return appGlobal
      },
      getCurrentPages() {
        return []
      },
    }
    context.global.global = context.global
    context.global.wx = fakeWx
    context.global.__wxAppCode__ = context.__wxAppCode__
    context.global.__wxAppData = context.__wxAppData
    return context
  }

  resolveEngineRoots() {
    const explicit = normalizeEngineRootPair({
      mainRoot: this.mainRoot,
      dpsRoot: this.dpsRoot,
    })
    if (explicit) return explicit

    const roots = [
      this.engineRoot,
      path.resolve("data", "starrail-dps-engine"),
      path.resolve("data", "tmp", "wxapkg-tools", "out", "unpacked"),
    ].filter(Boolean)
    for (const root of roots) {
      const pair = normalizeEngineRootPair({
        mainRoot: path.join(root, "__APP__.dec"),
        dpsRoot: path.join(root, "_pagesDps_.dec", "pagesDps"),
      })
      if (pair) return pair
    }
    return {
      mainRoot: this.mainRoot || path.resolve("data", "starrail-dps-engine", "__APP__.dec"),
      dpsRoot: this.dpsRoot || path.resolve("data", "starrail-dps-engine", "_pagesDps_.dec", "pagesDps"),
    }
  }

  installSystemData() {
    const storage = this.context?.getApp?.()?.wxStorage || this.context?.globalData?.wxStorage
    const wxStorage = this.context?.getApp ? null : storage
    const target = this.context?.wx
    target?.setStorageSync?.("system_roles", this.systemData?.system_roles || [])
    target?.setStorageSync?.("system_guangs", this.systemData?.system_guangs || [])
    target?.setStorageSync?.("system_artifacts", this.systemData?.system_artifacts || [])
    wxStorage?.set?.("system_roles", this.systemData?.system_roles || [])
  }

  installSeededRandom(seed) {
    if (!this.context) return
    this.context.Math.random = seededRandom(seed)
  }

  defaultModule(id) {
    const mod = this.req(id)
    return mod?.default ?? mod
  }

  clearTimers() {
    for (const timer of this.timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.timers.clear()
  }

  getGameDictByKey(key) {
    return this.systemData?.[key] || []
  }

  getSystemRole(query = {}) {
    const id = String(query.item_id ?? query.id ?? query.nick_name ?? "")
    return this.getGameDictByKey("system_roles").find(item =>
      String(item.item_id) === id || String(item.id) === id || String(item.nick_name) === id) || {}
  }

  getSystemGuang(query = {}) {
    const id = String(typeof query === "object" ? (query.item_id ?? query.id) : query)
    return this.getGameDictByKey("system_guangs").find(item =>
      String(item.item_id) === id || String(item.id) === id || String(item.nick_name) === id) || {}
  }

  getSystemRelicBySetId(query = {}) {
    const id = String(typeof query === "object" ? (query.set_id ?? query.item_id ?? query.id) : query)
    return this.getGameDictByKey("system_artifacts").find(item =>
      String(item.set_id) === id || String(item.item_id) === id || String(item.id) === id) || {}
  }

  async readSystemDataCache() {
    try {
      const json = JSON.parse(await fsp.readFile(this.systemDataCacheFile, "utf8"))
      return Array.isArray(json?.system_roles) ? json : null
    } catch {
      return null
    }
  }

  async writeSystemDataCache(data) {
    try {
      await fsp.mkdir(path.dirname(this.systemDataCacheFile), { recursive: true })
      await fsp.writeFile(this.systemDataCacheFile, JSON.stringify(data), "utf8")
    } catch (error) {
      globalThis.logger?.debug?.(`[Lotus-Plugin] starrail team damage cache write skipped: ${error.message}`)
    }
  }
}

function listDpsAppServiceFiles(root) {
  try {
    return fs.readdirSync(root)
      .filter(name => (
        name === "app-service.js"
        || name === "appservice.app.js"
        || name === "common.app.js"
        || /^chunk_\d+\.appservice\.js$/.test(name)
      ))
      .sort((a, b) => appServiceOrder(a) - appServiceOrder(b) || a.localeCompare(b))
      .map(name => path.join(root, name))
  } catch {
    return []
  }
}

function appServiceOrder(name) {
  if (name === "app-service.js") return -3
  if (name === "appservice.app.js") return -2
  if (name === "common.app.js") return -1
  return Number(name.match(/^chunk_(\d+)/)?.[1] ?? 9999)
}

function createWebpackRequire(moduleFactories) {
  const cache = Object.create(null)
  function req(id) {
    if (cache[id]) return cache[id].exports
    const factory = moduleFactories[id]
    if (!factory) throw new Error(`missing webpack module ${id}`)
    const module = { exports: {} }
    cache[id] = module
    factory.call(module.exports, module, module.exports, req)
    return module.exports
  }
  req.m = moduleFactories
  req.c = cache
  req.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop)
  req.d = (exports, name, getter) => {
    if (typeof name === "object") {
      for (const key of Object.keys(name)) req.d(exports, key, name[key])
      return
    }
    if (!req.o(exports, name)) Object.defineProperty(exports, name, { enumerable: true, get: getter })
  }
  req.r = exports => {
    if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    }
    Object.defineProperty(exports, "__esModule", { value: true })
  }
  req.n = mod => {
    const getter = mod && mod.__esModule ? () => mod.default : () => mod
    req.d(getter, "a", getter)
    return getter
  }
  req.e = () => Promise.resolve()
  req.bind = Function.prototype.bind.bind(req)
  req.oe = err => { throw err }
  return req
}

function createFakeWx(wxStorage) {
  const base = {
    getStorageSync(key) {
      return wxStorage.get(key)
    },
    setStorageSync(key, value) {
      wxStorage.set(key, value)
    },
    removeStorageSync(key) {
      wxStorage.delete(key)
    },
    getSystemInfoSync() {
      return { language: "zh_CN", platform: "windows" }
    },
    getAppBaseInfo() {
      return { language: "zh_CN" }
    },
    getWindowInfo() {
      return { pixelRatio: 1 }
    },
    getDeviceInfo() {
      return { platform: "windows" }
    },
    getLaunchOptionsSync() {
      return {}
    },
    canIUse() {
      return false
    },
    showToast() {},
    showLoading() {},
    hideLoading() {},
    showModal() {
      return Promise.resolve([null, { confirm: false }])
    },
    navigateBack() {},
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === "symbol") return undefined
      return () => undefined
    },
  })
}

function createQuietConsole() {
  return {
    ...console,
    log() {},
    info() {},
    warn() {},
  }
}

function createTimerApi(timers) {
  return {
    setTimeout(fn, ms, ...args) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        fn(...args)
      }, ms)
      timers.add(timer)
      return timer
    },
    clearTimeout(timer) {
      timers.delete(timer)
      clearTimeout(timer)
    },
    setInterval(fn, ms, ...args) {
      const timer = setInterval(fn, ms, ...args)
      timers.add(timer)
      return timer
    },
    clearInterval(timer) {
      timers.delete(timer)
      clearInterval(timer)
    },
  }
}

function createLocalStorage() {
  return {
    getItem() {
      return null
    },
    setItem() {},
    removeItem() {},
  }
}

function normalizeEngineRootPair({ mainRoot, dpsRoot } = {}) {
  if (!mainRoot || !dpsRoot) return null
  return fs.existsSync(mainRoot) && fs.existsSync(dpsRoot) ? { mainRoot, dpsRoot } : null
}

function normalizeWeaponConfig(weapon = null) {
  if (!weapon?.id && !weapon?.weapon_id) return null
  return {
    weapon_id: number(weapon.weapon_id ?? weapon.id),
    level: number(weapon.level, 80),
    rank: number(weapon.rank ?? weapon.rankLevel ?? weapon.affix, 1),
  }
}

function mergeSkillLevels(baseSkills = [], panelSkills = []) {
  if (!panelSkills.length) return baseSkills
  const byType = new Map(baseSkills.map(skill => [skill.type, { ...skill }]))
  for (const skill of panelSkills) {
    const type = skill.type || skill.type_alias
    if (!type) continue
    const target = byType.get(type)
    if (target) target.level = number(skill.level, target.level)
  }
  return [...byType.values()]
}

function createEnemies(Enemy, enemyTotal = 3) {
  if (Number(enemyTotal) === 1) {
    return [new Enemy({ name: "BOSS怪", id: 9000202, item_id: 900020 })]
  }
  if (Number(enemyTotal) === 5) {
    return [
      new Enemy({ name: "小怪A", id: 9000101, item_id: 900001 }),
      new Enemy({ name: "小怪B", id: 9000102, item_id: 900001 }),
      new Enemy({ name: "BOSS怪", id: 9000202, item_id: 900020 }),
      new Enemy({ name: "小怪C", id: 9000103, item_id: 900001 }),
      new Enemy({ name: "小怪D", id: 9000104, item_id: 900001 }),
    ]
  }
  return [
    new Enemy({ name: "小怪A", id: 9000103, item_id: 900001 }),
    new Enemy({ name: "精英怪", id: 9000102, item_id: 900020 }),
    new Enemy({ name: "小怪B", id: 9000104, item_id: 900001 }),
  ]
}

function getGuangLevelBaseAttr({ promotion_values: promotionValues = [], level = 1 }) {
  const numericLevel = Number(level) || 1
  let index = 0
  if (numericLevel > 70) index = 6
  else if (numericLevel > 60) index = 5
  else if (numericLevel > 50) index = 4
  else if (numericLevel > 40) index = 3
  else if (numericLevel > 30) index = 2
  else if (numericLevel > 20) index = 1
  const values = promotionValues[index] || promotionValues[0] || {}
  const calc = entry => Number.parseInt((numericLevel - 1) * Number(entry?.step || 0) + Number(entry?.base || 0), 10)
  return {
    hp: calc(values.hp),
    atk: calc(values.atk),
    def: calc(values.def),
  }
}

async function fetchJsonWithTimeout(fetchImpl, url, { timeoutMs = 20000, ...options } = {}) {
  if (!fetchImpl) throw new Error("fetch is unavailable")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal })
    if (!response?.ok) throw new Error(`${url} HTTP ${response?.status || "请求失败"}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function normalizeBattleCycle(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 5
  return Math.min(20, Math.max(1, Math.round(n)))
}

function seededRandom(seed) {
  let state = Number(seed) || 1
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function number(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
