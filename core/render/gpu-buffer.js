import { Canvas } from 'skia-canvas'
import sharp from 'sharp'

// Prefer hardware rendering, but keep cards available without a working GPU.
// Hardware-only assertions belong in the explicit GPU verification scripts.
let fallbackReported = false
function useCpu(canvas, reason, options) {
  canvas.gpu = false
  if (!fallbackReported) {
    fallbackReported = true
    const warn = globalThis.logger?.warn?.bind(globalThis.logger) || console.warn
    warn(`[Lotus-Plugin] GPU rendering unavailable; using CPU: ${reason}`)
  }
  options.onFallback?.({reason, ...canvas.engine})
}

export async function encodeGpuCanvas(canvas, options = {}) {
  let hardware = false
  try {
    const engine = canvas.engine
    hardware = canvas.gpu && engine.renderer === 'GPU' && !/llvmpipe|lavapipe|SwiftShader/i.test(`${engine.device} ${engine.driver}`)
  } catch (error) {
    useCpu(canvas, error.message, options)
  }
  if (!hardware && canvas.gpu) useCpu(canvas, 'No hardware GPU renderer', options)
  try {
    return await encodeCanvas(canvas, options)
  } catch (error) {
    if (!hardware) throw error
    useCpu(canvas, error.message, options)
    return await encodeCanvas(canvas, options)
  }
}

// Replay tall canvases into bounded surfaces, then concatenate their pixels.
// Sharp only encodes the rendered pixels; it does not paint card content.
async function encodeCanvas(canvas, options) {
  let format = options.imgType === 'png' ? 'png' : 'jpeg'
  const quality = Number(options.quality || 98) / 100
  if (canvas.height <= 16384) return { buffer: canvas.toBufferSync(format, {quality, msaa:options.msaa}), tiles: 1, format }
  if (canvas.width > 16384) throw new Error(`Canvas width exceeds supported tile width: ${canvas.width}`)
  if (canvas.height > 65500) format = 'png' // JPEG's dimension limit, without reducing scale or dropping content.
  const tileHeight = 8192, stride = canvas.width * 4
  const pixels = Buffer.allocUnsafe(stride * canvas.height)
  let tiles = 0
  for (let top = 0; top < canvas.height; top += tileHeight) {
    const height = Math.min(tileHeight, canvas.height - top)
    const bleed = 2
    const tile = new Canvas(canvas.width, height + bleed * 2, {gpu: canvas.gpu})
    tile.gpu = canvas.gpu
    const ctx = tile.getContext('2d')
    ctx.drawCanvas(canvas, 0, bleed - top)
    const raw = tile.toBufferSync('raw', {colorType: 'rgba', msaa:options.msaa})
    if (raw.length !== stride * (height + bleed * 2)) throw new Error('Canvas tile pixel dimensions do not match the requested surface')
    raw.copy(pixels, top * stride, bleed * stride, (bleed + height) * stride)
    tiles++
    options.onTile?.({top, height, gpu:tile.gpu, ...tile.engine})
  }
  const encoder = sharp(pixels, { raw: {width: canvas.width, height: canvas.height, channels:4}, limitInputPixels:false })
  const buffer = format === 'png' ? await encoder.png().toBuffer() : await encoder.jpeg({quality: Math.round(quality * 100),chromaSubsampling:'4:4:4'}).toBuffer()
  return {buffer, tiles, format}
}
