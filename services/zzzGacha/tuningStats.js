const API_ROOT = "https://act-api-takumi.mihoyo.com/event/nap_gacha_record/api/zzz/"
const REFERER = "https://act.mihoyo.com/zzz/event/gacha-record/index.html"
const HISTORY_BATCH_SIZE = 8

const POOLS = Object.freeze({
  GACHA_TYPE_WEAPON_UP: { id: 3, name: "音擎频段" },
  GACHA_TYPE_WEAPON_RETURN: { id: 103, name: "音擎回响" },
  GACHA_TYPE_CHARACTER_UP: { id: 2, name: "独家频段" },
  GACHA_TYPE_CHARACTER_RETURN: { id: 102, name: "独家重映" },
  GACHA_TYPE_PERMANENT: { id: 1, name: "常驻频段" },
  GACHA_TYPE_BANGBOO: { id: 5, name: "邦布频段" },
})

const TICKET_KEYS = Object.freeze({
  GACHA_TICKET_TYPE_POLYCHROME: "polychrome",
  GACHA_TICKET_TYPE_RECHARGE_MONOCHROME: "monochrome",
  GACHA_TICKET_TYPE_ENCRYPTED_MASTER_TAPE: "encryptedMasterTape",
  GACHA_TICKET_TYPE_MASTER_TAPE: "masterTape",
  GACHA_TICKET_TYPE_BOOPON: "boopon",
})

