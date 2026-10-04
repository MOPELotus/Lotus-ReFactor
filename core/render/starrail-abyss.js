import path from "node:path"
import { Canvas, FontLibrary, loadImage } from "skia-canvas"
import { resourcesPath } from "../path.js"
import { fetchImageBytes } from "./image.js"
import { encodeGpuCanvas } from "./gpu-buffer.js"

// Native adaptation of genshin/resources/html/abyss/abyss-floor.{html,css}.
// All four SR modes share its inset frame, floor separators, four-avatar teams,
// original scene, star asset, fonts and cream level strips.
const ROOT = path.join(resourcesPath, "starrail-abyss")
const GOLD = "#d3bc8d", WHITE = "#f1f1f4", MUTED = "#afb9ce"
const CACHE = new Map()
const LABELS = { hall: "混沌回忆", story: "虚构叙事", boss: "末日幻影", peak: "异相仲裁" }
const KINDS = ["boss", "story", "hall", "peak"]
let fontsLoaded = false
const hasValue = value => value !== undefined && value !== null && value !== ""
const valueOr = (value, suffix = "") => hasValue(value) ? `${value}${suffix}` : "暂无记录"
const kindOf = result => result.kind || KINDS[result.challengeType]

export function isStarRailAbyss(data = {}) {
  return Boolean(data.results?.length) && data.results.every(result => LABELS[kindOf(result)])
}

// Translate mode data into the SAME source floor/team structure. Keep every
// result/peak record, and retain the existing deepest-valid-floor selection.
export function buildStarRailAbyssSections(data = {}) {
  return (data.results || []).flatMap(result => {
    const kind = kindOf(result)
    const common = { label: result.label || LABELS[kind] || "挑战战绩", scheduleType: result.scheduleType, extraStars: result.extraStars }
    if (kind === "peak" && result.peak?.length) return result.peak.map(record => {
      const nodes = [record.boss && { ...record.boss, label: "王棋" }, ...(record.mobs || []).map((mob, i) => ({ ...mob, label: `骑士 ${i + 1}` }))].filter(Boolean)
      const stars = hasValue(record.bossStars) || hasValue(record.mobStars) ? Number(record.bossStars || 0) + Number(record.mobStars || 0) : ""
      return { ...common, period: record.period || result.period, stars, floorTitle: record.title || "异相仲裁", nodes,
        metrics: [["王棋星数", valueOr(record.bossStars, " 星")], ["骑士星数", valueOr(record.mobStars, " 星")], ["战斗次数", valueOr(record.battleNum, " 次")], ["通关关卡", `${nodes.filter(node => node.cleared).length} / ${nodes.length}`]],
      }
    })
    const floors = (result.floors || []).filter(floor => hasValue(floor.stars) || hasValue(floor.round) || hasValue(floor.score) || floor.nodes?.length)
    const floor = floors.at(-1)
    return [{ ...common, period: result.period, stars: result.stars, floorTitle: floor?.title || "挑战记录", floorStars: floor?.stars,
      floorMaxStars: floor?.tierce ? 4 : Math.max(3, Number(floor?.stars || 0)), nodes: floor?.nodes || [],
      metrics: [[hasValue(floor?.score) ? "关卡积分" : "最深抵达", hasValue(floor?.score) ? String(floor.score) : valueOr(result.maxFloor)], ["使用轮次", valueOr(floor?.round, " 轮")], ["战斗次数", valueOr(result.battleNum, " 次")], ["关卡星数", valueOr(floor?.stars, " 星")]],
    }]
  })
}

async function image(src) {
  if (!src) return null
  if (!CACHE.has(src)) {
    CACHE.set(src, (async () => loadImage(/^https?:\/\//i.test(src) ? await fetchImageBytes(src) : /^file:\/\//i.test(src) ? new URL(src) : src))().catch(error => {
      CACHE.delete(src)
      globalThis.logger?.warn?.(`[荷花深渊模板] 图片加载失败：${error.message}`)
      return null
    }))
    if (CACHE.size > 96) CACHE.delete(CACHE.keys().next().value)
  }
  return CACHE.get(src)
}

