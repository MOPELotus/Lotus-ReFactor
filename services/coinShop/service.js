import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { loadLoggedInProfile, normalizeProfileId } from "../../core/config/profile.js"
import { notifyUser } from "../../core/transport/notify.js"
import { CoinShopClient, isCoinShopLimited } from "./client.js"
import { CoinShopStore } from "./store.js"
import { CoinShopTracking } from "./tracking.js"

const ACTIVE = new Set(["scheduled", "preparing", "submitting"])
const accountId = profile => String(profile.account?.stuid || profile.account?.ltuid || "")
const gameKey = { hk4e_cn: "gs", hkrpg_cn: "sr", nap_cn: "zzz" }

export class CoinShopService {
  constructor(options = {}) {
    this.client = options.client || new CoinShopClient(options)
    this.store = options.store || new CoinShopStore(options.file)
    this.loadProfile = options.loadProfile || loadLoggedInProfile
    this.now = options.now || Date.now
    this.wait = options.wait || ((ms, signal) => delay(ms, undefined, { signal, ref: false }))
    this.notify = options.notify || (async (plan, text) => {
      const bot = globalThis.Bot?.[plan.botId] || globalThis.Bot
      const result = await notifyUser(plan.qq, text, { bot, prefer: "private", allowGroupFallback: false })
      if (!result.ok) throw new Error(`私聊通知失败：${result.reason}，兑换结果保留在网页记录中`)
      return result
    })
    this.running = new Map()
    this.accountLocks = new Set()
    this.initializing = null
    this.timer = null
    this.tracking = new CoinShopTracking(this)
  }

  async initialize() {
    if (!this.initializing) this.initializing = (async () => {
      if ((await this.store.listTrackers()).some(rule => rule.pollUnit !== "minutes" || !Number.isFinite(rule.pollMs) || rule.pollMs < 60000)) await this.store.changeTrackers(rules => {
        for (const rule of rules) if (rule.pollUnit !== "minutes" || !Number.isFinite(rule.pollMs) || rule.pollMs < 60000) { rule.pollMs = 1800000; rule.pollUnit = "minutes" }
      })
      const plans = await this.store.list()
      if (plans.some(p => p.status === "submitting" || p.status === "preparing")) {
        await this.store.change(items => {
          for (const plan of items) {
            if (plan.status === "submitting") Object.assign(plan, { status: "unknown", message: "机器人在提交期间重启，结果待确认，请查米游社兑换记录；不会自动重发。" })
            else if (plan.status === "preparing") plan.status = "scheduled"
          }
        })
      }
      const uncertain = new Set((await this.store.list()).filter(plan => plan.status === "unknown" && plan.trackingId).map(plan => plan.trackingId))
      if (uncertain.size) await this.store.changeTrackers(rules => {
        for (const rule of rules) if (uncertain.has(rule.id)) { rule.enabled = false; rule.message = "有兑换结果待确认，请先核对米游社兑换记录" }
      })
    })()
    return this.initializing
  }

  async start() {
    await this.initialize()
    this.tracking.stopped = false
    if (this.timer) return
    this.timer = setInterval(() => void this.scan().catch(error => globalThis.logger?.warn?.(`[Lotus-Plugin] 米游币兑换调度失败：${error.message}`)), 1000)
    this.timer.unref?.()
    await this.scan()
  }

  stop() {
    this.tracking.stopped = true
    clearInterval(this.timer)
    this.timer = null
    for (const controller of this.running.values()) controller.abort()
  }

