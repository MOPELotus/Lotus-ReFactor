// Match Pillow's RGB resampling: antialias on reduction, 22-bit coefficients,
// and an 8-bit intermediate between the horizontal and vertical passes.
// Reference: Pillow src/libImaging/Resample.c; license in resources/captcha.
const precision = 2 ** 22
const sinc = x => x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
function coefficients(input, output, kernel) {
  const scale = input / output, filterScale = Math.max(1, scale)
  const radius = { linear: 1, cubic: 2, lanczos3: 3 }[kernel]
  if (!radius) throw new Error(`不支持的重采样方式：${kernel}`)
  const filter = value => {
    const x = Math.abs(value)
    if (kernel === 'linear') return x < 1 ? 1 - x : 0
    if (kernel === 'cubic') return x < 1 ? (1.5 * x - 2.5) * x * x + 1 : x < 2 ? ((x - 5) * x + 8) * x * -0.5 + 2 : 0
    return x < 3 ? sinc(value) * sinc(value / 3) : 0
  }
  return Array.from({ length: output }, (_, i) => {
    const center = (i + 0.5) * scale, support = radius * filterScale
    const start = Math.max(0, Math.trunc(center - support + 0.5)), end = Math.min(input, Math.trunc(center + support + 0.5))
    const weights = Array.from({ length: end - start }, (_, j) => filter((j + start - center + 0.5) / filterScale))
    const total = weights.reduce((a, b) => a + b, 0)
    return { start, weights: weights.map(w => { const n = total ? w / total : w; return Math.trunc(n * precision + (n < 0 ? -0.5 : 0.5)) }) }
  })
}
export function resizeRgb(data, width, height, outWidth, outHeight, kernel) {
  const clip = sum => Math.max(0, Math.min(255, Math.floor(sum / precision)))
  let intermediate = data
  if (width !== outWidth) {
    const rows = coefficients(width, outWidth, kernel)
    intermediate = Buffer.alloc(outWidth * height * 3)
    for (let y = 0; y < height; y++) for (let x = 0; x < outWidth; x++) for (let c = 0; c < 3; c++) {
      const { start, weights } = rows[x]; let sum = precision / 2
      for (let j = 0; j < weights.length; j++) sum += data[(y * width + start + j) * 3 + c] * weights[j]
      intermediate[(y * outWidth + x) * 3 + c] = clip(sum)
    }
  }
  if (height === outHeight) return intermediate
  const columns = coefficients(height, outHeight, kernel), result = Buffer.alloc(outWidth * outHeight * 3)
  for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) for (let c = 0; c < 3; c++) {
    const { start, weights } = columns[y]; let sum = precision / 2
    for (let j = 0; j < weights.length; j++) sum += intermediate[((start + j) * outWidth + x) * 3 + c] * weights[j]
    result[(y * outWidth + x) * 3 + c] = clip(sum)
  }
  return result
}
