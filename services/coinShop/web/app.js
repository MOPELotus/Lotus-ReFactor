const $ = id => document.getElementById(id)
const state = { csrf: "", profile: 1, page: 1, game: "", goods: [], plans: [], trackers: [], games: [], tab: "goods", nowOffset: 0, catalogRequest: 0 }
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
function showLogin(message) { state.csrf = ""; $("dashboard").hidden = true; $("login").hidden = false; if (message) $("login-message").textContent = message }
function run(fn) { return async event => { try { await fn(event) } catch (error) { toast(error.message) } } }
function syncClock() {
  const now = Date.now() + state.nowOffset
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
function switchTab(tab) { state.tab = tab; $("trackers-view").hidden = tab !== "trackers"; $("tab-trackers").classList.toggle("active", tab === "trackers"); $("goods-view").hidden = tab !== "goods"; $("plans-view").hidden = tab !== "plans"; $("tab-goods").classList.toggle("active", tab === "goods"); $("tab-plans").classList.toggle("active", tab === "plans") }
async function init() {
  try {
    const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket")
    if (location.hash) history.replaceState(null, "", location.pathname + location.search)
    const session = ticket ? await post("session", { ticket }) : await api("session")
    state.csrf = session.csrf; state.nowOffset = session.now - Date.now()
    const { profiles } = await api("profiles")
    const usable = profiles.filter(profile => profile.loggedIn)
    if (!usable.length) { showLogin("尚未绑定可用账号，请先在机器人中扫码登录。"); return }
    $("profile").replaceChildren()
    for (const profile of usable) { const option = el("option", "", `profile ${profile.id} · ${profile.name}`); option.value = profile.id; $("profile").append(option) }
    state.profile = usable[0].id; $("profile").value = state.profile
    $("login").hidden = true; $("dashboard").hidden = false
    await Promise.all([loadCatalog(), loadPlans(), loadTrackers()])
  } catch (error) { if ($("dashboard").hidden) showLogin(error.message); else toast(error.message) }
}
$("profile").addEventListener("change", run(async () => { state.profile = Number($("profile").value); state.page = 1; $("detail").close(); $("tracking-detail").close(); await loadCatalog() }))
$("game").addEventListener("change", run(async () => { state.game = $("game").value; state.page = 1; await loadCatalog() }))
$("status").addEventListener("change", renderGoods); $("search").addEventListener("input", renderGoods)
$("previous").addEventListener("click", run(async () => { state.page--; await loadCatalog() }))
$("next").addEventListener("click", run(async () => { state.page++; await loadCatalog() }))
$("tab-goods").addEventListener("click", () => switchTab("goods")); $("tab-plans").addEventListener("click", run(async () => { switchTab("plans"); await loadPlans() }))
$("refresh").addEventListener("click", run(async () => { await Promise.all([loadCatalog(), loadPlans(), loadTrackers()]); toast("已刷新官方数据") }))
$("logout").addEventListener("click", run(async () => { await post("logout", {}); state.csrf = ""; showLogin("已退出。下次请私聊机器人获取新的专属登录链接。") }))
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
    await post("trackers", { profileId: state.profile, mode: $("tracking-mode").value, game: $("tracking-game").value, itemType: Number($("tracking-type").value), goodsIds: $("tracking-mode").value === "goods" ? split("tracking-ids") : [], keywords: split("tracking-keywords"), followSameName: $("tracking-follow").checked, addressId: $("tracking-type").value === "1" ? $("tracking-target").value : "", maxPrice: $("tracking-price").value, spendLimit: $("tracking-budget").value, pollMinutes: Number($("tracking-poll").value), leadSeconds: Number($("tracking-lead").value), intervalMs: Number($("tracking-interval").value), afterSeconds: Number($("tracking-after").value) })
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
    copy.append(el("span", `badge ${rule.enabled ? "available" : "cancelled"}`, rule.enabled ? rule.status === "exchanging" ? "正在尝试兑换" : "持续追踪中" : "已暂停"), el("h3", "", rule.mode === "goods" ? rule.names.join("、") : `${state.games.find(game => game.key === rule.game)?.name || rule.game} · ${rule.itemType === 1 ? "实物周边" : "游戏道具"} · ${rule.keywords.join(" / ") || "全部"}`), el("p", "", `profile ${rule.profileId} · ${rule.role ? "UID " + rule.role.uid : rule.addressLabel} · 已兑换 ${rule.successes} 次 · 累计 ${rule.spent} 米游币${rule.spendLimit !== null ? " / 预算 " + rule.spendLimit : ""}`), el("p", "", `每 ${rule.pollMs / 60000} 分钟轮询 · 提前 ${rule.leadMs / 1000} 秒开始 · 每 ${rule.intervalMs} 毫秒尝试${rule.maxPrice !== null ? " · 单件不超过 " + rule.maxPrice + " 米游币" : ""}`), el("p", "", rule.message))
    if (rule.lastPolledAt) copy.append(el("p", "muted", "最近轮询：" + time(rule.lastPolledAt)))
    const toggle = el("button", "secondary", rule.enabled ? "暂停追踪" : "恢复追踪")
    toggle.addEventListener("click", run(async () => { await post(`trackers/${rule.id}/${rule.enabled ? "pause" : "resume"}`, {}); await loadTrackers() }))
    actions.append(toggle); row.append(copy, actions); $("trackers").append(row)
  }
}
