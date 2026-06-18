import crypto from "node:crypto"

export function randomString(length, chars = "abcdefghijklmnopqrstuvwxyz0123456789") {
  let result = ""
  for (let index = 0; index < length; index += 1) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

export function getDs2(query = "", body = "", salt = "") {
  const timestamp = Math.floor(Date.now() / 1000)
  const random = Math.floor(100001 + Math.random() * 99999)
  const sign = md5(`salt=${salt}&t=${timestamp}&r=${random}&b=${body}&q=${query}`)
  return `${timestamp},${random},${sign}`
}

export function getDs(salt = "") {
  const timestamp = Math.floor(Date.now() / 1000)
  const random = randomString(6)
  const sign = md5(`salt=${salt}&t=${timestamp}&r=${random}`)
  return `${timestamp},${random},${sign}`
}

export function md5(value) {
  return crypto.createHash("md5").update(String(value)).digest("hex")
}
