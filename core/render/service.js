import path from "node:path"
import { pathToFileURL } from "node:url"
import { resourcesPath } from "../path.js"
import { getRenderBackground } from "./background.js"
import { renderWithSkia } from "./skia.js"

const DEFAULT_RENDER_OPTIONS = Object.freeze({
  imgType: "jpeg",
  quality: 98,
})

export async function renderTemplate(templateName, data = {}, options = {}) {
  const saveId = sanitizeSaveId(options.saveId || templateName)
  const fontPath = toFileUrl(path.join(resourcesPath, "fonts", "MiSans-VF.ttf"))
  const payload = {
    pluginName: "荷花插件",
    generatedAt: formatTime(new Date()),
    bg: data.bg || await getRenderBackground(),
    ...data,
    fontPath,
  }

  return renderWithSkia(templateName, payload, {
    ...DEFAULT_RENDER_OPTIONS,
    ...options,
    saveId,
    data: payload,
  })
}

export async function renderStatusCard(data = {}, options = {}) {
  return renderTemplate("status", data, {
    saveId: `lotus-status-${data.userId || "system"}`,
    ...options,
  })
}

function sanitizeSaveId(value) {
  return String(value)
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "lotus-render"
}

function toFileUrl(file) {
  return pathToFileURL(file).href
}

function formatTime(date) {
  const pad = (value) => String(value).padStart(2, "0")
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ")
}
