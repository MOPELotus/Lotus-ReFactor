import { cleanBridgeReply, importRuntimeModule, splitProfileSuffix } from "./common.js"
import { installMiaoGachaCompatibility } from "./miaoGachaCompatibility.js"

export function normalizeGachaView(message, game) {
  const text = splitProfileSuffix(message).message
    .replace(/^(?:\*|#(?:原神|星铁)?)/, "")
    .replace(/喵喵/g, "")
  const all = /全部/.test(text)
  const stat = /统计$/.test(text)
  let pool = text.replace(/全部|池|记录|祈愿|分析|统计/g, "")
  if (game === "sr" && pool === "武器") pool = "光锥"
  if (!pool && all) return `#${game === "sr" ? "星铁" : ""}全部${stat ? "统计" : "记录"}`
  if (!pool || /^(?:抽卡|抽奖|up)$/.test(pool)) pool = stat ? "抽卡" : "角色"
  return `#${game === "sr" ? "星铁" : ""}${pool}${all ? "全部" : ""}${stat ? "统计" : "记录"}`
}

export async function renderMiaoGacha({ e, qq, uid, game, viewMessage, starRailRecords, loadGacha = loadMiaoGacha,
  loadCompatibility = loadGacha === loadMiaoGacha ? loadMiaoCompatibility : null }) {
  // Miao does not implement these special pools or genshin's cross-pool log.
  if (/新手|联动/.test(viewMessage)) {
    if (/统计$/.test(viewMessage)) throw new Error("喵喵暂不支持新手或联动池统计，请使用对应卡池的记录指令")
    return null
  }
  if (/^#(?:星铁)?全部记录$/.test(viewMessage)) return null
  const gacha = await loadGacha()
  const replies = []
  const event = {
    ...e,
    msg: viewMessage.replace(/^#原神/, "#"),
    original_msg: viewMessage,
    isMaster: e?.isMaster === true,
    isSr: game === "sr",
    game,
    uid: String(uid),
    user_id: String(qq),
    user: { ...e?.user, qq: String(qq) },
    reply: async payload => {
      const clean = cleanBridgeReply(payload)
      if (clean !== null) replies.push(clean)
      return true
    },
  }
  const method = /统计$/.test(viewMessage) ? "stat" : "detail"
  const allPools = game === "sr" && /^#星铁全部统计$/.test(event.msg)
  if (allPools && event.runtime?.render) {
    const runtime = event.runtime
    event.runtime = Object.create(runtime)
    event.runtime.render = (plugin, template, data, ...args) => runtime.render(plugin, template,
      plugin === "miao-plugin" && template === "gacha/gacha-stat" ? { ...data, poolName: "全部" } : data, ...args)
  }
  const invoke = () => gacha[method].call({ reply: event.reply }, event)
  const compatibility = game === "sr" && loadCompatibility ? await loadCompatibility() : null
  const handled = compatibility ? await compatibility.run({ qq, uid, records: starRailRecords, allPools }, invoke) : await invoke()
  if (handled === false || !replies.length) throw new Error("喵喵抽卡查询没有返回结果")
  return { image: replies.length === 1 ? replies[0] : replies, source: `miao-plugin/gacha/gacha-${method}` }
}

async function loadMiaoGacha() {
  return (await importRuntimeModule("miao-plugin", "apps", "gacha", "Gacha.js")).default
}

async function loadMiaoCompatibility() {
  const [data, luck] = await Promise.all([
    importRuntimeModule("miao-plugin", "apps", "gacha", "GachaData.js"),
    importRuntimeModule("miao-plugin", "apps", "gacha", "GachaLuck.js"),
  ])
  return installMiaoGachaCompatibility(data.default, luck.default)
}
