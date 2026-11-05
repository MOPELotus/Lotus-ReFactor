import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { rootPath, resolveData } from '../../core/path.js'
import { loadGlobalConfig } from '../../core/config/global.js'
import { collectMasterIds } from '../../core/transport/masters.js'
import { notifyUser } from '../../core/transport/notify.js'
import { detectGtCapabilities, LEGACY_GT_NOTICE } from './capabilities.js'

const key = Symbol.for('Lotus-Plugin.gtManual')
const state = globalThis[key] ||= { pending: null, current: null, maintenance: false }

export async function ensureInternalGt({ config, web, bot = globalThis.Bot, backendRoot = path.join(rootPath, 'gt-manual'), secretFile = resolveData('gtmanual', 'register-key'), fetch: fetchImpl = globalThis.fetch } = {}) {
  if (state.pending) return state.pending
  state.pending = start().finally(() => { state.pending = null })
  return state.pending
  async function start() {
    const global = config || await loadGlobalConfig()
    web ||= globalThis[Symbol.for('Lotus-Plugin.coinShop')]?.web
    if (!web) throw new Error('荷花网页服务尚未就绪')
    await web.start(global.coin_shop, bot)
    const basePath = '/lotus/gt'
    const publicUrl = new URL(basePath + '/', web.status().url)
    const identity = `${backendRoot}:${publicUrl.href}:${global.coin_shop?.icp_number || ''}`
    if (state.current?.identity === identity && web.routes.get(basePath) === state.current.handler) return state.current.connection
    stopInternalGt()
    const [{ createVerificationHandler }, { normalizeConfig }] = await Promise.all([
      import(pathToFileURL(path.join(backendRoot, 'lib/server.js')).href),
      import(pathToFileURL(path.join(backendRoot, 'lib/config.js')).href),
    ])
    await fs.mkdir(path.dirname(secretFile), { recursive: true })
    try { await fs.writeFile(secretFile, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    const registerKey = (await fs.readFile(secretFile, 'utf8')).trim()
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(registerKey)) throw new Error('内置 GT 注册密钥损坏，请检查私有数据文件')
    const handler = createVerificationHandler({ config: normalizeConfig({ BASE_PATH: basePath, PUBLIC_ADDRESS: publicUrl.origin, REGISTER_KEY: registerKey, ICP_NUMBER: global.coin_shop?.icp_number || '' }) })
    const unmount = web.mountRoute(basePath, handler)
    const address = (web.server || bot?.server)?.address?.()
    const port = address?.port
    if (!port) { unmount(); handler.close(); throw new Error('无法确定荷花网页监听端口') }
    const host = address.address === '::' ? '::1' : address.address === '0.0.0.0' ? '127.0.0.1' : address.address
    const local = new URL(basePath + '/', `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`)
    const connection = {
      address: new URL('GTest/register', local).href + '?key=' + encodeURIComponent(registerKey),
      // Result links are public; polling stays on the owned loopback listener.
      fetch: (url, options) => {
        const target = new URL(url)
        if (target.origin === publicUrl.origin && target.pathname.startsWith(basePath + '/')) {
          target.protocol = local.protocol; target.host = local.host
        }
        return fetchImpl(target.href, { ...options, redirect: 'error' })
      },
    }
    state.current = { identity, handler, unmount, connection }
    return connection
  }
}

export function stopInternalGt() {
  state.current?.unmount?.()
  state.current?.handler?.close?.()
  state.current = null
}

export function startGtMaintenance({ getConfig = loadGlobalConfig, ensure = ensureInternalGt, notify = notifyGtStartup, detect = detectGtCapabilities, delayMs = 60000 } = {}) {
  if (state.maintenance) return
  state.maintenance = true
  const timer = setTimeout(async () => {
    let message
    try {
      const config = await getConfig(), gt = config.captcha?.gtmanual || {}
      if (gt.enable === false) return
      if (gt.internal_enable !== false) { await ensure({ config }); return }
      const result = await detect(gt.verify_addr)
      if (result.kind === 'legacy') {
        globalThis.logger?.warn?.(LEGACY_GT_NOTICE)
        message = LEGACY_GT_NOTICE
      }
    } catch {
      globalThis.logger?.warn?.('[Lotus-Plugin] 内置人工验证服务准备失败，请检查子模块和网页服务状态')
      message = '[荷花插件]人工验证服务启动检查失败，请检查子模块同步及网页服务配置。'
    }
    if (message) await notify(message).catch(() => {
      globalThis.logger?.warn?.('[Lotus-Plugin] 人工验证服务启动通知未送达')
    })
  }, delayMs)
  timer.unref?.()
}

export async function notifyGtStartup(message, { collectMasters = collectMasterIds, notify = notifyUser,
  wait = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }), maxAttempts = 10, delayMs = 30000 } = {}) {
  const sent = new Set()
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt) await wait(delayMs)
    try {
      const ids = await collectMasters()
      for (const id of ids) {
        if (sent.has(String(id))) continue
        const result = await notify(id, message, { onlyKnownFriend: false, allowGroupFallback: false, at: false })
        if (result?.ok) sent.add(String(id))
      }
      if (ids.length && ids.every(id => sent.has(String(id)))) return { ok: true }
    } catch { /* Retry after adapters connect, without repeating delivered messages. */ }
  }
  globalThis.logger?.warn?.('[Lotus-Plugin] 人工验证服务启动通知未全部送达')
  return { ok: false }
}
