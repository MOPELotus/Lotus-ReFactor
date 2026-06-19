import path from "node:path"
import { pathToFileURL } from "node:url"
import { resourcesPath } from "../path.js"
import { createRenderBackgroundProvider } from "./background.js"
import { renderWithSkia } from "./skia.js"

const DEFAULT_RENDER_OPTIONS = Object.freeze({
  imgType: "jpeg",
  quality: 98,
})

export async function renderTemplate(templateName, data = {}, options = {}) {
  const saveId = sanitizeSaveId(options.saveId || templateName)
  const fontPath = toFileUrl(path.join(resourcesPath, "fonts", "MiSans-VF.ttf"))
  const hasExplicitBackground = Boolean(data.bg || data.backgrounds || data.backgroundProvider)
  const backgroundProvider = data.backgroundProvider || (hasExplicitBackground
    ? null
    : await createRenderBackgroundProvider())
  const bg = data.bg || firstBackground(data.backgrounds) || (backgroundProvider ? await backgroundProvider() : "")
  const payload = {
    pluginName: "荷花插件",
    generatedAt: formatTime(new Date()),
    ...data,
    bg,
    backgrounds: Array.isArray(data.backgrounds) && data.backgrounds.length
      ? data.backgrounds
      : bg
        ? [bg]
        : [],
    backgroundProvider,
    fontPath,
  }

  return renderWithSkia(templateName, payload, {
    ...DEFAULT_RENDER_OPTIONS,
    ...options,
    saveId,
    data: payload,
  })
}

function firstBackground(backgrounds) {
  return Array.isArray(backgrounds) ? backgrounds.find(Boolean) || "" : ""
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
