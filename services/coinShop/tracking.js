import { randomUUID } from "node:crypto"
import { normalizeProfileId } from "../../core/config/profile.js"
import { SHOP_GAME_BIZ, isCoinShopLimited } from "./client.js"

const ACTIVE = new Set(["scheduled", "preparing", "submitting"])
const GAME_KEY = { hk4e_cn: "gs", hkrpg_cn: "sr", nap_cn: "zzz", bh3_cn: "bh3", nxx_cn: "nxx", bh2_cn: "bh2" }
const accountId = profile => String(profile.account?.stuid || profile.account?.ltuid || "")
const normalizeText = text => String(text || "").normalize("NFKC").toLowerCase().trim()
const optionalLimit = value => value === null || value === undefined || value === "" ? null : Number(value)

export function trackingCycle(good, at) {
  const cycle = String(good.limitCycle || "forever")
  const date = new Date(at + 8 * 3600000)
  if (/day|daily/.test(cycle)) return `${good.id}:day:${date.toISOString().slice(0, 10)}`
  if (/week/.test(cycle)) { date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); return `${good.id}:week:${date.toISOString().slice(0, 10)}` }
  if (/month/.test(cycle)) return `${good.id}:month:${date.toISOString().slice(0, 7)}`
  if (cycle === "not_limit") return `${good.id}:batch:${good.saleStartsAt || good.startsAt || 0}`
  return `${good.id}:forever`
}

export function matchesTracker(rule, good) {
  if (good.type !== rule.itemType || (good.game && good.game !== rule.game)) return false
  if (rule.maxPrice !== null && good.price > rule.maxPrice) return false
  if (rule.mode === "goods") return rule.goodsIds.includes(good.id) || (rule.followSameName && rule.names.some(name => normalizeText(name) === normalizeText(good.name)))
  return !rule.keywords.length || rule.keywords.some(word => normalizeText(good.name).includes(normalizeText(word)))
}

export class CoinShopTracking {
  constructor(service) {
    this.service = service
    this.snapshots = new Map()
    this.polling = null
    this.stopped = false
  }

