import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Canvas, FontLibrary, loadImage } from 'skia-canvas'
import { resourcesPath } from '../path.js'
import { fetchImageBytes } from './image.js'
import { plainGameText } from './plain-text.js'
import { encodeGpuCanvas } from './gpu-buffer.js'

// Miao wiki/character-talent: elemental canvas, circular icon, gold headings,
// dark talent panels. Each content category is measured and kept on one complete image.
const WIDTH = 800, MARGIN = 24, INNER = WIDTH - MARGIN * 2
const HEADER = 184, BOTTOM = 62
const FONT = '"MiaoWiki", MiSans, sans-serif'
const GOLD = '#d3bc8e', WHITE = '#f1efed', MUTED = '#c2c5cb'
const ROOT = path.join(resourcesPath, 'miao-theme')
const CACHE = new Map()
let initialized = false, measureCanvas

function init() {
  if (initialized) return
  FontLibrary.use('MiaoWiki', [path.join(ROOT, 'fonts/HYWH-65W.ttf')])
  FontLibrary.use('MiSans', [path.join(resourcesPath, 'fonts/MiSans-VF.ttf')])
  initialized = true
}
function measure() { init(); measureCanvas ||= new Canvas(10, 10); return measureCanvas.getContext('2d') }
function linesOf(value, width, size = 19) {
  const ctx = measure(); ctx.font = `${size}px ${FONT}`
  const lines = []
  for (const paragraph of plainGameText(value).split(/\r?\n/)) {
    let line = ''
    const tokens = paragraph.match(/[-+]?\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9.-]*|./gu) || []
    for (const token of tokens) {
      if (ctx.measureText(token).width > width) {
        for (const char of token) {
          if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = '' }
          line += char
        }
      } else {
        if (line && ctx.measureText(line + token).width > width) { lines.push(line); line = '' }
        line += token
      }
    }
    lines.push(line)
  }
  return lines
}
function textBlock(value, options = {}) {
  const size = options.size || 19, lineHeight = options.lineHeight || 29
  const lines = linesOf(value, options.width || INNER - 40, size)
  return { type: 'text', lines, size, lineHeight, color: options.color || WHITE, height: lines.length * lineHeight + 20 }
}
function labelBlock(title, icon = '', type = '') {
  const lines = linesOf(title, INNER - (icon ? 124 : 40), 26)
  return { type: 'label', title: lines, icon, subtitle: plainGameText(type), height: Math.max(82, lines.length * 34 + 35) }
}
function splitTables(table) {
  const headers = table.headers || ['项目']
  const blocks = []
  // Four level columns remain readable at chat width; every value survives.
  const columns = Math.max(1, headers.length - 1)
  for (let start = 0; start < columns; start += 4) {
    const count = Math.min(4, columns - start)
    const cols = headers.length > 1 ? [headers[0], ...headers.slice(start + 1, start + count + 1)] : headers
    const widths = cols.length > 1 ? [280, ...Array(cols.length - 1).fill((INNER - 40 - 280) / (cols.length - 1))] : [INNER - 40]
    const cells = cols.map((s, i) => linesOf(s, widths[i] - 12, 17))
    blocks.push({ type: 'table-head', cells, widths, height: Math.max(44, ...cells.map(c => c.length * 25 + 14)),
      title: `${table.title || '等级数值'}${headers.length > 5 ? ` · ${cols[1]}—${cols.at(-1)}` : ''}` })
    for (const row of table.rows || []) {
      const values = cols.length > 1 ? [row.label, ...(row.values || []).slice(start, start + count)] : [row.label]
      while (values.length < cols.length) values.push('')
      const cells = values.map((s, i) => linesOf(s, widths[i] - 12, 17))
      blocks.push({ type: 'table-row', cells, widths, height: Math.max(40, ...cells.map(c => c.length * 25 + 14)) })
    }
    blocks.push({ type: 'gap', height: 12 })
  }
  return blocks
}
function cardBlocks(cards) {
  const out = []
  for (const card of (cards || []).filter(card => card.title || card.label || card.desc || card.descLines?.length || card.tables?.length)) {
    out.push(labelBlock([card.level, card.title || card.label].filter(Boolean).join(' · '), card.hideIcon ? '' : card.icon, card.type))
    if (card.desc || card.body) out.push(textBlock(card.desc || card.body))
    for (const desc of card.descLines || []) {
      if (desc.title) out.push(textBlock(desc.title, { size: 21, color: GOLD }))
      if (desc.parts?.some(part => part.icon)) out.push(...richBlocks(desc.parts))
      else if (desc.text) out.push(textBlock(desc.text))
    }
    for (const row of card.levelRows || []) {
      out.push(textBlock(row.level, { size: 17, color: GOLD }))
      out.push(textBlock(row.text))
    }
    for (const table of card.tables || []) {
      if (table.title) out.push(textBlock(table.title, { size: 17, color: GOLD }))
      out.push(...splitTables(table))
    }
    out.push({ type: 'gap', height: 16 })
  }
  return out
}
function richBlocks(parts) {
  const ctx = measure(); ctx.font = `19px ${FONT}`
  const lines = [], line = []; let used = 0
  const push = () => { lines.push([...line]); line.length = 0; used = 0 }
  for (const part of parts) {
    if (part.type === 'icon' && part.icon) {
      if (used + 25 > INNER - 40) push()
      line.push({ icon: part.icon, width: 25 }); used += 25
      continue
    }
    for (const char of plainGameText(part.text || part.label || '')) {
      if (char === '\n') { push(); continue }
      const width = ctx.measureText(char).width
      if (used + width > INNER - 40 && line.length) push()
      line.push({ text: char, width }); used += width
    }
  }
  if (line.length) push()
  return lines.map(atoms => ({ type: 'rich', atoms, height: 31 }))
}
function elementOf(data) {
  const view = data.view || {}
  const elem = view.meta?.find(m => m.label === '属性')?.value || ''
  if (/量子/.test(elem)) return 'quantum'
  if (/虚数|岩/.test(elem)) return 'geo'
  if (/火/.test(elem)) return 'pyro'
  if (/水/.test(elem)) return 'hydro'
  if (/冰|霜/.test(elem)) return 'cryo'
  if (/风/.test(elem)) return 'anemo'
  if (/雷|电/.test(elem)) return 'electro'
  if (/草/.test(elem)) return 'dendro'
  return 'sr'
}
function groupsOf(data) {
  const view = data.view || {}, groups = []
  const add = (section, blocks) => { if (blocks.length) groups.push({ section, blocks }) }
  if (view.kind === 'challenge' || data.template === 'atlas-challenge') {
    add('挑战图鉴', challengeBlocks(view, data))
  } else if (view.kind === 'character') {
    const overview = []
    if (view.portrait) overview.push({ type: 'portrait', image: view.portrait, height: 300 })
    if (view.description) overview.push(textBlock(view.description))
    const meta = (view.meta || []).filter(m => m.value && !['ID', '图鉴版本', '模块', '游戏'].includes(m.label))
    if (meta.length) overview.push(textBlock(meta.map(m => `${m.label}：${m.value}`).join(' · '), { color: GOLD }))
    overview.push(...factsBlocks(view.stats || []))
    add('角色总览', overview)
    add(view.game === '星铁' ? '技能与行迹' : view.game === '绝区零' ? '技能与核心能力' : '技能与天赋', [
      ...cardBlocks(view.skills),
      ...cardBlocks([...(view.passives || []), ...(view.enhancements || [])]),
    ])
    add(view.game === '星铁' ? '星魂' : view.game === '绝区零' ? '影画' : '命座', cardBlocks(view.constellations))
    const materialGroups = view.materialGroups?.length ? view.materialGroups : [{ title: '养成材料', items: view.materials || [] }]
    const blocks = []
    for (const group of materialGroups) {
      if (!group.items?.length) continue
      blocks.push(labelBlock(group.title))
      if (group.cost) blocks.push(textBlock(group.cost, { color: GOLD }))
      blocks.push(...materialBlocks(group.items))
    }
    add('养成材料', blocks)
  } else if (view.kind === 'weapon') {
    const blocks = [textBlock(view.description), ...factsBlocks(view.stats || []), ...cardBlocks(view.refinements || [])]
    if (view.story) blocks.push(labelBlock('武器故事'), textBlock(view.story))
    add(view.page || '装备图鉴', blocks)
  } else if (view.kind === 'relic') {
    add('套装效果', cardBlocks(view.effects || []))
    add('套装部件', materialBlocks(view.parts || []))
    if (view.story) add('套装故事', [textBlock(view.story)])
  } else if (view.kind === 'bangboo') {
    add('邦布总览', [textBlock(view.description), ...factsBlocks(view.stats || [])])
    add('邦布技能', cardBlocks(view.skills || []))
  } else {
    const sections = data.sections || []
    add(view.page || '图鉴资料', [textBlock(view.description), ...factsBlocks(view.stats || data.facts || []), ...cardBlocks(sections.map(s => ({ ...s, desc: s.body })))])
  }
  if (!groups.length) add(view.page || '图鉴资料', [textBlock(view.description || data.message || '本条目未提供详细说明。')])
  return groups
}
function challengeBlocks(view, data) {
  const blocks = []
  const paragraph = value => { if(value) blocks.push(textBlock(value)) }
  const heading = (title, icon='') => blocks.push(labelBlock(title, icon))
  const creatures = items => {
    for(const item of items || []) {
      heading([item.side,item.name||item.title].filter(Boolean).join(' · '),item.icon)
      paragraph([item.level,item.hp ? `生命值 ${item.hp}` : '',item.weakness ? `弱点 ${item.weakness}` : ''].filter(Boolean).join(' · '))
      if(item.levelByChallenge) paragraph(Object.entries(item.levelByChallenge).map(([name,level])=>`${name}：${level}`).join(' · '))
      if(item.descByLevel?.N5 || item.descByLevel?.N6) {
        for(const [name,desc] of Object.entries(item.descByLevel)) { heading(`${name}说明`); paragraph(desc) }
      } else paragraph(item.desc)
      paragraph(item.buffText)
    }
  }
  const room = item => {
    heading(item.title||'关卡');paragraph([item.subtitle,...(item.goals||[])].filter(Boolean).join(' · '));paragraph(item.desc)
    for(const side of item.sides||[]) { heading(side.label||'敌人');creatures(side.monsters) }
    creatures(item.monsters)
  }
  paragraph(view.description)
  if(view.theaterOverview) {
    const overview=view.theaterOverview
    paragraph([overview.version,overview.difficultyLabel,overview.period,overview.minLevel,overview.bossLimit].filter(Boolean).join(' · '))
    if(overview.elements?.length){heading('限定元素');creatures(overview.elements)}
    for(const group of overview.groups||[]) { heading(group.title);creatures(group.items) }
    for(const act of [...(overview.acts||[]),...(overview.hardActs||[])])room(act)
  } else if(view.hardChallengeOverview) {
    const overview=view.hardChallengeOverview
    paragraph([overview.title,overview.period].filter(Boolean).join(' · '))
    for(const item of overview.descriptions||[]) { heading(item.label);paragraph(item.text) }
    if(overview.monsters?.length)creatures(overview.monsters)
    else for(const level of overview.levels||[])room(level)
  } else {
    for(const [title,items]of [['环境与全局效果',view.environment],['可选增益',view.optionalBuffs]])if(items?.length){heading(title);blocks.push(...cardBlocks(items.map(item=>({...item,desc:item.body||item.desc}))))}
    for(const item of view.rooms||[])room(item)
    if(!view.environment?.length&&!view.optionalBuffs?.length&&!view.rooms?.length)blocks.push(...cardBlocks((data.sections||[]).map(s=>({...s,desc:s.body}))))
  }
  return blocks
}
function factsBlocks(items) {
  items = items.filter(item => String(item.value ?? item.body ?? '').trim())
  const blocks = []
  for (let i = 0; i < items.length; i += 3) {
    const facts = items.slice(i, i + 3).map(item => ({ label: linesOf(item.label || item.title, 212, 16), value: linesOf(item.value ?? item.body ?? '', 212, 23) }))
    blocks.push({ type: 'facts', facts, height: Math.max(90, ...facts.map(f => 20 + f.label.length * 24 + f.value.length * 30)) })
  }
  return blocks
}
function materialBlocks(items) {
  return (items || []).map(item => ({ type: 'material', icon: item.icon, name: linesOf(item.name || item.title || '', INNER - 180, 20), count: String(item.count || ''),
    height: Math.max(86, linesOf(item.name || item.title || '', INNER - 180, 20).length * 28 + 26) }))
}

