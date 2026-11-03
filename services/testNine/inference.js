import path from "node:path"
import sharp from "sharp"
import * as ort from "onnxruntime-node"
import { resizeRgb } from "./resize.js"

export async function imageTensor(image, size, { normalize = false, crop = null, classifier = false } = {}) {
  // PIL convert("RGB") discards alpha without compositing it onto white.
  let decoded = await sharp(image).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true })
  if (crop) {
    const data = Buffer.alloc(crop.width * crop.height * 3), source = decoded
    // PIL crops truncate box coordinates and pad out-of-image pixels with black.
    const left = Math.max(0, crop.left), right = Math.min(source.info.width, crop.left + crop.width)
    if (right > left) for (let y = Math.max(0, crop.top); y < Math.min(source.info.height, crop.top + crop.height); y++) {
      source.data.copy(data, ((y - crop.top) * crop.width + left - crop.left) * 3, (y * source.info.width + left) * 3, (y * source.info.width + right) * 3)
    }
    decoded = { data, info: { width: crop.width, height: crop.height } }
  }
  // The reference classifier consumes JPEG crops (Pillow's default quality 75).
  // This round trip is significant for the tiny 40px target, not just storage.
  if (classifier) {
    const jpeg = await sharp(decoded.data, { raw: { ...decoded.info, channels: 3 } }).jpeg({ quality: 75, chromaSubsampling: "4:2:0" }).toBuffer()
    decoded = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
  }
  const w = decoded.info.width, h = decoded.info.height
  const width = classifier ? (w < h ? 232 : Math.floor(232 * w / h)) : size
  const height = classifier ? (w < h ? Math.floor(232 * h / w) : 232) : size
  const resized = resizeRgb(decoded.data, w, h, width, height, classifier ? "cubic" : normalize ? "lanczos3" : "linear")
  const outWidth = classifier ? 224 : width, outHeight = classifier ? 224 : height
  const pixels = outWidth * outHeight, values = new Float32Array(pixels * 3)
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]
  for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) for (let c = 0; c < 3; c++) {
    let value = Math.fround(resized[(y * width + x) * 3 + c] / 255)
    if (normalize) value = classifier ? Math.fround(Math.fround(value - mean[c]) / std[c]) : Math.fround(Math.fround(value - Math.fround(mean[c])) / Math.fround(std[c]))
    values[c * pixels + y * outWidth + x] = value
  }
  return new ort.Tensor("float32", values, [1, 3, outHeight, outWidth])
}
const iou = (a, b) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  return w * h / Math.max(1, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - w * h)
}
function nms(rows, threshold) {
  const sorted = [...rows].sort((a, b) => b.score - a.score), kept = []
  while (sorted.length) { const best = sorted.shift(); kept.push(best); for (let i = sorted.length - 1; i >= 0; i--) if (iou(best.box, sorted[i].box) >= threshold) sorted.splice(i, 1) }
  return kept
}
function cosine(a, b) { let dot = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2 } return dot / Math.max(Number.EPSILON, Math.sqrt(aa * bb)) }

