import { Canvas } from 'skia-canvas'
import sharp from 'sharp'

// Replay the recorded Skia canvas into GPU surfaces below Vulkan's texture
// limit, then concatenate their already rendered pixels. Sharp only encodes
// those pixels: it never paints text, shapes or source images.
export async function encodeGpuCanvas(canvas, options = {}) {
  const engine = canvas.engine
  if (!canvas.gpu || engine.renderer !== 'GPU' || /llvmpipe|lavapipe|SwiftShader/i.test(`${engine.device} ${engine.driver}`)) {
    throw new Error('Card rendering requires a physical GPU and its hardware driver')
  }
  let format = options.imgType === 'png' ? 'png' : 'jpeg'
  const quality = Number(options.quality || 98) / 100
  if (canvas.height <= 16384) return { buffer: canvas.toBufferSync(format, {quality, msaa:options.msaa}), tiles: 1, format }
  if (canvas.width > 16384) throw new Error(`GPU canvas width exceeds supported tile width: ${canvas.width}`)
  if (canvas.height > 65500) format = 'png' // JPEG's dimension limit, without reducing scale or dropping content.
  const tileHeight = 8192, stride = canvas.width * 4
  const pixels = Buffer.allocUnsafe(stride * canvas.height)
  let tiles = 0
  for (let top = 0; top < canvas.height; top += tileHeight) {
    const height = Math.min(tileHeight, canvas.height - top)
    const bleed = 2
    const tile = new Canvas(canvas.width, height + bleed * 2)
    const ctx = tile.getContext('2d')
    ctx.drawCanvas(canvas, 0, bleed - top)
    const raw = tile.toBufferSync('raw', {colorType: 'rgba', msaa:options.msaa})
    if (raw.length !== stride * (height + bleed * 2)) throw new Error('GPU tile pixel dimensions do not match the requested surface')
    raw.copy(pixels, top * stride, bleed * stride, (bleed + height) * stride)
    tiles++
    options.onTile?.({top, height, gpu:tile.gpu, ...tile.engine})
  }
  const encoder = sharp(pixels, { raw: {width: canvas.width, height: canvas.height, channels:4}, limitInputPixels:false })
  const buffer = format === 'png' ? await encoder.png().toBuffer() : await encoder.jpeg({quality: Math.round(quality * 100),chromaSubsampling:'4:4:4'}).toBuffer()
  return {buffer, tiles, format}
}