export function buildAtlasPages(data) {
  const pages = groupsOf(data).map(({section, blocks}) => ({
    section,
    blocks,
    height: Math.max(460, HEADER + blocks.reduce((sum, block) => sum + block.height, 0) + BOTTOM),
  }))
  return pages.map((page, index) => ({ ...page, index: index + 1, total: pages.length, title: data.title, element: elementOf(data) }))
}

async function getImage(src, roots = []) {
  if (!src) return null
  if (src.startsWith('file://')) src = fileURLToPath(src)
  if (!path.isAbsolute(src) && !/^https?:|^data:/.test(src)) {
    for (const root of roots) {
      const candidate = path.join(root, src)
      if (existsSync(candidate)) { src = candidate; break }
      const game = path.join(root, 'gallery')
      for (const id of ['gi', 'hsr', 'zzz']) {
        const candidate = path.join(game, id, src.replace(/\.(png|webp)$/i, '') + '.webp')
        if (existsSync(candidate)) { src = candidate; break }
      }
    }
  }
  if (!CACHE.has(src)) {
    if (CACHE.size >= 96) CACHE.delete(CACHE.keys().next().value)
    CACHE.set(src, loadImage(/^https?:/.test(src) ? await fetchImageBytes(src) : src).catch(() => null))
  }
  return CACHE.get(src)
}