function number(value) {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function uint(value) {
  const n = number(value)
  return Number.isSafeInteger(n) ? n : null
}

function up(value) {
  return value === true || value === 1 || value === "1" || value === "true"
}

function normalizeRecord(row, version) {
  return {
    itemId: String(row.item_id || ""),
    name: String(row.name || ""),
    icon: String(row.icon || ""),
    rarity: String(row.rarity || ""),
    itemType: String(row.item_type || ""),
    isUp: up(row.is_up),
    upTag: String(row.up_tag ?? ""),
    count: uint(row.count),
    time: uint(row.record_time),
    sort: String(row.sort ?? ""),
    version,
  }
}

function normalizePeriod(row) {
  if (!row || typeof row !== "object" || !row.version || (!Array.isArray(row.cur_records) && row.cur_records != null)) {
    throw new Error("官方调频统计返回了无法识别的频段记录")
  }
  const version = String(row.version)
  return {
    version,
    status: String(row.gacha_state || ""),
    startAt: uint(row.start_ts),
    endAt: uint(row.end_ts),
    leftStartAt: uint(row.left_start_ts),
    leftEndAt: uint(row.left_end_ts),
    firstUp: row.first_up?.item_id ? normalizeRecord(row.first_up, version) : null,
    records: (row.cur_records || []).filter(item => item?.item_id && String(item.item_id) !== "0").map(item => normalizeRecord(item, version)),
    items: (row.cur_item_list || []).filter(item => item?.item_id && String(item.item_id) !== "0").map(item => normalizeRecord(item, version)),
  }
}

function inventoryOf(index) {
  const inventory = {}
  for (const item of Array.isArray(index.cur_tickets) ? index.cur_tickets : []) {
    const key = Object.hasOwn(TICKET_KEYS, item?.ticket_type) && TICKET_KEYS[item.ticket_type]
    const value = uint(item?.ticket_cnt)
    if (key && value !== null) inventory[key] = value
  }
  return inventory
}

function endpoint(path, role, extra = {}) {
  const url = new URL(path, API_ROOT)
  url.search = new URLSearchParams({ uid: role.uid, region: role.region, ...extra }).toString()
  return url
}

const listOf = res => {
  if (!Array.isArray(res.list)) throw new Error("官方调频统计缺少频段列表，本次未更新")
  return res.list
}

function normalizedPool(type, band, periods) {
  const records = periods.flatMap(period => period.records)
  // A record can belong to two views of the same banner. Keep its largest
  // multiplicity across periods, then compare against the official S count.
  const recordsByKey = new Map()
  for (const period of periods) {
    const counts = new Map()
    for (const item of period.records) {
      const key = recordKey(item)
      const occurrence = (counts.get(key) || 0) + 1
      counts.set(key, occurrence)
      const entries = recordsByKey.get(key) || []
      if (entries.length < occurrence) entries.push(item)
      recordsByKey.set(key, entries)
    }
  }
  const uniqueOverlap = [...recordsByKey.values()].flat()
  const totalDraws = uint(band.total_count)
  const totalS = uint(band.s_count)
  if (uniqueOverlap.length === totalS) records.splice(0, records.length, ...uniqueOverlap)
  if (totalDraws === null || totalS === null || totalDraws < totalS || records.length !== totalS
    || records.some(row => row.rarity !== "S" || !row.time || !row.count)) {
    throw new Error(`官方调频统计「${POOLS[type].name}」汇总和 S 级明细暂未对齐，本次未覆盖旧记录，请稍后再试。`)
  }
  records.sort((a, b) => b.time - a.time || b.sort.localeCompare(a.sort, "en", { numeric: true }))
  return {
    type,
    name: POOLS[type].name,
    totalDraws,
    totalS,
    upCount: uint(band.up_count),
    averageUp: number(band.avr_up_count),
    pity: uint(band.next_s_cur_times),
    guaranteedWithin: uint(band.new_s_max_times),
    records,
    periods,
  }
}

function recordKey(record) {
  return JSON.stringify([record.itemId, record.time, record.sort, record.count])
}

function countAdded(previous = [], records) {
  const counts = new Map()
  for (const row of previous) {
    const key = recordKey(row)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  let added = 0
  for (const row of records) {
    const key = recordKey(row)
    const count = counts.get(key) || 0
    if (count) counts.set(key, count - 1)
    else added++
  }
  return added
}

export function summarizeTuningUpdate(stats, previous) {
  const pools = stats.pools.map(pool => ({
    type: pool.type,
    name: pool.name,
    total: pool.totalS,
    totalDraws: pool.totalDraws,
    pity: pool.pity,
    added: countAdded(previous?.pools?.find(old => old.type === pool.type)?.records, pool.records),
  }))
  return { ok: true, source: "official_tuning_stats", uid: stats.uid, region: stats.region, profileId: stats.profileId, gameBiz: "nap_cn", stats, pools, inventory: stats.inventory }
}

export class ZzzTuningStatsClient {
  constructor(request) {
    this.request = request
  }

  async read(path, role, cookie, extra = {}) {
    const response = await this.request(endpoint(path, role, extra), {
      headers: { Accept: "application/json, text/plain, */*", Cookie: cookie, Origin: "https://act.mihoyo.com", Referer: REFERER },
      redirect: "error",
    })
    if (!response?.data || typeof response.data !== "object") throw new Error("官方调频统计没有返回数据")
    return response.data
  }

  async inventory(role, cookie) {
    const index = await this.read("index", role, cookie)
    return { uid: role.uid, fetchedAt: new Date().toISOString(), inventory: inventoryOf(index) }
  }

  async snapshot(role, cookie, profileId) {
    const index = await this.read("index", role, cookie)
    const currentVersion = String(index.cur_ver || "")
    const totalDraws = uint(index.total_gacha_count)
    const totalS = uint(index.total_s_count)
    if (!currentVersion || !Array.isArray(index.type_stats) || totalDraws === null || totalS === null) {
      throw new Error("官方调频统计缺少总览，本次未更新")
    }
    const byType = new Map(index.type_stats.map(row => [row.gacha_type, row]))
    const pools = []
    for (const [type, { id }] of Object.entries(POOLS)) {
      const band = byType.get(type)
      if (!band) throw new Error("官方调频统计没有返回全部频段，本次未更新")
      const versions = [...new Set((band.has_data_vers || []).map(String))].filter(version => version && version !== currentVersion)
      const periods = listOf(await this.read("cur_pool_stat", role, cookie, { gacha_type: id })).map(normalizePeriod)
      for (let i = 0; i < versions.length; i += HISTORY_BATCH_SIZE) {
        const batch = versions.slice(i, i + HISTORY_BATCH_SIZE)
        const history = await this.read("hist_pool_stat", role, cookie, { gacha_type: id, vers: batch.join(",") })
        periods.push(...listOf(history).map(normalizePeriod))
      }
      pools.push(normalizedPool(type, band, periods))
    }
    const mainPools = pools.filter(pool => pool.type !== "GACHA_TYPE_BANGBOO")
    if (mainPools.reduce((sum, pool) => sum + pool.totalDraws, 0) !== totalDraws
      || mainPools.reduce((sum, pool) => sum + pool.totalS, 0) !== totalS) {
      throw new Error("官方调频统计总览和分频段汇总暂未对齐，本次未覆盖旧记录，请稍后再试。")
    }
    return { version: 1, uid: role.uid, region: role.region, profileId, currentVersion, totalDraws, totalS, inventory: inventoryOf(index), pools, updatedAt: new Date().toISOString() }
  }
}
