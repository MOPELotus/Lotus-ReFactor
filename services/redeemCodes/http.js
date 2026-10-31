import https from "node:https"

const OFFICIAL_HOSTS = new Set(["bbs-api.mihoyo.com", "bbs-api.miyoushe.com", "api-takumi.mihoyo.com"])

// Native HTTPS does not use Node's environment proxy dispatcher. Keep this
// fallback scoped to our public official endpoints; never change global routing.
export function requestOfficialJson(url, { headers = {}, timeoutMs = 10000 } = {}) {
  const target = new URL(url)
  if (target.protocol !== "https:" || !OFFICIAL_HOSTS.has(target.hostname) || target.username || target.password || target.port) {
    return Promise.reject(new Error("不支持的官方接口地址"))
  }
  return new Promise((resolve, reject) => {
    const request = https.get(target, { headers: { ...headers, "accept-encoding": "identity" }, signal: AbortSignal.timeout(timeoutMs) }, response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`官方接口 HTTP ${response.statusCode}`))
        return
      }
      const chunks = []
      let bytes = 0
      response.on("data", chunk => {
        bytes += chunk.length
        if (bytes > 4 * 1024 * 1024) response.destroy(new Error("官方接口响应过大"))
        else chunks.push(chunk)
      })
      response.on("error", reject)
      response.on("aborted", () => reject(new Error("官方接口响应中断")))
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))) }
        catch (error) { reject(error) }
      })
    })
    request.on("error", reject)
  })
}