export async function renderAtlasPage(data, options = {}) {
  init()
  const page = data.atlasPage || buildAtlasPages(data)[0]
  const scaleValue = Number(options.renderScale ?? data.renderScale ?? process.env.LOTUS_RENDER_SCALE ?? 4)
  const scale = Number.isFinite(scaleValue) ? Math.min(4, Math.max(1, scaleValue)) : 4
  const canvas = new Canvas(Math.round(WIDTH * scale), Math.round(page.height * scale))
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale)
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
  const roots = [data.atlasRoot].filter(Boolean), missing = []
  async function image(src) { const value = await getImage(src, roots); if (src && !value) missing.push(src); return value }
  function rect(x, y, w, h, fill, radius = 12) { ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill() }
  function textLines(lines, x, y, size = 19, color = WHITE, lineHeight = 29) {
    ctx.font = `${size}px ${FONT}`; ctx.textBaseline = 'top'; ctx.fillStyle = color; ctx.textAlign = 'left'
    lines.forEach((s, i) => ctx.fillText(s, x, y + i * lineHeight))
  }
  function contain(img, x, y, w, h) { const ratio = Math.min(w / img.width, h / img.height); const dw = img.width * ratio, dh = img.height * ratio; ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh) }
  rect(0, 0, WIDTH, page.height, '#252c40', 0)
  const bg = await image(path.join(ROOT, `bg/bg-${page.element || 'sr'}.webp`))
  if (bg) ctx.drawImage(bg, 0, 0, WIDTH, page.height)
  rect(MARGIN, 12, INNER, 152, 'rgba(15,18,29,0.52)', 12)
  const avatar = await image(data.image || data.view?.image)
  if (avatar) {
    ctx.save(); ctx.beginPath(); ctx.arc(84, 79, 51, 0, Math.PI * 2); ctx.clip(); contain(avatar, 33, 28, 102, 102); ctx.restore()
    ctx.strokeStyle = GOLD; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(84, 79, 52, 0, Math.PI * 2); ctx.stroke()
  }
  const titleLines = linesOf(data.title, 620, 33)
  textLines(titleLines, 152, 30, 33, WHITE, 39)
  textLines([`${data.view?.game || ''} · ${page.section} · ${page.index}/${page.total}`], 154, 35 + titleLines.length * 39, 18, GOLD)
  textLines([data.view?.version ? `资料版本 ${data.view.version}` : '角色与装备资料'], 154, 69 + titleLines.length * 39, 14, MUTED)
  let y = HEADER
  const texture = await image(path.join(ROOT, 'card-bg.png'))
  for (const [blockIndex, block] of page.blocks.entries()) {
    if (block.type === 'gap') { y += block.height; continue }
    const isTable = block.type.startsWith('table')
    if (isTable && !page.blocks[blockIndex - 1]?.type.startsWith('table')) {
      let tableHeight = 0
      for (const row of page.blocks.slice(blockIndex)) { if (!row.type.startsWith('table')) break; tableHeight += row.height }
      ctx.save(); ctx.beginPath(); ctx.roundRect(MARGIN, y, INNER, tableHeight, 10); ctx.clip()
    } else if (!isTable) {
      ctx.save(); ctx.beginPath(); ctx.roundRect(MARGIN, y, INNER, block.height, 10); ctx.clip()
    }
    rect(MARGIN, y, INNER, block.height, 'rgba(15,20,31,0.58)', block.type.startsWith('table') ? 0 : 8)
    if (texture && block.type === 'label') ctx.drawImage(texture, MARGIN, y, INNER, block.height)
    if (block.type === 'label') {
      const icon = block.icon ? await image(block.icon) : null
      if (icon) { rect(40, y + 11, 62, 62, 'rgba(255,255,255,0.10)', 31); contain(icon, 49, y + 20, 44, 44) }
      const x = icon ? 122 : 44
      textLines(block.title, x, y + 14, 26, GOLD, 34)
      if (block.subtitle) textLines([block.subtitle], x, y + 19 + block.title.length * 34, 14, MUTED)
    } else if (block.type === 'text') textLines(block.lines, 44, y + 10, block.size, block.color, block.lineHeight)
    else if (block.type === 'rich') {
      let x = 44
      for (const atom of block.atoms) {
        if (atom.icon) { const icon = await image(atom.icon); if (icon) contain(icon, x, y + 3, 23, 23) }
        else textLines([atom.text], x, y + 3)
        x += atom.width
      }
    } else if (block.type === 'portrait') {
      const portrait = await image(block.image); if (portrait) contain(portrait, 44, y + 8, INNER - 40, block.height - 16)
    } else if (block.type === 'facts') block.facts.forEach((fact, i) => {
      const x = 48 + i * (INNER / 3)
      textLines(fact.label, x, y + 14, 16, MUTED, 24)
      textLines(fact.value, x, y + 18 + fact.label.length * 24, 23, GOLD, 30)
    })
    else if (block.type === 'material') {
      const icon = block.icon ? await image(block.icon) : null
      if (icon) contain(icon, 40, y + 11, 60, 60)
      textLines(block.name, icon ? 120 : 44, y + 24, 20)
      if (block.count) textLines([`× ${block.count}`], 654, y + 26, 21, GOLD)
    } else if (block.type.startsWith('table')) {
      if (block.type === 'table-head') rect(24, y, INNER, block.height, 'rgba(211,188,142,0.19)', 0)
      let x = 44
      block.cells.forEach((cell, i) => { textLines(cell, x + 6, y + 10, 17, block.type === 'table-head' ? GOLD : WHITE, 25); x += block.widths[i] })
      ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.beginPath(); ctx.moveTo(44, y + block.height); ctx.lineTo(756, y + block.height); ctx.stroke()
    }
    y += block.height
    if (!isTable || !page.blocks[blockIndex + 1]?.type.startsWith('table')) ctx.restore()
  }
  textLines([`荷花插件 · Nanoka Atlas · ${page.index}/${page.total}`], 24, page.height - 37, 14, MUTED)
  if (y + BOTTOM > page.height + 1) throw new Error(`Atlas page overflow: ${data.title}/${page.section}`)
  const { buffer, tiles, format } = await encodeGpuCanvas(canvas, options)
  options.onRender?.({ gpu: canvas.gpu, ...canvas.engine, width: canvas.width, height: canvas.height, tiles, format, section: page.section, page: page.index, missingImages: [...new Set(missing)] })
  if (options.path) await fs.writeFile(options.path, buffer)
  return globalThis.segment?.image ? globalThis.segment.image(buffer) : buffer
}
