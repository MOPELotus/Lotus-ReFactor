import crypto from "node:crypto"

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function verifyTotp(token, secret, options = {}) {
  const window = Number(options.window ?? 1)
  const now = Number(options.now ?? Date.now())
  const normalized = String(token || "").replace(/\s+/g, "")
  if (!/^\d{6}$/.test(normalized)) return false

  for (let offset = -window; offset <= window; offset += 1) {
    if (generateTotp(secret, {
      ...options,
      now: now + offset * 30000,
    }) === normalized) return true
  }
  return false
}

export function generateTotp(secret, options = {}) {
  const digits = Number(options.digits ?? 6)
  const step = Number(options.step ?? 30)
  const now = Number(options.now ?? Date.now())
  const counter = Math.floor(now / 1000 / step)
  const key = decodeBase32(secret)
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buffer.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac("sha1", key).update(buffer).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % (10 ** digits)
  return String(code).padStart(digits, "0")
}

export function generateBase32Secret(bytes = 20) {
  const buffer = crypto.randomBytes(Math.max(10, Number(bytes || 20)))
  let bits = ""
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0")
  let secret = ""
  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, "0")
    secret += BASE32_ALPHABET[Number.parseInt(chunk, 2)]
  }
  return secret
}

export function buildTotpUri({ secret, issuer = "荷花插件", account = "remote", digits = 6, period = 30 } = {}) {
  const safeIssuer = String(issuer || "荷花插件")
  const safeAccount = String(account || "remote")
  const label = `${safeIssuer}:${safeAccount}`
  const query = new URLSearchParams({
    secret: String(secret || ""),
    issuer: safeIssuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(period),
  })
  return `otpauth://totp/${encodeURIComponent(label)}?${query}`
}

export function decodeBase32(secret = "") {
  const clean = String(secret).replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase()
  let bits = ""
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char)
    if (value < 0) throw new Error("invalid base32 secret")
    bits += value.toString(2).padStart(5, "0")
  }
  const bytes = []
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2))
  }
  return Buffer.from(bytes)
}
