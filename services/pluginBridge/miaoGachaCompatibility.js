import { AsyncLocalStorage } from "node:async_hooks"

const compatibilityKey = Symbol.for("lotus.miao-gacha-compatibility")

// Keep upstream methods intact for calls outside this bridge, including other
// concurrent users. Only the current profile's temporary mirror supplies flags.
export function installMiaoGachaCompatibility(GachaData, GachaLuck) {
  if (GachaData[compatibilityKey]) return GachaData[compatibilityKey]
  const scope = new AsyncLocalStorage()
  const analyse = GachaData.analyse
  const stat = GachaData.stat
  const matches = (context, qq, uid, game) => context && game === "sr"
    && String(qq) === context.qq && String(uid) === context.uid

  GachaData.analyse = function (qq, uid, type, game) {
    const result = analyse.call(this, qq, uid, type, game)
    const context = scope.getStore()
    if (!result || !matches(context, qq, uid, game) || !context.records) return result
    const source = this.readJSON(qq, uid, type, game)
    const markers = markerMap(context.records[type])
    const five = source.items.filter(item => source.itemMap[item.id]?.star === 5)
    const log = result.fiveLog.filter(item => item.id !== 888)
    if (five.length !== log.length) throw new Error("星铁抽卡记录与统计样本不一致")
    log.forEach((item, index) => {
      const flag = markers.get(String(five[index].logId))
      if (typeof flag === "boolean") item.isUp = flag
    })
    const s = result.stat
    s.wai = log.filter(item => !item.isUp).length
    const upNum = s.fiveNum - s.wai
    const fiveUsed = s.allNum - s.noFiveNum
    const upUsed = upNum > 0 ? fiveUsed - (log[0]?.isUp ? 0 : log[0]?.count || 0) : 0
    s.isvalidNum = upNum > 0 ? (upUsed / upNum).toFixed(2) : 0
    const upCost = s.isvalidNum * 160
    s.upYs = upCost >= 10000 ? `${(upCost / 10000).toFixed(2)}w` : upCost.toFixed(0)
    const isUpPool = [11, 12].includes(Number(type))
    const wins = guaranteeStats(log, isUpPool)
    result.noWaiRate = wins.noWaiRate
    const luck = GachaLuck.get({ game, type, isUpPool, upNum, upUsed,
      fiveNum: s.fiveNum, fiveUsed, smallNum: wins.smallNum, smallWin: wins.smallWin })
    result.luck = luck && { ...luck, ...wins, hasNewPool: log.some(item => item.isNewPool) }
    return result
  }

  GachaData.stat = function (qq, uid, type, game) {
    const context = scope.getStore()
    const active = matches(context, qq, uid, game)
    // Older upstream parses 星铁全部 as a per-pool pagination request.
    if (active && context.allPools) type = "all"
    const result = stat.call(this, qq, uid, type, game)
    if (!result || !active || !context.records) return result
    const pools = { up: [11, 12], char: [11], weapon: [12], normal: [1], all: [11, 12, 1] }[type]
    if (!pools) return result
    const items = pools.flatMap(pool => {
      const source = this.readJSON(qq, uid, pool, game)
      const markers = markerMap(context.records[pool])
      return source.items.map(item => ({ ...item, meta: source.itemMap[item.id], flag: markers.get(String(item.logId)) }))
    }).sort((a, b) => b.time - a.time)
    const hasVersion = !["all", "normal"].includes(type)
    const groups = result.versionData.map(() => ({ char: 0, weapon: 0, ids: new Set() }))
    let version, index = -1
    for (const item of items) {
      if (!version || (hasVersion && item.time < version.start)) {
        version = this.getVersion(item.time, hasVersion, false, game)
        index++
      }
      const group = groups[index]
      if (!group) throw new Error("星铁抽卡卡池分组与统计样本不一致")
      const up = item.flag ?? Boolean((item.meta.type === "char" ? version.char5 : version.weapon5)?.includes(item.meta.name))
      if (up) {
        group.ids.add(String(item.id))
        if (item.meta.star === 5) group[item.meta.type]++
      }
    }
    let char = 0, weapon = 0
    result.versionData.forEach((row, index) => {
      const group = groups[index]
      row.upIds = {}
      for (const item of row.items) {
        item.isUp = group.ids.has(String(item.id)) ? 1 : 0
        if (item.isUp) row.upIds[item.id] = result.itemMap[item.id].name
      }
      row.stats.c5UpNum = group.char
      row.stats.w5UpNum = group.weapon
      row.stats.upNum = group.char + group.weapon
      char += group.char
      weapon += group.weapon
    })
    Object.assign(result.totalStat, { c5UpNum: char, w5UpNum: weapon, upNum: char + weapon,
      avgUpNum: char + weapon ? (result.totalStat.totalNum / (char + weapon)).toFixed(1) : 0 })
    return result
  }

  const compatibility = {
    run(context, handler) { return scope.run({ ...context, qq: String(context.qq), uid: String(context.uid) }, handler) },
  }
  Object.defineProperty(GachaData, compatibilityKey, { value: compatibility })
  return compatibility
}

function markerMap(records = []) {
  return new Map(records.filter(item => typeof item.is_up === "boolean").map(item => [String(item.id), item.is_up]))
}

function guaranteeStats(log, enabled) {
  let smallNum = 0, smallWin = 0, bigNum = 0, up = 0, wai = 0, maxUpStreak = 0, maxWaiStreak = 0
  let guaranteed = false
  for (const item of [...log].reverse()) {
    delete item.isBig
    if (!enabled) continue
    if (guaranteed) {
      item.isBig = true
      bigNum++
    } else {
      smallNum++
      if (item.isUp) { smallWin++; up++; wai = 0 } else { wai++; up = 0 }
      maxUpStreak = Math.max(maxUpStreak, up)
      maxWaiStreak = Math.max(maxWaiStreak, wai)
    }
    guaranteed = !item.isUp
  }
  return { smallNum, smallWin, bigNum, maxUpStreak, maxWaiStreak,
    noWaiRate: smallNum ? (smallWin / smallNum * 100).toFixed(1) : 0 }
}
