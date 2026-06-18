import fs from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Canvas, FontLibrary, loadImage } from "skia-canvas"
import { resourcesPath } from "../path.js"

const FONT_FAMILY = "MiSans"
const FONT_PATH = path.join(resourcesPath, "fonts", "MiSans-VF.ttf")
const IMAGE_CACHE = new Map()
const GALLERY_INDEX_CACHE = new Map()
let fontLoaded = false

const COLOR = {
  ink: "#1f2a33",
  sub: "#60717c",
  blue: "#24a9d8",
  panel: "rgba(255,255,255,0.86)",
  panelStrong: "rgba(255,255,255,0.94)",
  darkGlass: "rgba(0,0,0,0.34)",
  line: "rgba(255,255,255,0.55)",
}

export async function renderWithSkia(templateName, data = {}, options = {}) {
  await ensureFont()
  const normalized = normalizeData(data)
  const renderer = new SkiaRenderer(templateName, normalized, options)
  const buffer = await renderer.render()
  if (options.path) await fs.writeFile(options.path, buffer)
  return globalThis.segment?.image ? globalThis.segment.image(buffer) : buffer
}

function normalizeData(data) {
  return {
    pluginName: "荷花插件",
    generatedAt: formatTime(new Date()),
    ...data,
  }
}

async function ensureFont() {
  if (fontLoaded) return
  try {
    FontLibrary.use(FONT_FAMILY, [FONT_PATH])
  } catch {}
  fontLoaded = true
}

class SkiaRenderer {
  constructor(templateName, data, options) {
    this.templateName = templateName
    this.data = data
    this.options = options
    this.width = isAtlasTemplate(templateName) ? 1280 : 760
    this.padding = isAtlasTemplate(templateName) ? 34 : 34
    this.renderScale = normalizeRenderScale(options.renderScale ?? data.renderScale ?? process.env.LOTUS_RENDER_SCALE ?? 4)
    this.commands = []
    this.y = this.padding
    this.imageRefs = new Set()
    this.imageRoots = [
      data.atlasRoot,
      process.env.LOTUS_ATLAS_DATA_ROOT,
      path.resolve("data", "atlas"),
      path.resolve("nanoka-atlas-backend"),
    ].filter(Boolean)
  }

  async render() {
    this.collectImages(this.data)
    await Promise.all([...this.imageRefs].map(src => this.loadImage(src)))

    this.build()
    const height = Math.max(420, Math.ceil(this.y + this.padding))
    const canvas = new Canvas(this.width * this.renderScale, height * this.renderScale)
    const ctx = canvas.getContext("2d")
    ctx.scale(this.renderScale, this.renderScale)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    await this.drawBackground(ctx, this.width, height)
    for (const command of this.commands) await command(ctx)
    return canvas.toBuffer(this.options.imgType === "png" ? "png" : "jpeg", {
      quality: Number(this.options.quality || 96) / 100,
    })
  }

