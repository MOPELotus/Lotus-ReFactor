import path from "node:path"
import { pathToFileURL } from "node:url"
import { resourcesPath } from "../path.js"
import { formatLocalDateTime } from "../time.js"
import { createRenderBackgroundProvider } from "./background.js"

const DEFAULT_RENDER_OPTIONS = Object.freeze({
  imgType: "jpeg",
  quality: 98,
})

let skiaRendererPromise = null

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
    generatedAt: formatLocalDateTime(),
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

  const { renderWithSkia } = await loadSkiaRenderer()
  return renderWithSkia(templateName, payload, {
    ...DEFAULT_RENDER_OPTIONS,
    ...options,
    saveId,
    data: payload,
  })
}

async function loadSkiaRenderer() {
  if (!skiaRendererPromise) {
    skiaRendererPromise = import("./skia.js").catch(error => {
      skiaRendererPromise = null
      if (isSkiaCanvasLoadError(error)) {
        throw new Error([
          "skia-canvas 原生模块未安装或未编译，图片渲染不可用。",
          "pnpm v10 工作区用户请在 Yunzai 根目录执行 pnpm approve-builds，选择 skia-canvas 后再执行 pnpm rebuild skia-canvas。",
          "也可以在 Yunzai 根 pnpm-workspace.yaml 配置 onlyBuiltDependencies: [\"skia-canvas\"] 后重新安装。",
          `原始错误：${error.message}`,
        ].join(" "))
      }
      throw error
    })
  }
  return skiaRendererPromise
}

function isSkiaCanvasLoadError(error) {
  const text = `${error?.message || ""}\n${error?.stack || ""}`
  return /skia-canvas|skia\.node|Cannot find module|ERR_DLOPEN_FAILED/i.test(text)
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
