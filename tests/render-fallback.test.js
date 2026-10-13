import test from 'node:test'
import assert from 'node:assert/strict'
import {Canvas} from 'skia-canvas'
import sharp from 'sharp'
import {encodeGpuCanvas} from '../core/render/gpu-buffer.js'

// Explicit CPU regression coverage: no hardware renderer is needed here.
test('CPU cards retain pixels across tall-image tile boundaries', async () => {
  const canvas = new Canvas(24, 17000, {gpu: false})
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 24, 17000)
  for (const y of [8190, 8192, 16384]) {
    ctx.fillStyle = '#abcdef'; ctx.fillRect(0, y, 24, 3)
  }
  const expected = Buffer.alloc(24 * 17000 * 4)
  for (let y = 0; y < 17000; y++) {
    const marked = [8190, 8192, 16384].some(top => y >= top && y < top + 3)
    for (let x = 0; x < 24; x++) expected.set(marked ? [171, 205, 239, 255] : [18, 52, 86, 255], (y * 24 + x) * 4)
  }
  const result = await encodeGpuCanvas(canvas, {imgType: 'png', onTile: e => {
    assert.equal(e.gpu, false); assert.equal(e.renderer, 'CPU')
  }})
  assert.equal(result.tiles, 3)
  const actual = await sharp(result.buffer).ensureAlpha().raw().toBuffer()
  assert.deepEqual(actual, expected)
})

test('failed hardware export retries on CPU and preserves drawing', async () => {
  const real = new Canvas(32, 32, {gpu: false})
  const ctx = real.getContext('2d'); ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 32, 32)
  const expected = real.toBufferSync('png')
  let gpu = true, attempts = 0, reason
  const canvas = {
    width: 32, height: 32,
    get gpu() { return gpu }, set gpu(value) { gpu = value },
    get engine() { return {renderer: gpu ? 'GPU' : 'CPU', device: 'NVIDIA RTX A4000', driver: 'NVIDIA'} },
    toBufferSync(...args) { attempts++; if (gpu) throw new Error('GPU device lost'); return real.toBufferSync(...args) },
  }
  const result = await encodeGpuCanvas(canvas, {imgType: 'png', onFallback: e => { reason = e.reason }})
  assert.equal(attempts, 2); assert.equal(gpu, false); assert.equal(reason, 'GPU device lost')
  assert.deepEqual(result.buffer, expected)
})

test('software GPU is replaced by CPU before export', async () => {
  let gpu = true
  const canvas = {
    width: 1, height: 1,
    get gpu() { return gpu }, set gpu(value) { gpu = value },
    get engine() { return {renderer: gpu ? 'GPU' : 'CPU', device: 'llvmpipe', driver: 'Mesa'} },
    toBufferSync() { assert.equal(gpu, false); return Buffer.from('cpu') },
  }
  const result = await encodeGpuCanvas(canvas)
  assert.equal(result.buffer.toString(), 'cpu')
})