  async listPlans(qq, profileId) {
    await this.initialize()
    return (await this.store.list()).filter(plan => plan.qq === String(qq) && (!profileId || plan.profileId === Number(profileId)))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)
  }

  async destinations({ qq, profileId = 1, goodsId }) {
    const profile = await this.loadProfile(String(qq), normalizeProfileId(profileId))
    const good = await this.client.detail(goodsId, profile)
    if (good.type === 1) return { type: "address", items: await this.client.addresses(profile) }
    if (good.type === 2 && good.gameBiz) return { type: "role", items: await this.client.roles(profile, good.gameBiz), selected: profile.account.current_uid?.[gameKey[good.gameBiz]] || "" }
    throw new Error("暂不支持该商品类型")
  }

  async reserve({ qq, profileId = 1, goodsId, uid = "", addressId = "", botId = "", immediate = false, tracking = null }) {
    await this.initialize()
    const id = normalizeProfileId(profileId)
    const profile = await this.loadProfile(String(qq), id)
    this.assertDevice(profile)
    const good = await this.client.detail(goodsId, profile)
    this.assertGood(good)
    const balance = await this.client.points(profile)
    if (balance < good.price) throw new Error(`米游币不足：现有 ${balance}，商品需要 ${good.price}。`)
    let role = null, addressLabel = ""
    if (good.type === 1) {
      const addresses = await this.client.addresses(profile)
      if (!addressId) throw new Error("实物商品需指定收货地址 ID，请先查询商品的兑换目标。")
      const selected = addresses.find(address => address.id === String(addressId))
      if (!selected) throw new Error("收货地址不属于当前账号，请重新查询兑换目标。")
      addressLabel = selected.label
    } else if (good.type === 2 && good.gameBiz) {
      const roles = await this.client.roles(profile, good.gameBiz)
      const selectedUid = String(uid || profile.account.current_uid?.[gameKey[good.gameBiz]] || (roles.length === 1 ? roles[0].uid : ""))
      role = roles.find(item => item.uid === selectedUid)
      if (tracking && (role?.uid !== tracking.role?.uid || role?.region !== tracking.role?.region || role?.gameBiz !== tracking.gameBiz)) throw new Error("profile 的游戏 UID 绑定已变化")
      if (!role) throw new Error("请查询商品的兑换目标，并指定当前账号绑定的角色 UID。")
    } else throw new Error("暂不支持该商品类型")
    if (immediate && good.status !== "available") throw new Error("商品当前不可兑换，请使用预约兑换等待下一批。")
    if (!immediate && good.status !== "scheduled" && good.status !== "available") throw new Error("官方尚未公布可预约的兑换时间。")
    const plan = {
      id: randomUUID().replaceAll("-", "").slice(0, 12), qq: String(qq), profileId: id, accountId: accountId(profile), botId: String(botId),
      gameBiz: good.gameBiz,
      ...(tracking ? { trackingId: tracking.id, cycleKey: tracking.cycleKey, preStartMs: tracking.leadMs, retryIntervalMs: tracking.intervalMs, windowMs: tracking.afterMs } : {}),
      goodsId: good.id, goodsName: good.name, type: good.type, price: good.price,
      role, addressId: good.type === 1 ? String(addressId) : "", addressLabel,
      immediate,
      opensAt: good.status === "available" ? this.now() : good.opensAt,
      createdAt: this.now(), status: "scheduled", message: "等待开放兑换", attempts: 0,
    }
    if (!plan.accountId) throw new Error("profile 缺少米游社账号 ID，请重新扫码登录。")
    if (tracking && !(await this.store.listTrackers()).some(rule => rule.id === tracking.id && rule.enabled)) throw new Error("追踪已暂停")
    await this.store.change(plans => {
      if (plans.some(p => p.accountId === plan.accountId && p.goodsId === plan.goodsId && (ACTIVE.has(p.status) || p.status === "unknown"))) {
        throw new Error("该账号已有此商品的兑换计划或待确认结果，请先查看我的兑换计划。")
      }
      plans.push(plan)
      return plan
    })
    return plan
  }

  assertDevice(profile) {
    if (!profile.device?.id || !profile.device?.fp) throw new Error("兑换需要当前 profile 绑定的设备 ID 与 device_fp，请先绑定设备信息。")
  }

  assertGood(good) {
    if (!good.id || !Number.isFinite(good.price) || good.price < 0) throw new Error("商品价格或 ID 格式异常")
    if (good.status === "ended") throw new Error("商品兑换已结束")
    if (good.limitCycle !== "not_limit" && good.limit > 0 && good.exchanged >= good.limit) throw new Error("当前账号已达到该商品的兑换上限")
  }

  async cancel(qq, id) {
    await this.initialize()
    const plan = await this.store.change(plans => {
      const plan = plans.find(p => p.id === id && p.qq === String(qq))
      if (!plan) throw new Error("未找到你的兑换计划")
      if (plan.status === "submitting") throw new Error("兑换请求正在提交，暂不能取消，请等待结果。")
      if (!ACTIVE.has(plan.status)) throw new Error("该计划已经结束或结果待确认，无需取消。")
      plan.status = "cancelled"
      plan.message = "已取消"
      return plan
    })
    this.running.get(id)?.abort()
    return plan
  }

  async resolveUnknown(qq, id, redeemed) {
    await this.initialize()
    return this.store.change(plans => {
      const plan = plans.find(p => p.id === id && p.qq === String(qq))
      if (!plan) throw new Error("未找到你的兑换计划")
      if (plan.status !== "unknown") throw new Error("只有结果待确认的计划需要人工确认")
      Object.assign(plan, { status: redeemed ? "succeeded" : "failed", finishedAt: this.now(),
        message: redeemed ? "用户核对官方兑换记录后确认已兑换" : "用户核对官方兑换记录后确认未兑换，可重新预约" })
      return plan
    })
  }

  async scan() {
    await this.initialize()
    void this.tracking.poll().catch(error => globalThis.logger?.warn?.(`[Lotus-Plugin] 商城轮询失败：${error.message}`))
    for (const plan of await this.store.list()) {
      if (plan.status !== "scheduled" || plan.opensAt > this.now() + Math.max(15000, (plan.preStartMs || 0) + 10000) || this.running.has(plan.id) || this.accountLocks.has(plan.accountId)) continue
      void this.run(plan).catch(error => globalThis.logger?.warn?.(`[Lotus-Plugin] 米游币兑换 ${plan.id} 执行失败：${error.message}`))
    }
  }

  async run(plan) {
    if (this.running.has(plan.id) || this.accountLocks.has(plan.accountId)) return
    const controller = new AbortController()
    this.running.set(plan.id, controller)
    this.accountLocks.add(plan.accountId)
    let submitting = false
    try {
      if (this.now() > plan.opensAt + 30000) {
        await this.finish(plan, "missed", "已经错过预约场次，未提交兑换，请重新预约。")
        return
      }
      if (!await this.store.update(plan.id, { status: "preparing", message: "正在检查登录态、余额与兑换目标" }, ["scheduled"])) return
      const profile = await this.loadProfile(plan.qq, plan.profileId)
      if (accountId(profile) !== plan.accountId) throw new Error("profile 绑定的账号已变化，请重新预约。")
      this.assertDevice(profile)
      const good = await this.client.detail(plan.goodsId, profile)
      this.assertGood(good)
      if (good.price !== plan.price || good.type !== plan.type) throw new Error("商品价格或类型已变化，请重新预约。")
      if (await this.client.points(profile) < plan.price) throw new Error("米游币余额不足，预约停止。")
      if (plan.role) {
        if (plan.trackingId && String(profile.account.current_uid?.[gameKey[plan.gameBiz]] || "") !== plan.role.uid) throw new Error("profile 的游戏 UID 绑定已变化")
        if (good.gameBiz !== plan.role.gameBiz) throw new Error("商品游戏绑定已变化")
        const roles = await this.client.roles(profile, good.gameBiz)
        if (!roles.some(role => role.uid === plan.role.uid && role.region === plan.role.region && role.gameBiz === plan.role.gameBiz)) throw new Error("预约角色已不在账号绑定列表，请重新预约。")
      } else if (!(await this.client.addresses(profile)).some(address => address.id === plan.addressId)) throw new Error("预约收货地址已失效，请重新预约。")
      if (plan.immediate && good.status !== "available") throw new Error("商品当前不可兑换，立即兑换已停止。")
      if (!plan.immediate && good.status === "scheduled" && Math.abs(good.opensAt - plan.opensAt) > 1000) {
        await this.store.update(plan.id, { status: "scheduled", opensAt: good.opensAt, message: "官方调整了开放时间，预约已同步" }, ["preparing"])
        return
      }
      const startAt = plan.opensAt - (plan.preStartMs || 0)
      // While warming up, refresh official state rather than sleeping until a fixed timestamp.
      while (this.now() < startAt) {
        await this.wait(Math.min(1000, startAt - this.now()), controller.signal)
        if (plan.trackingId) {
          const fresh = await this.client.detail(plan.goodsId, profile)
          if (fresh.status === "available") break
          if (fresh.status === "scheduled" && Math.abs(fresh.opensAt - plan.opensAt) > 1000) {
            await this.store.update(plan.id, { status: "scheduled", opensAt: fresh.opensAt, message: "官方开放时间变化，继续轮询" }, ["preparing"])
            return
          }
        }
      }
      const interval = plan.retryIntervalMs || 500
      const deadline = plan.opensAt + (plan.windowMs || 20000)
      const maxAttempts = plan.trackingId ? Math.ceil(((plan.preStartMs || 0) + (plan.windowMs || 20000)) / interval) + 2 : 30
      for (let attempt = 1; attempt <= maxAttempts && this.now() <= deadline; attempt++) {
        if (controller.signal.aborted) return
        const latest = (await this.store.list()).find(p => p.id === plan.id)
        if (latest?.status !== "preparing") return
        if (plan.trackingId && !(await this.store.listTrackers()).some(rule => rule.id === plan.trackingId && rule.enabled)) {
          await this.cancel(plan.qq, plan.id); return
        }
        // Persist before POST. A crash or lost response must never trigger a replay.
        if (!await this.store.update(plan.id, { status: "submitting", attempts: attempt, ...(attempt === 1 ? { firstAttemptAt: this.now() } : {}), message: this.now() < plan.opensAt ? "开放前连续尝试兑换" : "正在提交兑换" }, ["preparing"])) return
        submitting = true
        const result = await this.client.exchange(plan, profile, controller.signal)
        if (result.retcode === 0) { await this.finish(plan, "succeeded", "兑换成功，请查看米游社兑换记录或游戏内邮件。"); return }
        submitting = false
        const message = String(result.message || `兑换失败（${result.retcode}）`)
        if (isCoinShopLimited(result)) {
          await this.finish(plan, "failed", `需要在米游社处理验证或风控：${message}`, { errorKind: "verification" }); return
        }
        const retryable = /未到.*(时间|开始)|尚未.*(开始|开放)|系统繁忙|服务繁忙|稍后重试/.test(message) || (plan.trackingId && /未开始|未开放|已抢光|库存不足|已兑完|售罄/.test(message))
        if (!retryable || attempt === maxAttempts || this.now() + interval > deadline) { await this.finish(plan, "failed", message); return }
        await this.store.update(plan.id, { status: "preparing", message })
        await this.wait(interval, controller.signal)
      }
      await this.finish(plan, "missed", "已超过本次兑换窗口，未继续提交。")
    } catch (error) {
      const latest = (await this.store.list()).find(p => p.id === plan.id)
      if (latest?.status === "cancelled") return
      await this.finish(plan, submitting ? "unknown" : "failed", submitting
        ? "兑换提交后连接异常，结果待确认。请查看米游社兑换记录，不会自动重发，以免重复扣币。"
        : error.message, isCoinShopLimited(error) ? { errorKind: "verification" } : /绑定.*变化|账号已变化|角色已不在/.test(error.message) ? { errorKind: "binding" } : {})
    } finally {
      this.running.delete(plan.id)
      this.accountLocks.delete(plan.accountId)
    }
  }

  async finish(plan, status, message, extra = {}) {
    const updated = await this.store.update(plan.id, { status, message, ...extra, finishedAt: this.now() }, [...ACTIVE])
    if (!updated) return
    await this.tracking.onFinish(updated, status, message)
    try { await this.notify(plan, `[米游币兑换]${plan.goodsName}\nprofile ${plan.profileId} · 计划 ${plan.id}\n${message}`) }
    catch (error) { globalThis.logger?.warn?.(`[Lotus-Plugin] 兑换结果通知失败 ${plan.id}：${error.message}`) }
  }
}
