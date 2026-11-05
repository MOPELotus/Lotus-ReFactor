const $ = id => document.getElementById(id)
const state = { csrf: "", expiresAt: 0, nowOffset: 0, groups: [], active: 0, inputs: new Map(), clears: new Set(), dirty: new Map(), configured: new Set(), values: {} }
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node }
let toastTimer
function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true }, 7000) }
function showLogin(message) { state.csrf = ""; state.dirty.clear(); state.clears.clear(); state.configured.clear(); state.values = {}; state.inputs.clear(); $("fields").replaceChildren(); $("dashboard").hidden = true; $("login").hidden = false; if (message) $("login-message").textContent = message }
async function api(route, body) {
  const response = await fetch(`api/${route}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(state.csrf ? { "X-CSRF-Token": state.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json()
  if (!response.ok) { if ([401, 403].includes(response.status)) showLogin(data.error); throw new Error(data.error || "请求失败") }
  return data
}
function renderGroup(index) {
  state.active = index; state.inputs.clear()
  const group = state.groups[index]
  $("breadcrumb").textContent = group.name; $("section-title").textContent = group.name; $("field-count").textContent = `${group.schemas.length} 项设置`
  for (const [i, button] of [...$("categories").children].entries()) { button.classList.toggle("active", i === index); button.setAttribute("aria-current", i === index ? "page" : "false") }
  const fields = []
  for (const schema of group.schemas) {
    const value = state.dirty.has(schema.field) ? state.dirty.get(schema.field) : state.values[schema.field], field = el("label", "field"), label = el("span", "field-label", schema.label)
    field.append(label); let input
    if (schema.component === "Select") {
      input = el("select")
      const options = schema.componentProps?.options || []
      for (const choice of options) { const option = el("option", "", choice.label); option.value = choice.value; input.append(option) }
      // Preserve existing custom values when a setting gains a fixed choice list.
      if (value !== undefined && value !== null && !options.some(choice => String(choice.value) === String(value))) {
        const option = el("option", "", `当前自定义值：${value}`); option.value = value; input.append(option)
      }
      input.value = value ?? ""
    }
    else if (schema.component === "Switch") { input = el("input"); input.type = "checkbox"; input.checked = Boolean(value); field.classList.add("switch-row") }
    else if (schema.component === "InputTextArea") { input = el("textarea"); input.rows = 3; input.value = value ?? "" }
    else { input = el("input"); input.type = schema.component === "InputPassword" ? "password" : schema.component === "InputNumber" ? "number" : "text"; if (schema.component === "InputNumber") input.step = "any"; input.value = value ?? ""; if (state.configured.has(schema.field)) input.placeholder = "已配置，留空保持" }
    input.name = schema.field; state.inputs.set(schema.field, { input, schema }); field.append(input)
    input.addEventListener("input", () => {
      const choice = schema.component === "Select" && schema.componentProps?.options?.find(option => String(option.value) === input.value)
      state.dirty.set(schema.field, schema.component === "Switch" ? input.checked : schema.component === "InputNumber" ? Number(input.value) : choice ? choice.value : input.value)
      $("save-status").textContent = "有未保存的修改"
    })
    if (schema.bottomHelpMessage) field.append(el("small", "", schema.bottomHelpMessage))
    if (state.configured.has(schema.field)) { const clearLabel = el("span", "clear-secret"), clear = el("input"); clear.type = "checkbox"; clear.checked = state.clears.has(schema.field); clear.setAttribute("aria-label", "清除" + schema.label); clear.addEventListener("change", () => { if (clear.checked) state.clears.add(schema.field); else state.clears.delete(schema.field); $("save-status").textContent = "有未保存的修改" }); clearLabel.append(clear, el("span", "", "清除此密钥")); field.append(clearLabel) }
    fields.push(field)
  }
  $("fields").replaceChildren(...fields)
  $("save-status").textContent = group.schemas.some(schema => state.dirty.has(schema.field) || state.clears.has(schema.field)) ? "有未保存的修改" : "修改后点击保存"
}
async function init() {
  try {
    const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket"); if (location.hash) history.replaceState(null, "", location.pathname + location.search)
    const session = await api("session", ticket ? { ticket } : undefined)
    state.csrf = session.csrf; state.expiresAt = session.expiresAt; state.nowOffset = session.now - Date.now(); $("expiry").textContent = `浏览器令牌至 ${new Date(session.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}`
    const data = await api("config"); state.values = data.values; state.configured = new Set(data.configured)
    for (const schema of data.schemas) { if (!schema.field) state.groups.push({ name: schema.label || "设置", schemas: [] }); else { if (!state.groups.length) state.groups.push({ name: "常规", schemas: [] }); state.groups.at(-1).schemas.push(schema) } }
    $("categories").replaceChildren(...state.groups.map((group, index) => { const button = el("button", "", group.name); button.type = "button"; button.addEventListener("click", () => renderGroup(index)); return button }))
    renderGroup(0); $("login").hidden = true; $("dashboard").hidden = false
  } catch (error) { showLogin(error.message) }
}
$("config-form").addEventListener("submit", async event => {
  event.preventDefault(); $("save").disabled = true
  try {
    const schemas = state.groups[state.active].schemas, names = new Set(schemas.map(s => s.field)), patch = { clearSecrets: [...state.clears].filter(field => names.has(field)) }
    for (const key of names) if (state.dirty.has(key)) patch[key] = state.dirty.get(key)
    if (Object.keys(patch).length === 1 && !patch.clearSecrets.length) { toast("当前分类没有未保存的修改"); return }
    const result = await api("config", patch)
    for (const key of names) { if (state.dirty.has(key)) state.values[key] = state.dirty.get(key); if (state.clears.has(key)) { state.configured.delete(key); state.values[key] = "" } else if (schemas.some(s => s.field === key && s.component === "InputPassword") && state.values[key]) { state.configured.add(key); state.values[key] = "" } state.dirty.delete(key); state.clears.delete(key) }
    renderGroup(state.active); $("save-status").textContent = "当前分类已保存"; toast(result.message || "配置已保存")
  } catch (error) { toast(error.message) } finally { $("save").disabled = false }
})
$("logout").addEventListener("click", async () => { try { await api("logout", {}); showLogin("已退出并撤销当前浏览器令牌，请私聊机器人获取新的管理链接。") } catch (error) { toast(error.message) } })
setInterval(() => { if (state.csrf && Date.now() + state.nowOffset >= state.expiresAt) showLogin("管理浏览器令牌已到期，请私聊机器人获取新链接。") }, 1000)
void init()
