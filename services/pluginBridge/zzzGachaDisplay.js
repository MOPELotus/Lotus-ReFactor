const POOL_ORDER = ["独家频段", "独家重映", "音擎频段", "音擎回响", "常驻频段", "邦布频段"]
const INVENTORY_LABELS = [
  ["polychrome", "菲林"],
  ["monochrome", "菲林底片"],
  ["encryptedMasterTape", "加密母带"],
  ["masterTape", "原装母带"],
  ["boopon", "邦布券"],
]
const LUCK_TAGS = ["非到极致", "运气不好", "平稳保底", "小欧一把", "欧狗在此"]
const LUCK_EMOJIS = [4, 1, 16, 12, 6]
const TIME_FORMAT = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" })

// ZZZ-Plugin's template consumes summaries. Feed it official totals and
// distances between S pulls instead of padding the legacy per-pull archive.
export function buildZzzTuningDisplay(stats) {
  return stats.pools.map(pool => {
    const name = pool.name
    const limited = ["独家频段", "独家重映", "音擎频段", "音擎回响"].includes(name)
    const weapon = /^音擎/.test(name)
    const bangboo = name === "邦布频段"
    const pulls = Number(pool.totalDraws)
    const fiveStars = Number(pool.totalS)
    const upCount = Number(pool.upCount)
    const records = [...pool.records].sort((left, right) => Number(right.time) - Number(left.time) || compareSort(right.sort, left.sort))
    const sum = records.reduce((total, record) => total + Number(record.count || 0), 0)
    const avgFive = fiveStars && sum > 0 ? sum / fiveStars : null
    const officialAverageUp = Number(pool.averageUp)
    const avgUp = upCount && officialAverageUp > 0 ? officialAverageUp : upCount && sum > 0 ? sum / upCount : null
    // The upstream panel estimates 50/50 outcomes from S and UP counts.
    const noWai = limited && upCount && fiveStars
      ? `${Math.round(Math.max(0, Math.min(1, 2 - fiveStars / upCount)) * 100)}%`
      : "-"
    const levels = weapon ? [62, 75, 88, 99, 111] : bangboo ? [51, 55, 61, 68, 70] : limited ? [74, 87, 99, 105, 120] : [53, 60, 68, 73, 75]
    const averageForLuck = limited || bangboo ? avgUp : avgFive
    const level = averageForLuck === null ? 2 : Math.max(0, 4 - levels.filter(limit => limit < averageForLuck).length)
    const dates = records.map(record => formatTime(record.time)).filter(Boolean)
    return {
      name,
      timeRange: dates.length ? `${dates[0]} ～ ${dates.at(-1)}（S级）` : pulls ? "暂无 S 级记录" : "还没有抽卡",
      lastFive: pool.pity ?? "-",
      fiveStars,
      upCount,
      totalCount: pulls,
      avgFive: avgFive?.toFixed(1) ?? "-",
      avgUp: avgUp?.toFixed(1) ?? "-",
      noWai,
      level,
      tag: LUCK_TAGS[level],
      emoji: LUCK_EMOJIS[level],
      list: records.map(record => ({
        name: record.name,
        square_icon: /^https:\/\//i.test(record.icon || "") ? record.icon : "",
        isUp: record.isUp === true,
        totalCount: Number(record.count) > 0 ? String(record.count) : "-",
        color: recordColor(Number(record.count), weapon || bangboo),
      })),
    }
  }).sort((left, right) => POOL_ORDER.indexOf(left.name) - POOL_ORDER.indexOf(right.name))
}

export function zzzInventoryReply({ e, profileId, uid, inventory }) {
  const fields = INVENTORY_LABELS
    .filter(([key]) => Number.isSafeInteger(inventory?.[key]) && inventory[key] >= 0)
    .map(([key, name]) => `${name} × ${inventory[key].toLocaleString("zh-CN")}`)
  if (!fields.length) return null
  const text = `Profile ${profileId}（UID: ${uid}）\n当前库存：\n${fields.slice(0, 2).join(" · ")}${fields.length > 2 ? `\n${fields.slice(2).join(" · ")}` : ""}`
  if (!e?.isGroup && !e?.group_id) return text
  const qq = String(e.user_id || "")
  if (!qq) return text
  const mention = globalThis.segment?.at?.(Number(qq) || qq) || { type: "at", qq }
  return [mention, " ", text]
}

function compareSort(left, right) {
  const a = String(left ?? ""), b = String(right ?? "")
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length || a.localeCompare(b)
  return a.localeCompare(b)
}

function formatTime(value) {
  const time = Number(value)
  if (!Number.isFinite(time) || time <= 0) return ""
  const date = new Date(time * 1000)
  return Number.isNaN(date.getTime()) ? "" : TIME_FORMAT.format(date)
}

function recordColor(draws, lowerCeiling) {
  if (draws <= 0) return "white"
  if (draws <= (lowerCeiling ? 50 : 60)) return "rgb(63, 255, 0)"
  if (draws >= (lowerCeiling ? 70 : 80)) return "rgb(255, 20, 20)"
  return "white"
}
