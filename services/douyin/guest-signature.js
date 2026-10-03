import { createHash } from "node:crypto"
import { WEB_UA } from "./signature.js"

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-."
const WEB_SIGN_SALT = "A96D855A08C0A9707F8BEF0D9A527E4E"

// Wire rules measured against the platform's acrawler and project 34 SDK.
// The desktop profile is independent of the machine running this HTTP client.
const NONCE_PROFILE = { fingerprint: 4170767054, flags: 788768 }
const hashText = (text, seed = 0, xor = true) => {
  let value = seed
  for (let i = 0; i < text.length; i++) {
    value = (xor ? Math.imul(value ^ text.charCodeAt(i), 65599) : Math.imul(value, 65599) + text.charCodeAt(i)) >>> 0
  }
  return value
}

/** Page challenge signature, computed locally without running downloaded scripts. */
export function generateNonceSignature(nonce, { url = "https://www.douyin.com/", userAgent = WEB_UA, now = Date.now(), profile = NONCE_PROFILE } = {}) {
  if (!/^[a-f0-9]{21}$/i.test(nonce) || !Number.isSafeInteger(now) || now <= 0) throw new Error("抖音页面签名参数无效")
  const location = new URL(url)
  const seconds = Math.floor(now / 1000)
  const route = hashText(`${seconds}${location.host}${location.pathname}`) % 65521
  const clock = (seconds ^ route * 65521) >>> 0
  const seed = hashText(String(8240 * 2 ** 32 + clock))
  const binding = ((hashText(userAgent, seed) % 65521) * 65536 + hashText(nonce, seed) % 65521) >>> 0
  const fields = [
    [clock >>> 2, 30], [(clock & 3) * 2 ** 28 + (8240 >>> 4), 30],
    [(profile.fingerprint ^ clock) >>> 0, 36], [binding >>> 2, 30],
    [(binding & 3) * 2 ** 28 + ((profile.flags ^ clock) >>> 4), 30], [route, 30],
  ]
  let output = "_02B4Z6wo00f01"
  for (const [value, width] of fields) {
    const bits = BigInt(value)
    for (let shift = width - 6; shift >= 0; shift -= 6) output += NONCE_ALPHABET[Number(bits >> BigInt(shift) & 63n)]
  }
  return output + (hashText(output, 0, false) & 255).toString(16).padStart(2, "0")
}

/** The second signing layer covers the exact serialized query, including a_bogus. */
export function signVisitorUrl(input, uifid, { now = Date.now() } = {}) {
  if (typeof uifid !== "string" || !uifid || /[;\r\n]/.test(uifid) || !Number.isSafeInteger(now) || now <= 0) throw new Error("抖音游客签名参数无效")
  const url = new URL(input)
  const stamp = String(Math.floor(now / 1000))
  url.searchParams.delete("x-secsdk-web-signature")
  url.searchParams.set("uifid", uifid)
  url.searchParams.set("timestamp", stamp)
  const signature = createHash("md5").update(`${uifid}_${stamp}_${WEB_SIGN_SALT}_${url.searchParams.toString()}`).digest("hex")
  url.searchParams.set("x-secsdk-web-signature", signature)
  return { url: url.href, headers: { uifid, "x-secsdk-web-signature": signature, "x-secsdk-web-expire": stamp } }
}
