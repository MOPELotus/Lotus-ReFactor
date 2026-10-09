import { AuthKeyService, buildGachaLogUrl, getServer } from "../mihoyoAuthKey/service.js"
import { importRuntimeModule, pickRole, getRoleUid } from "../pluginBridge/common.js"

const POOLS = { 301: "角色", 302: "武器", 500: "集录", 200: "常驻" }
const running = new Set()

export class MiniappGachaService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.auth = options.auth || new AuthKeyService({ fetch: (url, init) => this.fetch(url, { ...init, signal: AbortSignal.timeout(30000) }) })
    this.loadGachaLog = options.loadGachaLog || (async () => (await importRuntimeModule("genshin", "model", "gachaLog.js")).default)
  }

  async sync({ e, profile, profileId = 1 } = {}) {
    const role = pickRole(profile, "gs")
    const uid = getRoleUid(role)
    if (!uid) throw new Error(`profile ${profileId} 没有同步原神 UID。`)
    const region = role.region || getServer(uid, "gs")
    if (!/^cn_/.test(region)) throw new Error("小助手记录同步目前仅支持原神国服。")
    const key = `${e.user_id}:${uid}`
    if (running.has(key)) throw new Error("该账号的小助手记录正在同步，请稍后再试。")
    running.add(key)
    try {
      const auth = await this.auth.getAuthKey({ profile, game: "gs", uid, region, authAppId: "webview_gacha" })
      const response = await this.fetch("https://www.lelaer.com/outputGacha.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ uid, gachaurl: buildGachaLogUrl(auth), lang: "zh-Hans" }).toString(),
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) throw new Error(`小助手接口请求失败：HTTP ${response.status}`)
      let json
      try { json = await response.json() } catch { throw new Error("小助手接口返回了非 JSON 数据。") }
      if (!Array.isArray(json?.list)) throw new Error("小助手未返回记录，请检查登录状态或稍后重试。")
      const grouped = validateMiniappRecords(json.list, uid, json.info?.uid ?? json.uid)
      const GachaLog = await this.loadGachaLog()
      const model = new GachaLog({ ...e, user_id: String(e.user_id), uid, isSr: false, game: "gs", msg: "#更新小助手抽卡记录" })
      model.uid = uid
      // Validate the entire response before touching the existing gacha files.
      const pending = Object.entries(grouped).map(([type, records]) => {
        model.type = Number(type)
        const previous = model.readJson().list
        const merged = mergeGachaRecords(previous, records)
        const previousIds = new Set(previous.map(record => String(record.id)))
        return { type: Number(type), name: POOLS[type], received: records.length, added: merged.filter(record => !previousIds.has(String(record.id))).length, total: merged.length, merged }
      })
      for (const pool of pending) {
        model.type = pool.type
        model.writeJson(pool.merged)
      }
      return { uid, region, profileId, pools: pending.map(({ merged, ...pool }) => pool) }
    } finally {
      running.delete(key)
    }
  }
}

export function validateMiniappRecords(list, uid, responseUid) {
  if (responseUid != null && String(responseUid) !== uid) throw new Error("小助手返回的 UID 与当前 profile 不一致，未导入。")
  const grouped = {}
  for (const record of list) {
    if (!record || ["id", "gacha_type", "item_type", "name", "time", "rank_type"].some(field => !String(record[field] ?? "").trim())
      || !/^\d+$/.test(String(record.id)) || (typeof record.id === "number" && !Number.isSafeInteger(record.id))) {
      throw new Error("小助手记录字段缺失或 ID 无效，未导入。")
    }
    if (record.uid != null && String(record.uid) !== uid) throw new Error("小助手记录所属 UID 与当前 profile 不一致，未导入。")
    const rawType = String(record.gacha_type)
    const type = String(record.uigf_gacha_type ?? (rawType === "400" ? "301" : rawType))
    if (!POOLS[type]) throw new Error(`小助手返回了不支持的卡池类型 ${type}，未导入。`)
    ;(grouped[type] ||= []).push({ ...record, id: String(record.id), uid, gacha_type: rawType, uigf_gacha_type: type })
  }
  return grouped
}

export function mergeGachaRecords(previous, incoming) {
  const records = new Map()
  for (const record of [...previous, ...incoming]) {
    const id = String(record.id)
    if (!/^\d+$/.test(id) || (typeof record.id === "number" && !Number.isSafeInteger(record.id))) throw new Error("本地抽卡记录 ID 无效，未导入。")
    if (!records.has(id)) records.set(id, record)
  }
  return [...records.values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0)
}
