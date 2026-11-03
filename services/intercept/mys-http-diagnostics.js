import { AsyncLocalStorage } from "node:async_hooks"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { subscribe } from "node:diagnostics_channel"

const STATE = Symbol.for("lotus-plugin.mys-http-diagnostics")
const PATCHED = Symbol.for("lotus-plugin.mys-http-diagnostics.getData")
const REQUEST_IDS = ["x-request-id", "x-trace-id", "x-rpc-request_id", "cf-ray"]
const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE",
])

// These are literal route shapes in genshin's ApiTool. Unknown paths are hidden,
// rather than risking an account ID or ticket embedded in a future route.
const SAFE_PATHS = [
  /^\/device-fp\/api\/getFp$/,
  /^\/binding\/api\/getUserGameRolesByCookie$/,
  /^\/game_record\/app\/genshin\/api\/(?:index|spiralAbyss|role_combat|hard_challenge(?:\/popularity)?|character\/(?:list|detail)|dailyNote|gcg\/(?:basicInfo|deckList|cardList))$/,
  /^\/game_record\/app\/hkrpg\/api\/(?:index|role\/basicInfo|challenge|avatar\/(?:info|basic)|note)$/,
  /^\/event\/game_record_zzz\/api\/zzz\/(?:index|avatar\/basic|note|buddy\/info)$/,
  /^\/event\/e20200928calculate\/(?:v1\/(?:sync\/avatar\/detail|avatarSkill\/list|(?:avatar|weapon|reliquary|furniture)\/list|furniture\/(?:compute|blueprint))|v3\/batch_compute)$/,
  /^\/event\/(?:rpgcalc\/(?:compute|avatar\/detail)|srledger\/month_info|ys_ledger\/monthInfo)$/,
  /^\/common\/apicdkey\/api\/webExchangeCdkeyHyl$/,
]

export function installMysHttpDiagnostics(MysApi, { onDiagnostic = logDiagnostic } = {}) {
  const prototype = MysApi?.prototype
  if (typeof prototype?.getData !== "function") return { ok: true, skipped: true }
  if (Object.hasOwn(prototype, PATCHED)) return { ok: true, already: true }
  const state = getState()
  const original = prototype.getData
  function getData(...args) {
    const parent = state.context.getStore()
    // Salt never leaves this process, so small numeric UID spaces cannot be
    // enumerated from logs. No credentials or device values enter the record.
    const subject = createHmac("sha256", state.salt)
      .update(JSON.stringify([String(this?.uid || ""), String(this?.game || "")]))
      .digest("hex").slice(0, 16)
    const context = {
      trace: parent?.trace || randomUUID(),
      span: randomUUID(),
      subject,
      report: onDiagnostic,
    }
    return state.context.run(context, () => Reflect.apply(original, this, args))
  }
  Object.defineProperty(getData, PATCHED, { value: true })
  prototype.getData = getData
  Object.defineProperty(prototype, PATCHED, { value: true })
  return { ok: true }
}

function getState() {
  if (globalThis[STATE]) return globalThis[STATE]
  const state = { context: new AsyncLocalStorage(), requests: new WeakMap(), salt: randomBytes(32) }
  globalThis[STATE] = state
  const safely = callback => message => {
    // diagnostics_channel subscribers must never throw into the HTTP client.
    try { callback(message) } catch {}
  }
  const capture = (request, origin, path) => {
    if (!request || state.requests.has(request)) return
    const context = state.context.getStore()
    if (!context) return
    const url = new URL(path, origin)
    if (!/(?:^|\.)(?:mihoyo\.com|hoyolab\.com|hoyoverse\.com)$/.test(url.hostname)) return
    state.requests.set(request, {
      context,
      started: performance.now(),
      host: url.hostname,
      path: SAFE_PATHS.some(pattern => pattern.test(url.pathname)) ? url.pathname : "/[unrecognized]",
      reported: false,
    })
  }
  const finish = (request, status, headers) => {
    const entry = state.requests.get(request)
    if (!entry || entry.reported || (status >= 200 && status < 300)) return
    entry.reported = true
    const contentType = headers["content-type"]?.split(";")[0]?.trim().toLowerCase()
    emit(entry, {
      status: Number.isInteger(status) ? status : null,
      contentType: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType || "") ? contentType : null,
      requestIds: Object.fromEntries(REQUEST_IDS.flatMap(key => {
        const value = headers[key]
        return typeof value === "string" && /^[A-Za-z0-9:_.-]{1,100}$/.test(value) ? [[key, value]] : []
      })),
    })
  }
  const fail = (request, error) => {
    const entry = state.requests.get(request)
    if (!entry || entry.reported) return
    entry.reported = true
    emit(entry, { status: null, errorCode: NETWORK_CODES.has(error?.code) ? error.code : "NETWORK_ERROR" })
  }
  // Some Yunzai installations shim node-fetch to global.fetch (Undici), while
  // others use node-fetch's native HTTP transport. Neither transport is patched.
  subscribe("undici:request:create", safely(({ request }) => capture(request, request.origin, request.path)))
  subscribe("undici:request:headers", safely(({ request, response }) => {
    const headers = {}
    for (let i = 0; i < response.headers.length; i += 2) {
      const key = String(response.headers[i]).toLowerCase()
      if (key === "content-type" || REQUEST_IDS.includes(key)) headers[key] = String(response.headers[i + 1])
    }
    finish(request, response.statusCode, headers)
  }))
  subscribe("undici:request:error", safely(({ request, error }) => fail(request, error)))
  const captureHttp = safely(({ request }) => {
    capture(request, `${request.protocol || "https:"}//${request.getHeader("host")}`, request.path)
  })
  subscribe("http.client.request.created", captureHttp)
  subscribe("http.client.request.start", captureHttp)
  subscribe("http.client.response.finish", safely(({ request, response }) => finish(request, response.statusCode, response.headers)))
  subscribe("http.client.request.error", safely(({ request, error }) => fail(request, error)))
  return state
}

function emit(entry, details) {
  try {
    const pending = entry.context.report({
      host: entry.host,
      path: entry.path,
      elapsedMs: Math.max(0, Math.round(performance.now() - entry.started)),
      context: entry.context.trace,
      span: entry.context.span,
      subject: entry.context.subject,
      ...details,
    })
    Promise.resolve(pending).catch(() => {})
  } catch {}
}

function logDiagnostic(event) {
  globalThis.logger?.warn?.(`[Lotus-Plugin] mys HTTP ${JSON.stringify(event)}`)
}
