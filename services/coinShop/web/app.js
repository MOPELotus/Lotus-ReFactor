const $ = id => document.getElementById(id)
const state = { csrf: "", expiresAt: 0, profile: 1, page: 1, game: "", goods: [], plans: [], trackers: [], games: [], tab: "overview", nowOffset: 0, catalogRequest: 0 }
const states = { available: "正在兑换", scheduled: "等待开放", sold_out: "已兑完", ended: "已结束", unknown: "状态待确认" }
const planStates = { scheduled: "等待开放", preparing: "准备兑换", submitting: "正在提交", succeeded: "兑换成功", failed: "未成功", cancelled: "已取消", missed: "已错过", unknown: "结果待确认" }
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node }
function time(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ") }
let toastTimer
function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true }, 7000) }
async function api(route, options = {}) {
  const response = await fetch(`api/${route}`, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(state.csrf ? { "X-CSRF-Token": state.csrf } : {}), ...options.headers } })
  const data = await response.json()
  if (!response.ok) { if (response.status === 401) showLogin(data.error); throw new Error(data.error || "请求失败") }
  return data
}
function post(route, body) { return api(route, { method: "POST", body: JSON.stringify(body) }) }
function showLogin(message) { stopCaptchaPolling(); state.csrf = ""; $("dashboard").hidden = true; $("login").hidden = false; if (message) $("login-message").textContent = message }
function run(fn) { return async event => { try { await fn(event) } catch (error) { toast(error.message) } } }
function syncClock() {
  const now = Date.now() + state.nowOffset
  if (state.csrf && state.expiresAt && now >= state.expiresAt) showLogin("浏览器令牌已到期，请私聊机器人获取新的专属登录链接。")
  $("clock").textContent = time(now)
  document.querySelectorAll("[data-deadline]").forEach(node => {
    const remaining = Math.max(0, Math.ceil((Number(node.dataset.deadline) - now) / 1000))
    const days = Math.floor(remaining / 86400), hours = Math.floor(remaining % 86400 / 3600), minutes = Math.floor(remaining % 3600 / 60), seconds = remaining % 60
    node.textContent = remaining ? `距开放 ${days ? days + " 天 " : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : "已到开放时间，请刷新官方库存"
  })
}
function infoPair(container, label, value) { container.append(el("span", "", label), el("strong", "", value)) }
function renderGoods() {
  const filter = $("status").value, term = $("search").value.trim().toLowerCase()
  const goods = state.goods.filter(good => (filter === "all" || good.status === filter) && good.name.toLowerCase().includes(term))
  $("goods").replaceChildren()
  if (!goods.length) { $("goods").append(el("div", "empty", "这里暂时没有符合条件的商品。\n可以切换分区、状态或页码再看看。")); return }
  for (const good of goods) {
    const card = el("article", "good"), visual = el("div", "good-visual")
    if (good.icon) { const image = el("img"); image.src = good.icon; image.alt = good.name; image.loading = "lazy"; visual.append(image) }
    visual.append(el("span", `badge ${good.status}`, states[good.status] || "状态待确认"))
    const content = el("div", "good-body"), price = el("div", "price", good.price.toLocaleString())
    price.append(el("small", "", "米游币"))
    const info = el("div", "good-info")
    infoPair(info, "当前库存", good.unlimited ? "不限量" : good.stock ?? "未知")
    if (good.status === "scheduled") {
      infoPair(info, "开放时间", time(good.opensAt))
      infoPair(info, "下一批数量", good.nextStock ?? "未知")
    }
    const countdown = el("p", "countdown")
    if (good.status === "scheduled") countdown.dataset.deadline = good.opensAt
    else countdown.textContent = good.limit > 0 ? `账号限购 ${good.exchanged}/${good.limit}` : "查看详情了解兑换条件"
    const action = el("button", "action", good.status === "scheduled" ? "查看详情 · 预约兑换" : good.status === "available" ? "查看详情 · 立即兑换" : "查看商品详情")
    action.addEventListener("click", run(() => openDetail(good.id)))
    content.append(el("h3", "", good.name), price, info, countdown, action); card.append(visual, content); $("goods").append(card)
  }
  syncClock()
}
async function loadCatalog() {
  const request = ++state.catalogRequest
  $("catalog-note").textContent = "正在读取官方商品和余额…"
  const data = await api(`catalog?${new URLSearchParams({ profile: state.profile, game: state.game, page: state.page })}`)
  if (request !== state.catalogRequest) return
  state.games = data.games; state.goods = data.goods; state.nowOffset = data.now - Date.now()
  $("balance").textContent = data.balance === null ? "—" : Number(data.balance).toLocaleString()
  $("balance-note").textContent = data.balanceError || "来自当前账号的实时余额"
  $("upcoming").textContent = data.goods.filter(good => good.status === "scheduled").length
  $("catalog-note").textContent = `${data.total} 件商品 · 第 ${state.page} 页 · ${data.deviceBound ? "设备信息已绑定" : "尚未绑定设备，预约前请在机器人中绑定"}`
  $("game").replaceChildren(el("option", "", "全部商品")); $("game").firstChild.value = ""
  for (const game of data.games) if (game.key && game.key !== "all") { const option = el("option", "", game.name); option.value = game.key; $("game").append(option) }
  $("game").value = state.game
  $("previous").disabled = state.page <= 1; $("next").disabled = state.page * 20 >= data.total
  $("page-label").textContent = `${state.page} / ${Math.max(1, Math.ceil(data.total / 20))}`
  renderGoods()
}
async function openDetail(id) {
  const selectedProfile = state.profile
  const data = await api(`goods/${encodeURIComponent(id)}?profile=${selectedProfile}`)
  if (selectedProfile !== state.profile) return
  const { good, targets } = data, content = $("detail-content")
  content.replaceChildren(el("h2", "detail-title", good.name), el("div", "price", `${good.price.toLocaleString()} 米游币`), el("p", "muted", `${states[good.status] || "状态待确认"}${good.status === "scheduled" ? " · " + time(good.opensAt) + "（北京时间）" : ""}`), el("p", "detail-copy", good.requirements || "官方暂未提供额外兑换说明。"))
  const field = el("label", "field", targets.type === "address" ? "收货地址（来自当前账号，已脱敏）" : "接收奖励的游戏角色")
  const select = el("select"), placeholder = el("option", "", "请选择兑换目标")
  placeholder.value = ""; select.append(placeholder)
  for (const item of targets.items) { const option = el("option", "", targets.type === "address" ? item.label : `${item.nickname || "角色"} · ${item.uid} · ${item.regionName || item.region}`); option.value = targets.type === "address" ? item.id : item.uid; select.append(option) }
  if (targets.selected) select.value = targets.selected
  else if (targets.type === "role" && targets.items.length === 1) select.value = targets.items[0].uid
  field.append(select); content.append(field)
  const confirmation = el("label", "confirmation"), checkbox = el("input")
  checkbox.type = "checkbox"; confirmation.append(checkbox, el("span", "", `使用 profile ${selectedProfile} 的 ${good.price} 米游币，兑换此商品 1 件。${good.status === "scheduled" ? "到开放时间后自动尝试兑换。" : "确认后立即尝试兑换。"}`))
  const quotaReached = good.limitCycle !== "not_limit" && good.limit > 0 && good.exchanged >= good.limit
  const enabled = ["scheduled", "available"].includes(good.status) && !quotaReached
  const submit = el("button", "primary full", quotaReached ? "已达账号兑换上限" : !enabled ? "当前不可兑换" : good.status === "scheduled" ? "创建兑换预约" : "确认立即兑换")
  const update = () => { submit.disabled = !enabled || !checkbox.checked || !select.value }
  checkbox.addEventListener("change", update); select.addEventListener("change", update); update()
  submit.addEventListener("click", run(async () => {
    submit.disabled = true
    try {
      await post("plans", { profileId: selectedProfile, goodsId: good.id, immediate: good.status === "available", uid: targets.type === "role" ? select.value : "", addressId: targets.type === "address" ? select.value : "" })
      $("detail").close(); toast(good.status === "scheduled" ? "预约已保存，到点自动尝试兑换。" : "已提交兑换计划，请在兑换记录中查看结果。")
      await loadPlans(); switchTab("plans")
    } finally { update() }
  }))
  const track = el("button", "secondary full", "持续追踪此商品 · 包括后续同名商品")
  track.addEventListener("click", run(async () => { $("detail").close(); await openTracking(good) }))
  content.append(track, confirmation, submit)
  $("detail").showModal()
}
async function loadPlans() {
  const data = await api("plans"); state.plans = data.plans
  const active = data.plans.filter(plan => ["scheduled", "preparing", "submitting"].includes(plan.status))
  $("active-plans").textContent = active.length
  $("next-plan").textContent = active.length ? "最近一次：" + time(Math.min(...active.map(plan => plan.opensAt))) : "暂无进行中的兑换任务"
  $("plans").replaceChildren()
  if (!data.plans.length) { $("plans").append(el("div", "empty", "暂无兑换记录，可在商品商城中创建兑换任务。")); return }
  for (const plan of data.plans) {
    const row = el("article", "plan"), copy = el("div"), actions = el("div", "plan-actions")
    copy.append(el("span", `badge ${plan.status}`, planStates[plan.status] || plan.status), el("h3", "", plan.goodsName), el("p", "", `profile ${plan.profileId} · ${plan.price} 米游币 × 1 · ${time(plan.opensAt)}（北京时间）`), el("p", "", plan.role ? `游戏角色：${plan.role.uid} · ${plan.role.region}` : `收货地址：${plan.addressLabel}`), el("p", "", plan.message))
    if (plan.captcha?.events?.length) {
      const captcha = el("div", "captcha-status")
      renderCaptchaStatus(captcha, plan.captcha)
      copy.append(captcha)
    }
    if (["scheduled", "preparing"].includes(plan.status)) {
      const cancel = el("button", "secondary", "取消预约")
      cancel.addEventListener("click", run(async () => { await post(`plans/${plan.id}/cancel`, {}); toast("预约已取消"); await loadPlans() })); actions.append(cancel)
    }
    if (plan.status === "unknown") for (const [text, redeemed] of [["已在官方记录确认成功", true], ["已确认未兑换", false]]) {
      const resolve = el("button", "secondary", text)
      resolve.addEventListener("click", run(async () => { if (!confirm(`请先核对米游社兑换记录。${text}？`)) return; await post(`plans/${plan.id}/resolve`, { redeemed }); await loadPlans() })); actions.append(resolve)
    }
    row.append(copy, actions); $("plans").append(row)
  }
}
function switchTab(tab) {
  if (tab !== "overview") stopCaptchaPolling()
  state.tab = tab
  for (const name of ["overview", "goods", "trackers", "plans"]) { $(name + "-view").hidden = name !== tab; $("tab-" + name).classList.toggle("active", name === tab) }
}
async function init() {
  try {
    const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket")
    if (location.hash) history.replaceState(null, "", location.pathname + location.search)
    const session = ticket ? await post("session", { ticket }) : await api("session")
    state.csrf = session.csrf; state.expiresAt = session.expiresAt; state.nowOffset = session.now - Date.now()
    $("session-expiry").textContent = `浏览器令牌有效至 ${time(session.expiresAt)}（北京时间）；退出将撤销当前令牌。`
    const { profiles } = await api("profiles")
    const usable = profiles.filter(profile => profile.loggedIn)
    if (!usable.length) { showLogin("尚未绑定可用账号，请先在机器人中扫码登录。"); return }
    $("profile").replaceChildren()
    for (const profile of usable) { const option = el("option", "", `profile ${profile.id} · ${profile.name}`); option.value = profile.id; $("profile").append(option) }
    state.profile = usable[0]?.id || 1; $("profile").value = state.profile; $("profile").disabled = !usable.length
    $("login").hidden = true; $("dashboard").hidden = false
    if (usable.length) await Promise.allSettled([loadOverview(), loadCatalog(), loadPlans(), loadTrackers()])
  } catch (error) { if ($("dashboard").hidden) showLogin(error.message); else toast(error.message) }
}
$("profile").addEventListener("change", run(async () => { stopCaptchaPolling(); $("overview-captcha")?.replaceChildren(el("p", "muted", "正在读取当前 profile 的验证码状态…")); state.profile = Number($("profile").value); state.page = 1; $("detail").close(); $("tracking-detail").close(); await Promise.all([loadOverview(), loadCatalog()]) }))
$("game").addEventListener("change", run(async () => { state.game = $("game").value; state.page = 1; await loadCatalog() }))
$("status").addEventListener("change", renderGoods); $("search").addEventListener("input", renderGoods)
$("previous").addEventListener("click", run(async () => { state.page--; await loadCatalog() }))
$("next").addEventListener("click", run(async () => { state.page++; await loadCatalog() }))
$("tab-goods").addEventListener("click", () => switchTab("goods")); $("tab-plans").addEventListener("click", run(async () => { switchTab("plans"); await loadPlans() }))
$("refresh").addEventListener("click", run(async () => { await Promise.all([loadOverview(), loadCatalog(), loadPlans(), loadTrackers()]); toast("已刷新官方数据") }))
$("logout").addEventListener("click", run(async () => { await post("logout", {}); state.csrf = ""; showLogin("已退出并撤销当前浏览器令牌。下次请私聊机器人获取新的专属登录链接。") }))
$("tab-trackers").addEventListener("click", run(async () => { switchTab("trackers"); await loadTrackers() }))
$("new-tracker").addEventListener("click", run(() => openTracking()))
$("tracking-mode").addEventListener("change", trackingMode)
for (const id of ["tracking-game", "tracking-type"]) $(id).addEventListener("change", run(loadTrackingTargets))
$("tracking-form").addEventListener("submit", run(async event => {
  event.preventDefault()
  if (!$("tracking-form").reportValidity()) return
  $("tracking-submit").disabled = true
  try {
    const split = id => $(id).value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean)
    await post("trackers", { profileId: state.profile, mode: $("tracking-mode").value, game: $("tracking-game").value, itemType: Number($("tracking-type").value), goodsIds: $("tracking-mode").value === "goods" ? split("tracking-ids") : [], keywords: split("tracking-keywords"), followSameName: $("tracking-follow").checked, addressId: $("tracking-type").value === "1" ? $("tracking-target").value : "", maxPrice: $("tracking-price").value, spendLimit: $("tracking-budget").value, pollMinutes: Number($("tracking-poll").value), leadSeconds: Number($("tracking-lead").value), intervalMs: Number($("tracking-interval").value) })
    $("tracking-detail").close(); await loadTrackers(); switchTab("trackers"); toast("已开启持续追踪，成功后继续关注后续商品。")
  } finally { $("tracking-submit").disabled = false }
}))
setInterval(syncClock, 1000)
setInterval(() => { if (state.csrf && state.tab === "plans" && !document.hidden) void loadPlans().catch(error => toast(error.message)) }, 3000)
setInterval(() => { if (state.csrf && state.tab === "trackers" && !document.hidden) void loadTrackers().catch(error => toast(error.message)) }, 3000)
void init()

function trackingMode() {
  const specific = $("tracking-mode").value === "goods"
  $("tracking-ids-field").hidden = !specific; $("tracking-follow-field").hidden = !specific; $("tracking-keywords-field").hidden = specific
  $("tracking-ids").required = specific
}
let targetRequest = 0
async function loadTrackingTargets() {
  const request = ++targetRequest
  $("tracking-target").replaceChildren(); $("tracking-submit").disabled = true
  $("tracking-note").textContent = "正在读取 profile 绑定…"
  try {
    const data = await api(`tracking-targets?${new URLSearchParams({ profile: state.profile, game: $("tracking-game").value, itemType: $("tracking-type").value })}`)
    if (request !== targetRequest) return
    for (const item of data.items) { const option = el("option", "", data.type === "address" ? item.label : `${item.nickname || "角色"} · ${item.uid} · ${item.regionName || item.region}`); option.value = data.type === "address" ? item.id : item.uid; $("tracking-target").append(option) }
    $("tracking-target").disabled = data.type === "role"
    $("tracking-submit").disabled = !data.items.length
    $("tracking-note").textContent = data.type === "role" ? "使用当前 profile 的游戏 UID，规则不会自动切换角色。" : "请选择当前账号的收货地址。"
  } catch (error) { if (request === targetRequest) $("tracking-note").textContent = error.message; throw error }
}
async function openTracking(good) {
  $("tracking-form").reset()
  $("tracking-game").replaceChildren()
  for (const game of state.games) if (game.key && game.key !== "all") { const option = el("option", "", game.name); option.value = game.key; $("tracking-game").append(option) }
  $("tracking-game").value = good?.game || ({ hk4e_cn: "hk4e", hkrpg_cn: "hkrpg", nap_cn: "nap" })[good?.gameBiz] || state.game || $("tracking-game").options[0]?.value || ""
  if (good) { $("tracking-mode").value = "goods"; $("tracking-ids").value = good.id; $("tracking-type").value = good.type }
  trackingMode(); $("tracking-detail").showModal(); await loadTrackingTargets()
}
async function loadTrackers() {
  const { trackers } = await api("trackers"); state.trackers = trackers
  $("trackers").replaceChildren()
  if (!trackers.length) { $("trackers").append(el("div", "empty", "暂无追踪规则，可添加指定商品或商品类别的持续追踪。")); return }
  for (const rule of trackers) {
    const row = el("article", "plan"), copy = el("div"), actions = el("div", "plan-actions")
    copy.append(el("span", `badge ${rule.enabled ? "available" : "cancelled"}`, rule.enabled ? rule.status === "exchanging" ? "正在尝试兑换" : "持续追踪中" : "已暂停"), el("h3", "", rule.mode === "goods" ? rule.names.join("、") : `${state.games.find(game => game.key === rule.game)?.name || rule.game} · ${rule.itemType === 1 ? "实物周边" : "游戏道具"} · ${rule.keywords.join(" / ") || "全部"}`), el("p", "", `profile ${rule.profileId} · ${rule.role ? "UID " + rule.role.uid : rule.addressLabel} · 已兑换 ${rule.successes} 次 · 累计 ${rule.spent} 米游币${rule.spendLimit !== null ? " / 预算 " + rule.spendLimit : ""}`), el("p", "", `每 ${rule.pollMs / 60000} 分钟轮询 · 提前 ${rule.leadMs / 1000} 秒开始 · 每 ${rule.intervalMs} 毫秒尝试 · 按官方库存与场次决定结束${rule.maxPrice !== null ? " · 单件不超过 " + rule.maxPrice + " 米游币" : ""}`), el("p", "", rule.message))
    if (rule.lastPolledAt) copy.append(el("p", "muted", "最近轮询：" + time(rule.lastPolledAt)))
    const toggle = el("button", "secondary", rule.enabled ? "暂停追踪" : "恢复追踪")
    toggle.addEventListener("click", run(async () => { await post(`trackers/${rule.id}/${rule.enabled ? "pause" : "resume"}`, {}); await loadTrackers() }))
    actions.append(toggle); row.append(copy, actions); $("trackers").append(row)
  }
}

function checkField(label, checked) {
  const field = el("label", "option-field"), input = el("input"); input.type = "checkbox"; input.checked = Boolean(checked); field.append(input, el("span", "", label)); return { field, input }
}
let captchaPollTimer, captchaPollController, captchaPollGeneration = 0
function stopCaptchaPolling() {
  clearTimeout(captchaPollTimer)
  captchaPollController?.abort()
  captchaPollController = null
  captchaPollGeneration += 1
}
function renderCaptchaStatus(container, data = {}) {
  const events = Array.isArray(data.events) ? data.events : []
  container.replaceChildren(el("h2", "", "验证码进度"))
  container.append(el("p", "muted", data.running ? "任务执行中，验证进度会自动更新。人工验证链接也会尝试私聊发送。" : data.status === "completed" ? "本次任务已结束。" : data.status === "failed" ? "本次任务未完成，可重新尝试或联系机器人主人。" : "暂无正在处理的验证码。"))
  const latestManual = events.map(event => event.type).lastIndexOf("captcha:manual-link")
  const lastTerminal = Math.max(events.map(event => event.type).lastIndexOf("captcha:success"), events.map(event => event.type).lastIndexOf("captcha:fail"))
  events.forEach((event, index) => {
    const row = el("div", "captcha-event")
    if (Number.isFinite(event.time)) row.append(el("small", "muted", time(event.time).slice(11)))
    row.append(el("p", "", event.type === "captcha:manual-link" ? "自动识别未通过，需要人工完成本次验证。" : event.message || "验证码状态已更新。"))
    if (event.type === "captcha:manual-link" && index === latestManual && index > lastTerminal && data.running && event.link) {
      try {
        const url = new URL(event.link)
        if (["https:", "http:"].includes(url.protocol)) {
          const link = el("a", "captcha-manual-link", "打开人工验证页面")
          link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"
          row.append(link)
        }
      } catch {}
    }
    container.append(row)
  })
}
function startCaptchaPolling(profile) {
  stopCaptchaPolling()
  const generation = captchaPollGeneration
  const controller = new AbortController()
  captchaPollController = controller
  const current = () => generation === captchaPollGeneration && profile === state.profile && state.tab === "overview" && !$("dashboard").hidden
  const poll = async () => {
    if (!current()) return
    try {
      const data = await api(`miyoushe/captcha?profile=${profile}`, { signal: controller.signal })
      if (!current()) return
      const container = $("overview-captcha")
      if (container) renderCaptchaStatus(container, data)
      const button = $("miyoushe-run")
      if (button) { button.disabled = Boolean(data.running); button.textContent = data.running ? "任务执行中" : "立即执行签到与任务" }
      if (data.running) captchaPollTimer = setTimeout(poll, 1500)
    } catch (error) {
      if (!current() || controller.signal.aborted) return
      captchaPollTimer = setTimeout(poll, 4000)
    }
  }
  void poll()
}

let overviewRequest = 0
async function loadOverview() {
  stopCaptchaPolling()
  const request = ++overviewRequest, profile = state.profile
  const data = await api(`miyoushe?profile=${profile}`)
  if (request !== overviewRequest || profile !== state.profile) return
  const view = $("overview-view"), account = el("article", "overview-section"), missions = el("article", "overview-section")
  account.append(el("h2", "", "账号状态"), el("p", "", `profile ${profile} · ${data.account.loggedIn ? "已登录" : "未登录"} · ${data.account.deviceBound ? "设备已绑定" : "待绑定设备"}`), el("p", "muted", data.account.roles.map(role => `${role.nickname || role.game} · ${role.uid}`).join(" / ") || "暂无绑定游戏角色"))
  const today = data.todaySchedule || {}
  account.append(el("p", "muted", !today.enabled ? "自动签到已关闭。" : today.time ? `今日签到安排：${today.time} · ${today.running ? "正在执行" : today.done ? today.ok ? "已完成" : "执行未成功" : "等待执行"}` : "今日签到时间尚未安排，请稍后查看。"))
  missions.append(el("h2", "", "当前社区任务"))
  if (data.missions) {
    $("balance").textContent = Number(data.missions.balance).toLocaleString()
    missions.append(el("p", "muted", `今日已领 ${data.missions.received} 米游币，剩余可领 ${data.missions.remaining}。按当前账号实际任务展示。`))
    for (const item of data.missions.items) { const row = el("div", "mission-row"); row.append(el("span", "", item.name), el("span", item.done ? "complete" : "muted", item.done ? "已领奖" : item.automatic ? "待完成" : "请在米游社完成")); missions.append(row) }
  } else missions.append(el("p", "muted", data.missionError || "暂时无法读取社区任务"))
  const form = el("form", "overview-section"), settings = data.settings, fields = new Map()
  form.append(el("h2", "", "签到与通知"))
  const add = (key, label, value, group = form) => { const field = checkField(label, value); fields.set(key, field.input); group.append(field.field) }
  const switches = el("div", "option-grid"); form.append(switches)
  for (const [key, label] of [["enabled", "自动签到"], ["community", "社区任务"], ["notify", "签到结果通知"], ["osEnabled", "海外签到"]]) add(key, label, settings[key], switches)
  for (const side of ["cn", "os"]) {
    form.append(el("h3", "", side === "cn" ? "国内游戏签到" : "HoYoLAB 游戏签到")); const group = el("div", "option-grid"); form.append(group)
    for (const game of data.games.filter(g => side === "cn" || g.overseas)) add(side + "." + game.key, game.name, settings[side][game.key], group)
  }
  form.append(el("h3", "", "社区动作")); const tasks = el("div", "option-grid"); form.append(tasks)
  for (const [key, label] of [["checkin", "社区签到"], ["read", "阅读"], ["like", "点赞"], ["cancel_like", "点赞后取消"], ["share", "分享"]]) add("tasks." + key, label, settings.tasks[key], tasks)
  form.append(el("p", "muted", "阅读、点赞、分享仅在官方为当前账号提供对应任务时执行。"))
  const forums = el("div", "option-grid"); form.append(el("h3", "", "社区分区"), forums)
  for (const [id, label] of [[1,"崩坏3"],[2,"原神"],[3,"崩坏2"],[4,"未定事件簿"],[5,"大别野"],[6,"星铁"],[8,"绝区零"],[9,"因缘精灵"],[10,"星布谷地"]]) add("forum." + id, label, settings.forums.includes(id), forums)
  const cloud = el("div", "option-grid");form.append(el("h3", "", "云游戏"),cloud)
  add("cloud.genshin", "云原神", settings.cloud.genshin, cloud);add("cloud.zzz", "云绝区零", settings.cloud.zzz, cloud)
  form.append(el("p", "muted", "海外与云游戏需先通过现有聊天指令绑定各自凭证。"))
  const actions = el("div", "section-head"), save = el("button", "primary", "保存设置"), start = el("button", "secondary", data.running ? "任务执行中" : "立即执行签到与任务")
  save.type="submit";start.type="button";start.id="miyoushe-run";start.disabled=data.running;actions.append(save,start);form.append(actions)
  form.addEventListener("submit",run(async event => {
    event.preventDefault();save.disabled=true
    try { const patch={ tasks:{},cn:{},os:{},cloud:{},forums:[] }
      for(const [key,input] of fields){const [group,field]=key.split(".");if(group==="forum"){if(input.checked)patch.forums.push(Number(field))}else if(field)patch[group][field]=input.checked;else patch[key]=input.checked}
      await post("miyoushe/settings",{profileId:profile,settings:patch});toast("已保存，与聊天管理同步")
    }finally{save.disabled=false}
  }))
  start.addEventListener("click",run(async()=>{start.disabled=true;try{await post("miyoushe/run",{profileId:profile});if(profile!==state.profile)return;start.textContent="任务执行中";toast("任务已启动，验证码进度会自动更新");if(state.tab==="overview")startCaptchaPolling(profile)}catch(error){start.disabled=false;throw error}}))
  const captcha = el("article", "overview-section captcha-status"); captcha.id = "overview-captcha"
  renderCaptchaStatus(captcha, data.captcha)
  view.replaceChildren(account,missions,captcha,form)
  if (data.running && state.tab === "overview") startCaptchaPolling(profile)
}
$("tab-overview").addEventListener("click",run(async()=>{switchTab("overview");await loadOverview()}))
