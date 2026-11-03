import http from "node:http"
import { Worker } from "node:worker_threads"
import { randomUUID } from "node:crypto"
import { loadGlobalConfig } from "../../core/config/global.js"
import { formatLocalDateTime } from "../../core/time.js"
import { normalizeTestNineConfig, TestNineEnvService } from "./env.js"

const lifecycleKey = Symbol.for("lotus-plugin.test-nine-server-lifecycle")
const lifecycle = globalThis[lifecycleKey] ||= { running: null, starting: null, generation: 0, closing: Promise.resolve() }
lifecycle.generation ||= 0
lifecycle.closing ||= Promise.resolve()

function cancelled(endpoint) {
  return { ok: false, running: false, cancelled: true, reason: "验证码服务启动已取消", endpoint }
}

export class TestNineServerService {
  constructor(options = {}) { this.config = options.config; this.envService = options.envService }
  async getConfig() { return normalizeTestNineConfig(this.config || (await loadGlobalConfig()).captcha?.test_nine) }
  async start(options = {}) {
    // Capture before getConfig: stop must also invalidate a config lookup that
    // has not yet registered a pending listener.
    const generation = lifecycle.generation
    const config = await this.getConfig()
    if (generation !== lifecycle.generation) return cancelled(config.endpoint)
    if (lifecycle.running) {
      if (lifecycle.running.endpoint !== config.endpoint) throw new Error("验证码服务已使用其他地址运行")
      return { ...this.status(), alreadyRunning: true }
    }
    if (lifecycle.starting) {
      if (lifecycle.starting.endpoint !== config.endpoint) throw new Error("验证码服务正在使用其他地址启动")
      return lifecycle.starting.promise
    }
    const endpoint = new URL(config.endpoint)
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("本地验证码服务仅支持 loopback HTTP 地址；外部服务直接填写 endpoint，无需启动")
    const pending = { endpoint: config.endpoint, generation, state: null, cancelListen: null, promise: null }
    lifecycle.starting = pending
    pending.promise = startServer(this, config, endpoint, options, pending)
    return pending.promise
  }
  stop() {
    lifecycle.generation += 1
    const pending = lifecycle.starting, state = lifecycle.running
    lifecycle.starting = null; lifecycle.running = null
    pending?.cancelListen?.()
    const previousClose = lifecycle.closing
    lifecycle.closing = Promise.all([previousClose, closeState(state), closeState(pending?.state)]).then(() => {})
    return { ok: true, running: false, ...(state || pending ? { stopped: true } : {}) }
  }
  status() {
    const state = lifecycle.running
    return state ? { ok: true, running: true, pid: process.pid, endpoint: state.endpoint, startedAt: state.startedAt, lastOutput: state.lastOutput } : { ok: true, running: false }
  }
}

async function startServer(service, config, endpoint, options, pending) {
  const isCurrent = () => pending.generation === lifecycle.generation && lifecycle.starting === pending
  try {
    const env = await (service.envService || new TestNineEnvService({ config })).ensureEnv(options)
    if (!isCurrent()) return cancelled(config.endpoint)
    if (!env.ok) return env
    // A replacement start waits until the previous owned listener has closed.
    await lifecycle.closing
    if (!isCurrent()) return cancelled(config.endpoint)
    const state = pending.state = { endpoint: config.endpoint, startedAt: formatLocalDateTime(), modelDir: env.models.modelDir, lastOutput: "JS / ONNX 就绪", busy: false, worker: null, cancel: null }
    const server = state.server = http.createServer((req, res) => {
      const send = (code, data) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)) }
      const url = new URL(req.url, "http://localhost")
      if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true, runtime: "onnxruntime-node", busy: state.busy })
      if (req.method !== "GET" || url.pathname !== endpoint.pathname) return send(404, { error: "not_found" })
      if (state.busy) return send(429, { error: "captcha_busy" })
      const gt = url.searchParams.get("gt"), challenge = url.searchParams.get("challenge")
      if (!gt || !challenge || gt.length > 128 || challenge.length > 256) return send(400, { error: "invalid_challenge" })
      state.busy = true
      const controller = new AbortController()
      req.on("aborted", () => controller.abort())
      res.on("close", () => { if (!res.writableEnded) controller.abort() })
      void solveInWorker(state, { gt, challenge }, config.timeout_ms, controller.signal).then(result => send(200, result), () => send(502, { error: "local_captcha_failed" })).finally(() => { state.busy = false })
    })
    const listened = await new Promise((resolve, reject) => {
      pending.cancelListen = () => resolve(false)
      server.once("error", reject)
      server.listen(Number(endpoint.port || 80), endpoint.hostname === "localhost" ? "127.0.0.1" : endpoint.hostname.replace(/[\[\]]/g, ""), () => resolve(true))
    })
    pending.cancelListen = null
    if (!listened || !isCurrent()) {
      await closeState(state)
      return cancelled(config.endpoint)
    }
    server.unref(); lifecycle.running = state
    return service.status()
  } catch (error) {
    await closeState(pending.state)
    if (!isCurrent()) return cancelled(config.endpoint)
    throw error
  } finally {
    if (lifecycle.starting === pending) lifecycle.starting = null
  }
}

function closeState(state) {
  if (!state) return Promise.resolve()
  if (state.closing) return state.closing
  const worker = state.worker
  try { state.cancel?.() } catch {}
  const workerClosed = Promise.resolve(worker?.terminate()).catch(() => {})
  const serverClosed = new Promise(resolve => {
    if (!state.server) return resolve()
    state.server.closeAllConnections?.()
    state.server.close(() => resolve())
  })
  return state.closing = Promise.all([workerClosed, serverClosed]).then(() => {})
}

async function solveInWorker(state, challenge, timeoutMs, signal) {
  state.worker ||= new Worker(new URL("./worker.js", import.meta.url), { workerData: { modelDir: state.modelDir }, execArgv: process.execArgv.filter(a => !a.startsWith("--input-type")) })
  const worker = state.worker, id = randomUUID(), started = Date.now()
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (error, result) => {
      if (finished) return; finished = true
      clearTimeout(timer); worker.off("message", message); worker.off("error", failed); worker.off("exit", exited); signal.removeEventListener("abort", aborted); state.cancel = null
      state.lastOutput = `${error ? "识别失败" : "识别结束"} · ${Date.now() - started} ms`
      if (error) { state.worker = null; void worker.terminate(); reject(error) } else { worker.unref(); resolve(result) }
    }
    const message = value => { if (value.id === id) finish(value.error ? new Error(value.error) : null, value.result) }
    const failed = error => finish(error), exited = () => finish(new Error("验证码 worker 已停止")), aborted = () => finish(new Error("验证码请求已取消"))
    const timer = setTimeout(() => finish(new Error("验证码识别超时")), timeoutMs)
    state.cancel = aborted; signal.addEventListener("abort", aborted, { once: true }); worker.on("message", message); worker.once("error", failed); worker.once("exit", exited); worker.ref(); worker.postMessage({ id, challenge, timeoutMs })
  })
}
export async function autoStartTestNineServer(options = {}) {
  const config = normalizeTestNineConfig((options.globalConfig || await loadGlobalConfig()).captcha?.test_nine)
  if (!config.enable) return { ok: true, skipped: true }
  return new TestNineServerService({ config }).start()
}