export class CaptchaInference {
  constructor(modelDir) { this.modelDir = modelDir; this.sessions = new Map() }
  async session(file) {
    if (!this.sessions.has(file)) this.sessions.set(file, ort.InferenceSession.create(path.join(this.modelDir, file), { executionProviders: ["cpu"], intraOpNumThreads: 2 }).catch(error => { this.sessions.delete(file); throw error }))
    return this.sessions.get(file)
  }
  async close() { const sessions = await Promise.allSettled(this.sessions.values()); this.sessions.clear(); for (const s of sessions) if (s.status === "fulfilled") await s.value.release() }
  async nine(image) {
    const session = await this.session("PP-HGNetV2-B4.onnx"), tensors = []
    for (let i = 0; i < 10; i++) {
      const crop = i === 9 ? { left: 2, top: 344, width: 40, height: 40 } : { left: i % 3 * 116, top: Math.floor(i / 3) * 116, width: 112, height: 112 }
      tensors.push(await imageTensor(image, 224, { crop, classifier: true, normalize: true }))
    }
    const values = new Float32Array(10 * tensors[0].data.length)
    tensors.forEach((t, i) => values.set(t.data, i * t.data.length))
    const result = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", values, [10, 3, 224, 224]) })
    const tensor = result[session.outputNames[0]], classes = tensor.data.length / 10
    const scores = Array.from({ length: 10 }, (_, i) => Array.from(tensor.data.slice(i * classes, (i + 1) * classes)))
    const argmax = row => row.indexOf(Math.max(...row)), target = argmax(scores[9])
    const matches = scores.slice(0, 9).map((row, index) => ({ row, index })).filter(({ row }) => argmax(row) === target)
    // No matching class means uncertainty: let the retry/provider chain handle it.
    if (!matches.length) throw new Error("九宫格模型未识别到匹配项")
    return matches.map(({ index }) => `${index % 3 + 1}_${Math.floor(index / 3) + 1}`)
  }
  async dfine(image) {
    const session = await this.session("d-fine-n.onnx"), meta = await sharp(image).metadata()
    const result = await session.run({ [session.inputNames[0]]: await imageTensor(image, 320), [session.inputNames[1]]: new ort.Tensor("int64", BigInt64Array.from([BigInt(meta.width), BigInt(meta.height)]), [1, 2]) })
    const labels = result.labels.data, boxes = result.boxes.data, scores = result.scores.data, groups = new Map()
    for (let i = 0; i < scores.length; i++) {
      const box = Array.from(boxes.slice(i * 4, i * 4 + 4)), label = Number(labels[i])
      if (scores[i] <= 0.4 || box[2] > 160 && box[3] < 45) continue
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push({ box, score: Number(scores[i]) })
    }
    const pairs = [...groups.values()].map(g => nms(g, 0.01)).filter(g => g.length >= 2 && g[0].score + g[1].score >= 0.85)
      .sort((a, b) => b[0].score + b[1].score - a[0].score - a[1].score).slice(0, 3).map(p => p.slice(0, 2).sort((a, b) => b.box[3] - a.box[3]))
      .sort((a, b) => a[0].box[0] - b[0].box[0])
    if (!pairs.length) throw new Error("图标模型未识别到匹配项")
    return pairs.map(pair => { const b = pair[1].box; return [Math.round((b[0] + b[2]) / 2 / 333 * 10000), Math.round((b[1] + b[3]) / 2 / 333 * 10000)].join("_") })
  }
  async dino(image) {
    const detector = await this.session("yolo11n.onnx"), meta = await sharp(image).metadata()
    const detected = await detector.run({ [detector.inputNames[0]]: await imageTensor(image, 384) })
    const output = detected[detector.outputNames[0]], dimensions = output.dims, count = dimensions[2], channels = dimensions[1], rows = []
    for (let i = 0; i < count; i++) {
      const at = c => Number(output.data[c * count + i])
      let cls = 0, score = at(4)
      for (let c = 5; c < channels; c++) if (at(c) > score) { cls = c - 4; score = at(c) }
      if (score <= 0.5) continue
      const box = [(at(0) - at(2) / 2) / 384 * meta.width, (at(1) - at(3) / 2) / 384 * meta.height, (at(0) + at(2) / 2) / 384 * meta.width, (at(1) + at(3) / 2) / 384 * meta.height]
      rows.push({ box, score, cls })
    }
    const dino = await this.session("dinov3-small.onnx"), classify = await this.session("atten.onnx"), features = { top: [], bottom: [] }
    for (const row of nms(rows, 0.55)) {
      const box = row.box.map(Math.trunc), [left, top, right, bottom] = box
      const width = right - left, height = bottom - top
      if (width <= 0 || height <= 0) continue
      const input = await imageTensor(image, 224, { normalize: true, crop: { left, top, width, height } })
      const tokens = (await dino.run({ [dino.inputNames[0]]: input }))[dino.outputNames[0]]
      const patch = new ort.Tensor("float32", tokens.data.slice(5 * tokens.dims[2]), [1, tokens.dims[1] - 5, tokens.dims[2]])
      const feature = (await classify.run({ [classify.inputNames[0]]: patch }))[classify.outputNames[0]].data
      features[row.cls === 0 ? "top" : "bottom"].push({ ...row, box, feature })
    }
    if (!features.bottom.length || features.top.length < features.bottom.length) throw new Error("图标检测不完整")
    const used = new Set(), points = []
    for (const target of features.bottom.sort((a, b) => a.box[0] - b.box[0])) {
      const candidates = features.top.map((row, index) => ({ ...row, index, similarity: cosine(target.feature, row.feature) })).filter(row => !used.has(row.index)).sort((a, b) => b.similarity - a.similarity)
      const best = candidates[0]; used.add(best.index)
      points.push([Math.round((best.box[0] + best.box[2]) / 2 / 333 * 10000), Math.round((best.box[1] + best.box[3]) / 2 / 333 * 10000)].join("_"))
    }
    return points
  }
  async solve(image, type) {
    if (type === "nine") return this.nine(image)
    if (type === "icon1") return this.dfine(image)
    if (type === "icon") return this.dino(image)
    throw new Error(`不支持的验证码图片类型：${type}`)
  }
}
