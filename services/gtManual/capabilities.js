const cache = new Map()
export const LEGACY_GT_NOTICE = "[荷花插件]当前外部人工验证服务为旧版，仅支持部分极验 v3。建议启用荷花内置人工验证服务，或将外部服务更新为 Lotus GT-Manual。"

// Probe read-only resources only: never create or consume a challenge to identify
// a server. A timeout, HTML error page, or unknown deployment is not legacy.
export async function detectGtCapabilities(address, { fetch: fetchImpl = globalThis.fetch, signal, refresh = false } = {}) {
  let base
  try {
    const url = new URL(address)
    if (!['http:', 'https:'].includes(url.protocol) || !url.pathname.endsWith('/GTest/register')) return { kind: 'unknown' }
    base = new URL(url.href); base.pathname = url.pathname.slice(0, -'/GTest/register'.length) + '/'; base.search = ''; base.hash = ''
  } catch { return { kind: 'unknown' } }
  const key = base.href
  const previous = cache.get(key)
  if (!refresh && previous && Date.now() - previous.at < 60000) return previous.result
  const get = async route => {
    const response = await fetchImpl(new URL(route, base).href, { method: 'GET', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500), redirect: 'error' })
    if (!response.ok) return ''
    const reader = response.body?.getReader()
    if (!reader) return (await response.text()).slice(0, 65536)
    let text = '', size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) return text
        size += value.length
        if (size > 65536) return ''
        text += new TextDecoder().decode(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
  }
  let result = { kind: 'unknown' }
  try {
    const text = await get('healthz')
    let health
    try { health = JSON.parse(text) } catch {}
    if (health?.ok === true && Array.isArray(health.versions)) {
      if (health.versions.includes(4)) result = { kind: 'modern', versions: health.versions }
      else if (health.versions.includes(3)) result = { kind: 'legacy', versions: [3] }
    }
    if (result.kind === 'unknown') {
      const script = await get('GTest/js/script.js')
      if (['initGeetest(', 'new_captcha', 'offline:', 'register/', 'getValidate'].every(token => script.includes(token)) && !script.includes('initGeetest4')) result = { kind: 'legacy', versions: [3] }
    }
  } catch { signal?.throwIfAborted() }
  cache.set(key, { at: Date.now(), result })
  return result
}
