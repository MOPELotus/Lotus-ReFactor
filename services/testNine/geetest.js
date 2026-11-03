import crypto from "node:crypto"
import fs from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { fullpageProtocol, clickProtocol, geetestAssetUrl, knownGctScript, gctFields } from "./protocol.js"

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDB45NNFhRGWzMFPn9I7k7IexS5
XviJR3E9Je7L/350x5d9AtwdlFH3ndXRwQwprLaptNb7fQoCebZxnhdyVl8Jr2J3
FZGSIa75GJnK4IwNaG10iyCjYDviMYymvCtZcGWSqSGdC/Bcn2UCOiHSMwgHJSrg
Bm1Zzu+l8nSOqAurgQIDAQAB
-----END PUBLIC KEY-----`
const md5 = s => crypto.createHash("md5").update(s).digest("hex")
const bits = (n, width) => Math.abs(n).toString(2).padStart(width, "0")
const clamp = n => Math.max(-32767, Math.min(32767, Math.round(n)))
export function encodeGeetest(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789()", masks = [7274496, 9483264, 19220, 235]
  let result = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = Math.min(3, bytes.length - i), value = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    for (let j = 0; j < remaining + 1; j++) {
      let transformed = 0
      for (let bit = 23; bit >= 0; bit--) if ((masks[j] >> bit) & 1) transformed = transformed * 2 + ((value >> bit) & 1)
      result += alphabet[transformed]
    }
    if (remaining < 3) result += ".".repeat(3 - remaining)
  }
  return result
}
function insertSeed(text, c, s) {
  if (!c?.length || !s) return text
  let result = text
  for (let i = 0; i < s.length; i += 2) {
    const byte = parseInt(s.slice(i, i + 2), 16), pos = (c[0] * byte * byte + c[2] * byte + c[4]) % text.length
    result = result.slice(0, pos) + String.fromCharCode(byte) + result.slice(pos)
  }
  return result
}
export function encodeMousePath(path, c, s) {
  const family = ["mouse", "touch", "pointer", "MSPointer"].find(p => path.find(v => v?.[4])?.[4]?.startsWith(p)) || ""
  const prepared = []; let x = 0, y = 0, time = 0
  for (const p of path.filter(v => !["move", "down", "up"].includes(v[0]) || String(v[4] || "").startsWith(family)).slice(-300)) {
    if (["down", "move", "up", "scroll"].includes(p[0])) { prepared.push([p[0], [p[1] - x, p[2] - y], clamp(time ? p[3] - time : 0)]); x = p[1]; y = p[2]; time = p[3] }
    else if (["blur", "focus", "unload"].includes(p[0])) { prepared.push([p[0], clamp(time ? p[1] - time : 0)]); time = p[1] }
  }
  const codes = { move: 0, down: 1, up: 2, scroll: 3, focus: 4, blur: 5, unload: 6, unknown: 7 }
  const types = prepared.map(p => p[0]); let typeBits = bits(types.length | 32768, 16)
  for (let i = 0; i < types.length;) {
    let repeats = 0
    while (repeats < 16 && i + repeats + 1 < types.length && types[i + repeats + 1] === types[i]) repeats++
    typeBits += repeats ? bits(codes[types[i]] | 8, 4) + bits(repeats - 1, 4) : bits(codes[types[i]], 4)
    i += 1 + repeats
  }
  const encodeNumbers = (values, signed) => {
    const grouped = []
    for (let i = 0; i < values.length;) {
      const v = values[i]; let count = 1
      while (i + count < values.length && values[i + count] === v && Math.abs(v) < 127 && count < 127) count++
      grouped.push(count > 1 ? (v < 0 ? 49152 : 32768) | (count << 7) | Math.abs(v) : v); i += count
    }
    let sizes = "", data = "", signs = ""
    for (const v of grouped) { const n = Math.max(1, Math.ceil(Math.log(Math.abs(v) + 1) / Math.log(16))); sizes += bits(n - 1, 2); data += bits(v, n * 4); if (signed && v !== 0 && v >> 15 !== 1) signs += v < 0 ? "1" : "0" }
    return bits(grouped.length | 32768, 16) + sizes + data + signs
  }
  let encoded = typeBits + encodeNumbers(prepared.map(p => p.length === 2 ? p[1] : p[2]), false) + encodeNumbers(prepared.filter(p => p.length === 3).map(p => p[1][0]), true) + encodeNumbers(prepared.filter(p => p.length === 3).map(p => p[1][1]), true)
  encoded = encoded.padEnd(Math.ceil(encoded.length / 6) * 6, "0")
  const alphabet = "()*,-./0123456789:?@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~"
  let result = ""; for (let i = 0; i < encoded.length; i += 6) result += alphabet[parseInt(encoded.slice(i, i + 6), 2)]
  return insertSeed(result, c, s)
}
export function parseGeetestResponse(text) {
  const trimmed = text.trim(), match = trimmed.match(/^(?:[\w$]+)?\(([\s\S]*)\);?$/)
  return JSON.parse(match ? match[1] : trimmed)
}
const gctCache = new Map()

export class GeetestChallenge {
  constructor({ gt, challenge }, options = {}) {
    if (!/^[\w-]{1,128}$/.test(gt || "") || !/^[\w-]{1,256}$/.test(challenge || "")) throw new Error("无效的极验 challenge")
    this.gt = gt; this.challenge = challenge; this.fetch = options.fetch || globalThis.fetch; this.signal = options.signal
    this.key = crypto.randomBytes(8).toString("hex")
    this.encryptedKey = crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(this.key)).toString("hex")
  }
  encrypt(data, rsa = false) {
    const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(this.key), Buffer.from("0000000000000000"))
    return encodeGeetest(Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()])) + (rsa ? this.encryptedKey : "")
  }
  async get(host, route, params = {}) {
    const url = new URL(route, `https://${host}`)
    url.search = new URLSearchParams({ gt: this.gt, challenge: this.challenge, lang: "zh-cn", pt: "0", client_type: "web", callback: `geetest_${Date.now()}`, ...params })
    const result = await this.fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36" }, signal: this.signal || AbortSignal.timeout(20000) })
    if (!result.ok) throw new Error(`极验接口 HTTP ${result.status}`)
    return parseGeetestResponse(await result.text())
  }
  mergeConfig(data = {}) {
    if (data.challenge !== undefined) {
      if (typeof data.challenge !== "string" || !/^[\w-]{1,256}$/.test(data.challenge)) throw new Error("极验返回无效 challenge")
      this.challenge = data.challenge
    }
    if (data.c !== undefined) {
      if (!Array.isArray(data.c) || data.c.length < 5 || !data.c.every(Number.isFinite)) throw new Error("极验返回无效 c")
      this.c = data.c
    }
    if (data.s !== undefined) {
      if (typeof data.s !== "string" || !/^(?:[a-f\d]{2})+$/i.test(data.s)) throw new Error("极验返回无效 s")
      this.s = data.s
    }
  }
  async loadGct(resource, origin) {
    if (!resource) return {}
    const url = geetestAssetUrl(resource, origin), key = url.href
    if (!knownGctScript(url)) throw new Error("本地尚未支持该极验动态协议，请使用后续过码方案")
    if (!gctCache.has(key)) {
      const pending = (async () => {
        const response = await this.fetch(url, { signal: this.signal || AbortSignal.timeout(20000) })
        if (!response.ok) throw new Error(`极验动态协议 HTTP ${response.status}`)
        if (response.url) geetestAssetUrl(response.url)
        const source = Buffer.from(await response.arrayBuffer())
        if (source.length > 256 * 1024) throw new Error("极验动态协议体积无效")
        return gctFields(url, source)
      })()
      gctCache.set(key, pending)
      pending.catch(() => { if (gctCache.get(key) === pending) gctCache.delete(key) })
    }
    return { ...await gctCache.get(key) }
  }
  result(value) {
    if (value?.data?.result === "success" && typeof value.data.validate === "string" && value.data.validate) {
      return { ...value, data: { ...value.data, validate: value.data.validate.split("|")[0], challenge: this.challenge } }
    }
    return value
  }
  async prepare() {
    const type = await this.get("api.geetest.com", "/gettype.php")
    this.clickProtocol = clickProtocol(type.data?.click)
    this.fullpageProtocol = fullpageProtocol(type.data?.fullpage)
    const features = Array(this.fullpageProtocol.featureCount).fill("-1"), featureText = features.join("!!"), featureHashText = features.join("magic data")
    const initial = await this.get("api.geetest.com", "/get.php", { w: this.encrypt({ gt: this.gt, challenge: this.challenge, offline: false, new_captcha: true, product: "embed", width: "300px", https: true, protocol: "https://", ...type.data, cc: 16, ww: true, i: featureText }, true) })
    this.mergeConfig(initial.data)
    if (!this.c || !this.s) throw new Error("极验初始化缺少 c/s")
    this.mouse = JSON.parse(await fs.readFile(new URL("../../resources/captcha/mousepath.json", import.meta.url), "utf8"))
    await sleep(500, undefined, { signal: this.signal })
    const now = Date.now(), path = [["move", 385, 313, now, "pointermove"], ["move", 388, 317, now + 54, "pointermove"], ["down", 388, 317, now + 422, "pointerdown"], ["focus", now + 423], ["up", 388, 317, now + 468, "pointerup"]]
    const timing = Object.fromEntries("abcdefghijklmnopqrstu".split("").map((k, i) => [k, ["d", "e"].includes(k) ? 0 : now - 1600 + i * 50]))
    const checked = await this.get("api.geetest.com", "/ajax.php", { w: this.encrypt({ lang: "zh-cn", type: "fullpage", tt: encodeMousePath(path, this.c, this.s), light: "DIV_0", s: "c7c3e21112fe4f741921cb3e4ff9f7cb", h: md5(encodeGeetest(Buffer.from(featureHashText))), hh: md5(featureHashText), hi: md5(featureText), vip_order: -1, ct: -1, ep: { v: this.fullpageProtocol.version, te: false, $_BBn: true, ven: "Google Inc. (Intel)", ren: "ANGLE (Intel)", fp: path[0], lp: path.at(-1), em: { ph: 0, cp: 0, ek: "11", wd: 1, nt: 0, si: 0, sc: 0 }, tm: timing, dnf: "dnf", by: 0 }, passtime: 1600, rp: md5(this.gt + this.challenge + "1600"), captcha_token: this.fullpageProtocol.captcha_token, tsfq: this.fullpageProtocol.tsfq }) })
    if (checked.data?.result === "success" && checked.data.validate) return { validate: checked.data.validate.split("|")[0] }
    const picture = await this.get("api.geevisit.com", "/get.php", { is_next: "true", type: "click", https: "true", protocol: "https://", offline: "false", product: "float", api_server: "api.geevisit.com", isPC: "true", autoReset: "true", width: "100%" })
    const data = picture.data
    if (!data?.pic || !data.resource_servers?.[0]) throw new Error("极验未返回验证码图片")
    this.mergeConfig(data)
    this.picture = data.pic; this.timing = timing
    const origin = new URL(`https://${data.resource_servers[0]}`), url = geetestAssetUrl(data.pic, origin)
    this.gct = await this.loadGct(data.gct_path, origin)
    const response = await this.fetch(url, { signal: this.signal || AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`验证码图片 HTTP ${response.status}`)
    const image = Buffer.from(await response.arrayBuffer())
    if (!image.length || image.length > 8 * 1024 * 1024) throw new Error("验证码图片体积无效")
    return { image, type: data.pic.includes("80/2023-12-04T12/icon") ? "icon1" : data.pic_type }
  }
  async verify(points) {
    if (!points.length) throw new Error("没有识别到验证码坐标")
    const payload = { lang: "zh-cn", passtime: 1600, a: points.join(","), pic: this.picture, tt: encodeMousePath(this.mouse, this.c, this.s), ep: { ca: [{ x: 524, y: 209, t: 0, dt: 1819 }, { x: 558, y: 299, t: 0, dt: 428 }, { x: 563, y: 95, t: 0, dt: 952 }, { x: 670, y: 407, t: 3, dt: 892 }], v: this.clickProtocol.version, [this.clickProtocol.touchKey]: false, me: true, tm: this.timing }, ...this.gct, rp: md5(this.gt + this.challenge + "1600") }
    return this.result(await this.get("api.geevisit.com", "/ajax.php", { w: this.encrypt(payload, true) }))
  }
}
