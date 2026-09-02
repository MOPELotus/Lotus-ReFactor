import fs from "node:fs/promises"
import path from "node:path"
import { importRuntimeModule } from "./common.js"

const MIAO_POOL_TYPES = Object.freeze({
  GachaType_AvatarUp: 11,
  GachaType_EquipmentUp: 12,
  GachaType_CollabAvatarUp: 21,
  GachaType_CollabEquipmentUp: 22,
  GachaType_Standard: 1,
  GachaType_Newbie: 2,
})

export class StarRailGachaDisplayBridge {
  constructor(options = {}) {
    this.loadGachaLog = options.loadGachaLog || loadGachaLog
    this.loadGcLogApp = options.loadGcLogApp || loadGcLogApp
    this.storageRoot = options.storageRoot || path.resolve(process.cwd(), "data", "srJson")
  }

  async render({ e, uid, data, viewMessage = "#星铁角色记录" } = {}) {
    const renderUserId = `lotus-render-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      await this.mirror({ qq: renderUserId, uid, data })
      const [GachaLog, GcLogApp] = await Promise.all([this.loadGachaLog(), this.loadGcLogApp()])
      const event = createRenderEvent(e, uid, renderUserId, viewMessage)
      const model = new GachaLog(event)
      model.uid = String(uid)
      model.isLogUrl = true
      model.all = []
      const renderData = await model.getLogData()
      if (!renderData || renderData === true) throw new Error("miao 星铁抽卡渲染数据生成失败")

      const renderer = new GcLogApp()
      renderer.e = event
      renderer.reply = event.reply.bind(event)
      const image = await renderer.renderImg("genshin", "html/gacha/gacha-log", renderData, { retType: "base64" })
      if (!image) throw new Error("miao 星铁抽卡模板渲染失败")
      return {
        image,
        button: renderer.button,
        renderData,
      }
    } finally {
      await this.cleanupRender(renderUserId)
    }
  }

  async mirror({ qq, uid, data, storageRoot = this.storageRoot } = {}) {
    if (!qq || !uid) throw new Error("miao 星铁抽卡镜像缺少 QQ 或 UID")
    const directory = path.join(storageRoot, String(qq), String(uid))
    await fs.mkdir(directory, { recursive: true })
    for (const [poolType, numericType] of Object.entries(MIAO_POOL_TYPES)) {
      const records = buildMiaoPoolRecords(data?.pools?.[poolType], numericType, uid)
      await writeJsonAtomic(path.join(directory, `${numericType}.json`), records)
    }
    return directory
  }

  async syncLegacy({ qq, uid, data } = {}) {
    if (!qq || !uid) throw new Error("miao 星铁抽卡同步缺少 QQ 或 UID")
    const root = path.resolve(this.storageRoot)
    const directory = path.join(root, String(qq), String(uid))
    await backupLegacyDirectory(root, directory, qq, uid)
    return this.mirror({ qq, uid, data, storageRoot: root })
  }

  async cleanupRender(renderUserId) {
    const root = path.resolve(this.storageRoot)
    const target = path.resolve(root, String(renderUserId))
    if (!target.startsWith(`${root}${path.sep}`) || !String(renderUserId).startsWith("lotus-render-")) {
      throw new Error("拒绝清理非 Lotus 临时抽卡目录")
    }
    await fs.rm(target, { recursive: true, force: true })
  }
}

async function backupLegacyDirectory(root, directory, qq, uid) {
  try {
    await fs.access(directory)
  } catch {
    return
  }
  const backupRoot = path.resolve(`${root}.backup`)
  const backupDirectory = path.join(backupRoot, String(qq), String(uid))
  try {
    await fs.access(backupDirectory)
    return
  } catch {
    // first-seen legacy data: preserve a cold copy before Lotus overwrites it
  }
  await fs.mkdir(path.dirname(backupDirectory), { recursive: true })
  await fs.cp(directory, backupDirectory, { recursive: true, errorOnExist: false })
}

export function buildMiaoPoolRecords(pool = {}, numericType, uid) {
  const fiveStars = Array.isArray(pool?.fiveStars) ? pool.fiveStars : []
  const output = []
  let sequence = 0
  const addFillers = (count, time) => {
    for (let index = 0; index < count; index += 1) {
      sequence += 1
      output.push({
        id: `lotus-${numericType}-${sequence}`,
        uid: String(uid),
        name: "占位记录",
        item_type: "光锥",
        rank_type: "3",
        gacha_type: String(numericType),
        time,
      })
    }
  }

  const fallbackTime = fiveStarTime(fiveStars[0])
  addFillers(nonNegativeInt(pool?.pity), fallbackTime)
  for (const record of fiveStars) {
    const time = fiveStarTime(record)
    output.push({
      id: String(record.id || record.uuid || `lotus-five-${numericType}-${sequence}`),
      uid: String(uid),
      name: String(record.item?.name || "未知"),
      item_type: record.item?.item_type === "ItemType_Avatar" ? "角色" : "光锥",
      rank_type: "5",
      gacha_type: String(numericType),
      time,
    })
    addFillers(Math.max(0, nonNegativeInt(record.gacha_count) - 1), time)
  }

  const accounted = output.length
  addFillers(Math.max(0, nonNegativeInt(pool?.totalDraws) - accounted), fiveStarTime(fiveStars.at(-1)))
  return output
}

async function writeJsonAtomic(file, data) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(data, null, "\t"), "utf8")
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function createRenderEvent(e, uid, renderUserId, viewMessage) {
  const isAll = /全部/.test(String(viewMessage))
  return {
    ...e,
    msg: viewMessage,
    original_msg: viewMessage,
    isAll,
    isSr: true,
    game: "sr",
    uid: String(uid),
    user_id: String(renderUserId),
    isPrivate: true,
    reply: async () => true,
  }
}

function fiveStarTime(record) {
  const explicit = String(record?.time || record?.legacy_time || "")
  if (explicit) return explicit
  const seconds = String(record?.id || "").slice(0, 10)
  if (/^\d{10}$/.test(seconds)) {
    return new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 19)
  }
  return "1970-01-01 00:00:00"
}

function nonNegativeInt(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : 0
}

async function loadGachaLog() {
  return (await importRuntimeModule("genshin", "model", "gachaLog.js")).default
}

async function loadGcLogApp() {
  return (await importRuntimeModule("genshin", "apps", "gcLog.js")).gcLog
}