export async function renderStarRailAbyss(data = {}, options = {}) {
  if (!fontsLoaded) {
    FontLibrary.use("AbyssText", [path.join(ROOT, "fonts/HYWenHei-55W.ttf")])
    FontLibrary.use("AbyssNumber", [path.join(ROOT, "fonts/tttgbnumber.ttf")])
    fontsLoaded = true
  }
  const scaleValue = Number(options.renderScale ?? data.renderScale ?? process.env.LOTUS_RENDER_SCALE ?? 4)
  const scale = Number.isFinite(scaleValue) ? Math.min(4, Math.max(1, scaleValue)) : 4
  const canvas = new Canvas(760, 10), ctx = canvas.getContext("2d")
  const family = '"AbyssText", MiSans, sans-serif'
  function text(value, x, y, size = 18, color = WHITE, width = 650, align = "left", number = false) {
    const label = String(value ?? "")
    ctx.font = `${size}px ${number ? '"AbyssNumber", ' : ""}${family}`
    while (ctx.measureText(label).width > width && size > 12) {
      size -= 0.5
      ctx.font = `${size}px ${number ? '"AbyssNumber", ' : ""}${family}`
    }
    ctx.fillStyle = color; ctx.textBaseline = "top"; ctx.textAlign = align
    ctx.fillText(label, align === "center" ? x + width / 2 : align === "right" ? x + width : x, y)
  }
  function wrap(value, width, size = 17) {
    ctx.font = `${size}px ${family}`
    const lines = []
    for (const paragraph of String(value || "").split(/\r?\n/)) {
      let line = ""
      for (const char of paragraph) {
        if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = "" }
        line += char
      }
      if (line) lines.push(line)
    }
    return lines
  }
  const sections = buildStarRailAbyssSections(data)
  if (!sections.length) sections.push({ label: "挑战战绩", period: "", stars: "", floorTitle: "挑战记录", metrics: [], nodes: [] })
  const layouts = sections.map(section => {
    const titleLines = wrap(section.floorTitle, hasValue(section.floorStars) ? 500 : 672, 26)
    const headerHeight = 396 + Math.max(0, titleLines.length - 1) * 33
    const nodes = section.nodes.map((node, index) => {
      const buffLines = wrap(node.buff, 624)
      const isEnemy = Boolean(node.title)
      const titleLines = isEnemy ? wrap(node.title, node.icon ? 526 : 636, 22) : []
      const meta = [node.time, hasValue(node.score) ? `积分 ${node.score}` : "", hasValue(node.round) ? `${node.round} 轮` : "", hasValue(node.stars) ? `${node.stars} 星` : "", node.defeated === true ? "已击败首领" : node.defeated === false ? "未击败首领" : "", hasValue(node.cleared) ? (node.cleared ? "已通关" : "未通关") : "", node.hard ? "绝境模式" : "", node.fast ? "快速通关" : ""].filter(Boolean).join(" · ")
      const metaLines = wrap(meta || "暂无战斗记录", 636, 16)
      const label = /^节点\d+$/.test(node.label || "") ? (section.nodes.length === 2 ? (index === 0 ? "上半" : "下半") : `第${["一", "二", "三"][index] || index + 1}队`) : (node.label || `队伍 ${index + 1}`)
      const teamTop = (isEnemy ? Math.max(node.icon ? 132 : 82, 44 + titleLines.length * 29) : 42) + metaLines.length * 23 + 12
      const rows = Math.max(1, Math.ceil((node.avatars?.length || 0) / 4))
      return { node, label, titleLines, metaLines, teamTop, buffLines, rows, height: teamTop + rows * 195 + (buffLines.length ? 12 + buffLines.length * 25 : 0) + 12 }
    })
    return { section, titleLines, headerHeight, nodes, height: headerHeight + (nodes.length ? nodes.reduce((sum, item) => sum + item.height + 14, 0) : 130) }
  })
  const height = layouts.reduce((sum, item) => sum + item.height, 0) + 86
  canvas.width = Math.round(760 * scale); canvas.height = Math.round(height * scale)
  ctx.scale(scale, scale); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"
  const refs = new Set([path.join(ROOT, "floor12.png"), path.join(ROOT, "star.png")])
  for (const section of sections) for (const node of section.nodes) {
    if (node.icon) refs.add(node.icon)
    for (const avatar of node.avatars || []) if (avatar.icon) refs.add(avatar.icon)
  }
  const images = new Map()
  await Promise.all([...refs].map(async src => images.set(src, await image(src))))
  const bg = images.get(path.join(ROOT, "floor12.png")), star = images.get(path.join(ROOT, "star.png"))
  function rect(x, y, w, h, fill, radius = 0) {
    ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill()
  }
  function line(x, y, w, color = "rgba(211,188,141,0.30)") {
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke()
  }
  function starAt(x, y, size, active = true) {
    ctx.save(); ctx.globalAlpha = active ? 1 : 0.20
    if (star) ctx.drawImage(star, x, y, size, size)
    ctx.restore()
  }
  rect(0, 0, 760, height, "#1d2a4a")
  ctx.strokeStyle = "rgba(211,188,141,0.65)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.roundRect(12, 12, 736, height - 24, 14); ctx.stroke()
  ctx.strokeStyle = "rgba(255,255,255,0.13)"; ctx.beginPath(); ctx.roundRect(18, 18, 724, height - 36, 10); ctx.stroke()
  let offset = 0
  for (const layout of layouts) {
    const { section, headerHeight } = layout
    ctx.save(); ctx.translate(0, offset)
    if (bg) ctx.drawImage(bg, 20, 0, 720, 720 * bg.height / bg.width)
    const shade = ctx.createLinearGradient(0, 0, 0, 450)
    shade.addColorStop(0, "rgba(10,19,39,0.20)"); shade.addColorStop(1, "rgba(10,19,39,0)")
    rect(20, 0, 720, 450, shade)
    text("崩坏：星穹铁道", 44, 39, 18, GOLD)
    text(data.demo ? "演示数据 · 模板预览" : "挑战战绩", 430, 40, 16, MUTED, 284, "right")
    text(section.label, 44, 83, 44)
    starAt(536, 84, 40); text(hasValue(section.stars) ? section.stars : "暂无", 583, 86, 42, GOLD, 65, "center", true)
    text("总星数", 651, 100, 17, MUTED, 68)
    text(`UID ${data.uid || "未绑定"}`, 46, 144, 22, WHITE, 340, "left", true)
    text(["2", "3"].includes(String(section.scheduleType)) ? "往期记录" : "本期记录", 540, 146, 19, GOLD, 174, "right")
    if (Number(section.extraStars) > 0) text(`星启加星 +${section.extraStars}`, 540, 169, 13, GOLD, 174, "right")
    line(44, 185, 672); text(section.period || "周期暂无数据", 44, 200, 18, MUTED, 672)
    rect(44, 242, 672, 80, "rgba(9,17,34,0.40)", 10)
    section.metrics.forEach(([label, value], i) => {
      const x = 44 + i * 168
      text(label, x, 255, 16, MUTED, 168, "center"); text(value, x + 8, 281, 23, WHITE, 152, "center", true)
      if (i) { ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.moveTo(x, 257); ctx.lineTo(x, 307); ctx.stroke() }
    })
    layout.titleLines.forEach((value, i) => text(value, 44, 346 + i * 33, 26, GOLD, hasValue(section.floorStars) ? 500 : 672))
    if (hasValue(section.floorStars)) for (let i = 0; i < section.floorMaxStars; i++) starAt(716 - section.floorMaxStars * 35 + i * 35, 346, 29, i < Number(section.floorStars))
    line(44, headerHeight - 13, 672)
    let y = headerHeight
    for (const item of layout.nodes) {
      const { node, height: nodeHeight, teamTop } = item
      rect(44, y, 672, nodeHeight, "rgba(10,18,35,0.32)", 10); rect(44, y, 3, 37, GOLD, 2)
      text(item.label, 62, y + 10, 22, GOLD, 636)
      if (node.title) {
        const enemy = images.get(node.icon)
        if (enemy) ctx.drawImage(enemy, 62, y + 44, 80, 80)
        item.titleLines.forEach((value, i) => text(value, node.icon ? 158 : 62, y + 46 + i * 29, 22, WHITE, node.icon ? 526 : 636))
      }
      item.metaLines.forEach((value, i) => text(value, 62, y + teamTop - 12 - (item.metaLines.length - i) * 23, 16, MUTED, 636))
      for (const [i, avatar] of (node.avatars || []).entries()) {
        const x = 62 + (i % 4) * 159, top = y + teamTop + Math.floor(i / 4) * 195
        ctx.save(); ctx.beginPath(); ctx.roundRect(x, top, 141, 157, 5); ctx.clip()
        const rarity = ctx.createLinearGradient(x, top, x, top + 134)
        rarity.addColorStop(0, Number(avatar.rarity) >= 5 ? "#776058" : "#51456d"); rarity.addColorStop(1, Number(avatar.rarity) >= 5 ? "#c2996a" : "#9b81b3")
        rect(x, top, 141, 134, rarity)
        const portrait = images.get(avatar.icon)
        if (portrait) {
          const ratio = Math.max(141 / portrait.width, 134 / portrait.height), sw = 141 / ratio, sh = 134 / ratio
          ctx.drawImage(portrait, (portrait.width - sw) / 2, 0, sw, sh, x, top, 141, 134)
        } else text(avatar.name || "角色资料未记录", x + 5, top + 54, 23, WHITE, 131, "center")
        rect(x, top + 133, 141, 24, "#e9e5dc"); text(hasValue(avatar.level) ? `Lv.${avatar.level}` : "等级未记录", x, top + 138, 16, "#25252c", 141, "center", true)
        if (hasValue(avatar.rank)) {
          const rank = Number(avatar.rank)
          rect(x + 84, top, 57, 27, rank >= 5 ? "#af533f" : rank >= 3 ? "#3d8d6c" : rank > 0 ? "#477fa9" : "rgba(10,18,35,0.68)", 2)
          text(`${avatar.rank}魂`, x + 84, top + 5, 16, WHITE, 57, "center", true)
        }
        ctx.restore(); text(avatar.name || "角色资料未记录", x, top + 164, 17, WHITE, 141, "center")
      }
      if (!node.avatars?.length) text("暂无队伍数据", 62, y + teamTop + 54, 20, MUTED, 636, "center")
      item.buffLines.forEach((value, i) => text(value, 62, y + teamTop + item.rows * 195 + 12 + i * 25, 17, MUTED, 624))
      y += nodeHeight + 14
    }
    if (!layout.nodes.length) text("暂无可展示的挑战记录", 44, y + 44, 23, MUTED, 672, "center")
    ctx.restore(); offset += layout.height
  }
  for (const [x, y, direction] of [[26, 26, 1], [734, 26, -1], [26, height - 26, 1], [734, height - 26, -1]]) line(x, y, direction * 22, GOLD)
  line(44, offset + 6, 672); text("荷花插件 · 米游社 / HoYoLAB", 44, offset + 27, 16, MUTED, 672, "center")
  text(data.demo ? "genshin 深渊模板 · Skia 适配样稿" : (data.generatedAt || ""), 44, offset + 53, 13, MUTED, 672, "center")
  const { buffer, tiles, format } = await encodeGpuCanvas(canvas, options)
  options.onRender?.({ gpu: canvas.gpu, ...canvas.engine, width: canvas.width, height: canvas.height, tiles, format, missingImages: [...images].filter(([, img]) => !img).map(([src]) => src) })
  return buffer
}
