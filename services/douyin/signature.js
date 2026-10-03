import { createHash, randomInt } from "node:crypto"

// Platform wire constants (bdms 1.0.1.19). This module is independently implemented.
// Protocol research: Evil0ctal/Douyin_TikTok_Download_API, Black-Cyan/napcat-plugin-douyin.
export const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
export const BROWSER_INFO = "1920|947|1920|1032|1920|1032|1920|1080|Win32"
export const SIGNING_ALPHABET = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe"
const UA_ALPHABET = "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe"
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const SLOT_ORDER = [34, 44, 56, 61, 73, 29, 70, 45, 35, 49, 38, 66, 51, 68, 28, 48, 64, 47, 30, 71,
  26, 55, 31, 69, 59, 40, 62, 63, 27, 72, 41, 74, 57, 52, 42, 39, 33, 67, 53, 43, 65, 46, 36, 24, 60, 32, 79, 80, 84, 85]
const EPOCH = 1721836800000
const NOISE_MASKS = [0x91, 0x42, 0x2c]

function platformBytes(text) {
  const bytes = []
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit > 255) bytes.push(unit >>> 8)
    bytes.push(unit & 255)
  }
  return Buffer.from(bytes)
}

function sm3(bytes) {
  return createHash("sm3").update(bytes).digest()
}

function encode(bytes, alphabet) {
  return Buffer.from(bytes).toString("base64").replace(/[A-Za-z0-9+/]/g, char => alphabet[BASE64.indexOf(char)])
}

/** Platform's modified RC4: reversed initial permutation and multiplicative scheduling. */
export function sealPlatformBytes(bytes, key) {
  const permutation = Uint8Array.from({ length: 256 }, (_, index) => 255 - index)
  let cursor = 0
  for (let position = 0; position < 256; position++) {
    cursor = (cursor * (permutation[position] + 1) + key[position % key.length]) & 255
    const saved = permutation[position]
    permutation[position] = permutation[cursor]
    permutation[cursor] = saved
  }
  const result = Buffer.alloc(bytes.length)
  let position = 0
  cursor = 0
  for (let index = 0; index < bytes.length; index++) {
    position = (position + 1) & 255
    cursor = (cursor + permutation[position]) & 255
    const saved = permutation[position]
    permutation[position] = permutation[cursor]
    permutation[cursor] = saved
    result[index] = bytes[index] ^ permutation[(permutation[position] + permutation[cursor]) & 255]
  }
  return result
}

/** Returns an unescaped signature. Only the HTTP query builder URL-encodes it. */
export function generateABogus(query, { userAgent = WEB_UA, browserInfo = BROWSER_INFO, body = "", now = Date.now(), random = () => randomInt(0x1000000) / 0x1000000 } = {}) {
  if (!Number.isSafeInteger(now) || now < EPOCH) throw new Error("抖音签名时间必须为有效毫秒时间戳")
  const slots = Buffer.alloc(86)
  const write = (offset, value, width) => slots.writeUIntLE(value, offset, width)
  slots[24] = 41
  slots[26] = Math.floor((now - EPOCH) / 1209600000) & 255
  slots[27] = 6
  slots[28] = 3
  write(29, now, 6)
  slots[35] = 1
  slots[38] = 0x21
  write(44, 14, 4)
  write(60, now - 1, 6)
  slots[66] = 3
  write(67, 6241, 4)
  write(71, 6383, 4)
  const geometry = platformBytes(browserInfo)
  const tail = Buffer.from(`${(now + 3) & 255},`)
  write(79, geometry.length, 2)
  write(84, tail.length, 2)
  const bindings = [
    [sm3(sm3(platformBytes(`${query}dhzx`))), [48, 49, 51], [9, 18], [3, 11, 12]],
    [sm3(sm3(platformBytes(`${body}dhzx`))), [52, 53, 55], [10, 19], [4, 8, 9]],
    [sm3(Buffer.from(encode(sealPlatformBytes(Buffer.from(userAgent.trim(), "latin1"), [0, 1, 14]), UA_ALPHABET))), [56, 57, 59], [11, 21], [5, 12, 13]],
  ]
  for (const [digest, offsets, indices, [start, sentinel, fallback]] of bindings) {
    slots[offsets[0]] = digest[indices[0]]
    slots[offsets[1]] = digest[indices[1]]
    slots[offsets[2]] = digest.subarray(start).find(byte => byte !== sentinel) ?? fallback
  }
  const carrier = (left, right, low, high) => {
    const noise = Math.floor(random() * 65535)
    const a = low ?? (noise & 255)
    const b = high ?? (noise >>> 8)
    return Buffer.from([a & 0xaa | left & 0x55, a & 0x55 | left & 0xaa, b & 0xaa | right & 0x55, b & 0x55 | right & 0xaa])
  }
  const probe = Math.floor(random() * 240)
  const version = Buffer.concat([carrier(1, 0), carrier(1, 0, probe > 109 ? probe + probe % 2 + 1 : probe, Math.floor(random() * 255) & 0x4d | 0xb2)])
  const fields = Buffer.from(SLOT_ORDER.map(offset => slots[offset]))
  const check = [...version, ...fields].reduce((sum, byte) => sum ^ byte, 0)
  const payload = Buffer.concat([fields, geometry, tail, Buffer.from([check])])
  const expanded = []
  for (let offset = 0; offset < payload.length; offset += 3) {
    const group = payload.subarray(offset, offset + 3)
    if (group.length < 3) { expanded.push(...group); continue }
    const noise = Math.floor(random() * 1000) & 255
    let saved = 0
    for (let index = 0; index < 3; index++) {
      expanded.push(noise & NOISE_MASKS[index] | group[index] & (255 ^ NOISE_MASKS[index]))
      saved |= group[index] & NOISE_MASKS[index]
    }
    expanded.push(saved)
  }
  const ua = userAgent.toLowerCase()
  const band = ua.includes("edg") ? 125 : ua.includes("huawei") ? 170 : ua.includes("firefox") ? 40 : ua.includes("chrome") ? 0 : ua.includes("safari") ? 81 : 210
  const header = carrier(3, 82, undefined, band + Math.floor(random() * 40))
  return encode(Buffer.concat([header, sealPlatformBytes(Buffer.concat([version, Buffer.from(expanded)]), [0xd3])]), SIGNING_ALPHABET)
}