  collectImages(value) {
    if (!value) return
    if (typeof value === "string") {
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) this.collectImages(item)
      return
    }
    if (typeof value !== "object") return
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:bg|image|icon|portrait|qrDataUrl)$/i.test(key) && typeof item === "string" && looksLikeImage(item)) {
        this.imageRefs.add(item)
      } else {
        this.collectImages(item)
      }
    }
  }

  build() {
    if (this.templateName === "qr-login") return this.buildQr()
    if (this.templateName === "profile-card") return this.buildProfile()
    if (this.templateName === "daily-note-summary") return this.buildDailyNote()
    if (this.templateName === "checkin-result") return this.buildCheckinResult()
    if (this.templateName === "schedule-notice") return this.buildScheduleNotice()
    if (this.templateName === "bilibili-info") return this.buildBilibiliInfo()
    if (this.templateName === "atlas-result") return this.buildAtlasResult()
    if (this.templateName === "atlas-challenge") return this.buildAtlasChallenge()
    if (this.templateName === "atlas-item") return this.buildAtlasItem()
    return this.buildStatus()
  }

  loadImage(src) {
    return loadCachedImage(src, this.imageRoots)
  }

  async drawBackground(ctx, width, height) {
    ctx.fillStyle = "#222"
    ctx.fillRect(0, 0, width, height)
    const bg = await this.loadImage(this.data.bg)
    if (bg) {
      const tileW = Math.max(width, bg.width)
      const scale = tileW / bg.width
      const tileH = Math.max(1, bg.height * scale)
      for (let y = 0; y < height; y += tileH) {
        for (let x = (width - tileW) / 2; x < width; x += tileW) {
          ctx.drawImage(bg, x, y, tileW, tileH)
        }
      }
      ctx.fillStyle = isAtlasTemplate(this.templateName) ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.18)"
      ctx.fillRect(0, 0, width, height)
    }
  }

  buildStatus() {
    this.hero({
      title: this.data.title || "荷花插件",
      subtitle: this.data.subtitle || "",
      badge: this.data.badge || "INFO",
      message: this.data.message || "",
      image: this.data.avatar || this.data.image,
      width: this.innerWidth(),
    })
    this.gridItems(this.data.items || [], 2)
    this.footer()
  }

  buildQr() {
    this.hero({
      title: this.data.title || "米游社扫码登录",
      subtitle: this.data.subtitle || `荷花插件 profile ${this.data.profileId || 1}`,
      badge: this.data.badge || "5 MIN",
      message: this.data.notice || "请使用对应 App 扫码确认登录。",
      width: this.innerWidth(),
    })
    const size = 420
    const y = this.y + 12
    this.card(120, y, size + 80, size + 104, async ctx => {
      const img = await this.loadImage(this.data.qrDataUrl)
      if (img) ctx.drawImage(img, 160, y + 38, size, size)
      this.text(ctx, `profile ${this.data.profileId || 1}`, 0, y + size + 76, {
        width: this.width,
        size: 22,
        weight: 850,
        color: COLOR.blue,
        align: "center",
      })
    })
    this.y += size + 136
    this.footer()
  }

  buildProfile() {
    this.hero({
      title: this.data.title || "配置资料卡",
      subtitle: this.data.subtitle || "",
      badge: this.data.badge || "PROFILE",
      message: this.data.summary || "",
      image: this.data.avatar || this.data.image,
      width: this.innerWidth(),
    })
    this.sectionTiles("账号状态", this.data.account || [])
    this.sectionTiles("游戏角色", this.data.roles || [])
    this.sectionTiles("签到设置", this.data.settings || [])
    for (const warning of this.data.warnings || []) {
      const y = this.y
      this.card(this.padding, y, this.innerWidth(), 54, ctx => {
        this.text(ctx, warning, this.padding + 18, y + 18, {
          width: this.innerWidth() - 36,
          size: 17,
          weight: 750,
          color: "#995500",
        })
      }, { fill: "rgba(255,235,190,0.92)" })
      this.y += 66
    }
    this.footer()
  }

  buildDailyNote() {
    this.hero({
      title: this.data.title || "全部体力",
      subtitle: this.data.subtitle || "",
      badge: this.data.badge || "NOTE",
      message: this.data.message || "",
      width: this.innerWidth(),
    })
    for (const group of this.data.groups || []) {
      this.sectionTitle(group.name || "profile")
      for (const item of group.items || []) this.dailyItem(item)
    }
    this.footer()
  }

  buildCheckinResult() {
    this.hero({
      title: this.data.title || "签到结果",
      subtitle: this.data.subtitle || "",
      badge: this.data.badge || "完成",
      message: this.data.message || "",
      image: this.data.avatar || this.data.image,
      width: this.innerWidth(),
    })
    this.sectionTitle("签到明细")
    this.checkinRows(this.data.games || [])
    this.footer()
  }

  buildBilibiliInfo() {
    const stat = this.data.stat || {}
    const cover = this.data.cover || this.data.image
    this.hero({
      title: this.data.type === "live" ? "B站直播" : "B站视频",
      subtitle: this.data.id || "荷花插件 Bilibili",
      badge: this.data.type === "live" ? "LIVE" : "BILI",
      message: this.data.title || "",
      image: cover,
      width: this.innerWidth(),
      heroHeight: 232,
    })
    if (cover) this.mediaCover(cover)
    this.sectionTitle("详情")
    const items = this.data.type === "live"
      ? [
          { label: "主播", value: this.data.owner || "未知" },
          { label: "状态", value: this.data.liveStatus || "-" },
          { label: "在线", value: formatShortNumber(this.data.online) },
          { label: "分区", value: this.data.desc || "-" },
        ]
      : [
          { label: "UP主", value: this.data.owner || "未知" },
          { label: "时长", value: formatDuration(this.data.duration) },
          { label: "点赞", value: formatShortNumber(stat.like) },
          { label: "收藏", value: formatShortNumber(stat.favorite) },
          { label: "投币", value: formatShortNumber(stat.coin) },
          { label: "播放", value: formatShortNumber(stat.view) },
          { label: "弹幕", value: formatShortNumber(stat.danmaku) },
          { label: "评论", value: formatShortNumber(stat.reply) },
        ]
    this.gridItems(items, 4)
    if (this.data.desc) {
      this.sectionTitle(this.data.type === "live" ? "分区说明" : "简介")
      this.drawTextCards([{ title: this.data.type === "live" ? this.data.desc : this.data.title, body: this.data.desc }], 1, "title", "body")
    }
    this.footer()
  }

  mediaCover(image) {
    const y = this.y
    const width = this.innerWidth()
    const height = Math.round(width * 9 / 16)
    this.card(this.padding, y, width, height + 28, async ctx => {
      const img = await this.loadImage(image)
      if (img) {
        this.roundRect(ctx, this.padding + 14, y + 14, width - 28, height, 20, "rgba(0,0,0,0.18)")
        this.drawImageCover(ctx, img, this.padding + 14, y + 14, width - 28, height, 20)
      } else {
        this.iconPlaceholder(ctx, this.padding + 14, y + 14, width - 28, height, "B")
      }
    }, { fill: "rgba(255,255,255,0.72)", radius: 24 })
    this.y += height + 46
  }

  buildScheduleNotice() {
    this.hero({
      title: this.data.title || "明日签到时间",
      subtitle: this.data.subtitle || "",
      badge: this.data.badge || "PLAN",
      message: this.data.message || "",
      image: this.data.avatar || this.data.image,
      width: this.innerWidth(),
    })
    this.sectionTitle("计划")
    this.gridItems(this.data.items || [], 2)
    this.footer()
  }

  buildAtlasResult() {
    this.hero({
      title: this.data.title || "图鉴搜索结果",
      subtitle: this.data.subtitle || "",
      badge: this.data.badge || "ATLAS",
      message: this.data.message || "",
      image: this.data.avatar || this.data.image,
      width: this.innerWidth(),
    })
    for (const item of this.data.items || []) {
      const height = Math.max(94, this.measureParagraph(item.desc || "", this.innerWidth() - 138, 16) + 58)
      const y = this.y
      this.card(this.padding, y, this.innerWidth(), height, async ctx => {
        const img = await this.loadImage(item.image)
        if (img) this.drawImageContain(ctx, img, this.padding + 16, y + 16, 62, 62)
        else this.iconPlaceholder(ctx, this.padding + 16, y + 16, 62, 62, "图")
        this.text(ctx, item.title || "", this.padding + 96, y + 16, { width: this.innerWidth() - 116, size: 22, weight: 900, color: "#004466" })
        this.text(ctx, item.meta || "", this.padding + 96, y + 44, { width: this.innerWidth() - 116, size: 14, weight: 750, color: COLOR.sub })
        this.text(ctx, item.desc || "", this.padding + 96, y + 66, { width: this.innerWidth() - 116, size: 16, lineHeight: 23, weight: 650, color: COLOR.ink })
      })
      this.y += height + 12
    }
    this.footer()
  }

  buildAtlasItem() {
    const view = this.data.view || {}
    this.hero({
      title: this.data.title || view.title || "图鉴",
      subtitle: this.data.subtitle || "",
      badge: this.data.badge || view.page || "ATLAS",
      message: this.data.message || view.description || "",
      image: view.portrait || view.image || this.data.avatar || this.data.image,
      width: this.innerWidth(),
      heroHeight: 230,
    })
    this.gridItems(view.stats || this.data.facts || [], 6)
    if (view.kind === "character") {
      this.sectionTitle("技能与等级数值")
      this.drawSkillCards(view.skillColumns || [view.skills || []])
      this.drawMiniSections([
        ["命座 / 星魂 / 影画", view.constellations],
        ["被动与核心能力", view.passives],
        ["强化与额外能力", view.enhancements],
      ])
    } else if (view.kind === "weapon") {
      this.sectionTitle("效果与精炼等级")
      this.drawTextCards(view.refinements || [], Math.min(3, Math.max(1, view.refinements?.length || 1)), "level")
    } else if (view.kind === "relic") {
      this.sectionTitle("套装效果")
      this.drawTextCards(view.effects || [], 2, "label")
      this.sectionTitle("部件")
      this.iconGrid(view.parts || [])
    } else if (view.kind === "bangboo") {
      this.sectionTitle("邦布技能与等级数值")
      this.drawSkillCards(view.skillColumns || [view.skills || []])
    } else {
      this.drawTextCards(this.data.sections || [], 2, "title", "body")
    }
    if (view.materials?.length) {
      this.sectionTitle("素材")
      this.iconGrid(view.materials)
    }
    if (view.meta?.length) this.sectionTiles("资料", view.meta, 6)
    this.footer("数据来源 Nanoka Atlas")
  }

  buildAtlasChallenge() {
    const view = this.data.view || {}
    this.hero({
      title: this.data.title || "挑战图鉴",
      subtitle: this.data.subtitle || "",
      badge: this.data.badge || "CHALLENGE",
      message: this.data.message || view.description || "",
      image: this.data.avatar || this.data.image,
      width: this.innerWidth(),
      heroHeight: 220,
    })
    if (view.theaterOverview) {
      this.drawTheaterOverview(view.theaterOverview)
      this.footer("数据来源 Nanoka Atlas")
      return
    }
    if (view.environment?.length) {
      this.sectionTitle("环境与全局效果")
      this.drawTextCards(view.environment, 2, "title", "body")
    }
    if (view.optionalBuffs?.length) {
      this.sectionTitle("可选增益")
      this.drawTextCards(view.optionalBuffs, 3, "title", "body")
    }
    if (view.rooms?.length) {
      this.sectionTitle("关卡与敌人")
      for (const room of view.rooms) this.roomCard(room)
    }
    this.footer("数据来源 Nanoka Atlas")
  }

  hero({ title, subtitle, badge, message, image, width, heroHeight = 198 }) {
    const x = this.padding
    const y = this.y
    const textX = image ? x + 198 : x + 34
    const messageWidth = width - (textX - x) - 28
    const messageHeight = this.measureParagraph(message || "", messageWidth, 17, 26)
    const actualHeight = Math.max(heroHeight, 128 + messageHeight, image ? 198 : 176)
    this.card(x, y, width, actualHeight, async ctx => {
      if (image) {
        const img = await this.loadImage(image)
        if (img) this.drawImageContain(ctx, img, x + 24, y + 24, 150, actualHeight - 48)
      }
      this.text(ctx, title, textX, y + 28, { width: width - (textX - x) - 30, size: 38, weight: 950, color: "#fff", shadow: true })
      this.text(ctx, subtitle, textX, y + 78, { width: width - (textX - x) - 130, size: 17, weight: 760, color: "rgba(255,255,255,0.92)", shadow: true })
      this.pill(ctx, x + width - 112, y + 28, 84, 30, badge)
      this.text(ctx, message, textX, y + 108, { width: messageWidth, size: 17, lineHeight: 26, weight: 650, color: "#fff", shadow: true })
    }, { fill: "rgba(0,0,0,0.38)", radius: 30 })
    this.y += actualHeight + 18
  }

  gridItems(items, columns = 2) {
    const list = (items || []).map(item => ({
      label: item.label || item.title || "",
      value: item.value || item.desc || item.meta || "",
    })).filter(item => item.label || item.value)
    if (!list.length) return
    const gap = 10
    const width = (this.innerWidth() - gap * (columns - 1)) / columns
    for (let index = 0; index < list.length; index += columns) {
      const row = list.slice(index, index + columns)
      const heights = row.map(item => 54 + this.measureParagraph(item.value, width - 28, 18))
      const height = Math.max(74, ...heights)
      row.forEach((item, offset) => {
        const x = this.padding + offset * (width + gap)
        const y = this.y
        this.card(x, y, width, height, ctx => {
          this.text(ctx, item.label, x + 14, y + 13, { width: width - 28, size: 13, weight: 850, color: COLOR.sub })
          this.text(ctx, item.value, x + 14, y + 34, { width: width - 28, size: 18, lineHeight: 24, weight: 900, color: COLOR.ink })
        })
      })
      this.y += height + 10
    }
  }

  sectionTiles(title, items, columns = 2) {
    if (!items?.length) return
    this.sectionTitle(title)
    this.gridItems(items, columns)
  }

  dailyItem(item) {
    const details = item.details || []
    const height = 96 + Math.ceil(details.length / 3) * 34 + this.measureParagraph(item.detail || "", this.innerWidth() - 38, 16)
    const y = this.y
    this.card(this.padding, y, this.innerWidth(), height, ctx => {
      this.text(ctx, `${item.gameName || ""} ${item.uid || ""} ${item.nickname || ""}`.trim(), this.padding + 18, y + 18, { width: this.innerWidth() - 150, size: 21, weight: 900, color: "#004466" })
      this.pill(ctx, this.width - this.padding - 96, y + 16, 76, 28, item.status || (item.ok ? "正常" : "失败"), item.ok === false ? "#bb3344" : COLOR.blue)
      this.text(ctx, item.detail || "", this.padding + 18, y + 52, { width: this.innerWidth() - 36, size: 16, lineHeight: 23, weight: 650, color: COLOR.ink })
      let x = this.padding + 18
      let chipY = y + height - Math.ceil(details.length / 3) * 34 - 10
      for (const detail of details) {
        this.smallChip(ctx, x, chipY, `${detail.label} ${detail.value}`)
        x += 220
        if (x > this.width - this.padding - 220) {
          x = this.padding + 18
          chipY += 34
        }
      }
    })
    this.y += height + 12
  }

  checkinRows(rows) {
    for (const row of rows || []) {
      const y = this.y
      this.card(this.padding, y, this.innerWidth(), 76, ctx => {
        this.text(ctx, row.label || "", this.padding + 18, y + 16, { width: 170, size: 20, weight: 950, color: "#004466" })
        this.checkinCell(ctx, this.padding + 210, y + 14, (this.innerWidth() - 246) / 2, "游戏签到", row.game)
        this.checkinCell(ctx, this.padding + 222 + (this.innerWidth() - 246) / 2, y + 14, (this.innerWidth() - 246) / 2, "社区签到", row.community)
      })
      this.y += 88
    }
  }

  checkinCell(ctx, x, y, width, label, value) {
    const status = String(value || "跳过")
    const color = status.includes("成功")
      ? "#14a86b"
      : status.includes("失败")
        ? "#cf3f4f"
        : status.includes("关闭")
          ? "#7c8790"
          : COLOR.blue
    this.text(ctx, label, x, y, { width, size: 12, weight: 850, color: COLOR.sub, align: "center" })
    this.pill(ctx, x + width / 2 - 48, y + 24, 96, 28, status, color)
  }

  drawSkillCards(columns) {
    const gap = 14
    const activeColumns = columns.filter(column => column?.length).slice(0, 2)
    const columnCount = Math.max(1, activeColumns.length)
    const colWidth = (this.innerWidth() - gap * (columnCount - 1)) / columnCount
    const colY = Array(columnCount).fill(this.y)
    activeColumns.forEach((column, columnIndex) => {
      const x = this.padding + columnIndex * (colWidth + gap)
      for (const skill of column || []) {
        const h = this.skillHeight(skill, colWidth)
        const y = colY[columnIndex]
        this.card(x, y, colWidth, h, async ctx => {
          const icon = await this.loadImage(skill.icon)
          if (icon) this.drawImageContain(ctx, icon, x + 14, y + 16, 58, 58)
          else this.iconPlaceholder(ctx, x + 14, y + 16, 58, 58, skill.iconText || "技")
          this.text(ctx, skill.title || "技能", x + 84, y + 16, { width: colWidth - 100, size: 20, weight: 950, color: "#004466" })
          this.text(ctx, skill.type || "", x + 84, y + 43, { width: colWidth - 100, size: 13, weight: 750, color: COLOR.sub })
          let yy = y + 74
          if (skill.desc) {
            yy += this.text(ctx, skill.desc, x + 18, yy, { width: colWidth - 36, size: 14, lineHeight: 21, weight: 650, color: COLOR.ink })
          }
          for (const desc of skill.descLines || []) {
            this.text(ctx, desc.title || "说明", x + 18, yy + 6, { width: colWidth - 36, size: 13, weight: 900, color: COLOR.blue })
            yy += 24
            yy += this.text(ctx, desc.text || partsToText(desc.parts), x + 18, yy, { width: colWidth - 36, size: 13, lineHeight: 20, weight: 650, color: COLOR.ink })
          }
          for (const table of skill.tables || []) {
            yy += this.table(ctx, table, x + 18, yy + 8, colWidth - 36)
          }
          if (skill.levelRows?.length) {
            yy += this.levelRows(ctx, skill.levelRows, x + 18, yy + 8, colWidth - 36)
          }
        })
        colY[columnIndex] += h + 12
      }
    })
    this.y = Math.max(...colY) + 8
  }

  skillHeight(skill, width) {
    let h = 96
    if (skill.desc) h += this.measureParagraph(skill.desc, width - 36, 14, 21)
    for (const desc of skill.descLines || []) {
      h += 30 + this.wrap(desc.text || partsToText(desc.parts), width - 36, 13).length * 20
    }
    for (const table of skill.tables || []) h += this.measureTable(table, width - 36)
    if (skill.levelRows?.length) h += this.measureLevelRows(skill.levelRows, width - 36) + 12
    return Math.max(h, 130)
  }

  drawMiniSections(sections) {
    const active = sections.filter(([, items]) => items?.length)
    if (!active.length) return
    const gap = 14
    const width = (this.innerWidth() - gap * (active.length - 1)) / active.length
    const startY = this.y
    const ys = active.map(() => startY)
    active.forEach(([title, items], index) => {
      const x = this.padding + index * (width + gap)
      this.sectionTitleAt(title, x, ys[index], width)
      ys[index] += 48
      for (const item of items || []) {
        const textOffset = item.hideIcon || !item.icon ? 18 : 66
        const textWidth = width - textOffset - 12
        const h = Math.max(82, this.measureParagraph(item.desc || "", textWidth, 13, 19) + 52)
        const y = ys[index]
        this.card(x, y, width, h, async ctx => {
          const icon = await this.loadImage(item.icon)
          if (icon && !item.hideIcon) this.drawImageContain(ctx, icon, x + 12, y + 14, 42, 42)
          this.text(ctx, `${item.level || ""} ${item.title || ""}`.trim(), x + textOffset, y + 13, { width: textWidth, size: 15, weight: 900, color: "#004466" })
          this.text(ctx, item.desc || "", x + textOffset, y + 38, { width: textWidth, size: 13, lineHeight: 19, weight: 650, color: COLOR.ink })
        })
        ys[index] += h + 10
      }
    })
    this.y = Math.max(...ys) + 6
  }

  drawTextCards(items, columns = 2, titleKey = "title", bodyKey = "desc") {
    const list = items || []
    const gap = 12
    const width = (this.innerWidth() - gap * (columns - 1)) / columns
    const ys = Array(columns).fill(this.y)
    list.forEach((item, index) => {
      const col = index % columns
      const x = this.padding + col * (width + gap)
      const y = ys[col]
      const title = item[titleKey] || item.title || item.label || ""
      const body = item[bodyKey] || item.desc || item.body || ""
      const h = Math.max(92, this.measureParagraph(body, width - 30, 15, 22) + 58)
      this.card(x, y, width, h, ctx => {
        this.text(ctx, title, x + 15, y + 14, { width: width - 30, size: 17, weight: 900, color: "#004466" })
        this.text(ctx, body, x + 15, y + 44, { width: width - 30, size: 15, lineHeight: 22, weight: 650, color: COLOR.ink })
      })
      ys[col] += h + 12
    })
    this.y = Math.max(...ys) + 8
  }

  iconGrid(items) {
    const columns = 8
    const gap = 10
    const width = (this.innerWidth() - gap * (columns - 1)) / columns
    for (let index = 0; index < items.length; index++) {
      const x = this.padding + (index % columns) * (width + gap)
      const y = this.y + Math.floor(index / columns) * 112
      const item = items[index]
      this.card(x, y, width, 102, async ctx => {
        const icon = await this.loadImage(item.icon || item.image)
        if (icon) this.drawImageContain(ctx, icon, x + (width - 48) / 2, y + 10, 48, 48)
        this.text(ctx, item.name || item.title || "", x + 8, y + 64, { width: width - 16, size: 12, lineHeight: 16, weight: 750, color: COLOR.ink, align: "center", maxLines: 2 })
        if (item.count) this.text(ctx, item.count, x + 8, y + 86, { width: width - 16, size: 11, weight: 900, color: COLOR.blue, align: "center" })
      })
    }
    this.y += Math.ceil(items.length / columns) * 112 + 4
  }

  roomCard(room) {
    const titleH = 30
    const subtitleText = [room.subtitle, ...(room.goals || [])].filter(Boolean).join(" / ")
    const subtitleH = this.measureParagraph(subtitleText, this.innerWidth() - 36, 15, 22)
    const descH = room.desc ? this.measureParagraph(room.desc, this.innerWidth() - 36, 14, 21) + 8 : 0
    const sides = (room.sides || []).filter(side => side.monsters?.length)
    const sideH = sides.reduce((sum, side) => {
      const rows = Math.max(1, Math.ceil((side.monsters?.length || 0) / 6))
      return sum + rows * 104
    }, 0)
    const h = Math.max(128, 44 + titleH + subtitleH + descH + sideH)
    const x = this.padding
    const y = this.y
    this.card(x, y, this.innerWidth(), h, async ctx => {
      this.text(ctx, room.title || "关卡", x + 18, y + 16, { width: this.innerWidth() - 36, size: 22, weight: 950, color: "#004466" })
      let yy = y + 48
      yy += this.text(ctx, subtitleText, x + 18, yy, { width: this.innerWidth() - 36, size: 15, lineHeight: 22, weight: 650, color: COLOR.ink })
      if (room.desc) {
        yy += 8
        yy += this.text(ctx, room.desc, x + 18, yy, { width: this.innerWidth() - 36, size: 14, lineHeight: 21, weight: 650, color: COLOR.sub })
      }
      yy += 10
      for (const side of sides) {
        this.text(ctx, side.label || "敌人", x + 18, yy, { width: 120, size: 15, weight: 900, color: COLOR.blue })
        let xx = x + 120
        let rowY = yy - 8
        for (const monster of side.monsters || []) {
          const icon = await this.loadImage(monster.icon)
          if (icon) this.drawImageContain(ctx, icon, xx, rowY, 58, 58)
          this.text(ctx, monster.name || "", xx - 10, rowY + 62, { width: 78, size: 11, lineHeight: 14, weight: 750, color: COLOR.ink, align: "center", maxLines: 2 })
          xx += 92
          if (xx > x + this.innerWidth() - 80) {
            xx = x + 120
            rowY += 104
          }
        }
        yy = Math.max(rowY + 104, yy + 104)
      }
    })
    this.y += h + 12
  }

  drawTheaterOverview(overview) {
    this.theaterSummary(overview)
    if (overview.acts?.length) {
      this.sectionTitle(`${overview.difficultyLabel || "月谕"}幕次`)
      this.theaterActGrid(overview.acts, 3)
    }
    if (overview.hardActs?.length) {
      this.sectionTitle("圣牌挑战")
      this.theaterActGrid(overview.hardActs, 2)
    }
  }

  theaterSummary(overview) {
    const x = this.padding
    const y = this.y
    const width = this.innerWidth()
    const contentWidth = width - 48
    const groupHeights = (overview.groups || []).map(group =>
      34 + this.theaterIconRowsHeight(group.items || [], contentWidth, 78, 88))
    const h = Math.max(260, 122 + groupHeights.reduce((sum, height) => sum + height, 0))
    this.card(x, y, width, h, async ctx => {
      this.text(ctx, `${overview.version || ""}${overview.difficultyLabel ? ` · ${overview.difficultyLabel}` : ""}`, x + 24, y + 18, { width: width - 48, size: 30, weight: 950, color: "#004466", align: "center" })
      const meta = [overview.month, overview.period, overview.minLevel, overview.bossLimit].filter(Boolean).join(" · ")
      this.text(ctx, meta, x + 24, y + 60, { width: width - 48, size: 15, weight: 750, color: COLOR.ink, align: "center" })
      await this.drawTheaterElementChips(ctx, overview.elements || [], x + 24, y + 84, width - 48)
      let yy = y + 130
      for (const group of overview.groups || []) {
        this.text(ctx, group.title, x + 24, yy, { width: width - 48, size: 18, weight: 950, color: "#004466", align: "center" })
        yy += 30
        yy += await this.drawTheaterIconRows(ctx, group.items || [], x + 24, yy, width - 48, { itemWidth: 78, rowHeight: 88, iconSize: 50, showId: group.title.includes("阵容") || group.title.includes("挑战") })
        yy += 4
      }
    }, { fill: "rgba(255,255,255,0.9)", radius: 20 })
    this.y += h + 14
  }

  theaterActGrid(acts, columns = 3) {
    const list = acts || []
    const gap = 12
    const width = (this.innerWidth() - gap * (columns - 1)) / columns
    for (let index = 0; index < list.length; index += columns) {
      const row = list.slice(index, index + columns)
      const heights = row.map(act => this.theaterActHeight(act, width))
      const rowH = Math.max(...heights)
      row.forEach((act, offset) => {
        const x = this.padding + offset * (width + gap)
        const y = this.y
        this.card(x, y, width, rowH, async ctx => {
          this.text(ctx, act.title || "幕次", x + 14, y + 14, { width: width - 28, size: 20, weight: 950, color: "#004466", align: "center" })
          this.text(ctx, act.subtitle || "", x + 14, y + 43, { width: width - 28, size: 13, weight: 800, color: "#b17900", align: "center" })
          let yy = y + 66
          if (act.monsters?.length) {
            yy += await this.drawTheaterIconRows(ctx, act.monsters, x + 14, yy, width - 28, { itemWidth: 76, rowHeight: 92, iconSize: 54, showId: true, maxLabelLines: 1 })
            yy += 8
          }
          if (act.desc) {
            this.text(ctx, act.desc, x + 16, yy, { width: width - 32, size: 13, lineHeight: 20, weight: 650, color: COLOR.ink })
          }
        }, { fill: "rgba(255,255,255,0.9)", radius: 16 })
      })
      this.y += rowH + 12
    }
    this.y += 4
  }

  theaterActHeight(act, width) {
    const iconH = act.monsters?.length ? this.theaterIconRowsHeight(act.monsters, width - 28, 76, 92) + 10 : 0
    const descH = act.desc ? this.measureParagraph(act.desc, width - 32, 13, 20) : 0
    return Math.max(122, 82 + iconH + descH)
  }

  theaterIconRowsHeight(items, width, itemWidth = 78, rowHeight = 88) {
    const count = items?.length || 0
    if (!count) return 0
    const perRow = Math.max(1, Math.floor(width / itemWidth))
    return Math.ceil(count / perRow) * rowHeight
  }

  async drawTheaterElementChips(ctx, elements, x, y, width) {
    const list = elements || []
    if (!list.length) return 0
    const chipW = 58
    const gap = 8
    const total = list.length * chipW + (list.length - 1) * gap
    let xx = x + Math.max(0, (width - total) / 2)
    for (const element of list) {
      this.roundRect(ctx, xx, y, chipW, 28, 14, "rgba(36,169,216,0.12)")
      const icon = await this.loadImage(element.icon)
      if (icon) this.drawImageContain(ctx, icon, xx + 7, y + 4, 20, 20)
      this.text(ctx, element.name || "", xx + (icon ? 30 : 0), y + 6, { width: icon ? 22 : chipW, size: 12, weight: 900, color: "#006699", align: icon ? "left" : "center" })
      xx += chipW + gap
    }
    return 28
  }

  async drawTheaterIconRows(ctx, items, x, y, width, options = {}) {
    const list = items || []
    if (!list.length) return 0
    const itemWidth = options.itemWidth || 78
    const rowHeight = options.rowHeight || 88
    const iconSize = options.iconSize || 50
    const perRow = Math.max(1, Math.floor(width / itemWidth))
    for (let index = 0; index < list.length; index += perRow) {
      const row = list.slice(index, index + perRow)
      const startX = x + Math.max(0, (width - row.length * itemWidth) / 2)
      const rowY = y + Math.floor(index / perRow) * rowHeight
      for (const [offset, item] of row.entries()) {
        const itemX = startX + offset * itemWidth
        const iconX = itemX + (itemWidth - iconSize) / 2
        const icon = await this.loadImage(item.icon || item.image)
        if (icon) this.drawImageContain(ctx, icon, iconX, rowY, iconSize, iconSize)
        else {
          this.roundRect(ctx, iconX, rowY, iconSize, iconSize, 14, "rgba(36,169,216,0.12)")
          this.text(ctx, item.name?.slice?.(0, 1) || "?", iconX, rowY + iconSize / 2 - 13, { width: iconSize, size: 20, weight: 950, color: COLOR.blue, align: "center" })
        }
        const labelLines = options.showId ? 1 : options.maxLabelLines || 2
        this.text(ctx, item.name || "", itemX + 2, rowY + iconSize + 5, { width: itemWidth - 4, size: 10, lineHeight: 13, weight: 800, color: COLOR.ink, align: "center", maxLines: labelLines })
        if (options.showId && item.id) {
          this.text(ctx, item.id, itemX + 2, rowY + iconSize + 20, { width: itemWidth - 4, size: 10, weight: 950, color: "#006699", align: "center", maxLines: 1 })
        }
      }
    }
    return this.theaterIconRowsHeight(list, width, itemWidth, rowHeight)
  }

  table(ctx, table, x, y, width) {
    const rows = table.rows || []
    if (!rows.length) return 0
    const headers = normalizeTableHeaders(table)
    const widths = tableColumnWidths(headers.length, width)
    const headerH = Math.max(26, ...headers.map((head, index) =>
      this.wrap(head, widths[index] - 8, 10, Infinity, 900).length * 14 + 10))
    const rowHeights = rows.map(row => {
      const values = normalizeTableRowValues(row, headers.length)
      const cellHeights = [
        this.wrap(row.label || "", widths[0] - 8, 9, Infinity, 900).length * 13,
        ...values.map((value, index) =>
          this.wrap(value, widths[index + 1] - 8, 9, Infinity, 650).length * 13),
      ]
      return Math.max(28, ...cellHeights.map(height => height + 10))
    })
    const totalH = headerH + rowHeights.reduce((sum, height) => sum + height, 0)
    this.roundRect(ctx, x, y, width, totalH, 10, "rgba(232,248,255,0.78)")
    ctx.strokeStyle = "rgba(0,68,102,0.14)"
    ctx.lineWidth = 1
    let xx = x
    for (const colWidth of widths.slice(0, -1)) {
      xx += colWidth
      ctx.beginPath()
      ctx.moveTo(xx, y)
      ctx.lineTo(xx, y + totalH)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.moveTo(x, y + headerH)
    ctx.lineTo(x + width, y + headerH)
    ctx.stroke()
    let cursorX = x
    headers.forEach((head, index) => {
      this.text(ctx, head, cursorX + 4, y + 5, { width: widths[index] - 8, size: 10, lineHeight: 14, weight: 900, color: "#006699", align: "center" })
      cursorX += widths[index]
    })
    let yy = y + headerH
    rows.forEach((row, rowIndex) => {
      const rowH = rowHeights[rowIndex]
      if (rowIndex > 0) {
        ctx.beginPath()
        ctx.moveTo(x, yy)
        ctx.lineTo(x + width, yy)
        ctx.stroke()
      }
      let cellX = x
      this.text(ctx, row.label || "", cellX + 4, yy + 5, { width: widths[0] - 8, size: 9, lineHeight: 13, weight: 900, color: "#006699", align: "center" })
      cellX += widths[0]
      normalizeTableRowValues(row, headers.length).forEach((value, index) => {
        this.text(ctx, value, cellX + 4, yy + 5, { width: widths[index + 1] - 8, size: 9, lineHeight: 13, color: COLOR.ink, align: "center" })
        cellX += widths[index + 1]
      })
      yy += rowH
    })
    return totalH + 8
  }

  measureTable(table, width) {
    const rows = table.rows || []
    if (!rows.length) return 0
    const headers = normalizeTableHeaders(table)
    const widths = tableColumnWidths(headers.length, width)
    const headerH = Math.max(26, ...headers.map((head, index) =>
      this.wrap(head, widths[index] - 8, 10, Infinity, 900).length * 14 + 10))
    const bodyH = rows.reduce((sum, row) => {
      const values = normalizeTableRowValues(row, headers.length)
      const cellHeights = [
        this.wrap(row.label || "", widths[0] - 8, 9, Infinity, 900).length * 13,
        ...values.map((value, index) =>
          this.wrap(value, widths[index + 1] - 8, 9, Infinity, 650).length * 13),
      ]
      return sum + Math.max(28, ...cellHeights.map(height => height + 10))
    }, 0)
    return headerH + bodyH + 8
  }

  levelRows(ctx, rows, x, y, width) {
    const colW = (width - 8) / 2
    let offsetY = 0
    for (let index = 0; index < rows.length; index += 2) {
      const pair = rows.slice(index, index + 2)
      const rowH = Math.max(...pair.map(row => this.levelRowHeight(row, colW)))
      pair.forEach((row, offset) => {
        const xx = x + offset * (colW + 8)
        const yy = y + offsetY
        this.roundRect(ctx, xx, yy, colW, rowH, 8, "rgba(232,248,255,0.78)")
        this.text(ctx, `${row.level} ${row.text}`, xx + 8, yy + 8, { width: colW - 16, size: 11, lineHeight: 15, color: COLOR.ink })
      })
      offsetY += rowH + 8
    }
    return offsetY
  }

  measureLevelRows(rows, width) {
    const colW = (width - 8) / 2
    let height = 0
    for (let index = 0; index < rows.length; index += 2) {
      height += Math.max(...rows.slice(index, index + 2).map(row => this.levelRowHeight(row, colW))) + 8
    }
    return height
  }

  levelRowHeight(row, width) {
    return Math.max(36, this.measureParagraph(`${row.level} ${row.text}`, width - 16, 11, 15) + 16)
  }

  sectionTitle(title) {
    this.sectionTitleAt(title, this.padding, this.y, this.innerWidth())
    this.y += 48
  }

  sectionTitleAt(title, x, y, width) {
    this.commands.push(ctx => {
      ctx.save()
      ctx.font = `950 18px ${FONT_FAMILY}, sans-serif`
      const textW = Math.min(width, Math.max(140, ctx.measureText(title).width + 54))
      ctx.restore()
      this.roundRect(ctx, x, y, textW, 34, 17, "rgba(255,255,255,0.88)")
      this.roundRect(ctx, x + 14, y + 8, 8, 18, 99, COLOR.blue)
      this.text(ctx, title, x + 32, y + 8, { width: textW - 44, size: 18, weight: 950, color: "#004466" })
    })
  }

  card(x, y, width, height, draw, options = {}) {
    this.commands.push(async ctx => {
      this.roundRect(ctx, x, y, width, height, options.radius || 20, options.fill || COLOR.panelStrong)
      ctx.strokeStyle = COLOR.line
      ctx.lineWidth = 1
      this.roundRectStroke(ctx, x, y, width, height, options.radius || 20)
      await draw(ctx)
    })
  }

  footer(prefix = "") {
    const text = [
      prefix,
      `Generated by ${this.data.pluginName || "荷花插件"}`,
      this.data.generatedAt || "",
    ].filter(Boolean).join(" · ")
    const y = this.y + 8
    this.commands.push(ctx => {
      const width = this.innerWidth()
      const x = (this.width - width) / 2
      this.roundRect(ctx, x, y, width, 34, 17, COLOR.darkGlass)
      this.text(ctx, text, x + 18, y + 9, { width: width - 36, size: 11, color: "rgba(255,255,255,0.92)", align: "center", maxLines: 1 })
    })
    this.y += 52
  }

  text(ctx, text, x, y, options = {}) {
    const lines = this.wrap(text, options.width || 200, options.size || 16, options.maxLines || Infinity, options.weight || 650)
    ctx.save()
    ctx.font = `${options.weight || 650} ${options.size || 16}px ${FONT_FAMILY}, sans-serif`
    ctx.fillStyle = options.color || COLOR.ink
    ctx.textAlign = options.align || "left"
    ctx.textBaseline = "top"
    if (options.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.36)"
      ctx.shadowBlur = 8
      ctx.shadowOffsetY = 2
    }
    const lineHeight = options.lineHeight || Math.round((options.size || 16) * 1.35)
    const drawX = options.align === "center" ? x + (options.width || 0) / 2 : options.align === "right" ? x + (options.width || 0) : x
    lines.forEach((line, index) => ctx.fillText(line, drawX, y + index * lineHeight))
    ctx.restore()
    return lines.length * lineHeight
  }

  wrap(text, width, size = 16, maxLines = Infinity, weight = 650) {
    const input = String(text || "").replace(/\s+/g, " ").trim()
    if (!input) return []
    const canvas = wrapMeasureCanvas || (wrapMeasureCanvas = new Canvas(10, 10))
    const ctx = canvas.getContext("2d")
    ctx.font = `${weight} ${size}px ${FONT_FAMILY}, sans-serif`
    const lines = []
    let line = ""
    for (const char of input) {
      const next = line + char
      if (ctx.measureText(next).width > width && line) {
        lines.push(line)
        line = char
        if (lines.length >= maxLines) break
      } else {
        line = next
      }
    }
    if (line && lines.length < maxLines) lines.push(line)
    if (lines.length >= maxLines && input.length > lines.join("").length) {
      lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, -1)}…`
    }
    return lines
  }

  measureParagraph(text, width, size = 16, lineHeight = Math.round(size * 1.35)) {
    return this.wrap(text, width, size).length * lineHeight
  }

  pill(ctx, x, y, width, height, text, color = COLOR.blue) {
    this.roundRect(ctx, x, y, width, height, height / 2, color)
    this.text(ctx, text || "", x, y + 6, { width, size: 12, weight: 900, color: "#fff", align: "center" })
  }

  smallChip(ctx, x, y, text) {
    this.roundRect(ctx, x, y, 200, 26, 13, "rgba(102,204,255,0.16)")
    this.text(ctx, text, x + 10, y + 6, { width: 180, size: 12, weight: 800, color: "#006699" })
  }

  iconPlaceholder(ctx, x, y, w, h, text) {
    this.roundRect(ctx, x, y, w, h, 16, "rgba(102,204,255,0.16)")
    this.text(ctx, text, x, y + h / 2 - 13, { width: w, size: 22, weight: 950, color: COLOR.blue, align: "center" })
  }

  drawImageContain(ctx, img, x, y, w, h) {
    const scale = Math.min(w / img.width, h / img.height)
    const dw = img.width * scale
    const dh = img.height * scale
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
  }

  drawImageCover(ctx, img, x, y, w, h, radius = 0) {
    const scale = Math.max(w / img.width, h / img.height)
    const sw = w / scale
    const sh = h / scale
    const sx = Math.max(0, (img.width - sw) / 2)
    const sy = Math.max(0, (img.height - sh) / 2)
    ctx.save()
    if (radius > 0) {
      rrectPath(ctx, x, y, w, h, radius)
      ctx.clip()
    }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h)
    ctx.restore()
  }

  roundRect(ctx, x, y, w, h, r, fill) {
    r = Math.max(0, Math.min(r, w / 2, h / 2))
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
  }

  roundRectStroke(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2))
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
    ctx.stroke()
  }

  innerWidth() {
    return this.width - this.padding * 2
  }
}

let wrapMeasureCanvas

async function loadCachedImage(src, imageRoots = []) {
  if (!src || typeof src !== "string") return null
  const resolved = normalizeImageSource(src, imageRoots)
  const key = resolved
  if (IMAGE_CACHE.has(key)) return IMAGE_CACHE.get(key)
  const promise = loadImage(resolved).catch(error => {
    if (error?.code !== "ENOENT") {
      globalThis.logger?.warn?.(`[荷花插件渲染] 图片加载失败：${String(src).slice(0, 120)} ${error.message}`)
    }
    return null
  })
  IMAGE_CACHE.set(key, promise)
  return promise
}

function normalizeImageSource(src, imageRoots = []) {
  if (src.startsWith("file://")) return fileURLToPath(src)
  if (/^(?:data:image\/|https?:\/\/)/i.test(src)) return src
  if (path.isAbsolute(src)) return src
  for (const root of imageRoots) {
    const candidate = path.join(root, src)
    if (existsSyncCheap(candidate)) return candidate
    const indexed = findInGalleryIndex(root, src)
    if (indexed) return indexed
  }
  return src
}

function rrectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function existsSyncCheap(file) {
  return existsSync(file)
}

function findInGalleryIndex(root, src) {
  const base = path.basename(src).replace(/\.[^.]+$/, "").toLowerCase()
  if (!base) return ""
  const index = getGalleryIndex(root)
  return index.get(base) || index.get(path.basename(src).toLowerCase()) || ""
}

function getGalleryIndex(root) {
  const galleryRoot = path.join(root, "gallery")
  if (GALLERY_INDEX_CACHE.has(galleryRoot)) return GALLERY_INDEX_CACHE.get(galleryRoot)
  const index = new Map()
  const stack = [galleryRoot]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(file)
      } else if (/\.(?:png|jpe?g|webp|gif|svg)$/i.test(entry.name)) {
        const lower = entry.name.toLowerCase()
        const noExt = lower.replace(/\.[^.]+$/, "")
        if (!index.has(noExt)) index.set(noExt, file)
        if (!index.has(lower)) index.set(lower, file)
      }
    }
  }
  GALLERY_INDEX_CACHE.set(galleryRoot, index)
  return index
}

function looksLikeImage(value) {
  return /^(?:data:image\/|https?:\/\/)/i.test(value)
    || /\.(?:png|jpe?g|webp|gif|svg)(?:[?#].*)?$/i.test(value)
}

function isAtlasTemplate(templateName) {
  return /^atlas-/.test(templateName)
}

function normalizeRenderScale(value) {
  const scale = Number(value)
  if (!Number.isFinite(scale)) return 4
  return Math.min(4, Math.max(1, scale))
}

function normalizeTableHeaders(table = {}) {
  const rows = table.rows || []
  const valueCount = Math.max(0, ...rows.map(row => (row.values || []).length))
  const headers = table.headers?.length ? table.headers : ["项目", ...Array.from({ length: valueCount }, (_, index) => String(index + 1))]
  if (headers.length >= valueCount + 1) return headers.map(value => String(value || ""))
  return [
    ...headers.map(value => String(value || "")),
    ...Array.from({ length: valueCount + 1 - headers.length }, (_, index) => String(headers.length + index)),
  ]
}

function normalizeTableRowValues(row = {}, headerCount = 1) {
  return Array.from({ length: Math.max(0, headerCount - 1) }, (_, index) => String(row.values?.[index] ?? ""))
}

function tableColumnWidths(count, width) {
  const columns = Math.max(1, count)
  if (columns === 1) return [width]
  const first = columns > 6
    ? Math.min(width * 0.18, Math.max(92, width / columns * 1.28))
    : width / columns
  const rest = (width - first) / (columns - 1)
  return [first, ...Array.from({ length: columns - 1 }, () => rest)]
}

function formatShortNumber(value) {
  const number = Number(value || 0)
  if (!Number.isFinite(number) || number <= 0) return "-"
  if (number >= 100000000) return `${(number / 100000000).toFixed(1)}亿`
  if (number >= 10000) return `${(number / 10000).toFixed(1)}万`
  return String(Math.round(number))
}

function formatDuration(seconds) {
  const total = Number(seconds || 0)
  if (!Number.isFinite(total) || total <= 0) return "-"
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const pad = value => String(value).padStart(2, "0")
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function partsToText(parts = []) {
  return parts.map(part => part.text || part.label || "").join("")
}

function formatTime(date) {
  const pad = value => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