  async destinations({ qq, profileId = 1, game, itemType }) {
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(game || "") || ![1, 2].includes(Number(itemType))) throw new Error("请选择游戏分区与商品类型")
    const profile = await this.service.loadProfile(String(qq), normalizeProfileId(profileId))
    if (Number(itemType) === 1) return { type: "address", items: await this.service.client.addresses(profile) }
    const gameBiz = SHOP_GAME_BIZ[game]
    if (!gameBiz) throw new Error("该游戏的 profile 绑定尚未接入")
    const uid = String(profile.account.current_uid?.[GAME_KEY[gameBiz]] || "")
    const roles = await this.service.client.roles(profile, gameBiz)
    const role = roles.find(role => role.uid === uid && role.gameBiz === gameBiz && role.region)
    if (!role) throw new Error("当前 profile 未绑定这个游戏的有效 UID，请先在插件中绑定")
    return { type: "role", items: [role], selected: uid, gameBiz }
  }

  async create({ qq, profileId = 1, botId = "", mode, game, itemType, goodsIds = [], keywords = [], maxPrice, spendLimit,
    followSameName = true, addressId = "", pollMinutes = 30, leadSeconds = 5, intervalMs = 500, afterSeconds = 20 }) {
    await this.service.initialize()
    if (!["goods", "category"].includes(mode)) throw new Error("追踪方式无效")
    if (!Array.isArray(goodsIds) || goodsIds.length > 20 || goodsIds.some(id => !/^\d+$/.test(String(id)))) throw new Error("具体商品最多选择 20 件，商品 ID 必须是数字")
    if (mode === "goods" && !goodsIds.length) throw new Error("请选择需要持续追踪的商品")
    if (!Array.isArray(keywords) || keywords.length > 10 || keywords.some(word => typeof word !== "string" || word.length > 80)) throw new Error("关键词格式错误")
    const priceLimit = optionalLimit(maxPrice), totalLimit = optionalLimit(spendLimit)
    for (const limit of [priceLimit, totalLimit]) if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("米游币上限应为非负整数，不填表示不限")
    for (const [value, min, max] of [[pollMinutes, 1, 1440], [leadSeconds, 0, 30], [intervalMs, 250, 5000], [afterSeconds, 5, 60]]) {
      if (!Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error("轮询或连续请求参数超出允许范围")
    }
    const id = normalizeProfileId(profileId)
    const profile = await this.service.loadProfile(String(qq), id)
    this.service.assertDevice(profile)
    const targets = await this.destinations({ qq, profileId: id, game, itemType })
    const address = targets.type === "address" ? targets.items.find(item => item.id === String(addressId)) : null
    if (targets.type === "address" && !address) throw new Error("请选择当前账号的收货地址")
    const anchors = []
    for (const goodsId of goodsIds) {
      const good = await this.service.client.detail(String(goodsId), profile)
      if (good.type !== Number(itemType) || (good.game && good.game !== game) || (targets.gameBiz && good.gameBiz !== targets.gameBiz)) throw new Error("所选商品不属于这个 profile 的游戏或商品类型")
      anchors.push(good)
    }
    const rule = {
      id: randomUUID().replaceAll("-", "").slice(0, 12), qq: String(qq), profileId: id, accountId: accountId(profile), botId: String(botId),
      mode, game, itemType: Number(itemType), goodsIds: [...new Set(goodsIds.map(String))], names: anchors.map(good => good.name),
      keywords: keywords.map(word => word.trim()).filter(Boolean), followSameName: Boolean(followSameName), maxPrice: priceLimit, spendLimit: totalLimit,
      role: targets.type === "role" ? targets.items[0] : null, gameBiz: targets.gameBiz || "",
      addressId: address?.id || "", addressLabel: address?.label || "", pollMs: Number(pollMinutes) * 60000, pollUnit: "minutes",
      leadMs: Number(leadSeconds) * 1000, intervalMs: Number(intervalMs), afterMs: Number(afterSeconds) * 1000,
      enabled: true, createdAt: this.service.now(), message: "持续追踪中，等待官方商品状态变化",
    }
    if (!rule.accountId) throw new Error("profile 缺少米游社账号 ID")
    await this.service.store.changeTrackers(rules => { rules.push(rule); return rule })
    return rule
  }

  usage(rule, plans) {
    const relevant = plans.filter(plan => plan.trackingId === rule.id)
    const spent = relevant.filter(plan => plan.status === "succeeded").reduce((sum, plan) => sum + plan.price, 0)
    const held = relevant.filter(plan => ACTIVE.has(plan.status) || plan.status === "unknown").reduce((sum, plan) => sum + plan.price, 0)
    return { spent, held, successes: relevant.filter(plan => plan.status === "succeeded").length }
  }

  async list(qq) {
    const plans = await this.service.store.list()
    return (await this.service.store.listTrackers()).filter(rule => rule.qq === String(qq)).map(rule => ({
      ...rule, ...this.snapshots.get(rule.id), ...this.usage(rule, plans),
      message: !rule.enabled ? rule.message : this.snapshots.get(rule.id)?.message || rule.message,
      status: !rule.enabled ? "paused" : this.snapshots.get(rule.id)?.status || "watching",
    })).sort((a, b) => b.createdAt - a.createdAt)
  }

  async setEnabled(qq, id, enabled) {
    const rules = await this.service.store.listTrackers()
    const rule = rules.find(item => item.id === id && item.qq === String(qq))
    if (!rule) throw new Error("未找到你的追踪规则")
    if (enabled && (await this.service.store.list()).some(plan => plan.trackingId === id && plan.status === "unknown")) throw new Error("请先核对该规则下结果待确认的兑换记录")
    await this.service.store.changeTrackers(items => {
      const target = items.find(item => item.id === id && item.qq === String(qq))
      target.enabled = Boolean(enabled)
      target.message = enabled ? "持续追踪已恢复" : "追踪已暂停"
    })
    this.snapshots.delete(id)
    if (!enabled) {
      for (const plan of await this.service.store.list()) if (plan.trackingId === id && ["scheduled", "preparing"].includes(plan.status)) {
        try { await this.service.cancel(qq, plan.id) } catch {}
      }
    }
    return (await this.list(qq)).find(item => item.id === id)
  }

  async onFinish(plan, status, message) {
    if (!plan.trackingId) return
    const rule = (await this.service.store.listTrackers()).find(item => item.id === plan.trackingId)
    this.snapshots.set(plan.trackingId, { status: "watching", nextPollAt: this.service.now() + (rule?.pollMs || 1800000), message: status === "succeeded" ? "本轮兑换成功，继续追踪后续批次与同名新商品" : message })
    if (plan.errorKind === "verification") { await this.pauseAccount(plan.accountId, message); return }
    if (status === "unknown" || plan.errorKind === "binding") {
      await this.service.store.changeTrackers(rules => {
        const rule = rules.find(item => item.id === plan.trackingId)
        if (rule) { rule.enabled = false; rule.message = message }
      })
    }
  }

  async pauseAccount(account, message) {
    await this.service.store.changeTrackers(rules => {
      for (const rule of rules) if (rule.accountId === account) { rule.enabled = false; rule.message = message }
    })
    for (const plan of await this.service.store.list()) if (plan.accountId === account && ["scheduled", "preparing"].includes(plan.status)) {
      try { await this.service.cancel(plan.qq, plan.id) } catch {}
    }
  }

  poll() {
    if (this.polling || this.stopped) return this.polling || Promise.resolve()
    this.polling = this.pollOnce().finally(() => { this.polling = null })
    return this.polling
  }

  async pollOnce() {
    const { service } = this
    const cached = new Map()
    for (const rule of await service.store.listTrackers()) {
      if (this.stopped) return
      if (!(await service.store.listTrackers()).some(item => item.id === rule.id && item.enabled) || (this.snapshots.get(rule.id)?.nextPollAt || 0) > service.now()) continue
      if (service.accountLocks.has(rule.accountId)) { this.snapshots.set(rule.id, { ...this.snapshots.get(rule.id), status: "exchanging", nextPollAt: service.now() + 1000 }); continue }
      const snapshot = { status: "watching", lastPolledAt: service.now(), nextPollAt: service.now() + rule.pollMs, matchedCount: 0, message: "未发现符合条件的可兑换商品，继续轮询" }
      try {
        const profile = await service.loadProfile(rule.qq, rule.profileId)
        if (accountId(profile) !== rule.accountId) throw new Error("profile 的通行证已变化，请重新建立追踪规则")
        if (rule.role && String(profile.account.current_uid?.[GAME_KEY[rule.gameBiz]] || "") !== rule.role.uid) throw new Error("profile 的游戏 UID 绑定已变化，请重新建立追踪规则")
        const key = `${rule.accountId}:${rule.game}`
        if (!cached.has(key)) cached.set(key, service.client.listAll({ game: rule.game, profile }))
        const goods = (await cached.get(key)).filter(good => matchesTracker(rule, good))
        snapshot.matchedCount = goods.length
        for (const item of goods) {
          if (this.stopped || !(await service.store.listTrackers()).some(item => item.id === rule.id && item.enabled)) break
          const good = await service.client.detail(item.id, profile)
          if (!matchesTracker(rule, good) || (rule.role && good.gameBiz !== rule.gameBiz)) continue
          if (!["available", "scheduled"].includes(good.status)) continue
          if (good.status === "scheduled" && good.opensAt > service.now() + rule.leadMs + 10000) {
            snapshot.message = "已发现下一批商品，持续轮询官方开放状态"
            snapshot.nextOpenAt = good.opensAt
            snapshot.nextPollAt = Math.min(snapshot.nextPollAt, service.now() + Math.max(1000, good.opensAt - service.now() - rule.leadMs - 10000))
            continue
          }
          if (good.limitCycle !== "not_limit" && good.limit > 0 && good.exchanged >= good.limit) {
            snapshot.message = "匹配商品已达本轮限购，继续追踪下一轮或新版本商品"
            if (good.status === "scheduled") snapshot.nextPollAt = Math.min(snapshot.nextPollAt, good.opensAt + 1000)
            continue
          }
          const plans = await service.store.list()
          const cycleKey = trackingCycle(good, good.status === "scheduled" ? good.opensAt : service.now())
          if (plans.some(plan => plan.accountId === rule.accountId && plan.goodsId === good.id && (ACTIVE.has(plan.status) || plan.status === "unknown" || (plan.status === "succeeded" && plan.cycleKey === cycleKey)))) continue
          const previous = plans.filter(plan => plan.trackingId === rule.id && plan.goodsId === good.id && plan.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt)[0]
          if (previous && previous.status !== "succeeded" && previous.finishedAt + 30000 > service.now()) continue
          const { spent, held } = this.usage(rule, plans)
          if (rule.spendLimit !== null && spent + held + good.price > rule.spendLimit) { snapshot.message = "剩余追踪预算不足，等待调整预算或暂停规则"; continue }
          await service.reserve({ qq: rule.qq, profileId: rule.profileId, goodsId: good.id, uid: rule.role?.uid, addressId: rule.addressId, botId: rule.botId,
            immediate: false, tracking: { id: rule.id, cycleKey, role: rule.role, gameBiz: rule.gameBiz, leadMs: rule.leadMs, intervalMs: rule.intervalMs, afterMs: rule.afterMs } })
          snapshot.status = "exchanging"
          snapshot.message = "已进入开放前连续请求阶段，成功后继续追踪后续批次"
          snapshot.nextPollAt = service.now() + 1000
        }
      } catch (error) {
        snapshot.message = error.message
        if (isCoinShopLimited(error)) await this.pauseAccount(rule.accountId, `官方接口要求验证或限制频率，已暂停该账号的追踪：${error.message}`)
        if (/绑定已变化|通行证已变化/.test(error.message)) await service.store.changeTrackers(rules => { const item = rules.find(item => item.id === rule.id); if (item) { item.enabled = false; item.message = error.message } })
      }
      this.snapshots.set(rule.id, snapshot)
    }
  }
}
