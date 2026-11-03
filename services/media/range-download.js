import fs from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { randomUUID } from "node:crypto"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

// A mirror is always restarted from byte zero; ranges from different CDN objects
// never share a destination. No files are published before complete validation.
export async function downloadRanges(urls, target, options = {}) {
  const { fetch: request = globalThis.fetch, headers = {}, timeoutMs = 600000, maxBytes = 0, concurrency = 4, signal } = options
  const timeout = AbortSignal.timeout(timeoutMs), parentSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let lastError
  for (const url of [...new Set([urls].flat().filter(Boolean))]) {
    if (parentSignal.aborted) throw new Error("下载已取消或超时")
    const parsed = new URL(url)
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("下载地址协议无效")
    const temp = `${target}.${randomUUID()}.part`, controller = new AbortController(), transferSignal = AbortSignal.any([parentSignal, controller.signal])
    let handle
    const full = async response => {
      if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}`)
      const expected = Number(response.headers.get("content-length")) || 0
      if (maxBytes && expected > maxBytes) throw new Error("下载文件超出大小限制")
      let received = 0
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) { received += chunk.length; done(maxBytes && received > maxBytes ? new Error("下载文件超出大小限制") : null, chunk) } }), createWriteStream(temp, { flags: "wx" }), { signal: transferSignal })
      if (!received || expected && received !== expected) throw new Error("下载文件不完整")
      return received
    }
    try {
      const base = { "Accept-Encoding": "identity", ...headers }
      const probe = await request(url, { headers: { ...base, Range: "bytes=0-0" }, signal: transferSignal })
      let total
      if (probe.status === 200) total = await full(probe)
      else {
        const range = probe.headers.get("content-range")?.match(/^bytes 0-0\/(\d+)$/)
        await probe.body?.cancel()
        if (probe.status !== 206 || !range) throw new Error(`下载探测失败 HTTP ${probe.status}`)
        total = Number(range[1])
        if (!Number.isSafeInteger(total) || total <= 0 || maxBytes && total > maxBytes) throw new Error("下载文件体积无效或超出限制")
        const count = Math.max(1, Math.min(16, Math.floor(concurrency), Math.ceil(total / (2 * 1024 * 1024))))
        if (count === 1) total = await full(await request(url, { headers: base, signal: transferSignal }))
        else {
          handle = await fs.open(temp, "wx"); await handle.truncate(total)
          const etag = probe.headers.get("etag"), modified = probe.headers.get("last-modified"), validator = etag && !etag.startsWith("W/") ? etag : modified
          const workers = Array.from({ length: count }, async (_, index) => {
            const start = Math.floor(total * index / count), end = Math.floor(total * (index + 1) / count) - 1
            let last
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const response = await request(url, { headers: { ...base, Range: `bytes=${start}-${end}`, ...(validator ? { "If-Range": validator } : {}) }, signal: transferSignal })
                const expected = `bytes ${start}-${end}/${total}`
                if (response.status !== 206 || response.headers.get("content-range") !== expected) { await response.body?.cancel(); throw new Error("分段响应范围不一致") }
                if (etag && response.headers.get("etag") && response.headers.get("etag") !== etag) { await response.body?.cancel(); throw new Error("下载期间源文件发生变化") }
                let offset = start
                for await (const chunk of Readable.fromWeb(response.body)) {
                  if (offset + chunk.length > end + 1) throw new Error("下载分段超出范围")
                  let written = 0
                  while (written < chunk.length) { const result = await handle.write(chunk, written, chunk.length - written, offset + written); if (!result.bytesWritten) throw new Error("写入分段失败"); written += result.bytesWritten }
                  offset += chunk.length
                }
                if (offset !== end + 1) throw new Error("下载分段不完整")
                return
              } catch (error) { last = error; if (transferSignal.aborted) break }
            }
            throw last
          })
          const results = await Promise.allSettled(workers.map(p => p.catch(error => { controller.abort(); throw error })))
          const failed = results.find(r => r.status === "rejected")
          if (failed) throw failed.reason
          await handle.sync(); await handle.close(); handle = null
        }
      }
      await fs.rename(temp, target)
      return { file: target, sizeBytes: total }
    } catch (error) { controller.abort(); lastError = error }
    finally { if (handle) await handle.close(); await fs.rm(temp, { force: true }) }
  }
  throw lastError || new Error("没有可用下载地址")
}
