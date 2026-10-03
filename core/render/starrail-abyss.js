import path from "node:path"
import { Canvas, FontLibrary, loadImage } from "skia-canvas"
import { resourcesPath } from "../path.js"
import { fetchImageBytes } from "./image.js"

// Adapted from genshin/resources/html/abyss/abyss-floor.{html,css}.
// Keep the original scene, inset frame, star asset and cream level strips.
const ROOT = path.join(resourcesPath, "starrail-abyss")
const GOLD = "#d3bc8d"
const WHITE = "#f1f1f4"
const MUTED = "#afb9ce"
const CACHE = new Map()
let fontsLoaded = false

export function isStarRailAbyss(data = {}) {
  const results = data.results || []
  return results.length === 1 && (results[0].kind === "hall" || results[0].challengeType === 2)
}

async function image(src) {
  if (!src) return null
  if (!CACHE.has(src)) {
    CACHE.set(src, (async () => loadImage(/^https?:\/\//i.test(src) ? await fetchImageBytes(src) : src))()
      .catch(error => {
        CACHE.delete(src)
        globalThis.logger?.warn?.(`[荷花混沌模板] 图片加载失败：${error.message}`)
        return null
      }))
  }
  return CACHE.get(src)
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== ""
}

export async function renderStarRailAbyss(data = {}, options = {}) {
  if (!fontsLoaded) {
    FontLibrary.use("AbyssText", [path.join(ROOT, "fonts/HYWenHei-55W.ttf")])
    FontLibrary.use("AbyssNumber", [path.join(ROOT, "fonts/tttgbnumber.ttf")])
    fontsLoaded = true
  }
  const result = data.results?.[0] || {}
  const floors = (result.floors || []).filter(floor =>
    hasValue(floor.stars) || hasValue(floor.round) || floor.nodes?.length)
  // Preserve the current command's latest valid floor selection.
  const floor = floors.at(-1)
  const nodes = floor?.nodes || []
  const scaleValue = Number(options.renderScale ?? data.renderScale ?? process.env.LOTUS_RENDER_SCALE ?? 4)
  const scale = Number.isFinite(scaleValue) ? Math.min(4, Math.max(1, scaleValue)) : 4
  const canvas = new Canvas(760, 10)
  const ctx = canvas.getContext("2d")
  const family = '"AbyssText", MiSans, sans-serif'

  function text(value, x, y, size = 18, color = WHITE, width = 650, align = "left", number = false) {
    const label = String(value ?? "")
    ctx.font = `${size}px ${number ? '"AbyssNumber", ' : ""}${family}`
    // Fit labels using actual font metrics; never silently cut timestamps/names.
    while (ctx.measureText(label).width > width && size > 12) {
      size -= 0.5
      ctx.font = `${size}px ${number ? '"AbyssNumber", ' : ""}${family}`
    }
    ctx.fillStyle = color
    ctx.textBaseline = "top"
    ctx.textAlign = align
    ctx.fillText(label, align === "center" ? x + width / 2 : align === "right" ? x + width : x, y)
  }
  function wrap(value, width, size = 17) {
    ctx.font = `${size}px ${family}`
    const lines = []
    for (const paragraph of String(value || "").split(/\r?\n/)) {
      let line = ""
      for (const char of paragraph) {
        if (line && ctx.measureText(line + char).width > width) {
          lines.push(line)
          line = ""
        }
        line += char
      }
      if (line) lines.push(line)
    }
    return lines
  }
  const layouts = nodes.map(node => {
    const buffLines = wrap(node.buff, 624)
    const rows = Math.max(1, Math.ceil((node.avatars?.length || 0) / 4))
    return { node, buffLines, rows, height: 62 + rows * 183 + (buffLines.length ? 18 + buffLines.length * 25 : 0) }
  })
  const height = 396 + (layouts.length ? layouts.reduce((sum, item) => sum + item.height + 14, 0) : 130) + 86
  canvas.width = Math.round(760 * scale)
  canvas.height = Math.round(height * scale)
  ctx.scale(scale, scale)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  const [bg, star] = await Promise.all([image(path.join(ROOT, "floor12.png")), image(path.join(ROOT, "star.png"))])
  const portraits = new Map()
  await Promise.all(nodes.flatMap(node => node.avatars || []).map(async avatar => {
    if (avatar.icon) portraits.set(avatar.icon, await image(avatar.icon))
  }))

  function rect(x, y, w, h, fill, radius = 0) {
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, radius)
    ctx.fill()
  }
  function line(x, y, w, color = "rgba(211,188,141,0.30)") {
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + w, y)
    ctx.stroke()
  }
  function starAt(x, y, size, active = true) {
    ctx.save()
    ctx.globalAlpha = active ? 1 : 0.20
    if (star) ctx.drawImage(star, x, y, size, size)
    ctx.restore()
  }

  rect(0, 0, 760, height, "#1d2a4a")
  if (bg) ctx.drawImage(bg, 0, 0, 760, 760 * bg.height / bg.width)
  const shade = ctx.createLinearGradient(0, 0, 0, 450)
  shade.addColorStop(0, "rgba(10,19,39,0.20)")
  shade.addColorStop(1, "rgba(10,19,39,0)")
  rect(0, 0, 760, 450, shade)
  ctx.strokeStyle = "rgba(211,188,141,0.65)"
  ctx.lineWidth = 1.5
  ctx.strokeRect(12, 12, 736, height - 24)
  ctx.strokeStyle = "rgba(255,255,255,0.13)"
  ctx.strokeRect(18, 18, 724, height - 36)
  for (const [x, y, direction] of [[26, 26, 1], [734, 26, -1], [26, height - 26, 1], [734, height - 26, -1]]) {
    line(x, y, direction * 22, GOLD)
  }

  text("崩坏：星穹铁道", 44, 39, 18, GOLD)
  text(data.demo ? "演示数据 · 模板预览" : "忘却之庭 · 挑战战绩", 430, 40, 16, MUTED, 284, "right")
  text(result.label || "混沌回忆", 44, 83, 44)
  starAt(536, 84, 40)
  text(hasValue(result.stars) ? result.stars : "—", 583, 86, 42, GOLD, 65, "center", true)
  text("总星数", 651, 100, 17, MUTED, 68)
  text(`UID ${data.uid || "—"}`, 46, 144, 22, WHITE, 340, "left", true)
  text(result.scheduleType === "2" ? "上期记录" : "本期记录", 540, 146, 19, GOLD, 174, "right")
  if (Number(result.extraStars) > 0) text(`星启加星 +${result.extraStars}`, 540, 169, 13, GOLD, 174, "right")
  line(44, 185, 672)
  text(result.period || "周期暂无数据", 44, 200, 18, MUTED, 672)

  rect(44, 242, 672, 80, "rgba(9,17,34,0.40)", 4)
  const metrics = [
    ["最深抵达", hasValue(result.maxFloor) ? String(result.maxFloor) : (floor?.title || "—")],
    ["使用轮次", hasValue(floor?.round) ? `${floor.round} 轮` : "—"],
    ["战斗次数", hasValue(result.battleNum) ? `${result.battleNum} 次` : "—"],
    ["关卡星数", hasValue(floor?.stars) ? `${floor.stars} 星` : "—"],
  ]
  metrics.forEach(([label, value], i) => {
    const x = 44 + i * 168
    text(label, x, 255, 16, MUTED, 168, "center")
    text(value, x + 8, 281, 23, WHITE, 152, "center", true)
    if (i) {
      ctx.strokeStyle = "rgba(255,255,255,0.12)"
      ctx.beginPath(); ctx.moveTo(x, 257); ctx.lineTo(x, 307); ctx.stroke()
    }
  })
  text(floor?.title || "挑战记录", 44, 346, 26, GOLD, 480)
  const starCount = floor?.tierce ? 4 : Math.max(3, Number(floor?.stars || 0))
  if (floor) for (let i = 0; i < starCount; i++) starAt(716 - starCount * 35 + i * 35, 346, 29, i < Number(floor.stars || 0))
  line(44, 383, 672)

  let y = 396
  for (const [index, layout] of layouts.entries()) {
    const { node, height: nodeHeight } = layout
    rect(44, y, 672, nodeHeight, "rgba(10,18,35,0.32)", 4)
    rect(44, y, 3, 37, GOLD)
    const label = /^节点\d+$/.test(node.label || "") ? (nodes.length === 2 ? (index === 0 ? "上半" : "下半") : `第${["一", "二", "三"][index] || index + 1}队`) : (node.label || `队伍 ${index + 1}`)
    text(label, 62, y + 10, 22, GOLD, 160)
    const meta = [node.time, hasValue(node.round) ? `${node.round} 轮` : "", node.defeated === true ? "已击败首领" : node.defeated === false ? "未击败首领" : ""].filter(Boolean).join(" · ")
    text(meta || "暂无战斗时间", 235, y + 14, 16, MUTED, 461, "right")

    for (const [i, avatar] of (node.avatars || []).entries()) {
      const x = 62 + (i % 4) * 159
      const top = y + 52 + Math.floor(i / 4) * 183
      ctx.save()
      ctx.beginPath(); ctx.roundRect(x, top, 141, 157, 5); ctx.clip()
      const rarity = ctx.createLinearGradient(x, top, x, top + 134)
      rarity.addColorStop(0, Number(avatar.rarity) >= 5 ? "#776058" : "#51456d")
      rarity.addColorStop(1, Number(avatar.rarity) >= 5 ? "#c2996a" : "#9b81b3")
      rect(x, top, 141, 134, rarity)
      const portrait = portraits.get(avatar.icon)
      if (portrait) {
        const ratio = Math.max(141 / portrait.width, 134 / portrait.height)
        const sw = 141 / ratio, sh = 134 / ratio
        ctx.drawImage(portrait, (portrait.width - sw) / 2, 0, sw, sh, x, top, 141, 134)
      } else text(avatar.name || "角色", x + 5, top + 54, 23, WHITE, 131, "center")
      rect(x, top + 133, 141, 24, "#e9e5dc")
      text(hasValue(avatar.level) ? `Lv.${avatar.level}` : "Lv.—", x, top + 138, 16, "#25252c", 141, "center", true)
      if (hasValue(avatar.rank)) {
        const rank = Number(avatar.rank)
        rect(x + 84, top, 57, 27, rank >= 5 ? "#af533f" : rank >= 3 ? "#3d8d6c" : rank > 0 ? "#477fa9" : "rgba(10,18,35,0.68)", 2)
        text(`${avatar.rank}魂`, x + 84, top + 5, 16, WHITE, 57, "center", true)
      }
      ctx.restore()
      text(avatar.name || "未知角色", x, top + 164, 17, WHITE, 141, "center")
    }
    if (!node.avatars?.length) text("暂无队伍数据", 62, y + 112, 20, MUTED, 636, "center")
    layout.buffLines.forEach((buffLine, i) => text(buffLine, 62, y + 62 + layout.rows * 183 + i * 25, 17, MUTED, 624))
    y += nodeHeight + 14
  }
  if (!layouts.length) {
    text("暂无可展示的挑战记录", 44, y + 44, 23, MUTED, 672, "center")
    y += 130
  }
  line(44, y + 6, 672)
  text("荷花插件 · 米游社 / HoYoLAB", 44, y + 27, 16, MUTED, 672, "center")
  text(data.demo ? "模板取自 genshin 原神深渊 · Skia 适配样稿" : (data.generatedAt || ""), 44, y + 53, 13, MUTED, 672, "center")

  const buffer = await canvas.toBuffer(options.imgType === "png" ? "png" : "jpeg", { quality: Number(options.quality || 98) / 100 })
  options.onRender?.({ gpu: canvas.gpu, ...canvas.engine, width: canvas.width, height: canvas.height })
  return buffer
}
